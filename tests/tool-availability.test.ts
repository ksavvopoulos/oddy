import { describe, expect, it } from 'vitest';
import { withToolAvailability } from '../lib/assistant/tool-availability';

describe('authoritative tool availability', () => {
  it('supersedes stale conversation claims without changing user text', () => {
    const original = [
      { role: 'system' as const, content: 'System' },
      { role: 'assistant' as const, content: 'Schema tools are unavailable.' },
      { role: 'user' as const, content: 'Try again.' }
    ];
    const messages = withToolAvailability(original, [
      'list_dataverse_solutions',
      'prepare_dataverse_schema_change'
    ]);
    expect(messages[0]?.content).toContain(
      '"enabledTools":["list_dataverse_solutions","prepare_dataverse_schema_change"]'
    );
    expect(messages[0]?.content).toContain('NOT evidence that tools disappeared');
    expect(messages[0]?.content).toContain('ask only unresolved questions');
    expect(messages[2]).toEqual(original[2]);
    expect(original[0]?.content).toBe('System');
  });
  it('reports unavailable reasons on tool-free requests, not a global inability', () => {
    const messages = withToolAvailability(
      [{ role: 'user', content: 'Create a table' }],
      [],
      'Dataverse tools were not enabled for this request.'
    );
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('"enabledTools":[]');
    expect(messages[0]?.content).toContain('Dataverse tools were not enabled for this request.');
  });
});
