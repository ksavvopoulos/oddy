// @vitest-environment happy-dom
import { StrictMode, createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { App } from '../entrypoints/sidepanel/App';
import { sendExtensionMessage } from '../lib/messages';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { getAvailableSkills } from '../lib/skills';
import { bulkHarness, bulkOrigin, guid, updatePlan } from './fixtures/bulk';
import type { BulkJobSummary } from '../lib/bulk/contracts';
import { bulkRepository } from '../lib/bulk/repository';

vi.mock('../lib/messages', async (original) => ({
  ...(await original<typeof import('../lib/messages')>()),
  sendExtensionMessage: vi.fn()
}));
vi.mock('../lib/storage', async (original) => ({
  ...(await original<typeof import('../lib/storage')>()),
  getSettings: vi.fn()
}));
vi.mock('../lib/skills', async (original) => ({
  ...(await original<typeof import('../lib/skills')>()),
  getAvailableSkills: vi.fn()
}));
const context = {
  isDataverse: true,
  source: 'url',
  origin: bulkOrigin,
  fields: [],
  capturedAt: 'now'
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    tabs: {
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    windows: {
      getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } }
  });
  vi.mocked(getSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    azureOpenAI: {
      ...DEFAULT_SETTINGS.azureOpenAI,
      endpoint: 'https://test.openai.azure.com',
      apiKey: 'test',
      deployment: 'test'
    }
  });
  vi.mocked(getAvailableSkills).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function route(h: ReturnType<typeof bulkHarness>, preview: BulkJobSummary) {
  let chats = 0;
  vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
    try {
      if (message.type === 'GET_ACTIVE_CONTEXT') return { ok: true, data: context };
      if (message.type === 'LLM_CHAT')
        return {
          ok: true,
          data:
            ++chats === 1
              ? { content: 'Review and approve this bulk operation.', pendingBulkJobs: [preview] }
              : { content: 'The bulk request is complete.' }
        };
      if (message.type === 'APPROVE_BULK_JOB')
        return {
          ok: true,
          data: await h.engine.approve(
            message.payload.id,
            message.payload.revision,
            message.payload.acknowledgeReadableScope,
            message.payload.executionOptions
          )
        };
      if (message.type === 'EXECUTE_BULK_JOB_CHUNK')
        return {
          ok: true,
          data: await h.engine.runChunk(
            message.payload.id,
            message.payload.runToken,
            message.payload.expectedOffset
          )
        };
      if (message.type === 'STOP_BULK_JOB')
        return { ok: true, data: await h.engine.stop(message.payload.id, message.payload.reject) };
      if (message.type === 'GET_BULK_JOB_ROWS')
        return {
          ok: true,
          data: await h.engine.inspectRows(message.payload.id, message.payload.offset)
        };
      if (message.type === 'LIST_BULK_DATASETS') return { ok: true, data: [] };
      if (message.type === 'LIST_BULK_JOBS')
        return { ok: true, data: (await bulkRepository.jobs()).map((job) => job.summary) };
      if (message.type === 'PREPARE_BULK_JOB_REMAINDER')
        return { ok: true, data: await h.engine.remaining(message.payload.id) };
      throw new Error(`Unexpected message ${message.type}`);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return () => chats;
}
async function submit(total: number) {
  render(createElement(StrictMode, null, createElement(App)));
  await screen.findByText('URL context');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, {
    target: { value: 'Apply the requested changes to all matching contacts' }
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveProperty('disabled', true)
  );
  fireEvent.submit(input.closest('form')!);
  return screen.findByRole('button', { name: `Approve ${total.toLocaleString()} rows` });
}

describe('real side-panel bulk approvals', () => {
  it('inspects locally, waits for approval, runs chunks once under StrictMode, and continues with compact counts', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    const chats = route(h, preview);
    const approve = await submit(120);
    expect(h.transport).not.toHaveBeenCalled();
    expect(
      screen.getByRole('checkbox', { name: 'Bypass custom plug-ins and classic workflows' })
    ).toHaveProperty('checked', false);
    expect(
      screen.getByRole('checkbox', { name: 'Suppress Power Automate triggers' })
    ).toHaveProperty('checked', false);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect full selection locally' }));
    await screen.findByText(/Rows 1–25 of 120/);
    fireEvent.click(screen.getByRole('button', { name: 'Next 25' }));
    await screen.findByText(/Rows 26–50 of 120/);
    expect(chats()).toBe(1);
    fireEvent.click(approve);
    await screen.findByText('The bulk request is complete.');
    expect(h.transport).toHaveBeenCalledTimes(2);
    expect(h.transport.mock.calls.map(([request]) => request.rows.length)).toEqual([100, 20]);
    expect(chats()).toBe(2);
    const continuation = vi
      .mocked(sendExtensionMessage)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === 'LLM_CHAT')[1]!;
    expect(JSON.stringify(continuation)).toContain('Completed approved bulk job');
    expect(JSON.stringify(continuation)).toContain('"succeeded\\":120');
    expect(JSON.stringify(continuation)).not.toContain(guid(100));
    expect(JSON.stringify(continuation)).not.toContain('runToken');
  });

  it('requires per-job opt-in and fixes both bypass choices at approval', async () => {
    const h = bulkHarness(125);
    const preview = await h.engine.prepare(updatePlan);
    route(h, preview);
    const approve = await submit(125);
    const custom = screen.getByRole('checkbox', {
      name: 'Bypass custom plug-ins and classic workflows'
    });
    const flows = screen.getByRole('checkbox', { name: 'Suppress Power Automate triggers' });
    expect(custom).toHaveProperty('checked', false);
    expect(flows).toHaveProperty('checked', false);
    fireEvent.click(custom);
    expect(custom).toHaveProperty('checked', true);
    expect(flows).toHaveProperty('checked', false);
    fireEvent.click(flows);
    expect(h.transport).not.toHaveBeenCalled();
    fireEvent.click(approve);
    await screen.findByText('The bulk request is complete.');
    expect(custom).toHaveProperty('disabled', true);
    expect(flows).toHaveProperty('disabled', true);
    const expected = { bypassCustomLogic: true, bypassPowerAutomate: true };
    const approval = vi
      .mocked(sendExtensionMessage)
      .mock.calls.map(([message]) => message)
      .find((message) => message.type === 'APPROVE_BULK_JOB');
    expect(approval?.payload.executionOptions).toEqual(expected);
    expect(h.transport).toHaveBeenCalledTimes(2);
    for (const [request] of h.transport.mock.calls)
      expect(request.executionOptions).toEqual(expected);
    const continuation = vi
      .mocked(sendExtensionMessage)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === 'LLM_CHAT')[1]!;
    expect(JSON.stringify(continuation)).toContain('bypassCustomLogic\\\":true');
    expect(JSON.stringify(continuation)).toContain('bypassPowerAutomate\\\":true');
    fireEvent.click(custom);
    expect(custom).toHaveProperty('checked', true);
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it('keeps rejected bypass choices visible and resets them on a fresh remaining-work card', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    h.setWrite(async (request) => ({
      error: 'Bypass privilege denied',
      outcomes: request.rows.map((row) => ({
        recordId: row.recordId,
        status: 'failed',
        error: 'Bypass privilege denied'
      }))
    }));
    const chats = route(h, preview);
    const approve = await submit(120);
    const custom = screen.getByRole('checkbox', {
      name: 'Bypass custom plug-ins and classic workflows'
    });
    fireEvent.click(custom);
    fireEvent.click(approve);
    await screen.findByText('Bulk job stopped; reconciliation required');
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(chats()).toBe(1);
    expect(custom).toHaveProperty('checked', true);
    expect(custom).toHaveProperty('disabled', true);
    expect(h.transport.mock.calls[0]![0].executionOptions).toEqual({
      bypassCustomLogic: true,
      bypassPowerAutomate: false
    });
    fireEvent.click(screen.getByText('Bulk workspace · datasets and recovery'));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare remaining-work preview' }));
    await screen.findByRole('button', { name: 'Approve 120 rows' });
    const pendingCustom = screen
      .getAllByRole('checkbox', { name: 'Bypass custom plug-ins and classic workflows' })
      .filter((input) => !(input as HTMLInputElement).disabled);
    const pendingFlows = screen
      .getAllByRole('checkbox', { name: 'Suppress Power Automate triggers' })
      .filter((input) => !(input as HTMLInputElement).disabled);
    expect(pendingCustom).toHaveLength(1);
    expect(pendingFlows).toHaveLength(1);
    expect(pendingCustom[0]).toHaveProperty('checked', false);
    expect(pendingFlows[0]).toHaveProperty('checked', false);
    expect(h.transport).toHaveBeenCalledTimes(1);
  });

  it('requires explicit readable-source acknowledgement before applying related counts', async () => {
    const h = bulkHarness(3);
    const preview = await h.engine.prepare({
      operation: 'count_related',
      selection: updatePlan.selection,
      targetColumn: 'new_casecount',
      related: { table: 'incident', lookupColumn: 'customerid', filters: [], allRecords: true }
    });
    route(h, preview);
    const approve = await submit(3);
    expect(approve).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand these counts/ }));
    expect(approve).not.toHaveProperty('disabled', true);
    fireEvent.click(approve);
    await screen.findByText('The bulk request is complete.');
    expect([...h.records.values()].every((record) => record.values.new_casecount === 0)).toBe(true);
    const approval = vi
      .mocked(sendExtensionMessage)
      .mock.calls.map(([message]) => message)
      .find((message) => message.type === 'APPROVE_BULK_JOB');
    expect(approval?.payload.acknowledgeReadableScope).toBe(true);
  });

  it('stops on conflicts without continuation and prepares a separate remaining-work card', async () => {
    const h = bulkHarness(120);
    const preview = await h.engine.prepare(updatePlan);
    h.records.get(guid(1))!.etag = 'W/"changed"';
    const chats = route(h, preview);
    fireEvent.click(await submit(120));
    await screen.findByText('Bulk job stopped; reconciliation required');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Approve 120 rows' })).toBeNull()
    );
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(chats()).toBe(1);
    fireEvent.click(screen.getByText('Bulk workspace · datasets and recovery'));
    const prepare = await screen.findByRole('button', { name: 'Prepare remaining-work preview' });
    fireEvent.click(prepare);
    await screen.findByRole('button', { name: 'Approve 21 rows' });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(chats()).toBe(1);
  });
});
