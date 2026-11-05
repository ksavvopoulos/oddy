// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';
import { DATAVERSE_TOOLS } from '../lib/assistant/tool-catalog';
import { activityForTool } from '../lib/assistant/activity';

const origin = 'https://contoso.crm.dynamics.com';
const viewId = '00000000-0000-0000-0000-000000000099';
const metadata = {
  LogicalName: 'contact',
  EntitySetName: 'contacts',
  PrimaryIdAttribute: 'contactid',
  PrimaryNameAttribute: 'fullname',
  ObjectTypeCode: 2
};
const xml =
  '<fetch><entity name="contact"><attribute name="contactid"/><attribute name="fullname"/><order attribute="contactid"/></entity></fetch>';
const complex = `<fetch distinct="true"><entity name="contact"><attribute name="fullname" alias="person"/>
  <filter type="and"><condition attribute="statecode" operator="eq" value="0"/>
    <filter type="or"><condition attribute="contactid" operator="in"><value>00000000-0000-0000-0000-000000000001</value><value>00000000-0000-0000-0000-000000000002</value></condition><condition attribute="fullname" operator="eq" value="A &amp; B"/></filter>
  </filter><link-entity name="account" from="accountid" to="parentcustomerid" alias="company" link-type="outer"><attribute name="name"/></link-entity><order attribute="fullname"/></entity></fetch>`;
const layout =
  '<grid name="resultset" object="2" jump="fullname" select="1" icon="1"><row name="result" id="contactid"><cell name="fullname" width="270"/><cell name="company.name" width="180"/></row></grid>';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(
  options: {
    pages?: Record<string, unknown>[];
    existing?: boolean;
    saveStatus?: number;
    batch?: Response;
  } = {}
) {
  vi.stubGlobal('window', { location: { origin } });
  let page = 0;
  const mock = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.pathname.includes('EntityDefinitions(')) return json(metadata);
    if (url.pathname.endsWith('/contacts'))
      return json(
        options.pages?.[page++] ?? { value: [], '@Microsoft.Dynamics.CRM.morerecords': false }
      );
    if (url.pathname.endsWith('/$batch') && options.batch) return options.batch;
    if (url.pathname.endsWith('/userqueries') && !init?.method)
      return json({
        value: options.existing
          ? [
              {
                userqueryid: viewId,
                name: 'AI Result',
                returnedtypecode: 'contact',
                fetchxml: complex,
                layoutxml: layout,
                '@odata.etag': 'W/"12"'
              }
            ]
          : []
      });
    if (url.pathname.includes('/userqueries') && init?.method) {
      if (options.saveStatus) return new Response('Conflict', { status: options.saveStatus });
      return init.method === 'POST'
        ? json({ userqueryid: viewId }, 201)
        : new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL ${raw}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
const query = (fetchXml = xml, pageSize?: number) =>
  executeDataversePrimitive({ action: 'query_records', origin, fetchXml, pageSize });
const dataCall = (mock: ReturnType<typeof setup>, index = 0) =>
  mock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/contacts'))[index]!;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native FetchXML record reads', () => {
  it('sends IN, nested OR and joins intact in one data read without an extra count query', async () => {
    const mock = setup({
      pages: [
        {
          value: [{ person: 'A', 'company.name': 'B' }],
          '@Microsoft.Dynamics.CRM.morerecords': false
        }
      ]
    });
    const result = await query(complex);
    expect(result.ok).toBe(true);
    const sent = new URL(dataCall(mock)[0]).searchParams.get('fetchXml')!;
    const document = new DOMParser().parseFromString(sent, 'application/xml');
    expect(
      document.querySelector('filter[type="or"] condition[operator="in"]')?.children
    ).toHaveLength(2);
    expect(document.querySelector('link-entity')?.getAttribute('alias')).toBe('company');
    expect(sent).toContain('A &amp; B');
    expect(result.records).toEqual([{ person: 'A', 'company.name': 'B' }]);
    expect(result.totalCount).toBeUndefined();
    expect(result.recordPage).toMatchObject({
      completeness: 'complete',
      hasMore: false,
      returned: 1
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(dataCall(mock)[1]).toMatchObject({ credentials: 'include', redirect: 'error' });
    expect(activityForTool('query_dataverse_records', result).summary).toBe(
      '1 rows returned · complete'
    );
  });

  it('preserves aggregate and aliased fields, formatted values and long strings without inventing identity', async () => {
    setup({
      pages: [
        {
          value: [
            {
              total: 12,
              category: 'x'.repeat(2501),
              'total@OData.Community.Display.V1.FormattedValue': '12 contacts'
            }
          ],
          '@Microsoft.Dynamics.CRM.morerecords': false
        }
      ]
    });
    const result = await query(
      '<fetch aggregate="true"><entity name="contact"><attribute name="contactid" alias="total" aggregate="count"/><attribute name="statecode" alias="category" groupby="true"/></entity></fetch>'
    );
    expect(result.ok).toBe(true);
    expect(result.records).toEqual([
      { total: { value: 12, formattedValue: '12 contacts' }, category: 'x'.repeat(2501) }
    ]);
    expect(result.records?.[0]).not.toHaveProperty('contactid');
  });

  it('continues a server cookie while retaining the native query and page size', async () => {
    const cookie = '<cookie page="1"><contactid last="abc" first="a" /></cookie>';
    const wrapper = `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(cookie))}" />`;
    const mock = setup({
      pages: [
        {
          value: [{ contactid: 'a' }],
          '@Microsoft.Dynamics.CRM.morerecords': true,
          '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': wrapper
        },
        { value: [{ contactid: 'b' }], '@Microsoft.Dynamics.CRM.morerecords': false }
      ]
    });
    const first = await query(xml, 1);
    expect(first.recordPage).toMatchObject({
      page: 1,
      hasMore: true,
      completeness: 'more-pages',
      pagingMode: 'cookie'
    });
    const next = await executeDataversePrimitive({
      action: 'query_records',
      origin,
      cursor: first.recordPage?.nextCursor
    });
    expect(next.ok).toBe(true);
    expect(next.recordPage).toMatchObject({ page: 2, returned: 1, hasMore: false });
    const sent = new DOMParser().parseFromString(
      new URL(dataCall(mock, 1)[0]).searchParams.get('fetchXml')!,
      'application/xml'
    ).documentElement;
    expect(sent.getAttribute('paging-cookie')).toBe(cookie);
    expect(sent.getAttribute('page')).toBe('2');
    expect(sent.getAttribute('count')).toBe('1');
  });

  it('supports simple paging when joined queries return no cookie', async () => {
    const mock = setup({
      pages: [
        { value: [{ person: 'a' }], '@Microsoft.Dynamics.CRM.morerecords': true },
        { value: [{ person: 'b' }], '@Microsoft.Dynamics.CRM.morerecords': false }
      ]
    });
    const first = await query(complex, 1);
    expect(first.warnings?.join(' ')).toContain('simple paging');
    const next = await executeDataversePrimitive({
      action: 'query_records',
      origin,
      cursor: first.recordPage?.nextCursor
    });
    expect(next.ok).toBe(true);
    expect(new URL(dataCall(mock, 1)[0]).searchParams.get('fetchXml')).toContain('page="2"');
  });

  it('stops at the simple-paging limit and reports incomplete results', async () => {
    setup({
      pages: [{ value: [{ contactid: 'a' }], '@Microsoft.Dynamics.CRM.morerecords': true }]
    });
    const cursor = JSON.stringify({
      version: 1,
      origin,
      action: 'query_records',
      fetchXml: xml,
      pageSize: 100,
      page: 500
    });
    const result = await executeDataversePrimitive({ action: 'query_records', origin, cursor });
    expect(result.ok).toBe(true);
    expect(result.recordPage).toMatchObject({ hasMore: true, completeness: 'incomplete' });
    expect(result.recordPage?.nextCursor).toBeUndefined();
  });

  it.each(['', '<cookie pagenumber="2" pagingcookie="" />'])(
    'treats an empty server cookie as simple paging (%s)',
    async (cookie) => {
      setup({
        pages: [
          {
            value: [{ contactid: 'a' }],
            '@Microsoft.Dynamics.CRM.morerecords': true,
            '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': cookie
          }
        ]
      });
      const result = await query(xml, 1);
      expect(result.ok).toBe(true);
      expect(result.recordPage).toMatchObject({ pagingMode: 'simple', hasMore: true });
      expect(result.recordPage?.nextCursor).toBeDefined();
    }
  );

  it('refuses simple-paging cursors whose page would exceed the server ceiling', async () => {
    const mock = setup();
    const cursor = JSON.stringify({
      version: 1,
      origin,
      action: 'query_records',
      fetchXml: xml,
      pageSize: 3,
      page: 16667
    });
    const result = await executeDataversePrimitive({ action: 'query_records', origin, cursor });
    expect(result.error).toContain('simple-paging limit');
    expect(mock).not.toHaveBeenCalled();
  });

  it('marks top results as limited instead of claiming exhaustive matches', async () => {
    const mock = setup({ pages: [{ value: [{ contactid: 'a' }] }] });
    const result = await query(xml.replace('<fetch>', '<fetch top="1">'));
    expect(result.recordPage).toMatchObject({ completeness: 'top-limited', hasMore: false });
    expect(result.totalCount).toBeUndefined();
    expect(new URL(dataCall(mock)[0]).searchParams.get('fetchXml')).not.toContain('count=');
  });

  it('honors explicit count requests without a second query and discloses capped counts', async () => {
    const mock = setup({
      pages: [
        {
          value: [],
          '@Microsoft.Dynamics.CRM.morerecords': false,
          '@Microsoft.Dynamics.CRM.totalrecordcount': 5000,
          '@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded': true
        }
      ]
    });
    const result = await query(xml.replace('<fetch>', '<fetch returntotalrecordcount="true">'));
    expect(result.totalCount).toBe(5000);
    expect(result.warnings?.join(' ')).toContain('not an exact total');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each([
    '',
    '<fetch>',
    '<account/>',
    '<fetch><entity name="contact"/><entity name="account"/></fetch>',
    '<fetch><entity name="https://evil.example"/></fetch>',
    '<!DOCTYPE fetch [<!ENTITY x SYSTEM "https://evil.example">]><fetch><entity name="contact"/></fetch>',
    xml.replace('<fetch>', '<fetch page="2">'),
    xml.replace('<fetch>', '<fetch paging-cookie="x">'),
    xml.replace('<fetch>', '<fetch top="101">'),
    xml.replace('<fetch>', '<fetch top="1" count="1">')
  ])('rejects invalid XML or unmanaged paging before reading records (%#)', async (input) => {
    const mock = setup();
    const result = await query(input);
    expect(result.ok).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5, -1])(
    'rejects invalid page size %s without silently clamping',
    async (pageSize) => {
      const mock = setup();
      expect((await query(xml, pageSize)).ok).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    }
  );

  it('rejects changed environments and changed cursor arguments before any network access', async () => {
    const mock = setup();
    vi.stubGlobal('window', { location: { origin: 'https://other.crm.dynamics.com' } });
    expect((await query()).ok).toBe(false);
    expect(mock).not.toHaveBeenCalled();
    vi.stubGlobal('window', { location: { origin } });
    const cursor = JSON.stringify({
      version: 1,
      origin: 'https://other.crm.dynamics.com',
      action: 'query_records',
      fetchXml: xml,
      pageSize: 50,
      page: 2
    });
    expect((await executeDataversePrimitive({ action: 'query_records', origin, cursor })).ok).toBe(
      false
    );
    expect(
      (await executeDataversePrimitive({ action: 'query_records', origin, cursor, fetchXml: xml }))
        .ok
    ).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects cursor action changes and malformed cursor contents', async () => {
    const mock = setup();
    for (const cursor of [
      'not-json',
      'null',
      JSON.stringify({
        version: 1,
        origin,
        action: 'execute_view',
        fetchXml: xml,
        pageSize: 50,
        page: 2
      })
    ]) {
      expect(
        (await executeDataversePrimitive({ action: 'query_records', origin, cursor })).ok
      ).toBe(false);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects oversized or malformed server pages and a repeated cookie', async () => {
    setup({ pages: [{ value: [{}, {}] }] });
    expect((await query(xml, 1)).ok).toBe(false);
    setup({ pages: [{ value: [null] }] });
    expect((await query()).ok).toBe(false);
    setup({
      pages: [
        {
          value: [{ a: 1 }],
          '@Microsoft.Dynamics.CRM.morerecords': true,
          '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': '<cookie page="1" />'
        }
      ]
    });
    const cursor = JSON.stringify({
      version: 1,
      origin,
      action: 'query_records',
      fetchXml: xml,
      pageSize: 1,
      page: 2,
      cookie: '<cookie page="1" />'
    });
    const result = await executeDataversePrimitive({ action: 'query_records', origin, cursor });
    expect(result.error).toContain('no progress');
  });

  it('reports empty pages with more-records as incomplete, not exhaustive absence', async () => {
    setup({ pages: [{ value: [], '@Microsoft.Dynamics.CRM.morerecords': true }] });
    const result = await query();
    expect(result.recordPage).toMatchObject({ hasMore: true, completeness: 'incomplete' });
    expect(result.recordPage?.nextCursor).toBeUndefined();
  });

  it('fails safely on an oversized response instead of returning truncated data', async () => {
    setup({ pages: [{ value: [{ fullname: 'x'.repeat(1024 * 1024) }] }] });
    const result = await query();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exceeds 1 MiB');
    expect(result.records).toBeUndefined();
  });

  it('aborts a stalled data request after the native request deadline', async () => {
    vi.useFakeTimers();
    const mock = setup();
    mock.mockImplementation(async (raw, init) => {
      if (new URL(raw).pathname.includes('EntityDefinitions(')) return json(metadata);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
      });
    });
    const pending = query();
    await vi.advanceTimersByTimeAsync(30001);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('refuses an HTTP error or conflicting continuation signals without retrying', async () => {
    const mock = setup();
    mock.mockImplementation(async (raw) =>
      new URL(raw).pathname.includes('EntityDefinitions(')
        ? json(metadata)
        : new Response('Throttled', { status: 429 })
    );
    expect((await query()).error).toContain('429');
    expect(mock).toHaveBeenCalledTimes(2);
    setup({
      pages: [
        {
          value: [],
          '@Microsoft.Dynamics.CRM.morerecords': false,
          '@odata.nextLink': 'https://evil.example/'
        }
      ]
    });
    expect((await query()).error).toContain('conflicting continuation');
  });

  it('uses one constructed read-only batch GET for long URLs', async () => {
    const body =
      '--reply\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"value":[]}\r\n--reply--\r\n';
    const mock = setup({
      batch: new Response(body, { headers: { 'Content-Type': 'multipart/mixed; boundary=reply' } })
    });
    const result = await query(
      `<fetch><entity name="contact"><attribute name="contactid"/><filter><condition attribute="fullname" operator="eq" value="${'a'.repeat(31000)}"/></filter></entity></fetch>`
    );
    expect(result.ok).toBe(true);
    const call = mock.mock.calls.find(([url]) => url.endsWith('/$batch'))!;
    expect(call[1]?.method).toBe('POST');
    expect(String(call[1]?.body)).toContain(
      'GET https://contoso.crm.dynamics.com/api/data/v9.2/contacts?fetchXml='
    );
    expect(String(call[1]?.body)).not.toContain('changeset');
    expect(String(call[1]?.body)).not.toContain('PATCH');
  });

  it('runs after MAIN-world serialization with no module closures', async () => {
    setup({
      pages: [{ value: [{ contactid: 'a' }], '@Microsoft.Dynamics.CRM.morerecords': false }]
    });
    const injected = new Function(
      `return (${executeDataversePrimitive.toString()});`
    )() as typeof executeDataversePrimitive;
    const result = await injected({ action: 'query_records', origin, fetchXml: complex });
    expect(result.ok).toBe(true);
  });
});

describe('native AI Result views', () => {
  it('returns complete definitions and ETag without a lossy structured projection', async () => {
    const mock = setup({ existing: true });
    const result = await executeDataversePrimitive({
      action: 'get_view',
      origin,
      table: 'contact'
    });
    expect(result.ok).toBe(true);
    expect(result.fetchXml).toBe(complex);
    expect(result.layoutXml).toBe(layout);
    expect(result.view?.etag).toBe('W/"12"');
    expect(result.query).toBeUndefined();
    expect(result.view?.query).toBeUndefined();
    const call = mock.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/userqueries'))!;
    expect(new URL(call[0]).searchParams.get('$filter')).toContain("returnedtypecode eq 'contact'");
  });

  it('saves exact XML bytes with an exact If-Match and no unrelated description overwrite', async () => {
    const mock = setup({ existing: true });
    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin,
      table: 'contact',
      fetchXml: complex,
      layoutXml: layout,
      etag: 'W/"12"'
    });
    expect(result.ok).toBe(true);
    const call = mock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(call[0]).toBe(`${origin}/api/data/v9.2/userqueries(${viewId})`);
    expect(call[1]?.headers).toMatchObject({ 'If-Match': 'W/"12"' });
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      name: 'AI Result',
      querytype: 0,
      returnedtypecode: 'contact',
      fetchxml: complex,
      layoutxml: layout
    });
  });

  it('creates only AI Result using complete native definitions', async () => {
    const mock = setup();
    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin,
      table: 'contact',
      fetchXml: complex,
      layoutXml: layout
    });
    expect(result.view).toMatchObject({ id: viewId, created: true, name: 'AI Result' });
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([undefined, '*', 'W/"11"'])(
    'refuses stale or missing ETag %s without writing',
    async (etag) => {
      const mock = setup({ existing: true });
      const result = await executeDataversePrimitive({
        action: 'upsert_view',
        origin,
        table: 'contact',
        fetchXml: complex,
        layoutXml: layout,
        etag
      });
      expect(result.ok).toBe(false);
      expect(mock.mock.calls.some(([, init]) => init?.method)).toBe(false);
    }
  );

  it('does not recreate a deleted view or retry a conflicting update', async () => {
    const mock = setup();
    expect(
      (
        await executeDataversePrimitive({
          action: 'upsert_view',
          origin,
          table: 'contact',
          fetchXml: complex,
          layoutXml: layout,
          etag: 'W/"12"'
        })
      ).ok
    ).toBe(false);
    expect(mock.mock.calls.some(([, init]) => init?.method)).toBe(false);
    const conflict = setup({ existing: true, saveStatus: 412 });
    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin,
      table: 'contact',
      fetchXml: complex,
      layoutXml: layout,
      etag: 'W/"12"'
    });
    expect(result.error).toContain('412');
    expect(conflict.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('reports an uncertain view-save outcome without retrying after a communication failure', async () => {
    const mock = setup();
    mock.mockImplementation(async (raw, init) => {
      if (new URL(raw).pathname.includes('EntityDefinitions(')) return json(metadata);
      if (init?.method === 'POST') throw new Error('Connection lost');
      return json({ value: [] });
    });
    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin,
      table: 'contact',
      fetchXml: complex,
      layoutXml: layout
    });
    expect(result.error).toContain('outcome is unconfirmed');
    expect(result.error).toContain('inspect it before retrying');
    expect(mock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects mismatched root tables and malformed layouts before network calls', async () => {
    const mock = setup();
    expect(
      (
        await executeDataversePrimitive({
          action: 'upsert_view',
          origin,
          table: 'account',
          fetchXml: complex,
          layoutXml: layout
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await executeDataversePrimitive({
          action: 'upsert_view',
          origin,
          table: 'contact',
          fetchXml: complex,
          layoutXml: '<html/>'
        })
      ).ok
    ).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('executes joined views intact and continues the frozen definition without re-reading the view', async () => {
    const mock = setup({
      existing: true,
      pages: [
        {
          value: [{ person: 'A', 'company.name': 'B' }],
          '@Microsoft.Dynamics.CRM.morerecords': true
        },
        { value: [], '@Microsoft.Dynamics.CRM.morerecords': false }
      ]
    });
    const first = await executeDataversePrimitive({
      action: 'execute_view',
      origin,
      table: 'contact',
      pageSize: 1
    });
    expect(first.ok).toBe(true);
    expect(first.records?.[0]?.['company.name']).toBe('B');
    expect(new URL(dataCall(mock)[0]).searchParams.get('fetchXml')).toContain('type="or"');
    const next = await executeDataversePrimitive({
      action: 'execute_view',
      origin,
      cursor: first.recordPage?.nextCursor
    });
    expect(next.ok).toBe(true);
    expect(next.view?.id).toBe(viewId);
    expect(
      mock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/userqueries'))
    ).toHaveLength(1);
  });
});

describe('native model tool schemas', () => {
  it('advertises native inputs, bounded pages and no raw HTTP authority', () => {
    const find = (name: string) =>
      DATAVERSE_TOOLS.find((tool) => tool.function.name === name)!.function;
    const queryProperties = find('query_dataverse_records').parameters.properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(queryProperties)).toEqual(['fetchXml', 'pageSize', 'cursor']);
    const viewProperties = find('manage_dataverse_view').parameters.properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(viewProperties)).toEqual([
      'action',
      'table',
      'fetchXml',
      'layoutXml',
      'etag'
    ]);
    expect(find('query_dataverse_records').description).toContain('Prefer one IN query');
    expect(find('manage_dataverse_view').description).toContain('AI Result only');
  });
});
