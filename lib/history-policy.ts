import type { ConversationSummary } from './conversation-model';

export interface HistoryLimits {
  maxConversations: number;
  retentionDays: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxConversations: 50,
  retentionDays: 30
};

export function normalizeHistoryLimits(limits: HistoryLimits): HistoryLimits {
  const bounded = (value: number, fallback: number, maximum: number) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), maximum) : fallback;
  return {
    maxConversations: bounded(
      limits.maxConversations,
      DEFAULT_HISTORY_LIMITS.maxConversations,
      500
    ),
    retentionDays: bounded(limits.retentionDays, DEFAULT_HISTORY_LIMITS.retentionDays, 3650)
  };
}

export function conversationIdsToDelete(
  conversations: Array<Pick<ConversationSummary, 'id' | 'updatedAt'>>,
  limits: HistoryLimits,
  now = Date.now()
): string[] {
  const { maxConversations, retentionDays } = normalizeHistoryLimits(limits);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return [...conversations]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter(
      (conversation, index) =>
        index >= maxConversations ||
        !Number.isFinite(Date.parse(conversation.updatedAt)) ||
        Date.parse(conversation.updatedAt) < cutoff
    )
    .map((conversation) => conversation.id);
}
