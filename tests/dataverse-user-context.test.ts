import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDataverseUserContext } from '../lib/dataverse-user-context';

const origin = 'https://contoso.crm.dynamics.com';
const userId = '00000000-0000-0000-0000-000000000123';
const utcNow = '2026-01-15T23:30:00.000Z';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function setup(
  options: {
    xrm?: boolean;
    offset?: number;
    settingsStatus?: number;
    conversionStatus?: number;
    definitionStatus?: number;
    localTime?: string;
    timeZoneCode?: number;
  } = {}
) {
  vi.stubGlobal('window', {
    location: { origin },
    ...(options.xrm === false
      ? {}
      : {
          Xrm: {
            Utility: {
              getGlobalContext: () => ({
                userSettings: {
                  userId: `{${userId}}`,
                  languageId: 1032,
                  dateFormattingInfo: { ShortDatePattern: 'dd/MM/yyyy' },
                  ...(options.offset === undefined
                    ? {}
                    : { getTimeZoneOffsetMinutes: () => options.offset })
                }
              })
            }
          }
        })
  });
  const fetchMock = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/WhoAmI')) return json({ UserId: userId });
    if (url.pathname.endsWith(`/usersettingscollection(${userId})`))
      return json(
        { timezonecode: options.timeZoneCode ?? 130, uilanguageid: 1032 },
        options.settingsStatus ?? 200
      );
    if (url.pathname.endsWith('/timezonedefinitions'))
      return json(
        {
          value: [
            {
              standardname: 'GTB Standard Time',
              userinterfacename: '(UTC+02:00) Athens, Bucharest'
            }
          ]
        },
        options.definitionStatus ?? 200
      );
    if (url.pathname.includes('/LocalTimeFromUtcTime('))
      return json(
        { LocalTime: options.localTime ?? '2026-01-16T01:30:00Z' },
        options.conversionStatus ?? 200
      );
    throw new Error(`Unexpected request: ${raw}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('signed-in Dataverse user settings', () => {
  it('reads personal time-zone settings and uses the server-converted local date', async () => {
    const fetchMock = setup();
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result).toMatchObject({
      source: 'webApi',
      observedAtUtc: utcNow,
      timeZoneCode: 130,
      timeZoneStandardName: 'GTB Standard Time',
      localDateTime: '2026-01-16T01:30:00',
      localDate: '2026-01-16',
      utcOffsetMinutes: 120,
      languageId: 1032,
      dateFormat: 'dd/MM/yyyy'
    });
    expect(result.warning).toBeUndefined();
    expect(result).not.toHaveProperty('userId');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls[0]?.searchParams.get('$select')).toBe('timezonecode,uilanguageid');
    expect(
      urls.find((url) => url.pathname.includes('LocalTimeFromUtcTime'))?.searchParams.get('@utc')
    ).toBe(utcNow);
    expect(
      urls.find((url) => url.pathname.endsWith('timezonedefinitions'))?.searchParams.get('$filter')
    ).toBe('timezonecode eq 130 and retiredorder eq 0');
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(call[1]).toMatchObject({ method: 'GET', credentials: 'include' });
    }
  });

  it('uses WhoAmI on list pages without an Xrm global context', async () => {
    const fetchMock = setup({ xrm: false });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${origin}/api/data/v9.2/WhoAmI`);
    expect(result.source).toBe('webApi');
    expect(result.localDate).toBe('2026-01-16');
  });

  it('uses server conversion rather than a stale or browser-derived offset', async () => {
    setup({ offset: 120, localTime: '2026-01-16T02:30:00Z' });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.utcOffsetMinutes).toBe(180);
    expect(result.source).toBe('webApi');
  });

  it('supports negative offsets and UTC date boundaries', async () => {
    setup({ localTime: '2026-01-15T18:30:00-05:00' });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.utcOffsetMinutes).toBe(-300);
    expect(result.localDateTime).toBe('2026-01-15T18:30:00');
  });

  it('accepts zero-valued time-zone codes and zero offsets without treating them as missing', async () => {
    setup({ timeZoneCode: 0, localTime: utcNow });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.timeZoneCode).toBe(0);
    expect(result.utcOffsetMinutes).toBe(0);
  });

  it('still converts user time if the optional time-zone name lookup is denied', async () => {
    setup({ definitionStatus: 403 });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.localDate).toBe('2026-01-16');
    expect(result.timeZoneStandardName).toBeUndefined();
    expect(result.warning).toContain('403');
  });

  it('falls back explicitly to the current Xrm user offset when Web API settings are denied', async () => {
    setup({ offset: 120, settingsStatus: 403 });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.source).toBe('xrm');
    expect(result.localDate).toBe('2026-01-16');
    expect(result.utcOffsetMinutes).toBe(120);
    expect(result.timeZoneStandardName).toBeUndefined();
    expect(result.warning).toContain('historical or future');
  });

  it('reports denied settings without pretending to know the user time zone', async () => {
    setup({ xrm: false, settingsStatus: 403 });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.source).toBe('unavailable');
    expect(result.localDate).toBeUndefined();
    expect(result.warning).toContain('403');
  });

  it('keeps known zone settings but does not invent a local time if conversion fails', async () => {
    setup({ conversionStatus: 500 });
    const result = await collectDataverseUserContext({ origin, utcNow });
    expect(result.timeZoneCode).toBe(130);
    expect(result.localDate).toBeUndefined();
    expect(result.warning).toContain('500');
  });

  it('rejects a changed origin without sending signed-session requests', async () => {
    const fetchMock = setup();
    const result = await collectDataverseUserContext({
      origin: 'https://other.crm.dynamics.com',
      utcNow
    });
    expect(result.source).toBe('unavailable');
    expect(result.warning).toContain('environment changed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid clock input without API requests', async () => {
    const fetchMock = setup();
    const result = await collectDataverseUserContext({ origin, utcNow: 'invalid' });
    expect(result.source).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs after serialization without module closures', async () => {
    setup();
    const injected = new Function(
      `return (${collectDataverseUserContext.toString()});`
    )() as typeof collectDataverseUserContext;
    expect((await injected({ origin, utcNow })).localDate).toBe('2026-01-16');
  });
});
