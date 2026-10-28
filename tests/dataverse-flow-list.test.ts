import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFlowPrimitive } from '../lib/dataverse-flow-primitives';
import type { DataverseFlowPrimitiveRequest } from '../lib/flows/contracts';
import { activityForTool } from '../lib/assistant/activity';

const origin = 'https://contoso.crm.dynamics.com';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const id = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
function flow(index: number, table = 'cr_voucher', message: unknown = 1) {
  return {
    workflowid: id(index),
    name: `Flow ${index}`,
    category: 5,
    type: 1,
    statecode: 1,
    componentstate: 0,
    ismanaged: false,
    clientdata: JSON.stringify({
      properties: {
        connectionReferences: { dataverse: { api: { name: 'shared_commondataserviceforapps' } } },
        definition: {
          triggers: {
            On_row: {
              type: 'OpenApiConnectionWebhook',
              inputs: {
                host: { connectionName: 'dataverse', operationId: 'SubscribeWebhookTrigger' },
                parameters: {
                  'subscriptionRequest/entityname': table,
                  'subscriptionRequest/message': message,
                  'subscriptionRequest/scope': 4,
                  'subscriptionRequest/filterexpression': 'statecode eq 0',
                  'subscriptionRequest/filteringattributes': 'cr_name'
                }
              },
              conditions: [{ expression: "@equals(triggerBody()?['cr_enabled'], true)" }]
            }
          },
          actions: {
            Secret_action: { type: 'Compose', inputs: 'PRIVATE_ACTION_DATA', runAfter: {} }
          }
        }
      }
    })
  };
}
function editFlow(record: ReturnType<typeof flow>, edit: (document: any) => void) {
  const document = JSON.parse(record.clientdata);
  edit(document);
  return { ...record, clientdata: JSON.stringify(document) };
}
const list = (
  options: Omit<
    Extract<DataverseFlowPrimitiveRequest, { action: 'list_flows' }>,
    'action' | 'origin'
  > = {}
) => executeDataverseFlowPrimitive({ action: 'list_flows', origin, ...options });
function mockPages(handler: (url: string, options?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/EntityDefinitions'))
      return response({ LogicalName: 'cr_voucher', EntitySetName: 'cr_vouchers' });
    return handler(url, options);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const encode = (value: unknown) =>
  `flow-list-v1.${btoa(encodeURIComponent(JSON.stringify(value)))}`;
const decode = (value: string) => JSON.parse(decodeURIComponent(atob(value.slice(13))));

beforeEach(() => vi.stubGlobal('window', { location: { origin } }));
afterEach(() => vi.unstubAllGlobals());

describe('existing flow-list tool: server filters and continuation', () => {
  it('builds escaped structured filters and deterministic ordering, using maxpagesize instead of $top', async () => {
    const fetchMock = mockPages(() => response({ value: [] }));
    const result = await list({
      pageSize: 100,
      definitionScope: 'published',
      filters: {
        name: "O'Brien's voucher",
        nameMatch: 'contains',
        state: 'activated',
        isManaged: false
      },
      orderBy: { field: 'name', direction: 'asc' }
    });
    expect(result.ok).toBe(true);
    const [url, options] = fetchMock.mock.calls[0]!;
    const query = new URL(url).searchParams;
    expect(query.get('$filter')).toBe(
      "category eq 5 and type eq 1 and componentstate eq 0 and contains(name,'O''Brien''s voucher') and statecode eq 1 and ismanaged eq false"
    );
    expect(query.get('$orderby')).toBe('name asc,workflowid asc');
    expect(query.has('$top')).toBe(false);
    expect(query.has('$skip')).toBe(false);
    expect(new Headers(options?.headers).get('Prefer')).toBe('odata.maxpagesize=100');
    expect(new Headers(options?.headers).has('MSCRM.IncludeUnpublished')).toBe(false);
    expect(options?.redirect).toBe('error');
    expect(result.flowPage).toMatchObject({
      pageSize: 100,
      definitionScope: 'published',
      scanned: 0,
      returned: 0,
      hasMore: false
    });
  });

  it.each([
    ['eq', "name eq 'Voucher'"],
    ['starts-with', "startswith(name,'Voucher')"]
  ] as const)('supports the %s name operator', async (nameMatch, expected) => {
    const fetchMock = mockPages(() => response({ value: [] }));
    await list({ filters: { name: 'Voucher', nameMatch } });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('$filter')).toContain(expected);
  });

  it('finds a matching flow beyond the former 50-flow limit and follows the exact encoded paging link', async () => {
    let nextLink = '';
    const fetchMock = mockPages((url) => {
      if (url.includes('$skiptoken=')) return response({ value: [flow(51)] });
      nextLink = `${url}&$skiptoken=%3Ccookie%20page%3D%222%22%2B%26%3E`;
      return response({
        value: Array.from({ length: 50 }, (_, index) => flow(index + 1, 'contact')),
        '@odata.nextLink': nextLink
      });
    });
    const first = await list({
      pageSize: 50,
      definitionScope: 'published',
      filters: { state: 'activated' },
      trigger: { table: 'cr_voucher', event: 'create' }
    });
    expect(first.flows).toEqual([]);
    expect(first.flowPage).toMatchObject({
      scanned: 50,
      returned: 0,
      hasMore: true,
      uninspectable: 0
    });
    expect(first.flowPage?.warnings.join(' ')).toContain('empty matching page does not mean');
    const second = await list({ cursor: first.flowPage!.nextCursor });
    expect(second.flows?.map((item) => item.workflowId)).toEqual([id(51)]);
    expect(second.flowPage).toMatchObject({
      scanned: 1,
      returned: 1,
      pageSize: 50,
      hasMore: false,
      definitionScope: 'published'
    });
    const calls = fetchMock.mock.calls.filter(([url]) =>
      new URL(url).pathname.endsWith('/workflows')
    );
    expect(calls[1]?.[0]).toBe(nextLink);
    expect(new Headers(calls[1]?.[1]?.headers).get('Prefer')).toBe('odata.maxpagesize=50');
    expect(calls.every(([, options]) => !options?.method)).toBe(true);
    expect(activityForTool('list_dataverse_flows', first).summary).toContain('more pages remain');
    expect(activityForTool('list_dataverse_flows', first).details).toContain(
      'No matching flows on this page.'
    );
  });

  it('preserves Unicode filters through an opaque cursor', async () => {
    const fetchMock = mockPages((url) =>
      response({ value: [], '@odata.nextLink': `${url}&$skiptoken=next` })
    );
    const first = await list({ filters: { name: 'Κουπόνι' } });
    expect(first.ok).toBe(true);
    mockPages(() => response({ value: [] }));
    const second = await list({ cursor: first.flowPage?.nextCursor });
    expect(second.ok).toBe(true);
    expect(decode(first.flowPage!.nextCursor!).query.filters.name).toBe('Κουπόνι');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('binds a continuation to its filters, page size, ordering, definition scope, and environment', async () => {
    mockPages((url) => response({ value: [], '@odata.nextLink': `${url}&$skiptoken=next` }));
    const first = await list({ pageSize: 50, filters: { state: 'activated' } });
    const cursor = first.flowPage!.nextCursor!;
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    for (const options of [
      { cursor, pageSize: 20 },
      { cursor, definitionScope: 'published' as const },
      { cursor, filters: { state: 'draft' as const } },
      { cursor, orderBy: { field: 'name' as const, direction: 'asc' as const } }
    ]) {
      expect((await list(options)).error).toContain('Do not change');
    }
    const decoded = decode(cursor);
    expect(
      (await list({ cursor: encode({ ...decoded, origin: 'https://other.crm.dynamics.com' }) }))
        .error
    ).toContain('different environment');
    expect(noFetch).not.toHaveBeenCalled();
  });

  it.each([
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: 1.5 },
    { pageSize: '20' },
    { filters: { state: 'on' } },
    { filters: { isManaged: 'false' } },
    { filters: { nameMatch: 'contains' } },
    { filters: { rawOData: 'true' } },
    { trigger: { table: "x') or true" } },
    { trigger: { event: 'created' } },
    { orderBy: { field: 'clientdata' } },
    { definitionScope: 'all' },
    { cursor: 'forged' }
  ])('fails closed on unsupported query input (%#)', async (options) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await list(options as any);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'cross-origin',
    'wrong-path',
    'wrong-filter',
    'expand',
    'duplicate',
    'fragment',
    'no-token'
  ])('refuses unsafe server continuation links: %s', async (scenario) => {
    const fetchMock = mockPages((url) => {
      const next = new URL(url);
      next.searchParams.set('$skiptoken', 'next');
      if (scenario === 'cross-origin') next.hostname = 'evil.example';
      if (scenario === 'wrong-path') next.pathname = '/api/data/v9.2/contacts';
      if (scenario === 'wrong-filter') next.searchParams.set('$filter', 'true');
      if (scenario === 'expand') next.searchParams.set('$expand', 'ownerid');
      if (scenario === 'duplicate') next.searchParams.append('$filter', 'true');
      if (scenario === 'fragment') next.hash = 'x';
      if (scenario === 'no-token') next.searchParams.delete('$skiptoken');
      return response({ value: [], '@odata.nextLink': next.toString() });
    });
    const result = await list();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsafe or mismatched');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates forged cursor URLs before sending any request or credentials', async () => {
    mockPages((url) => response({ value: [], '@odata.nextLink': `${url}&$skiptoken=next` }));
    const first = await list();
    const token = decode(first.flowPage!.nextCursor!);
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    expect(
      (
        await list({
          cursor: encode({
            ...token,
            nextLink: 'https://evil.example/api/data/v9.2/workflows?$skiptoken=next'
          })
        })
      ).ok
    ).toBe(false);
    expect(noFetch).not.toHaveBeenCalled();
  });
});

describe('native JSON trigger matching and definition versions', () => {
  it.each([
    ['create', [1, 4, 5, 7]],
    ['update', [3, 4, 6, 7]],
    ['delete', [2, 5, 6, 7]]
  ] as const)('matches every supported combined change type for %s', async (event, expected) => {
    mockPages(() =>
      response({
        value: Array.from({ length: 7 }, (_, index) =>
          flow(index + 1, 'cr_voucher', String(index + 1))
        )
      })
    );
    const result = await list({
      trigger: { table: 'CR_VOUCHER', event },
      definitionScope: 'published'
    });
    expect(result.ok).toBe(true);
    expect(result.flows?.map((item) => Number(item.workflowId.slice(-12)))).toEqual(expected);
    expect(result.flowPage?.uninspectable).toBe(0);
  });

  it('matches actual triggers, not flow names, action table references, or another connector', async () => {
    const actionOnly = editFlow(flow(1), (data) => {
      data.properties.definition.triggers = {
        manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } }
      };
      data.properties.definition.actions = {
        Voucher: { type: 'Compose', inputs: 'cr_voucher create' }
      };
    });
    actionOnly.name = 'Voucher creation flow';
    const otherConnector = editFlow(flow(2), (data) => {
      data.properties.connectionReferences.dataverse.api.name = 'shared_sharepointonline';
    });
    mockPages(() =>
      response({
        value: [actionOnly, otherConnector, flow(3, 'contact'), flow(4, 'cr_voucher', 3), flow(5)]
      })
    );
    const result = await list({ trigger: { table: 'cr_voucher', event: 'create' } });
    expect(result.flows?.map((item) => item.workflowId)).toEqual([id(5)]);
    expect(result.flowPage).toMatchObject({ scanned: 5, returned: 1, uninspectable: 0 });
  });

  it('keeps trigger conditions and scope but never exposes unrelated definition/action data', async () => {
    mockPages(() => response({ value: [{ ...flow(1), ismanaged: true }] }));
    const result = await list({ trigger: { table: 'cr_voucher' } });
    expect(result.flows?.[0]).toMatchObject({
      oddyEditable: false,
      definitionVersion: 'published',
      triggerInspection: 'complete',
      triggers: [
        {
          id: 'On_row',
          table: 'cr_voucher',
          events: ['create'],
          scope: 4,
          filterExpression: 'statecode eq 0',
          filteringAttributes: 'cr_name',
          conditions: [{ expression: "@equals(triggerBody()?['cr_enabled'], true)" }]
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ACTION_DATA');
    expect(JSON.stringify(result)).not.toContain('clientdata');
  });

  it('separates published triggers from newer unpublished drafts even when the flow is On', async () => {
    const fetchMock = mockPages((_url, options) =>
      response({
        value: [
          new Headers(options?.headers).get('MSCRM.IncludeUnpublished') === 'true'
            ? { ...flow(1, 'cr_voucher', 1), componentstate: 1 }
            : flow(1, 'cr_voucher', 3)
        ]
      })
    );
    const published = await list({
      definitionScope: 'published',
      filters: { state: 'activated' },
      trigger: { table: 'cr_voucher', event: 'create' }
    });
    const latest = await list({
      definitionScope: 'latest',
      filters: { state: 'activated' },
      trigger: { table: 'cr_voucher', event: 'create' }
    });
    expect(published.flows).toEqual([]);
    expect(published.flowPage?.uninspectable).toBe(0);
    expect(latest.flows?.[0]).toMatchObject({
      state: 'activated',
      definitionVersion: 'unpublished'
    });
    expect(latest.flowPage?.warnings.join(' ')).toContain(
      'not proof of the currently published trigger'
    );
    const urls = fetchMock.mock.calls
      .filter(([url]) => new URL(url).pathname.endsWith('/workflows'))
      .map(([url]) => new URL(url));
    expect(urls[0]?.searchParams.get('$filter')).toContain(
      'componentstate eq 0 and statecode eq 1'
    );
    expect(urls[1]?.searchParams.get('$filter')).toContain(
      '(componentstate eq 0 or componentstate eq 1)'
    );
  });

  it('does not claim published matches if the server returns unpublished or unknown versions', async () => {
    mockPages(() =>
      response({
        value: [
          { ...flow(1), componentstate: 1 },
          { ...flow(2), componentstate: undefined }
        ]
      })
    );
    const result = await list({
      definitionScope: 'published',
      trigger: { table: 'cr_voucher', event: 'create' }
    });
    expect(result.flows).toEqual([]);
    expect(result.flowPage).toMatchObject({ hasMore: false, uninspectable: 2 });
    expect(result.flowPage?.warnings.join(' ')).toContain('Do not claim an exhaustive negative');
  });

  it('treats an unresolved connector alias or unfamiliar trigger type as inconclusive', async () => {
    const unresolved = editFlow(flow(1), (data) => {
      data.properties.connectionReferences = {};
    });
    const unfamiliar = editFlow(flow(2), (data) => {
      data.properties.definition.triggers = { Custom: { type: 'FutureTrigger' } };
    });
    mockPages(() => response({ value: [unresolved, unfamiliar] }));
    const result = await list({ trigger: { table: 'cr_voucher', event: 'create' } });
    expect(result.flows).toEqual([]);
    expect(result.flowPage?.uninspectable).toBe(2);
  });

  it('reports unreadable, dynamic, and unsupported triggers instead of silently proving absence', async () => {
    const dynamic = flow(2, "@parameters('table')");
    const unknownEvent = flow(3, 'cr_voucher', '__proto__');
    const unsupported = editFlow(flow(4), (data) => {
      data.properties.definition.triggers.On_row.inputs.host.operationId = 'UnknownTrigger';
    });
    mockPages(() =>
      response({ value: [{ ...flow(1), clientdata: '{bad' }, dynamic, unknownEvent, unsupported] })
    );
    const result = await list({ trigger: { table: 'cr_voucher', event: 'create' } });
    expect(result.ok).toBe(true);
    expect(result.flows).toEqual([]);
    expect(result.flowPage).toMatchObject({
      scanned: 4,
      returned: 0,
      uninspectable: 4,
      hasMore: false
    });
    expect(result.flowPage?.inspectionIssues.map((item) => item.workflowId)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4)
    ]);
    expect(activityForTool('list_dataverse_flows', result).summary).toContain('4 uninspectable');
  });

  it('inspects triggers even when unrelated action shapes are not editable in Oddy', async () => {
    const record = editFlow(flow(1), (data) => {
      data.properties.definition.actions = { Legacy: {} };
    });
    mockPages(() => response({ value: [record] }));
    const result = await list({ trigger: { table: 'cr_voucher', event: 'create' } });
    expect(result.flows?.[0]).toMatchObject({ oddyEditable: false, triggerInspection: 'complete' });
    expect(result.flowPage?.uninspectable).toBe(0);
  });

  it('supports nested subscription parameters and MAIN-world serialization', async () => {
    const record = editFlow(flow(1), (data) => {
      data.properties.definition.triggers.On_row.inputs.parameters = {
        subscriptionRequest: { entityname: 'cr_voucher', message: 4, scope: 4 }
      };
    });
    mockPages(() => response({ value: [record] }));
    const injected = new Function(
      `return (${executeDataverseFlowPrimitive.toString()});`
    )() as typeof executeDataverseFlowPrimitive;
    const result = await injected({
      action: 'list_flows',
      origin,
      trigger: { table: 'cr_voucher', event: 'create' }
    });
    expect(result.ok).toBe(true);
    expect(result.flows?.[0]?.triggers[0]?.events).toEqual(['create', 'update']);
  });

  it('keeps native null-valued optional arguments unambiguous', async () => {
    mockPages(() => response({ value: [] }));
    const result = await list({
      pageSize: null,
      definitionScope: null,
      cursor: null,
      filters: { name: null, nameMatch: null, state: null, isManaged: null },
      orderBy: { field: null, direction: null },
      trigger: { table: null, event: null }
    } as any);
    expect(result.ok).toBe(true);
    expect(result.flowPage).toMatchObject({ pageSize: 20, definitionScope: 'latest' });
  });

  it('does not issue the flow search when the requested logical table cannot be resolved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: 'Not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const result = await list({ trigger: { table: 'vocuher', event: 'create' } });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("EntityDefinitions(LogicalName='vocuher')");
  });
});
