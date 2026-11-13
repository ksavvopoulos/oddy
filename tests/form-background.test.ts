import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveDataverseContext } from '../lib/browser/context';
import { executeFormPrimitiveInActiveTab } from '../lib/browser/forms';
import type { ExtensionMessage, MessageResult } from '../lib/types';
import { formOrigin } from './fixtures/forms';
import type { PreparedFormChange } from '../lib/forms/contracts';

vi.mock('../lib/browser/context', () => ({ getActiveDataverseContext: vi.fn() }));
vi.mock('../lib/browser/forms', () => ({ executeFormPrimitiveInActiveTab: vi.fn() }));
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
    origin: formOrigin,
    fields: [],
    capturedAt: 'now'
  });
  const background = (await import('../entrypoints/background')).default as unknown as {
    main: () => void;
  };
  background.main();
});
afterEach(() => vi.unstubAllGlobals());

const change = {
  mode: 'form-v1',
  id: 'f1',
  environmentOrigin: formOrigin,
  plan: { operation: 'publish_table_forms', tableLogicalName: 'contact' },
  tableLogicalName: 'contact',
  summary: [],
  warnings: []
} as PreparedFormChange;
const send = (payload = change) =>
  new Promise<MessageResult<unknown>>((resolve) =>
    listener({ type: 'EXECUTE_DATAVERSE_FORM_CHANGE', payload: { change: payload } }, {}, resolve)
  );

describe('form approval background routing', () => {
  it('returns failed step outcomes to the UI instead of dropping them', async () => {
    const outcome = {
      operation: 'publish_table_forms' as const,
      tableLogicalName: 'contact',
      status: 'failed' as const,
      message: 'Uncertain.',
      outcomes: [{ step: 'publish' as const, status: 'unknown' as const }]
    };
    vi.mocked(executeFormPrimitiveInActiveTab).mockResolvedValue({
      ok: true,
      action: 'execute_form_change',
      formChangeResult: outcome
    });
    expect(await send()).toEqual({ ok: true, data: outcome });
    expect(executeFormPrimitiveInActiveTab).toHaveBeenCalledWith(
      expect.objectContaining({ origin: formOrigin }),
      { action: 'execute_form_change', origin: formOrigin, change }
    );
  });

  it('refuses previews from another environment and surfaces preflight errors', async () => {
    const other = await send({ ...change, environmentOrigin: 'https://other.crm.dynamics.com' });
    expect(other.ok).toBe(false);
    expect(other.error).toContain('Return to the Dataverse environment');
    expect(executeFormPrimitiveInActiveTab).not.toHaveBeenCalled();
    vi.mocked(executeFormPrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'execute_form_change',
      error: 'The form changed since it was read.'
    });
    expect(await send()).toMatchObject({ ok: false, error: 'The form changed since it was read.' });
  });
});
