import type { BulkChunkOutcome, BulkChunkResult, BulkTransportRequest } from './contracts';

/** MAIN-world transport. All helpers are nested because Chrome serializes this function. */
export async function executeBulkTransport(
  request: BulkTransportRequest
): Promise<BulkChunkResult> {
  let submitted = false;
  const fail = (error: string, uncertain = false): BulkChunkResult => ({
    error,
    outcomes: request.rows.map((row) => ({
      recordId: row.recordId,
      status: uncertain ? 'uncertain' : 'failed',
      error
    }))
  });
  const guid = (value: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
  const identifier = (value: string) => /^[a-z_][a-z0-9_]*$/i.test(value);
  const http = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const retrySeconds = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const number = Number(value);
    const seconds = Number.isFinite(number)
      ? number
      : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
  };
  try {
    if (window.location.origin !== request.origin)
      throw new Error('The Dataverse environment changed before execution.');
    if (
      !identifier(request.entitySetName) ||
      !identifier(request.primaryIdAttribute) ||
      !guid(request.userId)
    )
      throw new Error('Invalid approved bulk target.');
    if (
      !['create', 'update'].includes(request.operation) ||
      !request.rows.length ||
      request.rows.length > 50 ||
      new Set(request.rows.map((row) => row.recordId)).size !== request.rows.length
    )
      throw new Error('Invalid bulk chunk.');
    for (const row of request.rows) {
      if (!guid(row.recordId)) throw new Error('Invalid approved record ID.');
      if (request.operation === 'update' && (!row.etag || !/^W\/"[^"\r\n]+"$/.test(row.etag)))
        throw new Error('A captured record version is required for every bulk update.');
      if (Object.hasOwn(row.payload, request.primaryIdAttribute))
        throw new Error('Primary IDs cannot be edited.');
      if (!Object.keys(row.payload).length || Object.keys(row.payload).length > 20)
        throw new Error('Invalid approved field selection.');
      for (const [key, value] of Object.entries(row.payload)) {
        if (!/^[a-z_][a-z0-9_]*(?:@odata\.bind)?$/i.test(key))
          throw new Error('Invalid approved field name.');
        if (key.endsWith('@odata.bind')) {
          if (typeof value !== 'string' || !/^\/[a-z_][a-z0-9_]*\([a-f0-9-]{36}\)$/i.test(value))
            throw new Error('Invalid approved lookup binding.');
        } else if (
          (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          throw new Error('Bulk payloads must contain validated finite scalar values.');
      }
    }
    const headers = {
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    };
    const identityResponse = await http(`${request.origin}/api/data/v9.2/WhoAmI`, {
      credentials: 'include',
      headers
    });
    if (!identityResponse.ok)
      throw new Error(`Could not revalidate the execution identity (${identityResponse.status}).`);
    const identity = (await identityResponse.json()) as { UserId?: string };
    if (identity.UserId?.replace(/[{}]/g, '').toLowerCase() !== request.userId.toLowerCase())
      throw new Error('The signed-in Dataverse user changed; prepare a fresh preview.');

    const boundary = `batch_${crypto.randomUUID().replace(/-/g, '')}`;
    const parts = request.rows.map((row, index) => {
      // Separate change sets allow precise per-row outcomes; the whole job is not a transaction.
      const change = `changeset_${index}_${crypto.randomUUID().replace(/-/g, '')}`;
      const path = `${request.origin}/api/data/v9.2/${request.entitySetName}${request.operation === 'update' ? `(${row.recordId})` : ''}`;
      const payload =
        request.operation === 'create'
          ? { ...row.payload, [request.primaryIdAttribute]: row.recordId }
          : row.payload;
      return (
        `--${boundary}\r\nContent-Type: multipart/mixed; boundary=${change}\r\n\r\n` +
        `--${change}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: ${index + 1}\r\n\r\n` +
        `${request.operation === 'update' ? 'PATCH' : 'POST'} ${path} HTTP/1.1\r\nContent-Type: application/json; charset=utf-8\r\n` +
        `${request.operation === 'update' ? `If-Match: ${row.etag}\r\n` : ''}` +
        `Accept: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${change}--\r\n`
      );
    });
    submitted = true;
    const response = await http(`${request.origin}/api/data/v9.2/$batch`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...headers,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
        Prefer: 'odata.continue-on-error'
      },
      body: `${parts.join('')}--${boundary}--\r\n`
    });
    if (!response.ok) {
      const result = fail(
        `Bulk request returned HTTP ${response.status}. Reconcile before any retry.`,
        ![401, 403, 429].includes(response.status)
      );
      result.retryAfterSeconds = retrySeconds(response.headers.get('Retry-After'));
      return result;
    }
    const body = await response.text();
    const boundaryOf = (contentType: string) =>
      /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
    const outerBoundary = boundaryOf(response.headers.get('Content-Type') || '');
    if (!outerBoundary)
      return fail('Missing multipart response boundary; outcome is uncertain.', true);
    const results = new Map<number, BulkChunkOutcome>();
    let retryAfterSeconds: number | undefined;
    const parse = (text: string, delimiter: string, depth = 0) => {
      if (depth > 3) throw new Error('Unexpected multipart nesting.');
      for (const raw of text.split(`--${delimiter}`).slice(1)) {
        if (raw.startsWith('--')) break;
        const part = raw.replace(/^\r?\n/, '');
        const separator = /\r?\n\r?\n/.exec(part);
        if (!separator || separator.index === undefined) continue;
        const partHeaders = part.slice(0, separator.index);
        const content = part.slice(separator.index + separator[0].length);
        const nested = boundaryOf(partHeaders);
        if (/Content-Type:\s*multipart\/mixed/i.test(partHeaders) && nested) {
          parse(content, nested, depth + 1);
          continue;
        }
        const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(content);
        const id = /(?:^|\r?\n)Content-ID:\s*(\d+)\s*(?:\r?\n|$)/i.exec(partHeaders);
        if (!status || !id) continue;
        const index = Number(id[1]) - 1;
        const row = request.rows[index];
        if (!row) continue;
        if (results.has(index)) {
          results.set(index, {
            recordId: row.recordId,
            status: 'uncertain',
            error: 'Duplicate response Content-ID.'
          });
          continue;
        }
        const code = Number(status[1]);
        const completed = (request.operation === 'create' ? [200, 201, 204] : [200, 204]).includes(
          code
        );
        let state: BulkChunkOutcome['status'] = completed
          ? 'succeeded'
          : code === 412
            ? 'conflict'
            : code >= 500 || code === 408 || (code >= 200 && code < 300)
              ? 'uncertain'
              : 'failed';
        const returnedIdHeader = /(?:^|\r?\n)OData-EntityId:\s*([^\r\n]+)/i.exec(content)?.[1];
        if (
          request.operation === 'create' &&
          completed &&
          returnedIdHeader &&
          returnedIdHeader.match(/\(([a-f0-9-]{36})\)/i)?.[1]?.toLowerCase() !==
            row.recordId.toLowerCase()
        )
          state = 'uncertain';
        const detail = state === 'succeeded' ? undefined : `HTTP ${code}: ${content.slice(0, 500)}`;
        results.set(index, { recordId: row.recordId, status: state, error: detail });
        const retry = retrySeconds(
          /(?:^|\r?\n)Retry-After:\s*([^\r\n]+)/i.exec(content)?.[1] || null
        );
        if (retry !== undefined) retryAfterSeconds = Math.max(retryAfterSeconds || 0, retry);
      }
    };
    parse(body, outerBoundary);
    return {
      outcomes: request.rows.map(
        (row, index) =>
          results.get(index) || {
            recordId: row.recordId,
            status: 'uncertain',
            error: 'No unambiguous result was returned; do not replay this operation.'
          }
      ),
      retryAfterSeconds
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), submitted);
  }
}
