import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigationUrlsMatch } from '../lib/browser/navigation';
import { executePrimitiveInActiveTab } from '../lib/browser/primitives';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';
import { executeDataverseFlowPrimitive } from '../lib/dataverse-flow-primitives';
import { executeFlowPrimitiveInActiveTab } from '../lib/browser/flows';
import { getActiveDataverseContext } from '../lib/browser/context';
import { collectDataverseUserContext } from '../lib/dataverse-user-context';
import { collectXrmPageContext } from '../lib/dataverse-context';

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

  it('uses the self-contained flow executor and refuses a changed environment', async () => {
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: 'https://other.crm.dynamics.com/main.aspx' }] },
      scripting: { executeScript }
    });
    const result = await executeFlowPrimitiveInActiveTab(context, {
      action: 'list_flows',
      origin
    });
    expect(result.ok).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('serializes the flow executor without module closures', async () => {
    const injected = new Function(
      `return (${executeDataverseFlowPrimitive.toString()});`
    )() as typeof executeDataverseFlowPrimitive;
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                connectionreferencelogicalname: 'cr_dataverse',
                connectionreferencedisplayname: 'Dataverse',
                connectorid: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
                ismanaged: false
              }
            ]
          })
        )
      )
    );
    const result = await injected({
      action: 'list_flow_connection_references',
      origin
    });
    expect(result.ok).toBe(true);
    expect(result.connectionReferences?.[0]?.logicalName).toBe('cr_dataverse');
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

describe('current user context wiring', () => {
  const currentUser = {
    source: 'webApi',
    observedAtUtc: '2026-01-15T23:30:00Z',
    timeZoneCode: 130,
    localDate: '2026-01-16'
  };
  const form = {
    source: 'xrm',
    tableLogicalName: 'contact',
    fields: [{ logicalName: 'fullname', label: 'Name', value: 'Ada' }]
  };

  it('keeps user settings even when form fields cause an early return', async () => {
    const executeScript = vi.fn(async ({ func }: { func: unknown }) => [
      { result: func === collectDataverseUserContext ? currentUser : form }
    ]);
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: `${origin}/main.aspx` }] },
      scripting: { executeScript }
    });
    const result = await getActiveDataverseContext();
    expect(result.currentUser).toEqual(currentUser);
    expect(result.fields).toHaveLength(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        world: 'MAIN',
        func: collectDataverseUserContext,
        args: [{ origin, utcNow: expect.any(String) }]
      })
    );
  });

  it('reads user settings on list pages without form fields', async () => {
    const executeScript = vi.fn(async ({ func }: { func: unknown }) => [
      { result: func === collectDataverseUserContext ? currentUser : { source: 'url' } }
    ]);
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [{ id: 1, url: `${origin}/main.aspx?pagetype=entitylist&etn=list` }]
      },
      scripting: { executeScript }
    });
    expect((await getActiveDataverseContext()).currentUser).toEqual(currentUser);
  });

  it('preserves user settings through the record Web API fallback', async () => {
    const executeScript = vi.fn(async ({ func }: { func: unknown }) => [
      {
        result:
          func === collectDataverseUserContext
            ? currentUser
            : func === collectXrmPageContext
              ? { source: 'url' }
              : form
      }
    ]);
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [
          { id: 1, url: `${origin}/main.aspx?etn=contact&id=00000000-0000-0000-0000-000000000123` }
        ]
      },
      scripting: { executeScript }
    });
    const result = await getActiveDataverseContext();
    expect(result.currentUser).toEqual(currentUser);
    expect(result.fields).toHaveLength(1);
  });

  it('can skip Dataverse user reads when only custom-skill tools are allowed', async () => {
    const executeScript = vi.fn(async () => [{ result: form }]);
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: `${origin}/main.aspx` }] },
      scripting: { executeScript }
    });
    expect(
      (await getActiveDataverseContext({ includeUserSettings: false })).currentUser
    ).toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ func: collectXrmPageContext })
    );
  });

  it('reports user lookup errors without breaking ordinary form context', async () => {
    const executeScript = vi.fn(async ({ func }: { func: unknown }) => {
      if (func === collectDataverseUserContext) throw new Error('Injection unavailable');
      return [{ result: form }];
    });
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: `${origin}/main.aspx` }] },
      scripting: { executeScript }
    });
    const result = await getActiveDataverseContext();
    expect(result.fields).toHaveLength(1);
    expect(result.currentUser?.source).toBe('unavailable');
    expect(result.currentUser?.warning).toContain('Injection unavailable');
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
