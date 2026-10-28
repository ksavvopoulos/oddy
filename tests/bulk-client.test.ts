import { describe, expect, it, vi } from 'vitest';
import { executeApprovedBulkJob, bulkAudit } from '../lib/bulk/client';
import { bulkSummary } from './fixtures/bulk';
import type { ExtensionMessage, MessageResult } from '../lib/types';

function client(
  options: { stop?: () => boolean; allowed?: () => boolean; fail?: boolean; lost?: boolean } = {}
) {
  let succeeded = 0;
  const raw = vi.fn(async (message: ExtensionMessage): Promise<MessageResult<unknown>> => {
    if (message.type === 'APPROVE_BULK_JOB')
      return {
        ok: true,
        data: {
          summary: bulkSummary({ status: 'approved', total: 120, remaining: 120 }),
          runToken: 'private-token'
        }
      };
    if (message.type === 'STOP_BULK_JOB')
      return {
        ok: true,
        data: bulkSummary({ status: 'paused', total: 120, succeeded, remaining: 120 - succeeded })
      };
    if (message.type === 'EXECUTE_BULK_JOB_CHUNK') {
      if (options.lost) throw new Error('response channel closed');
      if (options.fail)
        return {
          ok: true,
          data: bulkSummary({
            status: 'failed',
            failed: 50,
            remaining: 70,
            error: '429',
            retryAfterSeconds: 30
          })
        };
      succeeded += Math.min(50, 120 - succeeded);
      return {
        ok: true,
        data: bulkSummary({
          status: succeeded === 120 ? 'completed' : 'approved',
          total: 120,
          succeeded,
          remaining: 120 - succeeded
        })
      };
    }
    throw new Error('Unexpected message');
  });
  return {
    raw,
    send: raw as <T>(message: ExtensionMessage) => Promise<MessageResult<T>>,
    allowed: options.allowed || (() => true),
    stopRequested: options.stop || (() => false),
    progress: vi.fn()
  };
}

describe('live bulk approval client', () => {
  it('approves once and submits only the exact next chunk outside any model loop', async () => {
    const c = client();
    const result = await executeApprovedBulkJob(bulkSummary(), c);
    expect(result.status).toBe('completed');
    expect(c.raw.mock.calls.map(([message]) => message.type)).toEqual([
      'APPROVE_BULK_JOB',
      'EXECUTE_BULK_JOB_CHUNK',
      'EXECUTE_BULK_JOB_CHUNK',
      'EXECUTE_BULK_JOB_CHUNK'
    ]);
    expect(
      c.raw.mock.calls
        .slice(1)
        .map(
          ([message]) => message.type === 'EXECUTE_BULK_JOB_CHUNK' && message.payload.expectedOffset
        )
    ).toEqual([0, 50, 100]);
    expect(JSON.stringify(bulkAudit(result))).not.toContain('private-token');
    expect(bulkAudit(result)).not.toHaveProperty('sample');
  });
  it('sends bypass choices only at approval, never as per-chunk overrides', async () => {
    const c = client();
    const executionOptions = { bypassCustomLogic: true, bypassPowerAutomate: true };
    await executeApprovedBulkJob(bulkSummary(), { ...c, executionOptions });
    expect(c.raw.mock.calls[0]![0]).toMatchObject({
      type: 'APPROVE_BULK_JOB',
      payload: { executionOptions }
    });
    for (const [message] of c.raw.mock.calls.slice(1))
      if (message.type === 'EXECUTE_BULK_JOB_CHUNK')
        expect(message.payload).not.toHaveProperty('executionOptions');
    expect(bulkAudit(bulkSummary({ executionOptions }))).toHaveProperty(
      'executionOptions',
      executionOptions
    );
    expect(bulkAudit(bulkSummary())).toHaveProperty('executionOptions', {
      bypassCustomLogic: false,
      bypassPowerAutomate: false
    });
  });
  it('does not request approval without current consent', async () => {
    const c = client({ allowed: () => false });
    await expect(executeApprovedBulkJob(bulkSummary(), c)).rejects.toThrow(/consent/);
    expect(c.raw).not.toHaveBeenCalled();
  });
  it('stops after the current chunk when requested', async () => {
    let stopped = false;
    const c = client({ stop: () => stopped });
    c.progress.mockImplementation((summary) => {
      if (summary.succeeded === 50) stopped = true;
    });
    await expect(executeApprovedBulkJob(bulkSummary(), c)).rejects.toThrow(
      /fresh remaining-work preview/
    );
    expect(c.raw.mock.calls.map(([message]) => message.type)).toEqual([
      'APPROVE_BULK_JOB',
      'EXECUTE_BULK_JOB_CHUNK',
      'STOP_BULK_JOB'
    ]);
  });
  it('stops if consent is revoked between chunks', async () => {
    let allowed = true;
    const c = client({ allowed: () => allowed });
    c.progress.mockImplementation((summary) => {
      if (summary.succeeded === 50) allowed = false;
    });
    await expect(executeApprovedBulkJob(bulkSummary(), c)).rejects.toThrow(
      /fresh remaining-work preview/
    );
    expect(
      c.raw.mock.calls.filter(([message]) => message.type === 'EXECUTE_BULK_JOB_CHUNK')
    ).toHaveLength(1);
  });
  it('does not retry failed/throttled or lost-response chunks', async () => {
    for (const config of [{ fail: true }, { lost: true }]) {
      const c = client(config);
      await expect(executeApprovedBulkJob(bulkSummary(), c)).rejects.toThrow(/never replay/);
      expect(
        c.raw.mock.calls.filter(([message]) => message.type === 'EXECUTE_BULK_JOB_CHUNK')
      ).toHaveLength(1);
    }
  });
});
