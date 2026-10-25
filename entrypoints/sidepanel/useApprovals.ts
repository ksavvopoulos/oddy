import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { canEditApproval, createApprovalExecutor, toggleSelection } from '../../lib/approvals';
import type {
  ApprovalState,
  StoredTranscriptItem,
  StoredMutationApprovalState,
  StoredListMembershipApprovalState,
  StoredSkillChangeApprovalState
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

type ProposalKind = 'pendingMutations' | 'pendingListMemberships' | 'pendingSkillChanges';
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
  successActivity: (result: Result) => Omit<ToolActivity, 'name'>;
  failureLabel: string;
  isHistorical: (id: string) => boolean;
  activity: (id: string, activity: ToolActivity) => void;
  afterSuccess: () => void;
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
    if (!state) return;
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
        config.activity(proposal.id, { name: config.name, ...config.successActivity(result) });
        config.afterSuccess();
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
  transcript: StoredTranscriptItem[];
  setTranscript: Dispatch<SetStateAction<StoredTranscriptItem[]>>;
  loadContext: () => Promise<void>;
  loadSkills: () => Promise<void>;
}) {
  const activity = (kind: ProposalKind) => (id: string, tool: ToolActivity) => {
    options.setTranscript((items) =>
      items.map((item) =>
        item[kind]?.some((proposal) => proposal.id === id)
          ? { ...item, toolsUsed: [...(item.toolsUsed || []), tool] }
          : item
      )
    );
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
      details: `${result.tableLogicalName} ${result.recordId}`
    }),
    failureLabel: 'Approved record change failed',
    isHistorical: isHistorical('pendingMutations'),
    activity: activity('pendingMutations'),
    afterSuccess: () => {
      void options.loadContext();
    }
  });
  const memberships = useApprovalQueue<
    PreparedMarketingListMembership,
    MarketingListMembershipExecutionResult,
    StoredListMembershipApprovalState
  >({
    name: 'execute_marketing_list_membership',
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
      details: result.addedMemberNames.join('; ')
    }),
    failureLabel: 'Approved marketing-list membership failed',
    isHistorical: isHistorical('pendingListMemberships'),
    activity: activity('pendingListMemberships'),
    afterSuccess: () => {
      void options.loadContext();
    }
  });
  const skills = useApprovalQueue<
    PreparedOddySkillChange,
    OddySkillChangeExecutionResult,
    StoredSkillChangeApprovalState
  >({
    name: 'execute_oddy_skill_change',
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

  return {
    mutationApprovals: mutations.states,
    setMutationApprovals: mutations.setStates,
    listMembershipApprovals: memberships.states,
    setListMembershipApprovals: memberships.setStates,
    skillChangeApprovals: skills.states,
    setSkillChangeApprovals: skills.setStates,
    approving: [
      ...Object.values(mutations.states),
      ...Object.values(memberships.states),
      ...Object.values(skills.states)
    ].some((state) => state.status === 'approving'),
    registerResponse: (response: LlmResponse) => {
      mutations.register(response.pendingMutations);
      memberships.register(response.pendingListMemberships);
      skills.register(response.pendingSkillChanges);
    },
    approveMutation: mutations.approve,
    rejectMutation: mutations.reject,
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
