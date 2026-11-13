import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../lib/prompts';

describe('buildChatMessages', () => {
  it('keeps confirmed names and ownership through clarification loops beyond the old eight-turn window', () => {
    const history = [
      {
        role: 'user' as const,
        content: 'Create ConsentOutbox in solution test table with occurredOn and Contact lookup.'
      },
      { role: 'assistant' as const, content: 'Organization-owned?' },
      { role: 'user' as const, content: 'Yes, Organization-owned.' },
      ...Array.from({ length: 26 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: 'Clarification ' + i
      }))
    ];
    const sent = buildChatMessages('System', 'Try again now.', undefined, [], history);
    const content = JSON.stringify(sent);
    expect(content).toContain('ConsentOutbox');
    expect(content).toContain('test table');
    expect(content).toContain('Organization-owned');
    expect(content).toContain('later corrections supersede');
    expect(sent.at(-1)?.content).toBe('Try again now.');
  });

  it('bounds older quoted user requirements and never promotes older assistant guesses into them', () => {
    const history = [
      { role: 'assistant' as const, content: 'A guessed solution: wrong solution' },
      ...Array.from({ length: 16 }, (_, i) => ({
        role: 'user' as const,
        content: String(i) + 'x'.repeat(4000)
      })),
      ...Array.from({ length: 24 }, () => ({ role: 'assistant' as const, content: 'Recent' }))
    ];
    const sent = buildChatMessages('System', 'Continue', undefined, [], history);
    expect(sent[1]?.role).toBe('user');
    expect(sent[1]!.content.length).toBeLessThan(21000);
    expect(JSON.stringify(sent)).not.toContain('wrong solution');
    expect(sent.filter((m) => m.content === 'Recent')).toHaveLength(24);
  });

  it('includes recent conversation history before the new question', () => {
    const messages = buildChatMessages(
      'Be helpful.',
      'Can you open this record?',
      undefined,
      [],
      [
        { role: 'user', content: 'Find the most recent invoice.' },
        { role: 'assistant', content: 'The invoice is INV-1001.' }
      ]
    );

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ]);
    expect(messages[3]?.content).toBe('Can you open this record?');
  });
});
