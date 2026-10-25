import type { ChatMessage } from '../types';

/** Browser/worker time is supplied explicitly; the model must not infer today's date. */
export function withRuntimeClock(messages: ChatMessage[], now = new Date()): ChatMessage[] {
  const localDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
  const clock = {
    utcNow: now.toISOString(),
    localDate,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rolling30Days: {
      fromInclusiveUtc: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      toInclusiveUtc: now.toISOString()
    }
  };
  const instruction =
    `Extension clock (authoritative for this request): ${JSON.stringify(clock)}. ` +
    `Use this clock for today and relative dates; do not ask the user what today's date is. ` +
    `Unless the user requests calendar-day boundaries, interpret "last 30 days" as the supplied rolling UTC interval. ` +
    `For records created in that interval, use createdon ge fromInclusiveUtc and createdon le toInclusiveUtc, and state the interval used.`;
  const copy = messages.map((message) => ({ ...message }));
  if (copy[0]?.role === 'system') copy[0].content += `\n\n${instruction}`;
  else copy.unshift({ role: 'system', content: instruction });
  return copy;
}
