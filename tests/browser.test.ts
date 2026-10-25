import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigationUrlsMatch } from '../lib/browser/navigation';
import { executePrimitiveInActiveTab } from '../lib/browser/primitives';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';

afterEach(() => vi.unstubAllGlobals());
const origin = 'https://contoso.crm.dynamics.com';
const context = {
  isDataverse: true,
  source: 'url' as const,
  origin,
  fields: [],
  capturedAt: 'now'
};

describe('browser boundary', () => {
  it('does not inject into a different environment after the active tab changes', async () => {
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: 'https://other.crm.dynamics.com/main.aspx' }] },
      scripting: { executeScript }
    });
    const result = await executePrimitiveInActiveTab(context, {
      action: 'resolve_schema',
      origin,
      table: 'contact'
    });
    expect(result.ok).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('uses the self-contained MAIN-world executor and a serializable request', async () => {
    const executeScript = vi.fn(async () => [{ result: { ok: true, action: 'resolve_schema' } }]);
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: `${origin}/main.aspx` }] },
      scripting: { executeScript }
    });
    const request = { action: 'resolve_schema' as const, origin, table: 'contact' };
    await executePrimitiveInActiveTab(context, request);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      world: 'MAIN',
      func: executeDataversePrimitive,
      args: [request]
    });
  });

  it('still runs after serialization without access to module closures', async () => {
    const injected = new Function(
      `return (${executeDataversePrimitive.toString()});`
    )() as typeof executeDataversePrimitive;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'contact',
            EntitySetName: 'contacts',
            PrimaryIdAttribute: 'contactid'
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ value: [{ LogicalName: 'firstname', AttributeType: 'String' }] })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await injected({
      action: 'resolve_schema',
      origin,
      table: 'contact',
      columns: ['firstname']
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedColumns?.[0]?.logicalName).toBe('firstname');
  });
});

describe('Dataverse destination matching', () => {
  it('ignores app-shell extras and normalizes GUID braces and case', () => {
    expect(
      navigationUrlsMatch(
        `${origin}/main.aspx?ETN=CONTACT&ID={ABC}&appid=extra`,
        `${origin}/main.aspx?etn=contact&id=abc`
      )
    ).toBe(true);
  });
  it('does not match a different origin, table, or record', () => {
    expect(
      navigationUrlsMatch('https://other.crm.dynamics.com/main.aspx', `${origin}/main.aspx`)
    ).toBe(false);
    expect(
      navigationUrlsMatch(`${origin}/main.aspx?etn=account`, `${origin}/main.aspx?etn=contact`)
    ).toBe(false);
    expect(navigationUrlsMatch(`${origin}/main.aspx?id=one`, `${origin}/main.aspx?id=two`)).toBe(
      false
    );
    expect(navigationUrlsMatch('invalid', `${origin}/main.aspx`)).toBe(false);
  });
});
