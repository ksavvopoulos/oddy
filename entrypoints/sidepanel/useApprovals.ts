import { useCallback, useEffect, useRef, useState } from 'react';
import type { BulkJobSummary } from '../../lib/bulk/contracts';
import type {
  DataverseFlowChangeExecutionResult,
  PreparedDataverseFlowChange
} from '../../lib/flows/contracts';
import { bulkAudit, executeApprovedBulkJob } from '../../lib/bulk/client';
import type { Dispatch, SetStateAction } from 'react';
import { canEditApproval, createApprovalExecutor, toggleSelection } from '../../lib/approvals';
import {
  createApprovalContinuation,
  type ApprovalContinuation,
  type BusinessProposalKind
} from '../../lib/approval-continuation';
import type {
  ApprovalState,
  StoredTranscriptItem,
  StoredMutationApprovalState,
  StoredFlowChangeApprovalState,
  StoredListMembershipApprovalState,
  StoredSkillChangeApprovalState,
  StoredBulkJobApprovalState
} from '../../lib/conversation-model';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import type {
  DataverseMutationExecutionResult,
  ExtensionMessage,
  LlmResponse,
  MarketingListMembershipExecutionResult,
  OddySkillChangeExecutionResult,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange,
  ToolActivity
} from '../../lib/types';

type ProposalKind =
  | 'pendingMutations'
  | 'pendingFlowChanges'
  | 'pendingListMemberships'
  | 'pendingSkillChanges'
  | 'pendingBulkJobs';
type StateMap<State> = Record<string, State>;

/** One lifecycle for all approval kinds; adapters below supply only domain-specific details. */
function useApprovalQueue<
  Proposal extends { id: string },
  Result,
  State extends ApprovalState<Result>
>(config: {
  name: string;
  initial: (proposal: Proposal) => State;
  request: (proposal: Proposal, state: State) => ExtensionMessage;
  executeRequest?: (proposal: Proposal, state: State) => Promise<Result>;
  successActivity: (result: Result) => Omit<ToolActivity, 'name'>;
  failureLabel: string;
  isHistorical: (id: string) => boolean;
  blocked: boolean;
  activity: (id: string, activity: ToolActivity) => void;
  afterSuccess: (proposal: Proposal, result: Result, activity: ToolActivity) => void;
}) {
  const [states, setReactStates] = useState<StateMap<State>>({});
  const current = useRef(states);
  const [execute] = useState(createApprovalExecutor);
  const setStates: Dispatch<SetStateAction<StateMap<State>>> = useCallback((update) => {
    current.current = typeof update === 'function' ? update(current.current) : update;
    setReactStates(current.current);
  }, []);

  const register = (proposals: Proposal[] = []) =>
    setStates((existing) => {
      const next = { ...existing };
      for (const proposal of proposals) next[proposal.id] ||= config.initial(proposal);
      return next;
    });

  const reject = (id: string) =>
    setStates((existing) => {
      const state = existing[id];
      if (!state || !canEditApproval(state, config.isHistorical(id))) return existing;
      return { ...existing, [id]: { ...state, status: 'rejected', error: undefined } };
    });

  const approve = async (proposal: Proposal) => {
    const state = current.current[proposal.id];
    if (!state || config.blocked) return;
    await execute<Result>({
      id: proposal.id,
      getState: () => current.current[proposal.id],
      historical: config.isHistorical(proposal.id),
      start: () =>
        setStates((existing) => ({
          ...existing,
          [proposal.id]: { ...state, status: 'approving', error: undefined }
        })),
      request: async () => {
        if (config.executeRequest) return config.executeRequest(proposal, state);
        const response = await sendExtensionMessage<Result>(config.request(proposal, state));
        if (!response.ok || !response.data)
          throw new Error(response.error || 'The approved change returned no result.');
        return response.data;
      },
      success: (result) => {
        setStates((existing) => ({
          ...existing,
          [proposal.id]: { ...state, status: 'approved', result, error: undefined }
        }));
        const activity = { name: config.name, ...config.successActivity(result) };
        config.activity(proposal.id, activity);
        config.afterSuccess(proposal, result, activity);
      },
      failure: (error) => {
        const detail = errorMessage(error);
        setStates((existing) => ({
          ...existing,
          [proposal.id]: { ...state, status: 'error', error: detail }
        }));
        config.activity(proposal.id, {
          name: config.name,
          label: config.failureLabel,
          summary: 'Execution failed; prepare a fresh preview before retrying',
          details: detail
        });
      }
    });
  };

  return { states, setStates, register, reject, approve };
}

export function useApprovals(options: {
  conversationId: string;
  blocked: boolean;
  allowBulkWrites?: boolean;
  allowDataverseWrites?: boolean;
  onBusinessApproved: (event: ApprovalContinuation) => void;
  transcript: StoredTranscriptItem[];
  setTranscript: Dispatch<SetStateAction<StoredTranscriptItem[]>>;
  loadContext: () => Promise<void>;
  loadSkills: () => Promise<void>;
}) {
  const mounted = useRef(true);
  const allowed = useRef(options.allowBulkWrites !== false);
  allowed.current = options.allowBulkWrites !== false;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stopping = useRef(new Set<string>());
  const [bulkProgress, setBulkProgress] = useState<Record<string, BulkJobSummary>>({});
  const activity = (kind: ProposalKind) => (id: string, tool: ToolActivity) => {
    options.setTranscript((items) =>
      items.map((item) =>
        item[kind]?.some((proposal) => proposal.id === id)
          ? { ...item, toolsUsed: [...(item.toolsUsed || []), tool] }
          : item
      )
    );
  };
  const continueBusinessRequest = (
    kind: BusinessProposalKind,
    id: string,
    outcome: ToolActivity
  ) => {
    const event = createApprovalContinuation(
      options.conversationId,
      options.transcript,
      kind,
      id,
      outcome
    );
    if (event) options.onBusinessApproved(event);
  };
  const isHistorical = (kind: ProposalKind) => (id: string) =>
    options.transcript.some(
      (item) => item.historical && item[kind]?.some((proposal) => proposal.id === id)
    );

  const mutations = useApprovalQueue<
    PreparedDataverseMutation,
    DataverseMutationExecutionResult,
    StoredMutationApprovalState
  >({
    name: 'execute_dataverse_mutation',
    blocked: options.blocked || options.allowDataverseWrites === false,
    initial: (proposal) => ({
      status: 'pending',
      selectedColumns: proposal.fields.map((field) => field.logicalName)
    }),
    request: (mutation, state) => {
      if (!state.selectedColumns.length) throw new Error('Select at least one field to apply.');
      return {
        type: 'EXECUTE_DATAVERSE_MUTATION',
        payload: { mutation, selectedColumns: state.selectedColumns }
      };
    },
    successActivity: (result) => ({
      label: 'Applied approved record change',
      summary: `${result.changedColumns.length} field${result.changedColumns.length === 1 ? '' : 's'} changed`,
      details: JSON.stringify(result)
    }),
    failureLabel: 'Approved record change failed',
    isHistorical: isHistorical('pendingMutations'),
    activity: activity('pendingMutations'),
    afterSuccess: (proposal, _result, activity) => {
      void options.loadContext();
      continueBusinessRequest('pendingMutations', proposal.id, activity);
    }
  });
  const flows = useApprovalQueue<
    PreparedDataverseFlowChange,
    DataverseFlowChangeExecutionResult,
    StoredFlowChangeApprovalState
  >({
    name: 'execute_dataverse_flow_change',
    blocked: options.blocked || options.allowDataverseWrites === false,
    initial: () => ({ status: 'pending' }),
    request: (change) => ({ type: 'EXECUTE_DATAVERSE_FLOW_CHANGE', payload: { change } }),
    successActivity: (result) => ({
      label:
        result.savedAs === 'unpublished-draft'
          ? 'Saved approved cloud-flow draft'
          : 'Applied approved cloud-flow change',
      summary:
        result.savedAs === 'unpublished-draft'
          ? `${result.name} · unpublished draft saved; not published or activated`
          : `${result.name} was ${result.operation === 'create' ? 'created' : 'updated'} · ${result.state}`,
      details: JSON.stringify(result)
    }),
    failureLabel: 'Approved cloud-flow change failed',
    isHistorical: isHistorical('pendingFlowChanges'),
    activity: activity('pendingFlowChanges'),
    afterSuccess: (proposal, _result, activity) => {
      continueBusinessRequest('pendingFlowChanges', proposal.id, activity);
    }
  });
  const memberships = useApprovalQueue<
    PreparedMarketingListMembership,
    MarketingListMembershipExecutionResult,
    StoredListMembershipApprovalState
  >({
    name: 'execute_marketing_list_membership',
    blocked: options.blocked || options.allowDataverseWrites === false,
    initial: (proposal) => ({
      status: 'pending',
      selectedMemberIds: proposal.members.map((member) => member.recordId)
    }),
    request: (membership, state) => {
      if (!state.selectedMemberIds.length) throw new Error('Select at least one member to add.');
      return {
        type: 'EXECUTE_MARKETING_LIST_MEMBERSHIP',
        payload: { membership, selectedMemberIds: state.selectedMemberIds }
      };
    },
    successActivity: (result) => ({
      label: `Added members to ${result.listName}`,
      summary: `${result.addedMemberIds.length} member${result.addedMemberIds.length === 1 ? '' : 's'} added with AddListMembersList`,
      details: JSON.stringify(result)
    }),
    failureLabel: 'Approved marketing-list membership failed',
    isHistorical: isHistorical('pendingListMemberships'),
    activity: activity('pendingListMemberships'),
    afterSuccess: (proposal, _result, activity) => {
      void options.loadContext();
      continueBusinessRequest('pendingListMemberships', proposal.id, activity);
    }
  });
  const skills = useApprovalQueue<
    PreparedOddySkillChange,
    OddySkillChangeExecutionResult,
    StoredSkillChangeApprovalState
  >({
    name: 'execute_oddy_skill_change',
    blocked: options.blocked,
    initial: () => ({ status: 'pending' }),
    request: (change) => ({ type: 'EXECUTE_ODDY_SKILL_CHANGE', payload: { change } }),
    successActivity: (result) => ({
      label: 'Applied approved skill change',
      summary: `${result.skillName} was ${result.operation === 'create' ? 'created' : result.operation === 'update' ? 'updated' : 'deleted'}`,
      details: result.skillId
    }),
    failureLabel: 'Approved skill change failed',
    isHistorical: isHistorical('pendingSkillChanges'),
    activity: activity('pendingSkillChanges'),
    afterSuccess: () => {
      void options.loadSkills();
    }
  });

  const bulk = useApprovalQueue<BulkJobSummary, BulkJobSummary, StoredBulkJobApprovalState>({
    name: 'execute_bulk_job',
    blocked: options.blocked || options.allowBulkWrites === false,
    initial: () => ({ status: 'pending' }),
    request: (job) => ({
      type: 'APPROVE_BULK_JOB',
      payload: { id: job.id, revision: job.revision }
    }),
    executeRequest: (job, state) =>
      executeApprovedBulkJob(job, {
        send: sendExtensionMessage,
        acknowledgeReadableScope: state.acknowledgeReadableScope,
        allowed: () => mounted.current && allowed.current,
        stopRequested: () => stopping.current.has(job.id),
        progress: (summary) => {
          if (mounted.current) setBulkProgress((existing) => ({ ...existing, [job.id]: summary }));
        }
      }),
    successActivity: (result) => ({
      label: 'Completed approved bulk job',
      summary: `${result.succeeded} succeeded; ${result.skipped} skipped; ${result.remaining} remaining`,
      details: JSON.stringify(bulkAudit(result))
    }),
    failureLabel: 'Bulk job stopped; reconciliation required',
    isHistorical: isHistorical('pendingBulkJobs'),
    activity: activity('pendingBulkJobs'),
    afterSuccess: (job, _result, activity) => {
      void options.loadContext();
      continueBusinessRequest('pendingBulkJobs', job.id, activity);
    }
  });

  return {
    blocked: options.blocked,
    allowDataverseWrites: options.allowDataverseWrites !== false,
    allowBulkWrites: options.allowBulkWrites !== false,
    bulkJobApprovals: bulk.states,
    setBulkJobApprovals: bulk.setStates,
    approveBulkJob: bulk.approve,
    rejectBulkJob: (id: string) => {
      const state = bulk.states[id];
      if (!state || !canEditApproval(state, isHistorical('pendingBulkJobs')(id))) return;
      bulk.reject(id);
      void sendExtensionMessage({ type: 'STOP_BULK_JOB', payload: { id, reject: true } }).catch(
        () => undefined
      );
    },
    toggleBulkReadableScope: (id: string) =>
      bulk.setStates((states) => {
        const state = states[id];
        if (!state || !canEditApproval(state, isHistorical('pendingBulkJobs')(id))) return states;
        return {
          ...states,
          [id]: { ...state, acknowledgeReadableScope: !state.acknowledgeReadableScope }
        };
      }),
    stopBulkJob: (id: string) => {
      stopping.current.add(id);
    },
    bulkProgress,
    mutationApprovals: mutations.states,
    setMutationApprovals: mutations.setStates,
    flowChangeApprovals: flows.states,
    setFlowChangeApprovals: flows.setStates,
    listMembershipApprovals: memberships.states,
    setListMembershipApprovals: memberships.setStates,
    skillChangeApprovals: skills.states,
    setSkillChangeApprovals: skills.setStates,
    approving: [
      ...Object.values(mutations.states),
      ...Object.values(flows.states),
      ...Object.values(memberships.states),
      ...Object.values(skills.states),
      ...Object.values(bulk.states)
    ].some((state) => state.status === 'approving'),
    registerResponse: (response: LlmResponse) => {
      mutations.register(response.pendingMutations);
      flows.register(response.pendingFlowChanges);
      memberships.register(response.pendingListMemberships);
      skills.register(response.pendingSkillChanges);
      bulk.register(response.pendingBulkJobs);
    },
    approveMutation: mutations.approve,
    rejectMutation: mutations.reject,
    approveFlowChange: flows.approve,
    rejectFlowChange: flows.reject,
    approveListMembership: memberships.approve,
    rejectListMembership: memberships.reject,
    approveSkillChange: skills.approve,
    rejectSkillChange: skills.reject,
    toggleMutationField: (id: string, column: string) =>
      mutations.setStates((states) => {
        const state = states[id];
        if (!state || !canEditApproval(state, isHistorical('pendingMutations')(id))) return states;
        return {
          ...states,
          [id]: { ...state, selectedColumns: toggleSelection(state.selectedColumns, column) }
        };
      }),
    toggleListMembershipMember: (id: string, member: string) =>
      memberships.setStates((states) => {
        const state = states[id];
        if (!state || !canEditApproval(state, isHistorical('pendingListMemberships')(id)))
          return states;
        return {
          ...states,
          [id]: { ...state, selectedMemberIds: toggleSelection(state.selectedMemberIds, member) }
        };
      })
  };
}

export type ApprovalActions = ReturnType<typeof useApprovals>;
