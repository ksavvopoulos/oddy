// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';
import { bulkOrigin as origin, guid } from './fixtures/bulk';

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
    const inner = `<cookie page="1"><contactid last="${guid(500)}" /></cookie>`;
    const mock = setup({
      value: Array.from({ length: 500 }, (_, index) => ({ contactid: guid(index + 1) })),
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
    expect(document.documentElement.getAttribute('count')).toBe('500');
    expect(document.querySelector('order')?.getAttribute('attribute')).toBe('contactid');
    expect(xml).not.toContain('top=');
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
