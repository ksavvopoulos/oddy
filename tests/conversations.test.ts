import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConversations,
  deleteConversation,
  getConversation,
  listConversations,
  pruneConversations,
  saveConversation
} from '../lib/conversations';
import {
  conversationIdsToDelete,
  DEFAULT_HISTORY_LIMITS,
  normalizeHistoryLimits
} from '../lib/history-policy';
import { conversationFixture } from './fixtures/proposals';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-10T00:00:00.000Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IndexedDB conversation repository', () => {
  it('round-trips transcript, selections, audits, and proposal data', async () => {
    const conversation = conversationFixture();
    await saveConversation(conversation, DEFAULT_HISTORY_LIMITS);
    expect(await getConversation(conversation.id)).toEqual(conversation);
  });

  it('lists newest first and returns summaries, not full transcripts', async () => {
    await saveConversation(conversationFixture({ id: 'old' }), DEFAULT_HISTORY_LIMITS);
    await saveConversation(
      conversationFixture({ id: 'new', updatedAt: '2026-01-09T00:00:00.000Z' }),
      DEFAULT_HISTORY_LIMITS
    );
    const summaries = await listConversations();
    expect(summaries.map((item) => item.id)).toEqual(['new', 'old']);
    expect(summaries[0]?.messageCount).toBe(2);
    expect(summaries[0]).not.toHaveProperty('transcript');
  });

  it('updates in place instead of duplicating a conversation', async () => {
    await saveConversation(conversationFixture(), DEFAULT_HISTORY_LIMITS);
    await saveConversation(conversationFixture({ title: 'Revised title' }), DEFAULT_HISTORY_LIMITS);
    expect(await listConversations()).toHaveLength(1);
    expect((await getConversation('conversation'))?.title).toBe('Revised title');
  });

  it('deletes one conversation without affecting another and clears all', async () => {
    await saveConversation(conversationFixture({ id: 'a' }), DEFAULT_HISTORY_LIMITS);
    await saveConversation(conversationFixture({ id: 'b' }), DEFAULT_HISTORY_LIMITS);
    await deleteConversation('a');
    expect(await getConversation('a')).toBeUndefined();
    expect(await listConversations()).toHaveLength(1);
    await clearConversations();
    expect(await listConversations()).toEqual([]);
  });

  it('prunes expired conversations and enforces the count limit on save', async () => {
    const limits = { maxConversations: 2, retentionDays: 3 };
    for (const [id, day] of [
      ['expired', '01'],
      ['oldest', '08'],
      ['middle', '09'],
      ['newest', '10']
    ]) {
      await saveConversation(
        conversationFixture({ id, updatedAt: `2026-01-${day}T00:00:00.000Z` }),
        limits
      );
    }
    expect((await listConversations()).map((item) => item.id)).toEqual(['newest', 'middle']);
  });

  it('applies changed limits to existing history', async () => {
    await saveConversation(conversationFixture({ id: 'a' }), DEFAULT_HISTORY_LIMITS);
    await saveConversation(
      conversationFixture({ id: 'b', updatedAt: '2026-01-09T00:00:00.000Z' }),
      DEFAULT_HISTORY_LIMITS
    );
    await pruneConversations({ maxConversations: 1, retentionDays: 30 });
    expect((await listConversations()).map((item) => item.id)).toEqual(['b']);
  });

  it('serializes concurrent saves and retention in read-write transactions', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        saveConversation(
          conversationFixture({ id: String(i), updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
          { maxConversations: 3, retentionDays: 30 }
        )
      )
    );
    expect((await listConversations()).map((item) => item.id)).toEqual(['5', '4', '3']);
  });

  it('rolls back the save if retention fails instead of committing a partial transaction', async () => {
    await saveConversation(conversationFixture({ id: 'existing' }), DEFAULT_HISTORY_LIMITS);
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('Retention failed');
    });
    await expect(
      saveConversation(conversationFixture({ id: 'new', updatedAt: '2026-01-09T00:00:00.000Z' }), {
        maxConversations: 1,
        retentionDays: 30
      })
    ).rejects.toThrow('Retention failed');
    expect(await getConversation('new')).toBeUndefined();
    expect(await getConversation('existing')).toBeDefined();
  });

  it('reports unavailable local storage', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(listConversations()).rejects.toThrow('Local conversation storage is unavailable');
  });
});

describe('history policy', () => {
  it('normalizes limits once for both settings and the repository', () => {
    expect(normalizeHistoryLimits({ maxConversations: 0, retentionDays: 5000 })).toEqual({
      maxConversations: 1,
      retentionDays: 3650
    });
    expect(normalizeHistoryLimits({ maxConversations: NaN, retentionDays: Infinity })).toEqual(
      DEFAULT_HISTORY_LIMITS
    );
  });

  it('does not mutate input and expires invalid timestamps', () => {
    const conversations = [
      { id: 'bad', updatedAt: 'invalid' },
      { id: 'good', updatedAt: '2026-01-09T00:00:00.000Z' }
    ];
    expect(conversationIdsToDelete(conversations, DEFAULT_HISTORY_LIMITS)).toEqual(['bad']);
    expect(conversations[0]?.id).toBe('bad');
  });
});
