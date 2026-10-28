import type { BulkJobSummary } from './bulk/contracts';
import type {
  DataverseFlowChangeExecutionResult,
  PreparedDataverseFlowChange
} from './flows/contracts';
import type {
  DataverseMutationExecutionResult,
  MarketingListMembershipExecutionResult,
  OddySkillChangeExecutionResult,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange,
  ToolActivity,
  OddySkillRun,
  OddySkillToolName
} from './types';

/** Shared in-memory and persisted contracts. Keep additions optional for older histories. */
export type ApprovalStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
export interface ApprovalState<Result> {
  status: ApprovalStatus;
  result?: Result;
  error?: string;
}

export interface ConversationRequestContext {
  requestId: string;
  prompt: string;
  environmentOrigin?: string;
  allowDataverseTools: boolean;
  allowSkillTools: boolean;
  skillRun?: OddySkillRun;
  skillToolLimit?: OddySkillToolName[];
}

export interface StoredTranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolActivity[];
  pendingMutations?: PreparedDataverseMutation[];
  pendingFlowChanges?: PreparedDataverseFlowChange[];
  pendingListMemberships?: PreparedMarketingListMembership[];
  pendingSkillChanges?: PreparedOddySkillChange[];
  pendingBulkJobs?: BulkJobSummary[];
  historical?: boolean;
  requestContext?: ConversationRequestContext;
}

export interface StoredMutationApprovalState extends ApprovalState<DataverseMutationExecutionResult> {
  selectedColumns: string[];
}

export interface StoredFlowChangeApprovalState extends ApprovalState<DataverseFlowChangeExecutionResult> {}

export interface StoredListMembershipApprovalState extends ApprovalState<MarketingListMembershipExecutionResult> {
  selectedMemberIds: string[];
}

export interface StoredSkillChangeApprovalState extends ApprovalState<OddySkillChangeExecutionResult> {}
export interface StoredBulkJobApprovalState extends ApprovalState<BulkJobSummary> {
  acknowledgeReadableScope?: boolean;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  environmentName?: string;
  environmentOrigin?: string;
  tableLogicalName?: string;
  transcript: StoredTranscriptItem[];
  mutationApprovals: Record<string, StoredMutationApprovalState>;
  flowChangeApprovals?: Record<string, StoredFlowChangeApprovalState>;
  listMembershipApprovals: Record<string, StoredListMembershipApprovalState>;
  skillChangeApprovals: Record<string, StoredSkillChangeApprovalState>;
  bulkJobApprovals?: Record<string, StoredBulkJobApprovalState>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  environmentName?: string;
  tableLogicalName?: string;
  messageCount: number;
}

export function conversationMessages(
  transcript: StoredTranscriptItem[]
): import('./types').ChatMessage[] {
  return transcript.map((item) => ({
    role: item.role,
    content:
      item.role === 'assistant' && item.toolsUsed?.length
        ? `${item.content}\n\nExtension tool audit (authoritative):\n${item.toolsUsed
            .map(
              (tool) =>
                `- ${tool.label}: ${tool.summary}${tool.details ? ` — ${tool.details}` : ''}`
            )
            .join('\n')}`
        : item.content
  }));
}

/** Restored proposals are display-only, even when an approval state was not saved. */
export function restoreConversation(stored: StoredConversation): StoredConversation {
  const restoreApprovals = <T extends { status: ApprovalStatus }>(
    approvals: Record<string, T> = {}
  ): Record<string, T> =>
    Object.fromEntries(
      Object.entries(approvals).map(([id, approval]) => [
        id,
        { ...approval, status: approval.status === 'approving' ? 'pending' : approval.status }
      ])
    );

  const mutationApprovals = restoreApprovals(stored.mutationApprovals);
  const flowChangeApprovals = restoreApprovals(stored.flowChangeApprovals);
  const listMembershipApprovals = restoreApprovals(stored.listMembershipApprovals);
  const skillChangeApprovals = restoreApprovals(stored.skillChangeApprovals);
  const bulkJobApprovals = restoreApprovals(stored.bulkJobApprovals);
  const isExpired = (status?: ApprovalStatus) => status === undefined || status === 'pending';
  const transcript = stored.transcript.map((item) => {
    const hasExpiredProposal =
      item.pendingMutations?.some((p) => isExpired(mutationApprovals[p.id]?.status)) ||
      item.pendingFlowChanges?.some((p) => isExpired(flowChangeApprovals[p.id]?.status)) ||
      item.pendingListMemberships?.some((p) => isExpired(listMembershipApprovals[p.id]?.status)) ||
      item.pendingSkillChanges?.some((p) => isExpired(skillChangeApprovals[p.id]?.status)) ||
      item.pendingBulkJobs?.some((p) => isExpired(bulkJobApprovals[p.id]?.status));
    const toolsUsed = [...(item.toolsUsed || [])];
    if (
      hasExpiredProposal &&
      !toolsUsed.some((tool) => tool.name === 'historical_proposal_expired')
    ) {
      toolsUsed.push({
        name: 'historical_proposal_expired',
        label: 'Historical proposal expired',
        summary: 'A fresh approval preview is required before making changes'
      });
    }
    return { ...item, toolsUsed: toolsUsed.length ? toolsUsed : undefined, historical: true };
  });
  return {
    ...stored,
    transcript,
    mutationApprovals,
    flowChangeApprovals,
    listMembershipApprovals,
    skillChangeApprovals,
    bulkJobApprovals
  };
}
