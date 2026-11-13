import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveDataverseContext } from '../lib/browser/context';
import { executeSchemaPrimitiveInActiveTab } from '../lib/browser/schema';
import type { ExtensionMessage, MessageResult } from '../lib/types';
import { schemaProposal, schemaOrigin } from './fixtures/schema';

vi.mock('../lib/browser/context', () => ({ getActiveDataverseContext: vi.fn() }));
vi.mock('../lib/browser/schema', () => ({ executeSchemaPrimitiveInActiveTab: vi.fn() }));
let listener: (
  message: ExtensionMessage,
  sender: unknown,
  reply: (v: MessageResult<unknown>) => void
) => boolean;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (callback: typeof listener) => {
          listener = callback;
        }
      }
    },
    sidePanel: {
      setOptions: vi.fn().mockResolvedValue(undefined),
      setPanelBehavior: vi.fn().mockResolvedValue(undefined)
    }
  });
  vi.mocked(getActiveDataverseContext).mockResolvedValue({
    isDataverse: true,
    source: 'url',
    origin: schemaOrigin,
    fields: [],
    capturedAt: 'now'
  });
  const background = (await import('../entrypoints/background')).default as unknown as {
    main: () => void;
  };
  background.main();
});
afterEach(() => vi.unstubAllGlobals());
const send = () =>
  new Promise<MessageResult<unknown>>((resolve) =>
    listener(
      { type: 'EXECUTE_DATAVERSE_SCHEMA_CHANGE', payload: { change: schemaProposal } },
      {},
      resolve
    )
  );

describe('schema approval background outcomes', () => {
  it('preserves partial failure outcomes for the UI instead of throwing away prior successes', async () => {
    const outcome = {
      operation: 'create_table' as const,
      tableLogicalName: 'new_order',
      solutionUniqueName: 'ExampleSolution',
      status: 'partial' as const,
      message: 'Partial; inspect metadata.',
      outcomes: [
        { components: ['new_order'], status: 'succeeded' as const },
        { components: ['new_order.new_contact'], status: 'unknown' as const }
      ]
    };
    vi.mocked(executeSchemaPrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'execute_schema_change',
      error: outcome.message,
      schemaChangeResult: outcome
    });
    expect(await send()).toEqual({ ok: true, data: outcome });
    expect(executeSchemaPrimitiveInActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({ origin: schemaOrigin }),
      { action: 'execute_schema_change', origin: schemaOrigin, change: schemaProposal }
    );
  });
  it('returns ordinary preflight errors without manufacturing an execution outcome', async () => {
    vi.mocked(executeSchemaPrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'execute_schema_change',
      error: 'Stale preview'
    });
    expect(await send()).toEqual({ ok: false, error: 'Stale preview' });
  });
  it('blocks a changed environment before injection', async () => {
    vi.mocked(getActiveDataverseContext).mockResolvedValue({
      isDataverse: true,
      source: 'url',
      origin: 'https://other.crm.dynamics.com',
      fields: [],
      capturedAt: 'now'
    });
    expect(await send()).toMatchObject({
      ok: false,
      error: expect.stringContaining('Return to the Dataverse environment')
    });
    expect(executeSchemaPrimitiveInActiveTab).not.toHaveBeenCalled();
  });
});
