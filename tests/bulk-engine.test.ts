import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { bulkHarness, bulkOrigin, guid, updatePlan } from './fixtures/bulk';
import { bulkRepository } from '../lib/bulk/repository';
import { createDataset } from '../lib/bulk/datasets';
import type { BulkChunkResult, BulkExecutionOptions } from '../lib/bulk/contracts';
import { createBulkEngine } from '../lib/bulk/engine';
import type {
  DataversePrimitiveRequest,
  DataversePreparationMetadata
} from '../lib/dataverse/contracts';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

describe('query-backed bulk engine', () => {
  it('freezes thousands of IDs without exposing rows or writing during preparation', async () => {
    const h = bulkHarness(2400);
    const preview = await h.engine.prepare(updatePlan);
    expect(preview).toMatchObject({
      status: 'pending',
      matched: 2400,
      total: 2400,
      remaining: 2400
    });
    expect(preview.sample).toHaveLength(5);
    expect(JSON.stringify(preview).length).toBeLessThan(6000);
    expect(preview).not.toHaveProperty('userId');
    expect(preview).not.toHaveProperty('rows');
    expect(preview).not.toHaveProperty('runToken');
    expect(h.transport).not.toHaveBeenCalled();
    const pages = h.primitive.mock.calls.filter(([r]) => r.action === 'bulk_page');
    expect(pages).toHaveLength(3);
    for (const [request] of pages) {
      expect(request).toMatchObject({
        query: { columns: ['firstname'] },
        requireConcurrency: true
      });
    }
    expect(h.primitive.mock.calls.some(([r]) => r.action === 'bulk_read_versions')).toBe(false);
    expect((await bulkRepository.rows(preview.id, 0, 1))[0]).toMatchObject({
      etag: 'W/"1"',
      fields: [{ logicalName: 'firstname', currentValue: 'Old', proposedValue: 'New' }]
    });
    expect(await bulkRepository.rows(preview.id, 2350, 50)).toHaveLength(50);
  });

  it('updates the frozen set in bounded chunks even when new records appear', async () => {
    const h = bulkHarness(1200);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    h.records.set(guid(5000), {
      id: guid(5000),
      etag: 'W/"1"',
      values: { firstname: 'Old' },
      lookupTypes: {}
    });
    let result = approval.summary;
    while (result.status === 'approved')
      result = await h.engine.runChunk(
        preview.id,
        approval.runToken,
        result.total - result.remaining
      );
    expect(result).toMatchObject({ status: 'completed', succeeded: 1200, remaining: 0 });
    expect(h.transport).toHaveBeenCalledTimes(12);
    expect(h.transport.mock.calls.every(([request]) => request.rows.length === 100)).toBe(true);
    expect(h.records.get(guid(5000))?.values.firstname).toBe('Old');
    await expect(h.engine.runChunk(preview.id, approval.runToken, 0)).rejects.toThrow(/stale/);
  });

  it('checkpoints a full 100-row chunk and a final partial chunk without skipping rows', async () => {
    const h = bulkHarness(125);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    const first = await h.engine.runChunk(preview.id, approval.runToken, 0);
    expect(first).toMatchObject({ status: 'approved', succeeded: 100, remaining: 25 });
    await expect(h.engine.runChunk(preview.id, approval.runToken, 50)).rejects.toThrow(/stale/);
    const last = await h.engine.runChunk(preview.id, approval.runToken, 100);
    expect(last).toMatchObject({ status: 'completed', succeeded: 125, remaining: 0 });
    expect(h.transport.mock.calls.map(([request]) => request.rows.length)).toEqual([100, 25]);
    const ids = h.transport.mock.calls.flatMap(([request]) =>
      request.rows.map((row) => row.recordId)
    );
    expect(new Set(ids).size).toBe(125);
    expect([...h.records.values()].every((record) => record.values.firstname === 'New')).toBe(true);
  });

  it('still checks the signed-in user between 100-row chunks', async () => {
    const h = bulkHarness(125);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    await h.engine.runChunk(preview.id, approval.runToken, 0);
    h.setUser(guid(777));
    await expect(h.engine.runChunk(preview.id, approval.runToken, 100)).rejects.toThrow(
      /user changed/
    );
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { bypassCustomLogic: true },
    { bypassPowerAutomate: true },
    { bypassCustomLogic: true, bypassPowerAutomate: true }
  ] satisfies BulkExecutionOptions[])(
    'persists approval-bound automation options across chunks and engine instances: %j',
    async (executionOptions) => {
      const h = bulkHarness(125);
      const preview = await h.engine.prepare(updatePlan);
      expect(preview.executionOptions).toBeUndefined();
      const expected = {
        bypassCustomLogic: executionOptions.bypassCustomLogic === true,
        bypassPowerAutomate: executionOptions.bypassPowerAutomate === true
      };
      const approval = await h.engine.approve(
        preview.id,
        preview.revision,
        false,
        executionOptions
      );
      expect(approval.summary.executionOptions).toEqual(expected);
      expect((await bulkRepository.getJob(preview.id))?.summary.executionOptions).toEqual(expected);
      await expect(h.engine.approve(preview.id, preview.revision, false, {})).rejects.toThrow(
        /pending/
      );
      await h.engine.runChunk(preview.id, approval.runToken, 0);
      const nextEngine = createBulkEngine({
        origin: preview.environmentOrigin,
        primitive: h.primitive,
        transport: h.transport,
        now: () => Date.parse(preview.createdAt)
      });
      const result = await nextEngine.runChunk(preview.id, approval.runToken, 100);
      expect(result).toMatchObject({ status: 'completed', executionOptions: expected });
      expect(h.transport).toHaveBeenCalledTimes(2);
      for (const [request] of h.transport.mock.calls)
        expect(request.executionOptions).toEqual(expected);
    }
  );

  it('rejects malformed automation options without approving or submitting a write', async () => {
    const h = bulkHarness(2);
    const preview = await h.engine.prepare(updatePlan);
    for (const executionOptions of [
      null,
      'true',
      [],
      { bypassCustomLogic: 'true' },
      { bypassPowerAutomate: 1 },
      { header: true }
    ]) {
      await expect(
        h.engine.approve(
          preview.id,
          preview.revision,
          false,
          executionOptions as BulkExecutionOptions
        )
      ).rejects.toThrow(/execution options/);
      const stored = await bulkRepository.getJob(preview.id);
      expect(stored?.summary.status).toBe('pending');
      expect(stored?.runToken).toBeUndefined();
    }
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('does not inherit bypass choices into a fresh remaining-work approval', async () => {
    const h = bulkHarness(125);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision, false, {
      bypassCustomLogic: true,
      bypassPowerAutomate: true
    });
    await h.engine.runChunk(preview.id, approval.runToken, 0);
    await h.engine.stop(preview.id);
    const next = await h.engine.remaining(preview.id);
    expect(next).toMatchObject({ total: 25, status: 'pending' });
    expect(next.executionOptions).toBeUndefined();
    expect((await bulkRepository.getJob(preview.id))?.summary.executionOptions).toEqual({
      bypassCustomLogic: true,
      bypassPowerAutomate: true
    });
    const nextApproval = await h.engine.approve(next.id, next.revision);
    await h.engine.runChunk(next.id, nextApproval.runToken, 0);
    expect(h.transport.mock.calls[1]![0].executionOptions).toEqual({
      bypassCustomLogic: false,
      bypassPowerAutomate: false
    });
  });

  it('rejects bypass options on membership actions', async () => {
    const h = bulkHarness(2);
    const preview = await h.engine.prepare({
      operation: 'membership',
      selection: updatePlan.selection,
      listId: guid(700000)
    });
    await expect(
      h.engine.approve(preview.id, preview.revision, false, { bypassCustomLogic: true })
    ).rejects.toThrow(/bulk record creates and updates/);
    await expect(
      h.engine.approve(preview.id, preview.revision, false, { bypassPowerAutomate: true })
    ).rejects.toThrow(/bulk record creates and updates/);
    expect((await bulkRepository.getJob(preview.id))?.summary.status).toBe('pending');
    expect(
      h.primitive.mock.calls.some(([request]) => request.action === 'execute_list_membership')
    ).toBe(false);
  });

  it('scopes metadata to one preparation and never carries it into execution or storage', async () => {
    const h = bulkHarness(125);
    const primitive = vi.fn(
      async (request: DataversePrimitiveRequest, metadata?: DataversePreparationMetadata) => {
        const result = await h.primitive(request);
        return {
          ...result,
          preparationMetadata: metadata
            ? structuredClone({
                ...metadata,
                responses: { ...metadata.responses, sentinel: 'private-metadata' }
              })
            : undefined
        };
      }
    );
    const engine = createBulkEngine({
      origin: bulkOrigin,
      primitive,
      transport: h.transport,
      now: () => Date.parse('2026-01-01T12:00:00Z')
    });
    const preview = await engine.prepare(updatePlan);
    const preparation = primitive.mock.calls.find(([r]) => r.action === 'bulk_fields')![1]!;
    expect(preparation.responses.sentinel).toBe('private-metadata');
    expect(primitive.mock.calls.find(([r]) => r.action === 'bulk_page')![1]).toBe(preparation);
    expect(JSON.stringify(await bulkRepository.getJob(preview.id))).not.toContain(
      'private-metadata'
    );
    expect(JSON.stringify(preview)).not.toContain('preparationMetadata');
    primitive.mockClear();
    const approval = await engine.approve(preview.id, preview.revision);
    await engine.runChunk(preview.id, approval.runToken, 0);
    expect(primitive.mock.calls.every(([, metadata]) => metadata === undefined)).toBe(true);
    primitive.mockClear();
    await engine.remaining(preview.id);
    const recovery = primitive.mock.calls.find(([r]) => r.action === 'bulk_fields')![1]!;
    expect(recovery).not.toBe(preparation);
    expect(primitive.mock.calls.find(([r]) => r.action === 'bulk_read_versions')![1]).toBe(
      recovery
    );
    primitive.mockClear();
    await engine.prepare(updatePlan);
    expect(primitive.mock.calls.find(([r]) => r.action === 'bulk_fields')![1]).not.toBe(
      preparation
    );
  });

  it('reconciles frozen rows and versions in groups of 1000 without widening write chunks', async () => {
    const h = bulkHarness(2400);
    const preview = await h.engine.prepare(updatePlan);
    const next = await h.engine.remaining(preview.id);
    expect(next).toMatchObject({ total: 2400, status: 'pending' });
    const reads = h.primitive.mock.calls.flatMap(([r]) =>
      r.action === 'bulk_read_versions' ? [r.ids.length] : []
    );
    expect(reads).toEqual([1000, 1000, 400]);
    expect(await bulkRepository.rows(next.id, 1000, 1000)).toHaveLength(1000);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('validates create rows in groups of 100 rather than 50', async () => {
    const h = bulkHarness(0);
    const dataset = createDataset(
      'contacts.json',
      Array.from({ length: 205 }, (_, index) => ({ First: `New ${index}` })),
      new Date('2026-01-01T12:00:00Z')
    );
    await bulkRepository.saveDataset(dataset);
    const preview = await h.engine.prepare({
      operation: 'create',
      table: 'contact',
      datasetId: dataset.summary.id,
      mapping: { First: 'firstname' }
    });
    expect(preview.total).toBe(205);
    expect(
      h.primitive.mock.calls.flatMap(([r]) => (r.action === 'bulk_fields' ? [r.values.length] : []))
    ).toEqual([100, 100, 5]);
  });

  it('excludes unchanged rows before approval', async () => {
    const h = bulkHarness(5);
    h.records.get(guid(1))!.values.firstname = 'New';
    const preview = await h.engine.prepare(updatePlan);
    expect(preview).toMatchObject({ matched: 5, unchanged: 1, total: 4 });
    expect(
      (await bulkRepository.rows(preview.id, 0, 50)).some((row) => row.recordId === guid(1))
    ).toBe(false);
  });

  it('counts distinct related records through a typed lookup, excludes accounts, and writes zero', async () => {
    const h = bulkHarness(1200);
    h.cases.push(
      { id: guid(6000), values: { customerid: guid(1) }, lookupTypes: { customerid: 'contact' } },
      { id: guid(6001), values: { customerid: guid(1) }, lookupTypes: { customerid: 'contact' } },
      { id: guid(6001), values: { customerid: guid(1) }, lookupTypes: { customerid: 'contact' } },
      { id: guid(6002), values: { customerid: guid(2) }, lookupTypes: { customerid: 'account' } }
    );
    const preview = await h.engine.prepare({
      operation: 'count_related',
      selection: updatePlan.selection,
      targetColumn: 'new_casecount',
      related: { table: 'incident', lookupColumn: 'customerid', filters: [], allRecords: true }
    });
    const rows = await bulkRepository.rows(preview.id, 0, 50);
    expect(preview.total).toBe(1200);
    expect(rows[0]?.fields[0]?.proposedValue).toBe(2);
    expect(rows[1]?.fields[0]?.proposedValue).toBe(0);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('groups thousands of source cases across paging boundaries without model-visible rows', async () => {
    const h = bulkHarness(1200);
    for (let index = 0; index < 3000; index++)
      h.cases.push({
        id: guid(6000 + index),
        values: { customerid: guid((index % 1200) + 1) },
        lookupTypes: { customerid: 'contact' }
      });
    const preview = await h.engine.prepare({
      operation: 'count_related',
      selection: updatePlan.selection,
      targetColumn: 'new_casecount',
      related: { table: 'incident', lookupColumn: 'customerid', filters: [], allRecords: true }
    });
    const boundary = await bulkRepository.rows(preview.id, 550, 100);
    expect(boundary.slice(0, 50).every((row) => row.fields[0]?.proposedValue === 3)).toBe(true);
    expect(boundary.slice(50).every((row) => row.fields[0]?.proposedValue === 2)).toBe(true);
    expect(
      h.primitive.mock.calls.filter(
        ([request]) => request.action === 'bulk_page' && request.query.table === 'incident'
      )
    ).toHaveLength(3);
    expect(preview.total).toBe(1200);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('refuses ambiguous polymorphic counts and never approves a partial calculation', async () => {
    const h = bulkHarness(3);
    h.cases.push({ id: guid(6000), values: { customerid: guid(1) }, lookupTypes: {} });
    await expect(
      h.engine.prepare({
        operation: 'count_related',
        selection: updatePlan.selection,
        targetColumn: 'new_casecount',
        related: { table: 'incident', lookupColumn: 'customerid', filters: [], allRecords: true }
      })
    ).rejects.toThrow(/Polymorphic/);
    expect((await bulkRepository.jobs())[0]?.preparationComplete).toBe(false);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('requires readable-source acknowledgement at the execution boundary for derived counts', async () => {
    const h = bulkHarness(2);
    const preview = await h.engine.prepare({
      operation: 'count_related',
      selection: updatePlan.selection,
      targetColumn: 'new_casecount',
      related: { table: 'incident', lookupColumn: 'customerid', filters: [], allRecords: true }
    });
    await expect(h.engine.approve(preview.id, preview.revision)).rejects.toThrow(/Acknowledge/);
    expect((await h.engine.approve(preview.id, preview.revision, true)).summary.status).toBe(
      'approved'
    );
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('rejects missing record versions instead of silently overwriting', async () => {
    const h = bulkHarness(3);
    h.records.get(guid(1))!.etag = undefined;
    await expect(h.engine.prepare(updatePlan)).rejects.toThrow(/version/);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('binds approval to the nonce, environment, user, expiry, and pending status', async () => {
    const h = bulkHarness(2);
    const preview = await h.engine.prepare(updatePlan);
    await expect(h.engine.approve(preview.id, 'different')).rejects.toThrow(/pending/);
    h.setUser(guid(777));
    await expect(h.engine.approve(preview.id, preview.revision)).rejects.toThrow(/user changed/);
    h.setUser(guid(999999));
    h.advance(3600001);
    await expect(h.engine.approve(preview.id, preview.revision)).rejects.toThrow(/pending/);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('stops after conflicts and requires a separate remaining-work approval', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    h.records.get(guid(1))!.etag = 'W/"changed"';
    const approval = await h.engine.approve(preview.id, preview.revision);
    const result = await h.engine.runChunk(preview.id, approval.runToken, 0);
    expect(result).toMatchObject({ status: 'failed', succeeded: 99, conflicts: 1, remaining: 20 });
    await expect(h.engine.runChunk(preview.id, approval.runToken, 100)).rejects.toThrow(/stale/);
    const next = await h.engine.remaining(preview.id);
    expect(next).toMatchObject({ status: 'pending', total: 21 });
    expect((await bulkRepository.rows(next.id, 0, 50))[0]?.etag).toBe('W/"changed"');
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('stops before submission if writable field metadata changed after preview', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    const original = h.primitive.getMockImplementation()!;
    h.primitive.mockImplementation(async (request) => {
      const result = await original(request);
      if (request.action === 'bulk_fields')
        for (const fields of result.bulkFields || []) fields[0]!.attributeType = 'Memo';
      return result;
    });
    const approval = await h.engine.approve(preview.id, preview.revision);
    const result = await h.engine.runChunk(preview.id, approval.runToken, 0);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('metadata');
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('rejects concurrent and replayed chunk requests', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    let release!: (value: BulkChunkResult) => void;
    h.setWrite(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = h.engine.runChunk(preview.id, approval.runToken, 0);
    await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
    await expect(h.engine.runChunk(preview.id, approval.runToken, 0)).rejects.toThrow(/in flight/);
    await expect(h.engine.remove(preview.id)).rejects.toThrow(/in flight/);
    expect(await bulkRepository.getJob(preview.id)).toBeDefined();
    release({
      outcomes: h.transport.mock.calls[0]![0].rows.map((row) => ({
        recordId: row.recordId,
        status: 'succeeded'
      }))
    });
    await first;
    await expect(h.engine.runChunk(preview.id, approval.runToken, 0)).rejects.toThrow(/stale/);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('reconciles uncertain creates by their original IDs without recreating successes', async () => {
    const h = bulkHarness(0);
    const dataset = createDataset(
      'contacts.json',
      Array.from({ length: 1200 }, (_, index) => ({ First: `New ${index}` })),
      new Date('2026-01-01T12:00:00Z')
    );
    await bulkRepository.saveDataset(dataset);
    const preview = await h.engine.prepare({
      operation: 'create',
      table: 'contact',
      datasetId: dataset.summary.id,
      mapping: { First: 'firstname' }
    });
    const original = await bulkRepository.rows(preview.id, 100, 50);
    const approval = await h.engine.approve(preview.id, preview.revision);
    h.setWrite(async (request) => {
      await h.apply(request);
      return {
        outcomes: request.rows.map((row) => ({ recordId: row.recordId, status: 'uncertain' }))
      };
    });
    const result = await h.engine.runChunk(preview.id, approval.runToken, 0);
    expect(result.uncertain).toBe(100);
    expect(h.records.size).toBe(100);
    const remaining = await h.engine.remaining(preview.id);
    expect(remaining).toMatchObject({ total: 1100, unchanged: 100, status: 'pending' });
    expect((await bulkRepository.rows(remaining.id, 0, 50)).map((row) => row.recordId)).toEqual(
      original.map((row) => row.recordId)
    );
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight marker after a lost checkpoint and reconciles before further writes', async () => {
    let loseCheckpoint = false;
    const repository = {
      ...bulkRepository,
      save: vi.fn(async (...args: Parameters<typeof bulkRepository.save>) => {
        if (loseCheckpoint && args[1]?.length && args[1][0]?.status === 'succeeded')
          throw new Error('checkpoint quota failure');
        return bulkRepository.save(...args);
      })
    };
    const h = bulkHarness(120, repository);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    loseCheckpoint = true;
    await expect(h.engine.runChunk(preview.id, approval.runToken, 0)).rejects.toThrow(/quota/);
    expect((await bulkRepository.getJob(preview.id))?.inFlight).toMatchObject({
      start: 0,
      count: 100
    });
    await expect(h.engine.runChunk(preview.id, approval.runToken, 0)).rejects.toThrow(
      /interrupted/
    );
    loseCheckpoint = false;
    const next = await h.engine.remaining(preview.id);
    expect(next).toMatchObject({ total: 20, unchanged: 100, status: 'pending' });
    expect((await bulkRepository.getJob(preview.id))?.summary.uncertain).toBe(100);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('does not upsert a reserved create ID that exists with different values', async () => {
    const h = bulkHarness(0);
    const dataset = createDataset(
      'contacts.json',
      [{ First: 'Alice' }],
      new Date('2026-01-01T12:00:00Z')
    );
    await bulkRepository.saveDataset(dataset);
    const preview = await h.engine.prepare({
      operation: 'create',
      table: 'contact',
      datasetId: dataset.summary.id,
      mapping: { First: 'firstname' }
    });
    const row = (await bulkRepository.rows(preview.id, 0, 50))[0]!;
    h.records.set(row.recordId, {
      id: row.recordId,
      values: { firstname: 'Someone else' },
      lookupTypes: {}
    });
    await expect(h.engine.remaining(preview.id)).rejects.toThrow(/not overwritten or upserted/);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('prepares thousands of memberships excluding existing ones and executes bulk actions', async () => {
    const h = bulkHarness(1500);
    h.memberships.add(guid(1));
    const preview = await h.engine.prepare({
      operation: 'membership',
      selection: updatePlan.selection,
      listId: guid(700000)
    });
    expect(preview).toMatchObject({ total: 1499, unchanged: 1 });
    expect(
      h.primitive.mock.calls.some(([request]) => request.action === 'execute_list_membership')
    ).toBe(false);
    const approval = await h.engine.approve(preview.id, preview.revision);
    let result = approval.summary;
    while (result.status === 'approved')
      result = await h.engine.runChunk(
        preview.id,
        approval.runToken,
        result.total - result.remaining
      );
    expect(result).toMatchObject({ status: 'completed', succeeded: 1499 });
    expect(h.memberships.size).toBe(1500);
    expect(
      h.primitive.mock.calls.filter(([request]) => request.action === 'execute_list_membership')
    ).toHaveLength(30);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('enforces throttling cooldown before reconciling remaining work', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    h.setWrite(async (request) => ({
      retryAfterSeconds: 30,
      outcomes: request.rows.map((row) => ({ recordId: row.recordId, status: 'failed' }))
    }));
    await h.engine.runChunk(preview.id, approval.runToken, 0);
    await expect(h.engine.remaining(preview.id)).rejects.toThrow(/cooldown/);
    h.advance(30001);
    expect((await h.engine.remaining(preview.id)).total).toBe(120);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('invalidates execution authority when a live job is stopped', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    const approval = await h.engine.approve(preview.id, preview.revision);
    await h.engine.runChunk(preview.id, approval.runToken, 0);
    await h.engine.stop(preview.id);
    await expect(h.engine.runChunk(preview.id, approval.runToken, 100)).rejects.toThrow(/stale/);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('enforces retention when a known old job is opened directly', async () => {
    const h = bulkHarness(2);
    const preview = await h.engine.prepare(updatePlan);
    h.advance(86400001);
    await expect(h.engine.inspect(preview.id)).rejects.toThrow(/checkpoint expired/);
    expect(await bulkRepository.rows(preview.id, 0, 50)).toEqual([]);
  });

  it('reduces chunk size for large payloads without skipping buffered rows', async () => {
    const h = bulkHarness(120);
    const text = 'x'.repeat(10000);
    const preview = await h.engine.prepare({
      ...updatePlan,
      values: [{ column: 'firstname', value: text }]
    });
    const approval = await h.engine.approve(preview.id, preview.revision);
    let result = approval.summary;
    while (result.status === 'approved')
      result = await h.engine.runChunk(
        preview.id,
        approval.runToken,
        result.total - result.remaining
      );
    expect(result.succeeded).toBe(120);
    expect(h.transport.mock.calls.every(([request]) => request.rows.length < 100)).toBe(true);
    expect([...h.records.values()].every((record) => record.values.firstname === text)).toBe(true);
  });

  it('deletes one dataset without deleting a different source', async () => {
    const a = createDataset('a.json', [{ A: 'A' }]);
    const b = createDataset('b.json', [{ B: 'B' }]);
    await bulkRepository.saveDataset(a);
    await bulkRepository.saveDataset(b);
    await bulkRepository.deleteDataset(a.summary.id);
    expect(await bulkRepository.getDataset(a.summary.id)).toBeUndefined();
    expect((await bulkRepository.datasets()).map((dataset) => dataset.id)).toEqual([b.summary.id]);
    expect((await bulkRepository.getDataset(b.summary.id))?.records).toEqual([{ B: 'B' }]);
  });

  it('deletes one old job without losing a different job’s recovery evidence', async () => {
    const h = bulkHarness(120);
    const first = await h.engine.prepare(updatePlan);
    const second = await h.engine.prepare(updatePlan);
    await h.engine.remove(first.id);
    expect(await bulkRepository.getJob(first.id)).toBeUndefined();
    expect(await bulkRepository.rows(first.id, 0, 50)).toEqual([]);
    expect((await h.engine.inspect(second.id)).id).toBe(second.id);
    expect(await bulkRepository.rows(second.id, 0, 50)).toHaveLength(50);
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('expires datasets and purges all job rows with their manifest', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    await bulkRepository.prune(Date.parse(preview.createdAt) + 86400001);
    expect(await bulkRepository.getJob(preview.id)).toBeUndefined();
    expect(await bulkRepository.rows(preview.id, 0, 50)).toEqual([]);
  });
});
