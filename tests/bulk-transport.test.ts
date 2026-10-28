import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeBulkTransport } from '../lib/bulk/transport';
import type { BulkExecutionOptions, BulkTransportRequest } from '../lib/bulk/contracts';
import { bulkOrigin as origin, guid } from './fixtures/bulk';

const request = (operation: 'create' | 'update' = 'update'): BulkTransportRequest => ({
  origin,
  userId: guid(9000),
  operation,
  entitySetName: 'contacts',
  primaryIdAttribute: 'contactid',
  rows: [1, 2, 3].map((id) => ({
    recordId: guid(id),
    etag: 'W/"1"',
    payload: { firstname: `Name ${id}` }
  }))
});
function multipart(entries: Array<{ id?: number; code: number; retry?: string }>) {
  const parts = entries.map(
    (entry, index) =>
      `--outer\r\nContent-Type: multipart/mixed; boundary=inner_${index}\r\n\r\n--inner_${index}\r\nContent-Type: application/http\r\n${entry.id ? `Content-ID: ${entry.id}\r\n` : ''}\r\nHTTP/1.1 ${entry.code} Result\r\n${entry.retry ? `Retry-After: ${entry.retry}\r\n` : ''}\r\n\r\n--inner_${index}--\r\n`
  );
  return new Response(`${parts.join('')}--outer--\r\n`, {
    status: 200,
    headers: { 'Content-Type': 'multipart/mixed; boundary="outer"' }
  });
}
function setup(response: Response | Error, userId = guid(9000)) {
  vi.stubGlobal('window', { location: { origin } });
  const mock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ UserId: userId }), { status: 200 }));
  if (response instanceof Error) mock.mockRejectedValueOnce(response);
  else mock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe('bulk Web API batch transport', () => {
  it('submits conditional sparse PATCH requests in separate change sets', async () => {
    const mock = setup(multipart([1, 2, 3].map((id) => ({ id, code: 204 }))));
    const result = await executeBulkTransport(request());
    expect(result.outcomes.map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded'
    ]);
    const init = mock.mock.calls[1]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Prefer: 'odata.continue-on-error' });
    expect(String(init.body)).toContain(
      `PATCH ${origin}/api/data/v9.2/contacts(${guid(1)}) HTTP/1.1\r\n`
    );
    expect(String(init.body).match(/If-Match: W\/"1"/g)).toHaveLength(3);
    expect(String(init.body)).not.toContain('If-Match: *');
    expect(String(init.body)).not.toContain('MSCRM.');
  });
  it.each(
    (['update', 'create'] as const).flatMap((operation) =>
      [
        {},
        { bypassCustomLogic: true },
        { bypassPowerAutomate: true },
        { bypassCustomLogic: true, bypassPowerAutomate: true }
      ].map((executionOptions) => ({ operation, executionOptions }))
    )
  )(
    'applies only selected bypass headers to each inner $operation: $executionOptions',
    async ({ operation, executionOptions }) => {
      const mock = setup(
        multipart([1, 2, 3].map((id) => ({ id, code: operation === 'create' ? 201 : 204 })))
      );
      const result = await executeBulkTransport({ ...request(operation), executionOptions });
      expect(result.outcomes.every((row) => row.status === 'succeeded')).toBe(true);
      const body = String(mock.mock.calls[1]![1].body);
      const innerHeaders = [
        ...body.matchAll(/(?:PATCH|POST) [^\r\n]+ HTTP\/1\.1\r\n([\s\S]*?)\r\n\r\n/g)
      ];
      expect(innerHeaders).toHaveLength(3);
      for (const [, headers] of innerHeaders) {
        expect(
          headers!.includes('MSCRM.BypassBusinessLogicExecution: CustomSync,CustomAsync')
        ).toBe(executionOptions.bypassCustomLogic === true);
        expect(headers!.includes('MSCRM.SuppressCallbackRegistrationExpanderJob: true')).toBe(
          executionOptions.bypassPowerAutomate === true
        );
      }
      for (const [, init] of mock.mock.calls) {
        expect(init.headers).not.toHaveProperty('MSCRM.BypassBusinessLogicExecution');
        expect(init.headers).not.toHaveProperty('MSCRM.SuppressCallbackRegistrationExpanderJob');
      }
      expect(mock).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['outer', 'inner'])(
    'does not retry or remove bypass headers after an %s permission rejection',
    async (location) => {
      const mock = setup(
        location === 'outer'
          ? new Response('', { status: 403 })
          : multipart([1, 2, 3].map((id) => ({ id, code: 403 })))
      );
      const result = await executeBulkTransport({
        ...request(),
        executionOptions: { bypassCustomLogic: true, bypassPowerAutomate: true }
      });
      expect(result.outcomes.every((row) => row.status === 'failed')).toBe(true);
      expect(mock).toHaveBeenCalledTimes(2);
      const body = String(mock.mock.calls[1]![1].body);
      expect(body.match(/MSCRM.BypassBusinessLogicExecution:/g)).toHaveLength(3);
      expect(body.match(/MSCRM.SuppressCallbackRegistrationExpanderJob:/g)).toHaveLength(3);
    }
  );
  it('rejects malformed bypass options before any request', async () => {
    const mock = setup(multipart([]));
    for (const executionOptions of [
      null,
      [],
      { bypassCustomLogic: 'true' },
      { bypassPowerAutomate: 1 },
      { header: true }
    ]) {
      const result = await executeBulkTransport({
        ...request(),
        executionOptions: executionOptions as BulkExecutionOptions
      });
      expect(result.error).toContain('execution options');
      expect(result.outcomes.every((row) => row.status === 'failed')).toBe(true);
    }
    expect(mock).not.toHaveBeenCalled();
  });
  it.each(['update', 'create'] as const)(
    'submits 100 %s operations with per-row results',
    async (operation) => {
      const rows = Array.from({ length: 100 }, (_, index) => ({
        recordId: guid(index + 1),
        etag: 'W/"1"',
        payload: { firstname: `Name ${index + 1}` }
      }));
      const mock = setup(
        multipart(
          rows.map((_, index) => ({ id: index + 1, code: operation === 'create' ? 201 : 204 }))
        )
      );
      const result = await executeBulkTransport({
        ...request(operation),
        rows,
        executionOptions: { bypassCustomLogic: true, bypassPowerAutomate: true }
      });
      expect(result.outcomes).toHaveLength(100);
      expect(result.outcomes.every((row) => row.status === 'succeeded')).toBe(true);
      expect(result.outcomes.map((row) => row.recordId)).toEqual(rows.map((row) => row.recordId));
      const body = String(mock.mock.calls[1]![1].body);
      expect(body.match(/Content-ID: \d+/g)).toHaveLength(100);
      expect(body.match(/MSCRM.BypassBusinessLogicExecution:/g)).toHaveLength(100);
      expect(body.match(/MSCRM.SuppressCallbackRegistrationExpanderJob:/g)).toHaveLength(100);
      if (operation === 'update') expect(body.match(/If-Match: W\/"1"/g)).toHaveLength(100);
      else for (const row of rows) expect(body).toContain(`"contactid":"${row.recordId}"`);
      expect(mock).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['update', 'create'] as const)(
    'rejects more than 100 %s operations before any request',
    async (operation) => {
      const mock = setup(multipart([]));
      const rows = Array.from({ length: 101 }, (_, index) => ({
        recordId: guid(index + 1),
        etag: 'W/"1"',
        payload: { firstname: `Name ${index + 1}` }
      }));
      const result = await executeBulkTransport({ ...request(operation), rows });
      expect(result.error).toContain('Invalid bulk chunk');
      expect(result.outcomes).toHaveLength(101);
      expect(result.outcomes.every((row) => row.status === 'failed')).toBe(true);
      expect(mock).not.toHaveBeenCalled();
    }
  );
  it('includes reserved primary IDs for creates and never sends an upsert', async () => {
    const mock = setup(multipart([1, 2, 3].map((id) => ({ id, code: 201 }))));
    await executeBulkTransport(request('create'));
    const body = String(mock.mock.calls[1]![1].body);
    expect(body).toContain(`POST ${origin}/api/data/v9.2/contacts HTTP/1.1`);
    expect(body).toContain(`"contactid":"${guid(1)}"`);
    expect(body).not.toContain('PATCH');
  });
  it('maps out-of-order Content-IDs and distinguishes conflicts from uncertain failures', async () => {
    setup(
      multipart([
        { id: 2, code: 204 },
        { id: 1, code: 412 },
        { id: 3, code: 500 }
      ])
    );
    expect((await executeBulkTransport(request())).outcomes.map((row) => row.status)).toEqual([
      'conflict',
      'succeeded',
      'uncertain'
    ]);
  });
  it('does not report asynchronous acceptance or unexpected success codes as applied updates', async () => {
    setup(
      multipart([
        { id: 1, code: 202 },
        { id: 2, code: 207 },
        { id: 3, code: 201 }
      ])
    );
    expect(
      (await executeBulkTransport(request())).outcomes.every((row) => row.status === 'uncertain')
    ).toBe(true);
  });
  it('does not infer success from an outer 200 or missing/duplicate Content-IDs', async () => {
    setup(multipart([{ id: 1, code: 204 }, { id: 1, code: 204 }, { code: 204 }]));
    expect((await executeBulkTransport(request())).outcomes.map((row) => row.status)).toEqual([
      'uncertain',
      'uncertain',
      'uncertain'
    ]);
  });
  it('reports Retry-After and does not retry a throttled request', async () => {
    const mock = setup(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    const result = await executeBulkTransport(request());
    expect(result.retryAfterSeconds).toBe(30);
    expect(result.outcomes.every((row) => row.status === 'failed')).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('preserves successful rows alongside throttled subrequests', async () => {
    setup(
      multipart([
        { id: 1, code: 204 },
        { id: 2, code: 429, retry: '45' },
        { id: 3, code: 204 }
      ])
    );
    const result = await executeBulkTransport(request());
    expect(result.retryAfterSeconds).toBe(45);
    expect(result.outcomes.map((row) => row.status)).toEqual(['succeeded', 'failed', 'succeeded']);
  });
  it('marks lost responses uncertain without replaying requests', async () => {
    const mock = setup(new Error('connection lost'));
    expect(
      (await executeBulkTransport(request('create'))).outcomes.every(
        (row) => row.status === 'uncertain'
      )
    ).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('checks the signed-in identity immediately before any POST', async () => {
    const mock = setup(multipart([]), guid(9001));
    expect(
      (await executeBulkTransport(request())).outcomes.every((row) => row.status === 'failed')
    ).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed environment and malformed ETags before any request', async () => {
    const mock = setup(multipart([]));
    expect(
      (
        await executeBulkTransport({ ...request(), origin: 'https://other.crm.dynamics.com' })
      ).outcomes.every((row) => row.status === 'failed')
    ).toBe(true);
    const bad = request();
    bad.rows[0]!.etag = 'W/"1"\r\nInjected: yes';
    expect((await executeBulkTransport(bad)).outcomes.every((row) => row.status === 'failed')).toBe(
      true
    );
    expect(mock).not.toHaveBeenCalled();
  });
  it('runs after serialization without imported runtime helpers', async () => {
    setup(multipart([1, 2, 3].map((id) => ({ id, code: 204 }))));
    const serialized = new Function(
      `return (${executeBulkTransport.toString()})`
    )() as typeof executeBulkTransport;
    expect(
      (
        await serialized({
          ...request(),
          executionOptions: { bypassCustomLogic: true, bypassPowerAutomate: true }
        })
      ).outcomes.every((row) => row.status === 'succeeded')
    ).toBe(true);
    const body = String(vi.mocked(fetch).mock.calls[1]![1]!.body);
    expect(body.match(/MSCRM.BypassBusinessLogicExecution:/g)).toHaveLength(3);
    expect(body.match(/MSCRM.SuppressCallbackRegistrationExpanderJob:/g)).toHaveLength(3);
  });
});
