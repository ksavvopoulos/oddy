import type { DataverseUserContext } from './types';

export interface DataverseUserContextRequest {
  origin: string;
  utcNow: string;
}

/** Serialized into the page MAIN world. Keep all runtime helpers inside this function. */
export async function collectDataverseUserContext(
  request: DataverseUserContextRequest
): Promise<DataverseUserContext> {
  const instant = new Date(request.utcNow);
  if (!Number.isFinite(instant.getTime()))
    return {
      source: 'unavailable',
      observedAtUtc: new Date().toISOString(),
      warning: 'Invalid UTC instant for the user time-zone lookup.'
    };
  const observedAtUtc = instant.toISOString();
  const context: DataverseUserContext = { source: 'unavailable', observedAtUtc };
  const warnings: string[] = [];
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const validGuid = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const id = value.replace(/[{}]/g, '').trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
      ? id
      : undefined;
  };
  type UserSettings = {
    userId?: string;
    languageId?: number;
    dateFormattingInfo?: { ShortDatePattern?: string };
    getTimeZoneOffsetMinutes?: () => number;
  };
  let userSettings: UserSettings | undefined;
  let xrmOffset: number | undefined;
  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${request.origin}/api/data/v9.2/${path}`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' }
    });
    if (!response.ok) throw new Error(`User time-zone lookup failed (${response.status}).`);
    return (await response.json()) as T;
  };
  try {
    if (window.location.origin !== request.origin) {
      throw new Error('The Dataverse environment changed before reading user settings.');
    }
    try {
      const page = window as typeof window & {
        Xrm?: { Utility?: { getGlobalContext?: () => { userSettings?: UserSettings } } };
        GetGlobalContext?: () => { userSettings?: UserSettings };
      };
      const globalContext = page.Xrm?.Utility?.getGlobalContext?.() || page.GetGlobalContext?.();
      userSettings = globalContext?.userSettings;
      if (Number.isInteger(userSettings?.languageId)) context.languageId = userSettings!.languageId;
      if (typeof userSettings?.dateFormattingInfo?.ShortDatePattern === 'string') {
        context.dateFormat = userSettings.dateFormattingInfo.ShortDatePattern;
      }
      const offset = userSettings?.getTimeZoneOffsetMinutes?.();
      if (typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 14 * 60)
        xrmOffset = offset;
    } catch (error) {
      warnings.push(`Client user settings unavailable: ${message(error)}`);
    }

    let userId = validGuid(userSettings?.userId);
    if (!userId) userId = validGuid((await getJson<{ UserId?: string }>('WhoAmI')).UserId);
    if (!userId) throw new Error('Dataverse did not identify the signed-in user.');

    const settings = await getJson<{ timezonecode?: number; uilanguageid?: number }>(
      `usersettingscollection(${userId})?$select=timezonecode,uilanguageid`
    );
    if (Number.isInteger(settings.uilanguageid)) context.languageId = settings.uilanguageid;
    if (!Number.isInteger(settings.timezonecode) || settings.timezonecode! < 0) {
      throw new Error('The signed-in user has no readable Dataverse time-zone code.');
    }
    context.timeZoneCode = settings.timezonecode;
    context.source = 'webApi';

    // The server applies the user's actual Windows time-zone rules, including DST.
    const definitionPath =
      'timezonedefinitions?' +
      new URLSearchParams({
        $select: 'timezonecode,standardname,userinterfacename',
        $filter: `timezonecode eq ${settings.timezonecode} and retiredorder eq 0`,
        $top: '1'
      });
    const conversionPath =
      'LocalTimeFromUtcTime(TimeZoneCode=@zone,UtcTime=@utc)?' +
      new URLSearchParams({
        '@zone': String(settings.timezonecode),
        '@utc': observedAtUtc
      });
    const [definition, conversion] = await Promise.allSettled([
      getJson<{ value?: Array<{ standardname?: string; userinterfacename?: string }> }>(
        definitionPath
      ),
      getJson<{ LocalTime?: string }>(conversionPath)
    ]);
    if (definition.status === 'fulfilled') {
      context.timeZoneStandardName = definition.value.value?.[0]?.standardname;
      context.timeZoneDisplayName = definition.value.value?.[0]?.userinterfacename;
    } else warnings.push(message(definition.reason));

    if (conversion.status === 'fulfilled') {
      // LocalTime is a Dataverse wall-clock value even when its serialization ends in Z.
      const local = conversion.value.LocalTime?.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z|[+-]\d{2}:\d{2})?$/
      )?.[1];
      const localAsUtc = local ? Date.parse(`${local}Z`) : NaN;
      const offset = Math.round((localAsUtc - Date.parse(observedAtUtc)) / 60_000);
      if (!local || !Number.isFinite(offset) || Math.abs(offset) > 14 * 60) {
        warnings.push('Dataverse returned an invalid user-local time.');
      } else {
        context.localDateTime = local;
        context.localDate = local.slice(0, 10);
        context.utcOffsetMinutes = offset;
      }
    } else warnings.push(message(conversion.reason));
  } catch (error) {
    warnings.push(message(error));
  }

  // Current client offset is a fallback only, never a guessed named time zone or DST rule.
  if (!context.localDateTime && xrmOffset !== undefined) {
    const local = new Date(Date.parse(observedAtUtc) + xrmOffset * 60_000)
      .toISOString()
      .replace(/Z$/, '');
    context.localDateTime = local;
    context.localDate = local.slice(0, 10);
    context.utcOffsetMinutes = xrmOffset;
    context.source = 'xrm';
    warnings.push(
      'Using the current Xrm user offset only; do not apply it to historical or future calendar boundaries.'
    );
  }
  if (warnings.length) context.warning = warnings.join(' ');
  return context;
}
