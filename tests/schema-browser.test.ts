import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSchemaPrimitiveInActiveTab } from '../lib/browser/schema';
import { executeDataverseSchemaPrimitive } from '../lib/dataverse-schema-primitives';
import { schemaOrigin } from './fixtures/schema';
const context = {
  isDataverse: true,
  source: 'url' as const,
  origin: schemaOrigin,
  fields: [],
  capturedAt: 'now'
};
const request = {
  action: 'get_table_definition' as const,
  origin: schemaOrigin,
  tableLogicalName: 'new_example'
};
let query: ReturnType<typeof vi.fn>;
let script: ReturnType<typeof vi.fn>;
beforeEach(() => {
  query = vi.fn().mockResolvedValue([{ id: 1, url: schemaOrigin + '/main.aspx' }]);
  script = vi.fn().mockResolvedValue([{ result: { ok: true, action: request.action } }]);
  vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript: script } });
});
afterEach(() => vi.unstubAllGlobals());
describe('schema MAIN-world injection', () => {
  it('injects the self-contained executor into the active Dataverse tab', async () => {
    expect((await executeSchemaPrimitiveInActiveTab(context, request)).ok).toBe(true);
    expect(script).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      world: 'MAIN',
      func: executeDataverseSchemaPrimitive,
      args: [request]
    });
  });
  it.each([
    { url: 'https://make.powerautomate.com/' },
    { url: schemaOrigin + '/main.aspx', pendingUrl: schemaOrigin + '/other' },
    { url: 'https://other.crm.dynamics.com/main.aspx' },
    { url: undefined }
  ])('rejects wrong or navigating tabs %j', async (tab) => {
    query.mockResolvedValue([{ id: 1, ...tab }]);
    expect((await executeSchemaPrimitiveInActiveTab(context, request)).ok).toBe(false);
    expect(script).not.toHaveBeenCalled();
  });
  it('rejects request/context origin mismatches and unavailable Dataverse context', async () => {
    expect(
      (
        await executeSchemaPrimitiveInActiveTab(context, {
          ...request,
          origin: 'https://other.crm.dynamics.com'
        })
      ).ok
    ).toBe(false);
    expect(
      (await executeSchemaPrimitiveInActiveTab({ ...context, isDataverse: false }, request)).ok
    ).toBe(false);
    expect(script).not.toHaveBeenCalled();
  });
});
