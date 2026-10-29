// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';
import { bulkOrigin as origin, guid } from './fixtures/bulk';
import type { DataversePreparationMetadata } from '../lib/dataverse/contracts';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const attributes = [
  { LogicalName: 'contactid', AttributeType: 'Uniqueidentifier', IsValidForRead: true },
  { LogicalName: 'fullname', AttributeType: 'String', IsValidForRead: true },
  ...[
    ['firstname', 'String'],
    ['new_casecount', 'Integer'],
    ['preferredcontactmethodcode', 'Picklist'],
    ['customerid', 'Customer']
  ].map(([LogicalName, AttributeType]) => ({
    LogicalName,
    AttributeType,
    IsValidForRead: true,
    IsValidForCreate: true,
    IsValidForUpdate: true
  })),
  {
    LogicalName: 'readonly',
    AttributeType: 'Integer',
    IsValidForRead: true,
    IsValidForUpdate: false
  }
];
function setup(payload: Record<string, unknown> = { value: [] }, concurrent = true) {
  vi.stubGlobal('window', { location: { origin } });
  const mock = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname.includes('LookupAttributeMetadata'))
      return json({ value: [{ LogicalName: 'customerid', Targets: ['contact', 'account'] }] });
    if (url.pathname.includes('PicklistAttributeMetadata'))
      return json({
        OptionSet: { Options: [{ Value: 2, Label: { UserLocalizedLabel: { Label: 'Email' } } }] }
      });
    if (url.pathname.endsWith('/Attributes')) return json({ value: attributes });
    if (url.pathname.includes('EntityDefinitions('))
      return json({
        LogicalName: 'contact',
        EntitySetName: 'contacts',
        PrimaryIdAttribute: 'contactid',
        PrimaryNameAttribute: 'fullname',
        IsOptimisticConcurrencyEnabled: concurrent
      });
    if (url.pathname.endsWith('/contacts')) return json(payload);
    if (url.pathname.endsWith('/WhoAmI')) return json({ UserId: guid(9000) });
    throw new Error(`Unexpected URL ${raw}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe('bulk signed-session primitives', () => {
  it('validates many rows with cached metadata, coerces typed CSV values, and never writes', async () => {
    const mock = setup();
    const result = await executeDataversePrimitive({
      action: 'bulk_fields',
      origin,
      table: 'contact',
      operation: 'update',
      values: Array.from({ length: 100 }, (_, index) => [
        { column: 'new_casecount', value: String(index) },
        { column: 'preferredcontactmethodcode', value: 'Email' }
      ])
    });
    expect(result.ok).toBe(true);
    expect(result.bulkFields).toHaveLength(100);
    expect(result.bulkFields?.[0]?.map((field) => field.proposedValue)).toEqual([0, 2]);
    expect(result.bulkFields?.[99]?.map((field) => field.proposedValue)).toEqual([99, 2]);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')
    ).toBe(true);
  });
  it.each([0, 101])('rejects %s bulk field sets before fetching metadata', async (length) => {
    const mock = setup();
    const result = await executeDataversePrimitive({
      action: 'bulk_fields',
      origin,
      table: 'contact',
      operation: 'update',
      values: Array.from({ length }, () => [{ column: 'firstname', value: 'New' }])
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1–100');
    expect(mock).not.toHaveBeenCalled();
  });
  it('reuses only metadata across serialized preparation calls and starts fresh without the context', async () => {
    const mock = setup({
      value: [{ contactid: guid(1), firstname: 'Old', '@odata.etag': 'W/"7"' }],
      '@Microsoft.Dynamics.CRM.morerecords': false
    });
    const serialized = new Function(
      `return (${executeDataversePrimitive.toString()})`
    )() as typeof executeDataversePrimitive;
    const input = {
      action: 'bulk_fields' as const,
      origin,
      table: 'contact',
      operation: 'update' as const,
      values: [[{ column: 'preferredcontactmethodcode', value: 'Email' }]]
    };
    const first = await serialized(input, { origin, entities: {}, responses: {} });
    expect(first.ok).toBe(true);
    const context: DataversePreparationMetadata = JSON.parse(
      JSON.stringify(first.preparationMetadata)
    );
    const page = await serialized(
      {
        action: 'bulk_page',
        origin,
        query: { table: 'contact', columns: ['firstname'] },
        requireConcurrency: true
      },
      context
    );
    expect(page.bulkPage?.records[0]).toMatchObject({
      etag: 'W/"7"',
      values: { firstname: 'Old' }
    });
    const again = await serialized(input, JSON.parse(JSON.stringify(page.preparationMetadata)));
    expect(again.ok).toBe(true);
    expect(mock.mock.calls.filter(([url]) => url.includes('EntityDefinitions'))).toHaveLength(3);
    expect(JSON.stringify(again.preparationMetadata)).not.toContain('W/\\"7\\"');
    expect(JSON.stringify(again.preparationMetadata)).not.toContain('Old');
    mock.mockClear();
    const fresh = await serialized(input);
    expect(fresh.ok).toBe(true);
    expect(fresh.preparationMetadata).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mockClear();
    const otherOrigin = await serialized(input, {
      ...context,
      origin: 'https://other.crm.dynamics.com'
    });
    expect(otherOrigin.ok).toBe(true);
    expect(otherOrigin.preparationMetadata).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mockClear();
    await serialized({ action: 'bulk_identity', origin }, context);
    await serialized({ action: 'bulk_identity', origin }, context);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('rejects read-only or invalid typed values before any mutation', async () => {
    setup();
    for (const [column, value] of [
      ['readonly', 5],
      ['new_casecount', 'abc'],
      ['new_casecount', 1.5],
      ['new_casecount', 2147483648]
    ] as const) {
      const result = await executeDataversePrimitive({
        action: 'bulk_fields',
        origin,
        table: 'contact',
        operation: 'update',
        values: [[{ column, value }]]
      });
      expect(result.ok).toBe(false);
    }
  });
  it('decodes server paging cookies and preserves deterministic paging without a top limit', async () => {
    const inner = `<cookie page="1"><contactid last="${guid(1000)}" /></cookie>`;
    const mock = setup({
      value: Array.from({ length: 1000 }, (_, index) => ({ contactid: guid(index + 1) })),
      '@Microsoft.Dynamics.CRM.morerecords': true,
      '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(inner))}" />`
    });
    const first = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', filters: [] }
    });
    expect(first.ok).toBe(true);
    expect(first.bulkPage?.cursor).toEqual({ page: 2, cookie: inner });
    await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', filters: [] },
      cursor: first.bulkPage!.cursor
    });
    const xml = new URL(mock.mock.calls.at(-1)![0]).searchParams.get('fetchXml')!;
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    expect(document.documentElement.getAttribute('paging-cookie')).toBe(inner);
    expect(document.documentElement.getAttribute('page')).toBe('2');
    expect(document.documentElement.getAttribute('count')).toBe('1000');
    expect(document.querySelector('order')?.getAttribute('attribute')).toBe('contactid');
    expect(xml).not.toContain('top=');
  });
  it('requests all 20 update fields, without the small-query column truncation', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `new_field${index}`);
    const base = setup({
      value: [
        {
          contactid: guid(1),
          '@odata.etag': 'W/"9"',
          ...Object.fromEntries(names.map((name, index) => [name, index]))
        }
      ],
      '@Microsoft.Dynamics.CRM.morerecords': false
    });
    const mock = vi.fn(async (raw: string) =>
      new URL(raw).pathname.endsWith('/Attributes')
        ? json({
            value: [
              ...attributes,
              ...names.map((LogicalName) => ({
                LogicalName,
                AttributeType: 'Integer',
                IsValidForRead: true
              }))
            ]
          })
        : base(raw)
    );
    vi.stubGlobal('fetch', mock);
    const result = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', columns: names },
      requireConcurrency: true
    });
    expect(result.ok).toBe(true);
    const xml = new URL(mock.mock.calls.at(-1)![0]).searchParams.get('fetchXml')!;
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const selected = [...document.querySelectorAll('attribute')].map((node) =>
      node.getAttribute('name')
    );
    expect(selected).toHaveLength(22);
    for (const name of names) expect(selected).toContain(name);
    expect(result.bulkPage?.records[0]?.values.new_field19).toBe(19);
  });

  it('requires optimistic concurrency for update selection before reading records', async () => {
    const mock = setup({ value: [] }, false);
    const result = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', columns: ['firstname'] },
      requireConcurrency: true
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('optimistic concurrency');
    expect(mock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/contacts'))).toBe(
      false
    );
  });

  it('fails closed if more records exist without a usable cookie', async () => {
    setup({ value: [{ contactid: guid(1) }], '@Microsoft.Dynamics.CRM.morerecords': true });
    const result = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact' }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not truncated');
  });
  it('rejects unresolved filters instead of broadening the selection', async () => {
    const mock = setup();
    const result = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', filters: [{ column: 'typo_field', operator: 'eq', value: 'X' }] }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No filters were dropped');
    expect(mock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/contacts'))).toBe(
      false
    );
  });
  it('preserves polymorphic lookup types from Web API properties', async () => {
    setup({
      value: [
        {
          contactid: guid(1),
          _customerid_value: guid(2),
          '_customerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'contact'
        }
      ],
      '@Microsoft.Dynamics.CRM.morerecords': false
    });
    const result = await executeDataversePrimitive({
      action: 'bulk_page',
      origin,
      query: { table: 'contact', columns: ['customerid'] }
    });
    expect(result.bulkPage?.records[0]).toMatchObject({
      values: { customerid: guid(2) },
      lookupTypes: { customerid: 'contact' }
    });
  });
  it('requires optimistic concurrency for updates but can reconcile create IDs without it', async () => {
    setup({ value: [{ contactid: guid(1), firstname: 'A' }] }, false);
    const input = {
      action: 'bulk_read_versions' as const,
      origin,
      table: 'contact',
      ids: [guid(1)],
      columns: ['firstname']
    };
    expect((await executeDataversePrimitive(input)).ok).toBe(false);
    expect((await executeDataversePrimitive({ ...input, requireConcurrency: false })).ok).toBe(
      true
    );
  });
  it('reads 1000 versions using one read-only batch when the ID URL exceeds 32 KiB', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => guid(index + 1));
    const rows = ids.map((contactid) => ({ contactid, firstname: 'Old', '@odata.etag': 'W/"1"' }));
    const base = setup();
    const mock = vi.fn(async (raw: string, init?: RequestInit) => {
      if (!raw.endsWith('/$batch')) return base(raw);
      expect(init?.method).toBe('POST');
      const body = String(init?.body);
      expect(body).not.toMatch(/(?:PATCH|POST|DELETE) /);
      const target = /GET (.+) HTTP\/1.1/.exec(body)![1]!;
      expect(target.length).toBeGreaterThan(32768);
      expect(target.length).toBeLessThan(65536);
      const filter = new URL(target).searchParams.get('$filter')!;
      expect(filter).toContain('Microsoft.Dynamics.CRM.In(');
      expect(filter.match(/[a-f0-9-]{36}/g)).toHaveLength(1000);
      return new Response(
        `--response\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ value: rows })}\r\n--response--\r\n`,
        { headers: { 'Content-Type': 'multipart/mixed; boundary="response"' } }
      );
    });
    vi.stubGlobal('fetch', mock);
    const serialized = new Function(
      `return (${executeDataversePrimitive.toString()})`
    )() as typeof executeDataversePrimitive;
    const result = await serialized({
      action: 'bulk_read_versions',
      origin,
      table: 'contact',
      ids,
      columns: ['firstname']
    });
    expect(result.ok).toBe(true);
    expect(result.bulkPage?.records).toHaveLength(1000);
    expect(result.bulkPage?.records[999]).toMatchObject({
      id: guid(1000),
      etag: 'W/"1"',
      values: { firstname: 'Old' }
    });
    expect(mock.mock.calls.filter(([url]) => url.endsWith('/$batch'))).toHaveLength(1);
  });

  it.each([
    { status: 429, payload: { value: [] } },
    { status: 200, payload: { value: [], '@odata.nextLink': 'next' } },
    { status: 200, payload: {} }
  ])(
    'rejects failed or incomplete version reads inside a batch (%j)',
    async ({ status, payload }) => {
      const base = setup();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (raw: string) => {
          if (!raw.endsWith('/$batch')) return base(raw);
          return new Response(
            `--response\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--response--\r\n`,
            { headers: { 'Content-Type': 'multipart/mixed; boundary=response' } }
          );
        })
      );
      const result = await executeDataversePrimitive({
        action: 'bulk_read_versions',
        origin,
        table: 'contact',
        ids: Array.from({ length: 1000 }, (_, index) => guid(index + 1)),
        columns: ['firstname']
      });
      expect(result.ok).toBe(false);
      expect(result.bulkPage).toBeUndefined();
    }
  );

  it.each([0, 1001])('rejects %s version IDs before fetching metadata', async (length) => {
    const mock = setup();
    const result = await executeDataversePrimitive({
      action: 'bulk_read_versions',
      origin,
      table: 'contact',
      ids: Array.from({ length }, (_, index) => guid(index + 1)),
      columns: ['firstname']
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1000');
    expect(mock).not.toHaveBeenCalled();
  });

  it('revalidates page origin and survives function serialization', async () => {
    const mock = setup();
    const serialized = new Function(
      `return (${executeDataversePrimitive.toString()})`
    )() as typeof executeDataversePrimitive;
    expect((await serialized({ action: 'bulk_identity', origin })).userId).toBe(guid(9000));
    mock.mockClear();
    expect(
      (await serialized({ action: 'bulk_identity', origin: 'https://other.crm.dynamics.com' })).ok
    ).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });
});
