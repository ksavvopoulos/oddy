import { describe, expect, it } from 'vitest';
import { withRuntimeClock } from '../lib/assistant/runtime-clock';
import type { ChatMessage } from '../lib/types';

describe('authoritative runtime clock', () => {
  it('supplies today and a precise rolling 30-day interval across the year boundary', () => {
    const messages = withRuntimeClock(
      [{ role: 'user', content: 'last 30 days' }],
      new Date('2026-01-15T12:34:56.000Z')
    );
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('2026-01-15T12:34:56.000Z');
    expect(messages[0]?.content).toContain('2025-12-16T12:34:56.000Z');
    expect(messages[0]?.content).toContain('do not ask the user');
    expect(messages[0]?.content).toContain('createdon ge fromInclusiveUtc');
    expect(messages[0]?.content).toContain('createdon le toInclusiveUtc');
  });

  it('uses the Dataverse user-local date and named zone rather than treating the browser zone as the user setting', () => {
    const messages = withRuntimeClock(
      [{ role: 'user', content: 'Use current user settings' }],
      new Date('2026-01-15T23:30:00Z'),
      {
        source: 'webApi',
        observedAtUtc: '2026-01-15T23:30:00.000Z',
        timeZoneCode: 130,
        timeZoneStandardName: 'GTB Standard Time',
        localDateTime: '2026-01-16T01:30:00',
        localDate: '2026-01-16',
        utcOffsetMinutes: 120
      }
    );
    expect(messages[0]?.content).toContain('"localDate":"2026-01-16"');
    expect(messages[0]?.content).toContain('"timeZoneStandardName":"GTB Standard Time"');
    expect(messages[0]?.content).toContain('"utcNow":"2026-01-15T23:30:00.000Z"');
    expect(messages[0]?.content).toContain('"browserTimeZone":');
    expect(messages[0]?.content).toContain('settings are read automatically');
    expect(messages[0]?.content).toContain('earlier messages claiming otherwise are superseded');
  });

  it('labels missing Dataverse settings without silently calling browser time the user time', () => {
    const messages = withRuntimeClock([{ role: 'user', content: 'today' }]);
    expect(messages[0]?.content).toContain('"currentUser":{"source":"unavailable"');
    expect(messages[0]?.content).toContain('rolling UTC query can still proceed');
  });

  it('handles leap years and leaves the caller messages unchanged', () => {
    const original: ChatMessage[] = [
      { role: 'system', content: 'Existing instructions' },
      { role: 'user', content: 'Hi' }
    ];
    const messages = withRuntimeClock(original, new Date('2024-03-01T09:00:00.000Z'));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('2024-01-31T09:00:00.000Z');
    expect(messages[0]?.content).toContain('Existing instructions');
    expect(original[0]?.content).toBe('Existing instructions');
  });
});
