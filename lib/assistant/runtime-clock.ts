import type { ChatMessage, DataverseUserContext } from '../types';

/** Dataverse settings and browser settings are deliberately separate sources. */
export function withRuntimeClock(
  messages: ChatMessage[],
  now = new Date(),
  currentUser?: DataverseUserContext
): ChatMessage[] {
  const browserLocalDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
  // Keep the UTC interval and converted user-local date anchored to the same instant.
  const observed = currentUser ? new Date(currentUser.observedAtUtc) : now;
  const instant = Number.isFinite(observed.getTime()) ? observed : now;
  const clock = {
    utcNow: instant.toISOString(),
    browserLocalDate,
    browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentUser: currentUser || {
      source: 'unavailable',
      warning: 'Dataverse user settings were not read for this request.'
    },
    rolling30Days: {
      fromInclusiveUtc: new Date(instant.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      toInclusiveUtc: instant.toISOString()
    }
  };
  const instruction =
    `Extension clock (authoritative for this request): ${JSON.stringify(clock)}. ` +
    `The signed-in Dataverse user's settings are read automatically, not through a model tool. ` +
    `When currentUser.localDate is available, use it as today for "current user's" requests, along with the supplied Dataverse time-zone code/name or current offset. ` +
    `Do not claim that available user settings are inaccessible just because no model tool is named for them; earlier messages claiming otherwise are superseded by this request's clock. ` +
    `Never confuse browserTimeZone with the user's configured Dataverse time zone or invent an IANA mapping for a Windows time-zone name. ` +
    `Use this clock for today and relative dates; do not ask the user what today's date is. ` +
    `Unless the user requests calendar-day boundaries, interpret "last 30 days" as the supplied rolling UTC interval; this elapsed-time interval is independent of time zone. ` +
    `For records created in that interval, use createdon ge fromInclusiveUtc and createdon le toInclusiveUtc, and state the interval and user time zone used. ` +
    `A current offset is not a historical/future DST rule. If currentUser settings are unavailable, report the lookup warning rather than pretending the browser setting is the user's setting; a rolling UTC query can still proceed.`;
  const copy = messages.map((message) => ({ ...message }));
  if (copy[0]?.role === 'system') copy[0].content += `\n\n${instruction}`;
  else copy.unshift({ role: 'system', content: instruction });
  return copy;
}
