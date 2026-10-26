import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeBulkTransport } from '../lib/bulk/transport';
import type { BulkTransportRequest } from '../lib/bulk/contracts';
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
  });
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
    expect((await serialized(request())).outcomes.every((row) => row.status === 'succeeded')).toBe(
      true
    );
  });
});
