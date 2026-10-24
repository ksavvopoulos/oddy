import { describe, expect, it } from 'vitest';
import { buildChatMessages, QUICK_ACTIONS } from '../lib/prompts';

describe('quick actions', () => {
  it('only offers marketing-list creation', () => {
    expect(QUICK_ACTIONS).toHaveLength(1);
    expect(QUICK_ACTIONS[0]).toMatchObject({
      id: 'create-marketing-list',
      label: 'Create marketing list'
    });
  });
});

describe('buildChatMessages', () => {
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
