import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../lib/prompts';

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
