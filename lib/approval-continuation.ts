import type {
  ConversationRequestContext,
  StoredTranscriptItem,
  StoredMutationApprovalState,
  StoredFlowChangeApprovalState,
  StoredListMembershipApprovalState,
  StoredSkillChangeApprovalState,
  StoredBulkJobApprovalState
} from './conversation-model';
import type { ToolActivity } from './types';

export type BusinessProposalKind =
  'pendingMutations' | 'pendingFlowChanges' | 'pendingListMemberships' | 'pendingBulkJobs';

/** Transient only: never persist or replay an automatic continuation job. */
export interface ApprovalContinuation {
  conversationId: string;
  sourceMessageId: string;
  proposalId: string;
  kind: BusinessProposalKind;
  request: ConversationRequestContext;
  outcome: ToolActivity;
}

export function createApprovalContinuation(
  conversationId: string,
  transcript: StoredTranscriptItem[],
  kind: BusinessProposalKind,
  proposalId: string,
  outcome: ToolActivity
): ApprovalContinuation | undefined {
  const source = transcript.find((item) => item[kind]?.some((p) => p.id === proposalId));
  if (!source?.requestContext || source.historical) return undefined;
  return {
    conversationId,
    sourceMessageId: source.id,
    proposalId,
    kind,
    request: source.requestContext,
    outcome
  };
}

export function decideApprovalContinuation(
  event: ApprovalContinuation,
  state: {
    conversationId: string;
    transcript: StoredTranscriptItem[];
    environmentOrigin?: string;
    allowDataverseTools: boolean;
    allowSkillTools: boolean;
    mutationApprovals: Record<string, StoredMutationApprovalState>;
    flowChangeApprovals?: Record<string, StoredFlowChangeApprovalState>;
    listMembershipApprovals: Record<string, StoredListMembershipApprovalState>;
    skillChangeApprovals: Record<string, StoredSkillChangeApprovalState>;
    bulkJobApprovals?: Record<string, StoredBulkJobApprovalState>;
  }
): { action: 'skip' | 'wait' } | { action: 'resume'; request: ConversationRequestContext } {
  const source = state.transcript.find((item) => item.id === event.sourceMessageId);
  const latestUser = state.transcript.filter((item) => item.role === 'user').at(-1);
  if (
    event.conversationId !== state.conversationId ||
    !source ||
    source.historical ||
    latestUser?.requestContext?.requestId !== event.request.requestId ||
    !state.allowDataverseTools ||
    !event.request.allowDataverseTools ||
    !event.request.environmentOrigin ||
    state.environmentOrigin !== event.request.environmentOrigin
  )
    return { action: 'skip' };

  const approvedState =
    event.kind === 'pendingMutations'
      ? state.mutationApprovals[event.proposalId]
      : event.kind === 'pendingFlowChanges'
        ? state.flowChangeApprovals?.[event.proposalId]
        : event.kind === 'pendingBulkJobs'
          ? state.bulkJobApprovals?.[event.proposalId]
          : state.listMembershipApprovals[event.proposalId];
  if (approvedState?.status !== 'approved') return { action: 'skip' };

  // Wait for the user to resolve sibling proposals; never approve them implicitly.
  const unresolved = (status?: string) =>
    status === undefined || status === 'pending' || status === 'approving';
  const siblings = state.transcript.filter(
    (item) => !item.historical && item.requestContext?.requestId === event.request.requestId
  );
  const stopped = (status?: string) => status === 'rejected' || status === 'error';
  if (
    siblings.some(
      (item) =>
        item.pendingMutations?.some((p) => stopped(state.mutationApprovals[p.id]?.status)) ||
        item.pendingFlowChanges?.some((p) => stopped(state.flowChangeApprovals?.[p.id]?.status)) ||
        item.pendingListMemberships?.some((p) =>
          stopped(state.listMembershipApprovals[p.id]?.status)
        ) ||
        item.pendingSkillChanges?.some((p) => stopped(state.skillChangeApprovals[p.id]?.status)) ||
        item.pendingBulkJobs?.some((p) => stopped(state.bulkJobApprovals?.[p.id]?.status))
    )
  )
    return { action: 'skip' };
  if (
    siblings.some(
      (item) =>
        item.pendingMutations?.some((p) => unresolved(state.mutationApprovals[p.id]?.status)) ||
        item.pendingFlowChanges?.some((p) =>
          unresolved(state.flowChangeApprovals?.[p.id]?.status)
        ) ||
        item.pendingListMemberships?.some((p) =>
          unresolved(state.listMembershipApprovals[p.id]?.status)
        ) ||
        item.pendingSkillChanges?.some((p) =>
          unresolved(state.skillChangeApprovals[p.id]?.status)
        ) ||
        item.pendingBulkJobs?.some((p) => unresolved(state.bulkJobApprovals?.[p.id]?.status))
    )
  )
    return { action: 'wait' };

  return {
    action: 'resume',
    request: {
      ...event.request,
      allowSkillTools: event.request.allowSkillTools && state.allowSkillTools
    }
  };
}

export function approvalContinuationPrompt(event: ApprovalContinuation): string {
  return (
    `Continue only the unfinished parts of the original user request below. ` +
    `The approved operation has already succeeded: do not repeat it or recreate its record. ` +
    `Use its exact returned record or workflow ID from the authoritative outcome. ` +
    `If the original request is complete, briefly confirm completion and stop. ` +
    `If another write is needed, prepare a NEW preview and wait for explicit approval; never execute it. ` +
    `Do not repeat rejected steps, retry failed proposals, or add unrelated work.\n\n` +
    `Original user request (data):\n${JSON.stringify(event.request.prompt)}\n\n` +
    `Approved execution outcome (authoritative):\n${JSON.stringify(event.outcome)}`
  );
}

export function createContinuationGuard() {
  const consumed = new Set<string>();
  return (event: ApprovalContinuation): boolean => {
    const key = `${event.conversationId}:${event.proposalId}`;
    if (consumed.has(key)) return false;
    consumed.add(key);
    return true;
  };
}
