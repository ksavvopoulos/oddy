import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  clearConversations,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversation,
  type ConversationSummary,
  type StoredConversation
} from '../../lib/conversations';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import { buildChatMessages, contextAsText, filterContextFields } from '../../lib/prompts';
import { getAvailableSkills, SKILLS_KEY, validateSkillRunInputs } from '../../lib/skills';
import { getSettings, isAzureOpenAIConfigured, SETTINGS_KEY } from '../../lib/storage';
import type {
  DataverseContext,
  DataverseMutationExecutionResult,
  ExtensionMessage,
  ExtensionSettings,
  LlmResponse,
  MarketingListMembershipExecutionResult,
  NavigationProgress,
  OddySkill,
  OddySkillChangeExecutionResult,
  OddySkillRun,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange,
  ToolActivity
} from '../../lib/types';

interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolActivity[];
  pendingMutations?: PreparedDataverseMutation[];
  pendingListMemberships?: PreparedMarketingListMembership[];
  pendingSkillChanges?: PreparedOddySkillChange[];
  historical?: boolean;
}

interface MutationApprovalState {
  selectedColumns: string[];
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: DataverseMutationExecutionResult;
  error?: string;
}

interface ListMembershipApprovalState {
  selectedMemberIds: string[];
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: MarketingListMembershipExecutionResult;
  error?: string;
}

interface SkillChangeApprovalState {
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: OddySkillChangeExecutionResult;
  error?: string;
}

function formatPreviewValue(
  value: unknown,
  emptyLabel = 'Not set',
  nullLabel = 'Not set'
): string {
  if (value === undefined || value === '') return emptyLabel;
  if (value === null) return nullLabel;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    const lookup = value as { recordName?: unknown; tableLogicalName?: unknown; recordId?: unknown };
    if (typeof lookup.recordName === 'string' && lookup.recordName) return lookup.recordName;
    if (typeof lookup.tableLogicalName === 'string' && typeof lookup.recordId === 'string') {
      return `${lookup.tableLogicalName}: ${lookup.recordId}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function normalizeMarkdown(content: string): string {
  return content
    .replace(/^(\s*)(#{1,6})(?=\S)/gm, '$1$2 ')
    .replace(/^(\s*)(\d+[.)]|[-*+])(?=\S)/gm, '$1$2 ');
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>();
  const [context, setContext] = useState<DataverseContext>();
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [includeContext, setIncludeContext] = useState(true);
  const [allowSkillManagement, setAllowSkillManagement] = useState(false);
  const [question, setQuestion] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [loadingContext, setLoadingContext] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [navigationProgress, setNavigationProgress] = useState<NavigationProgress>();
  const [mutationApprovals, setMutationApprovals] = useState<Record<string, MutationApprovalState>>({});
  const [listMembershipApprovals, setListMembershipApprovals] = useState<Record<string, ListMembershipApprovalState>>({});
  const [skillChangeApprovals, setSkillChangeApprovals] = useState<Record<string, SkillChangeApprovalState>>({});
  const [skills, setSkills] = useState<OddySkill[]>([]);
  const [activeSkill, setActiveSkill] = useState<OddySkill>();
  const [skillInputValues, setSkillInputValues] = useState<Record<string, string>>({});
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [conversationCreatedAt, setConversationCreatedAt] = useState(() => new Date().toISOString());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const activeRequestId = useRef<string | undefined>(undefined);
  const deletedConversationIds = useRef<Set<string>>(new Set());

  const loadSettings = useCallback(async () => {
    const loaded = await getSettings();
    setSettings(loaded);
    setIncludeContext(loaded.privacy.includeRecordContextByDefault);
    setAllowSkillManagement(loaded.skills.allowModelManagementByDefault);
    return loaded;
  }, []);

  const loadSkills = useCallback(async () => {
    const loaded = await getAvailableSkills();
    setSkills(loaded);
    setActiveSkill((current) =>
      current ? loaded.find((skill) => skill.id === current.id) : undefined
    );
  }, []);

  const loadConversationHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setConversationHistory(await listConversations());
    } catch (historyError) {
      setError(errorMessage(historyError));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const startNewConversation = useCallback(() => {
    setTranscript([]);
    setMutationApprovals({});
    setListMembershipApprovals({});
    setSkillChangeApprovals({});
    setQuestion('');
    setActiveSkill(undefined);
    setSkillInputValues({});
    setConversationId(crypto.randomUUID());
    setConversationCreatedAt(new Date().toISOString());
    setHistoryOpen(false);
    setError(undefined);
  }, []);

  const loadStoredConversation = useCallback(async (id: string) => {
    setHistoryLoading(true);
    try {
      const stored = await getConversation(id);
      if (!stored) throw new Error('The selected conversation no longer exists.');
      const restoredMutationApprovals = Object.fromEntries(
        Object.entries(stored.mutationApprovals).map(([mutationId, approval]) => [
          mutationId,
          { ...approval, status: approval.status === 'approving' ? 'pending' : approval.status }
        ])
      ) as Record<string, MutationApprovalState>;
      const restoredListMembershipApprovals = Object.fromEntries(
        Object.entries(stored.listMembershipApprovals || {}).map(([membershipId, approval]) => [
          membershipId,
          { ...approval, status: approval.status === 'approving' ? 'pending' : approval.status }
        ])
      ) as Record<string, ListMembershipApprovalState>;
      const restoredSkillApprovals = Object.fromEntries(
        Object.entries(stored.skillChangeApprovals).map(([changeId, approval]) => [
          changeId,
          { ...approval, status: approval.status === 'approving' ? 'pending' : approval.status }
        ])
      ) as Record<string, SkillChangeApprovalState>;
      const restoredTranscript: TranscriptItem[] = stored.transcript.map((item) => {
        const toolsUsed = [...(item.toolsUsed || [])];
        const hasExpiredMutation = item.pendingMutations?.some((mutation) => {
          const status = restoredMutationApprovals[mutation.id]?.status;
          return status === 'pending';
        });
        const hasExpiredListMembership = item.pendingListMemberships?.some((membership) => {
          const status = restoredListMembershipApprovals[membership.id]?.status;
          return status === 'pending';
        });
        const hasExpiredSkillChange = item.pendingSkillChanges?.some((change) => {
          const status = restoredSkillApprovals[change.id]?.status;
          return status === 'pending';
        });
        if (
          (hasExpiredMutation || hasExpiredListMembership || hasExpiredSkillChange) &&
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

      setTranscript(restoredTranscript);
      setMutationApprovals(restoredMutationApprovals);
      setListMembershipApprovals(restoredListMembershipApprovals);
      setSkillChangeApprovals(restoredSkillApprovals);
      setConversationId(stored.id);
      setConversationCreatedAt(stored.createdAt);
      setQuestion('');
      setActiveSkill(undefined);
      setSkillInputValues({});
      setHistoryOpen(false);
      setError(undefined);
    } catch (historyError) {
      setError(errorMessage(historyError));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (knownSettings?: ExtensionSettings) => {
    setLoadingContext(true);
    try {
      const result = await sendExtensionMessage<DataverseContext>({ type: 'GET_ACTIVE_CONTEXT' });
      if (!result.ok || !result.data) throw new Error(result.error || 'Could not inspect the active tab.');
      setContext(result.data);
      const currentSettings = knownSettings || (await getSettings());
      const fields = filterContextFields(result.data, currentSettings.privacy.excludedFields);
      setSelectedFields(new Set(fields.map((field) => field.logicalName)));
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoadingContext(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings().then(loadContext);
    void loadSkills();

    const messageListener = (message: ExtensionMessage) => {
      if (message.type === 'CONTEXT_CHANGED') void loadContext();
      if (
        message.type === 'NAVIGATION_STATUS' &&
        message.payload.requestId === activeRequestId.current
      ) {
        setNavigationProgress(message.payload);
      }
    };
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (SETTINGS_KEY in changes) void loadSettings();
      if (SKILLS_KEY in changes) void loadSkills();
    };

    chrome.runtime.onMessage.addListener(messageListener);
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, [loadContext, loadSettings, loadSkills]);

  useEffect(() => {
    if (!settings?.conversationHistory.enabled || transcript.length === 0) return;
    const timeout = globalThis.setTimeout(() => {
      if (deletedConversationIds.current.has(conversationId)) return;
      const firstUserMessage = transcript.find((item) => item.role === 'user')?.content.trim();
      const title = (firstUserMessage || 'Oddy conversation').split('\n')[0]!.slice(0, 90);
      const conversation: StoredConversation = {
        id: conversationId,
        title,
        createdAt: conversationCreatedAt,
        updatedAt: new Date().toISOString(),
        environmentName: context?.environmentName,
        environmentOrigin: context?.origin,
        tableLogicalName: context?.tableLogicalName,
        transcript,
        mutationApprovals,
        listMembershipApprovals,
        skillChangeApprovals
      };
      void saveConversation(conversation, {
        maxConversations: settings.conversationHistory.maxConversations,
        retentionDays: settings.conversationHistory.retentionDays
      })
        .then(() => {
          if (deletedConversationIds.current.has(conversationId)) {
            void deleteConversation(conversationId);
            return;
          }
          if (historyOpen) void loadConversationHistory();
        })
        .catch((historyError) => setError(errorMessage(historyError)));
    }, 350);
    return () => globalThis.clearTimeout(timeout);
  }, [
    context?.environmentName,
    context?.origin,
    context?.tableLogicalName,
    conversationCreatedAt,
    conversationId,
    historyOpen,
    loadConversationHistory,
    listMembershipApprovals,
    mutationApprovals,
    settings,
    skillChangeApprovals,
    transcript
  ]);

  const availableFields = useMemo(
    () => (context && settings ? filterContextFields(context, settings.privacy.excludedFields) : []),
    [context, settings]
  );

  const fieldsToSend = useMemo(
    () => availableFields.filter((field) => selectedFields.has(field.logicalName)),
    [availableFields, selectedFields]
  );

  const configured = settings ? isAzureOpenAIConfigured(settings) : false;

  const toggleField = (logicalName: string) => {
    setSelectedFields((current) => {
      const next = new Set(current);
      if (next.has(logicalName)) next.delete(logicalName);
      else next.add(logicalName);
      return next;
    });
  };

  const sendPrompt = async (prompt: string, skillRun?: OddySkillRun) => {
    if (!prompt || !settings || sending) return;
    if (!configured) {
      setError('Configure Azure OpenAI before sending a request.');
      return;
    }
    if (skillRun && (!includeContext || !context?.isDataverse)) {
      setError('Enable Dataverse tools on an active Dataverse page before running a skill.');
      return;
    }

    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setNavigationProgress(undefined);
    setSending(true);
    setError(undefined);
    const userItem: TranscriptItem = { id: crypto.randomUUID(), role: 'user', content: prompt };
    setTranscript((current) => [...current, userItem]);

    try {
      const suppliedContext = includeContext && context?.isDataverse ? context : undefined;
      const history = transcript.map((item) => ({
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
      const messages = buildChatMessages(
        settings.azureOpenAI.systemPrompt,
        prompt,
        suppliedContext,
        suppliedContext ? fieldsToSend : [],
        history
      );
      const result = await sendExtensionMessage<LlmResponse>({
        type: 'LLM_CHAT',
        payload: {
          messages,
          allowDataverseTools: includeContext,
          allowSkillTools: !skillRun && allowSkillManagement,
          requestId,
          skillRun
        }
      });
      if (!result.ok || !result.data) throw new Error(result.error || 'The model returned no response.');
      if (result.data.pendingMutations?.length) {
        setMutationApprovals((current) => {
          const next = { ...current };
          for (const mutation of result.data!.pendingMutations || []) {
            next[mutation.id] ||= {
              selectedColumns: mutation.fields.map((field) => field.logicalName),
              status: 'pending'
            };
          }
          return next;
        });
      }
      if (result.data.pendingListMemberships?.length) {
        setListMembershipApprovals((current) => {
          const next = { ...current };
          for (const membership of result.data!.pendingListMemberships || []) {
            next[membership.id] ||= {
              selectedMemberIds: membership.members.map((member) => member.recordId),
              status: 'pending'
            };
          }
          return next;
        });
      }
      if (result.data.pendingSkillChanges?.length) {
        setSkillChangeApprovals((current) => {
          const next = { ...current };
          for (const change of result.data!.pendingSkillChanges || []) {
            next[change.id] ||= { status: 'pending' };
          }
          return next;
        });
      }
      setTranscript((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.data!.content,
          toolsUsed: result.data!.toolsUsed,
          pendingMutations: result.data!.pendingMutations,
          pendingListMemberships: result.data!.pendingListMemberships,
          pendingSkillChanges: result.data!.pendingSkillChanges
        }
      ]);
      if (skillRun) {
        setActiveSkill(undefined);
        setSkillInputValues({});
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      activeRequestId.current = undefined;
      setNavigationProgress(undefined);
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || !settings || sending) return;
    if (!configured) {
      setError('Configure Azure OpenAI before sending a request.');
      return;
    }
    setQuestion('');
    void sendPrompt(prompt);
  };

  const selectSkill = (skill: OddySkill) => {
    setActiveSkill(skill);
    setSkillInputValues(
      Object.fromEntries(
        skill.inputs.map((input) => [input.id, input.type === 'select' ? input.options?.[0] || '' : ''])
      )
    );
    setError(undefined);
  };

  const runActiveSkill = () => {
    if (!activeSkill) return;
    const errors = validateSkillRunInputs(activeSkill, skillInputValues);
    if (errors.length) {
      setError(errors.join(' '));
      return;
    }
    const inputSummary = activeSkill.inputs
      .map((input) => `${input.label}: ${skillInputValues[input.id] || 'Not provided'}`)
      .join('\n');
    void sendPrompt(
      `Run skill: ${activeSkill.name}\n${inputSummary}`,
      { skillId: activeSkill.id, inputValues: skillInputValues }
    );
  };

  const toggleMutationField = (mutationId: string, logicalName: string) => {
    setMutationApprovals((current) => {
      const state = current[mutationId];
      if (!state || state.status !== 'pending') return current;
      const selected = new Set(state.selectedColumns);
      if (selected.has(logicalName)) selected.delete(logicalName);
      else selected.add(logicalName);
      return {
        ...current,
        [mutationId]: { ...state, selectedColumns: [...selected], error: undefined }
      };
    });
  };

  const rejectMutation = (mutationId: string) => {
    setMutationApprovals((current) => {
      const state = current[mutationId];
      if (!state || state.status === 'approved') return current;
      return { ...current, [mutationId]: { ...state, status: 'rejected', error: undefined } };
    });
  };

  const appendMutationExecutionActivity = (mutationId: string, activity: ToolActivity) => {
    setTranscript((current) => current.map((item) =>
      item.pendingMutations?.some((mutation) => mutation.id === mutationId)
        ? { ...item, toolsUsed: [...(item.toolsUsed || []), activity] }
        : item
    ));
  };

  const appendListMembershipExecutionActivity = (membershipId: string, activity: ToolActivity) => {
    setTranscript((current) => current.map((item) =>
      item.pendingListMemberships?.some((membership) => membership.id === membershipId)
        ? { ...item, toolsUsed: [...(item.toolsUsed || []), activity] }
        : item
    ));
  };

  const appendSkillChangeExecutionActivity = (changeId: string, activity: ToolActivity) => {
    setTranscript((current) => current.map((item) =>
      item.pendingSkillChanges?.some((change) => change.id === changeId)
        ? { ...item, toolsUsed: [...(item.toolsUsed || []), activity] }
        : item
    ));
  };

  const approveMutation = async (mutation: PreparedDataverseMutation) => {
    const state = mutationApprovals[mutation.id];
    if (!state || state.selectedColumns.length === 0 || state.status !== 'pending') return;
    setMutationApprovals((current) => ({
      ...current,
      [mutation.id]: { ...state, status: 'approving', error: undefined }
    }));
    try {
      const result = await sendExtensionMessage<DataverseMutationExecutionResult>({
        type: 'EXECUTE_DATAVERSE_MUTATION',
        payload: { mutation, selectedColumns: state.selectedColumns }
      });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Dataverse did not apply the approved change.');
      }
      setMutationApprovals((current) => ({
        ...current,
        [mutation.id]: {
          ...state,
          status: 'approved',
          result: result.data,
          error: undefined
        }
      }));
      appendMutationExecutionActivity(mutation.id, {
        name: 'execute_dataverse_mutation',
        label: 'Applied approved record change',
        summary: `${result.data.changedColumns.length} field${result.data.changedColumns.length === 1 ? '' : 's'} changed`,
        details: `${result.data.tableLogicalName} ${result.data.recordId}`
      });
      void loadContext();
    } catch (approvalError) {
      const detail = errorMessage(approvalError);
      setMutationApprovals((current) => ({
        ...current,
        [mutation.id]: {
          ...state,
          status: 'error',
          error: detail
        }
      }));
      appendMutationExecutionActivity(mutation.id, {
        name: 'execute_dataverse_mutation',
        label: 'Approved record change failed',
        summary: 'Execution failed; prepare a corrected preview before retrying',
        details: detail
      });
    }
  };

  const toggleListMembershipMember = (membershipId: string, recordId: string) => {
    setListMembershipApprovals((current) => {
      const state = current[membershipId];
      if (!state || state.status !== 'pending') return current;
      const selected = new Set(state.selectedMemberIds);
      if (selected.has(recordId)) selected.delete(recordId);
      else selected.add(recordId);
      return {
        ...current,
        [membershipId]: { ...state, selectedMemberIds: [...selected], error: undefined }
      };
    });
  };

  const rejectListMembership = (membershipId: string) => {
    setListMembershipApprovals((current) => {
      const state = current[membershipId];
      if (!state || state.status !== 'pending') return current;
      return { ...current, [membershipId]: { ...state, status: 'rejected', error: undefined } };
    });
  };

  const approveListMembership = async (membership: PreparedMarketingListMembership) => {
    const state = listMembershipApprovals[membership.id];
    if (!state || state.selectedMemberIds.length === 0 || state.status !== 'pending') return;
    setListMembershipApprovals((current) => ({
      ...current,
      [membership.id]: { ...state, status: 'approving', error: undefined }
    }));
    try {
      const result = await sendExtensionMessage<MarketingListMembershipExecutionResult>({
        type: 'EXECUTE_MARKETING_LIST_MEMBERSHIP',
        payload: { membership, selectedMemberIds: state.selectedMemberIds }
      });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Dataverse did not add the approved marketing-list members.');
      }
      setListMembershipApprovals((current) => ({
        ...current,
        [membership.id]: {
          ...state,
          status: 'approved',
          result: result.data,
          error: undefined
        }
      }));
      appendListMembershipExecutionActivity(membership.id, {
        name: 'execute_marketing_list_membership',
        label: `Added members to ${result.data.listName}`,
        summary: `${result.data.addedMemberIds.length} member${result.data.addedMemberIds.length === 1 ? '' : 's'} added with AddListMembersList`,
        details: result.data.addedMemberNames.join('; ')
      });
      void loadContext();
    } catch (approvalError) {
      const detail = errorMessage(approvalError);
      setListMembershipApprovals((current) => ({
        ...current,
        [membership.id]: {
          ...state,
          status: 'error',
          error: detail
        }
      }));
      appendListMembershipExecutionActivity(membership.id, {
        name: 'execute_marketing_list_membership',
        label: 'Approved marketing-list membership failed',
        summary: 'Bulk execution failed; prepare a fresh preview before retrying',
        details: detail
      });
    }
  };

  const rejectSkillChange = (changeId: string) => {
    setSkillChangeApprovals((current) => {
      const state = current[changeId];
      if (!state || state.status === 'approved') return current;
      return { ...current, [changeId]: { ...state, status: 'rejected', error: undefined } };
    });
  };

  const approveSkillChange = async (change: PreparedOddySkillChange) => {
    const state = skillChangeApprovals[change.id];
    if (!state || state.status !== 'pending') return;
    setSkillChangeApprovals((current) => ({
      ...current,
      [change.id]: { ...state, status: 'approving', error: undefined }
    }));
    try {
      const result = await sendExtensionMessage<OddySkillChangeExecutionResult>({
        type: 'EXECUTE_ODDY_SKILL_CHANGE',
        payload: { change }
      });
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Oddy did not apply the approved skill change.');
      }
      setSkillChangeApprovals((current) => ({
        ...current,
        [change.id]: {
          ...state,
          status: 'approved',
          result: result.data,
          error: undefined
        }
      }));
      appendSkillChangeExecutionActivity(change.id, {
        name: 'execute_oddy_skill_change',
        label: 'Applied approved skill change',
        summary: `${result.data.skillName} was ${result.data.operation === 'create' ? 'created' : result.data.operation === 'update' ? 'updated' : 'deleted'}`,
        details: result.data.skillId
      });
      void loadSkills();
    } catch (approvalError) {
      const detail = errorMessage(approvalError);
      setSkillChangeApprovals((current) => ({
        ...current,
        [change.id]: {
          ...state,
          status: 'error',
          error: detail
        }
      }));
      appendSkillChangeExecutionActivity(change.id, {
        name: 'execute_oddy_skill_change',
        label: 'Approved skill change failed',
        summary: 'Execution failed; prepare a fresh preview before retrying',
        details: detail
      });
    }
  };

  const removeStoredConversation = async (id: string) => {
    deletedConversationIds.current.add(id);
    try {
      await deleteConversation(id);
      if (id === conversationId) startNewConversation();
      else await loadConversationHistory();
    } catch (historyError) {
      deletedConversationIds.current.delete(id);
      setError(errorMessage(historyError));
    }
  };

  const removeAllStoredConversations = async () => {
    if (!globalThis.confirm('Delete all locally stored Oddy conversations?')) return;
    for (const conversation of conversationHistory) {
      deletedConversationIds.current.add(conversation.id);
    }
    if (transcript.length > 0) deletedConversationIds.current.add(conversationId);
    try {
      await clearConversations();
      setConversationHistory([]);
      startNewConversation();
    } catch (historyError) {
      setError(errorMessage(historyError));
    }
  };

  return (
    <main className="panel-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/icons/oddy.svg" alt="" aria-hidden="true" />
          <div>
            <strong>Oddy</strong>
            <span>Dataverse navigator</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-button"
            title="Conversation history"
            disabled={sending}
            onClick={() => {
              const nextOpen = !historyOpen;
              setHistoryOpen(nextOpen);
              if (nextOpen) void loadConversationHistory();
            }}
          >
            ◷
          </button>
          {transcript.length > 0 && (
            <button
              type="button"
              className="icon-button"
              title="Start a new conversation"
              disabled={sending}
              onClick={startNewConversation}
            >
              ＋
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title="Open settings"
            onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}
          >
            ⚙
          </button>
        </div>
      </header>

      {historyOpen && (
        <section className="history-drawer">
          <div className="history-heading">
            <div>
              <p className="eyebrow">Local history</p>
              <strong>Past conversations</strong>
            </div>
            {conversationHistory.length > 0 && (
              <button type="button" className="history-clear" disabled={sending} onClick={() => void removeAllStoredConversations()}>
                Clear all
              </button>
            )}
          </div>

          {!settings?.conversationHistory.enabled && (
            <div className="history-notice">
              History saving is disabled. Existing local conversations remain available until deleted.
              <button type="button" onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}>Open settings</button>
            </div>
          )}

          {historyLoading ? (
            <p className="history-empty">Loading history…</p>
          ) : conversationHistory.length === 0 ? (
            <p className="history-empty">No saved conversations.</p>
          ) : (
            <div className="history-list">
              {conversationHistory.map((conversation) => (
                <article key={conversation.id} className={conversation.id === conversationId ? 'current' : undefined}>
                  <button type="button" className="history-open" disabled={sending} onClick={() => void loadStoredConversation(conversation.id)}>
                    <strong>{conversation.title}</strong>
                    <span>
                      {new Date(conversation.updatedAt).toLocaleString()} · {conversation.messageCount} messages
                    </span>
                    {(conversation.environmentName || conversation.tableLogicalName) && (
                      <small>{[conversation.environmentName, conversation.tableLogicalName].filter(Boolean).join(' · ')}</small>
                    )}
                  </button>
                  <button
                    type="button"
                    className="history-delete"
                    title={`Delete ${conversation.title}`}
                    disabled={sending}
                    onClick={() => void removeStoredConversation(conversation.id)}
                  >
                    ×
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {!configured && (
        <section className="setup-banner">
          <div>
            <strong>Connect Azure OpenAI</strong>
            <p>Add an endpoint, deployment, and API key to start using AI actions.</p>
          </div>
          <button type="button" onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}>
            Configure
          </button>
        </section>
      )}

      <section className="context-card">
        <div className="context-heading">
          <div>
            <p className="eyebrow">Active context</p>
            <h1>
              {loadingContext
                ? 'Inspecting page…'
                : context?.isDataverse
                  ? context.recordName || context.tableLogicalName || 'Dataverse page'
                  : 'No Dataverse page detected'}
            </h1>
          </div>
          <button
            type="button"
            className="icon-button subtle"
            title="Refresh context"
            disabled={loadingContext}
            onClick={() => void loadContext(settings)}
          >
            ↻
          </button>
        </div>

        {context?.isDataverse && (
          <div className="context-meta">
            {context.tableLogicalName && <span>{context.tableLogicalName}</span>}
            {context.formName && <span>{context.formName}</span>}
            {context.environmentName && <span>{context.environmentName}</span>}
            <span>
              {context.source === 'webApi'
                ? 'Dataverse Web API'
                : context.source === 'xrm'
                  ? 'Form context'
                  : 'URL context'}
            </span>
          </div>
        )}

        {context?.warning && <p className="context-warning">{context.warning}</p>}
      </section>

      <section className="skill-section">
        <div className="skill-section-heading">
          <p className="section-label">Skills</p>
          <button
            type="button"
            onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}
          >
            Manage
          </button>
        </div>
        <div className="skill-grid">
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              disabled={sending}
              className={activeSkill?.id === skill.id ? 'active' : undefined}
              onClick={() => selectSkill(skill)}
            >
              <strong>{skill.name}</strong>
              <span>{skill.description}</span>
              <small>{skill.source === 'built-in' ? 'Built in' : 'Custom'}</small>
            </button>
          ))}
        </div>

        {activeSkill && (
          <section className="skill-runner">
            <div className="skill-runner-heading">
              <div>
                <strong>{activeSkill.name}</strong>
                <span>{activeSkill.steps.length} workflow steps · {activeSkill.allowedTools.length} allowed tools</span>
              </div>
              <button
                type="button"
                className="skill-close"
                title="Close skill"
                onClick={() => {
                  setActiveSkill(undefined);
                  setSkillInputValues({});
                }}
              >
                ×
              </button>
            </div>

            <div className="skill-inputs">
              {activeSkill.inputs.map((input) => (
                <label key={input.id}>
                  <span>{input.label}{input.required ? ' *' : ''}</span>
                  {input.type === 'select' ? (
                    <select
                      value={skillInputValues[input.id] || ''}
                      onChange={(event) =>
                        setSkillInputValues((current) => ({
                          ...current,
                          [input.id]: event.target.value
                        }))
                      }
                    >
                      {(input.options || []).map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={input.type}
                      value={skillInputValues[input.id] || ''}
                      onChange={(event) =>
                        setSkillInputValues((current) => ({
                          ...current,
                          [input.id]: event.target.value
                        }))
                      }
                    />
                  )}
                </label>
              ))}
            </div>

            <div className="skill-runner-actions">
              <small>Runs only the tools allowed by this skill. Record writes still require approval.</small>
              <button
                type="button"
                disabled={sending || !configured || !includeContext || !context?.isDataverse}
                onClick={runActiveSkill}
              >
                {sending ? 'Running…' : 'Run skill'}
              </button>
            </div>
          </section>
        )}
      </section>

      {transcript.length > 0 && (
        <section className="transcript" aria-live="polite">
          {transcript.map((item) => (
            <article key={item.id} className={`message ${item.role}`}>
              <span>{item.role === 'assistant' ? 'Oddy' : 'You'}</span>
              <div className={item.role === 'assistant' ? 'markdown-body' : undefined}>
                {item.role === 'assistant' ? (
                  <>
                    {item.toolsUsed && item.toolsUsed.length > 0 && (
                      <div className="tool-activity">
                        {item.toolsUsed.map((tool, index) => (
                          <span key={`${tool.name}-${index}`} title={tool.details || tool.label}>
                            <strong>{tool.label}</strong>
                            {tool.summary}
                            {tool.details && <small>{tool.details}</small>}
                          </span>
                        ))}
                      </div>
                    )}
                    <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ children, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      )
                    }}
                  >
                      {normalizeMarkdown(item.content)}
                    </ReactMarkdown>
                    {item.pendingMutations && item.pendingMutations.length > 0 && (
                      <div className="mutation-list">
                        {item.pendingMutations.map((mutation) => {
                          const approval = mutationApprovals[mutation.id] || {
                            selectedColumns: mutation.fields.map((field) => field.logicalName),
                            status: 'pending' as const
                          };
                          const editable = !item.historical && approval.status === 'pending';
                          return (
                            <section
                              key={mutation.id}
                              className={`mutation-card ${approval.status}`}
                            >
                              <div className="mutation-heading">
                                <div>
                                  <strong>
                                    {mutation.operation === 'create' ? 'Create' : 'Update'}{' '}
                                    {mutation.tableDisplayName || mutation.tableLogicalName}
                                  </strong>
                                  <small>
                                    {mutation.recordName || mutation.recordId || 'New record'}
                                  </small>
                                </div>
                                <span>{approval.status === 'approved' ? 'Applied' : approval.status === 'rejected' ? 'Rejected' : approval.status === 'error' ? 'Failed' : item.historical ? 'Expired preview' : 'Approval required'}</span>
                              </div>

                              <div className="mutation-fields">
                                {mutation.fields.map((field) => {
                                  const selected = approval.selectedColumns.includes(field.logicalName);
                                  return (
                                    <label key={field.logicalName} className={!selected ? 'excluded' : undefined}>
                                      <input
                                        type="checkbox"
                                        checked={selected}
                                        disabled={!editable}
                                        onChange={() => toggleMutationField(mutation.id, field.logicalName)}
                                      />
                                      <span className="mutation-field-name">
                                        <strong>{field.displayName || field.logicalName}</strong>
                                        <small>{field.logicalName}</small>
                                      </span>
                                      <span className="mutation-values">
                                        {mutation.operation === 'update' && (
                                          <span className="before-value">
                                            {field.currentFormattedValue || formatPreviewValue(field.currentValue)}
                                          </span>
                                        )}
                                        {mutation.operation === 'update' && <b aria-hidden="true">→</b>}
                                        <span className="after-value">
                                          {field.proposedFormattedValue || formatPreviewValue(field.proposedValue, 'Empty text', 'Clear value')}
                                        </span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>

                              <p className="mutation-note">
                                {item.historical
                                  ? 'This is a historical preview. Ask Oddy to prepare a fresh preview before making changes.'
                                  : 'Only selected fields will be written using your current Dataverse permissions.'}
                              </p>
                              {approval.error && <p className="mutation-error">{approval.error}</p>}
                              {approval.status === 'approved' && approval.result && (
                                <>
                                  <p className="mutation-success">
                                    {approval.result.operation === 'create' ? 'Created' : 'Updated'} record{' '}
                                    {approval.result.recordName || approval.result.recordId}.
                                  </p>
                                  {approval.result.refreshMessage && (
                                    <p className={`mutation-refresh ${approval.result.refreshStatus || ''}`}>
                                      {approval.result.refreshMessage}
                                    </p>
                                  )}
                                </>
                              )}
                              {editable && (
                                <div className="mutation-actions">
                                  <button
                                    type="button"
                                    className="mutation-reject"
                                    onClick={() => rejectMutation(mutation.id)}
                                  >
                                    Reject
                                  </button>
                                  <button
                                    type="button"
                                    className="mutation-approve"
                                    disabled={approval.selectedColumns.length === 0}
                                    onClick={() => void approveMutation(mutation)}
                                  >
                                    Approve {approval.selectedColumns.length} field{approval.selectedColumns.length === 1 ? '' : 's'}
                                  </button>
                                </div>
                              )}
                              {approval.status === 'approving' && (
                                <p className="mutation-applying">Applying approved changes…</p>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                    {item.pendingListMemberships && item.pendingListMemberships.length > 0 && (
                      <div className="mutation-list">
                        {item.pendingListMemberships.map((membership) => {
                          const approval = listMembershipApprovals[membership.id] || {
                            selectedMemberIds: membership.members.map((member) => member.recordId),
                            status: 'pending' as const
                          };
                          const editable = !item.historical && approval.status === 'pending';
                          return (
                            <section key={membership.id} className={`mutation-card ${approval.status}`}>
                              <div className="mutation-heading">
                                <div>
                                  <strong>Add members to {membership.listName}</strong>
                                  <small>{membership.memberTableDisplayName || membership.memberTableLogicalName}</small>
                                </div>
                                <span>{approval.status === 'approved' ? 'Applied' : approval.status === 'rejected' ? 'Rejected' : approval.status === 'error' ? 'Failed' : item.historical ? 'Expired preview' : 'Approval required'}</span>
                              </div>

                              <div className="membership-members">
                                {membership.members.map((member) => {
                                  const selected = approval.selectedMemberIds.includes(member.recordId);
                                  return (
                                    <label key={member.recordId} className={!selected ? 'excluded' : undefined}>
                                      <input
                                        type="checkbox"
                                        checked={selected}
                                        disabled={!editable}
                                        onChange={() => toggleListMembershipMember(membership.id, member.recordId)}
                                      />
                                      <span>
                                        <strong>{member.recordName || member.recordId}</strong>
                                        <small>{member.tableLogicalName} · {member.recordId}</small>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>

                              <p className="mutation-note">
                                {item.historical
                                  ? 'This historical membership preview cannot be applied. Prepare a fresh preview to continue.'
                                  : 'All selected members will be submitted in one Dataverse AddListMembersList action.'}
                              </p>
                              {membership.alreadyMembers.length > 0 && (
                                <p className="mutation-note">
                                  {membership.alreadyMembers.length} existing member{membership.alreadyMembers.length === 1 ? '' : 's'} excluded: {membership.alreadyMembers.map((member) => member.recordName || member.recordId).join(', ')}.
                                </p>
                              )}
                              {approval.error && <p className="mutation-error">{approval.error}</p>}
                              {approval.status === 'approved' && approval.result && (
                                <p className="mutation-success">
                                  Added {approval.result.addedMemberIds.length} member{approval.result.addedMemberIds.length === 1 ? '' : 's'} to {approval.result.listName}.
                                </p>
                              )}
                              {editable && (
                                <div className="mutation-actions">
                                  <button type="button" className="mutation-reject" onClick={() => rejectListMembership(membership.id)}>
                                    Reject
                                  </button>
                                  <button
                                    type="button"
                                    className="mutation-approve"
                                    disabled={approval.selectedMemberIds.length === 0}
                                    onClick={() => void approveListMembership(membership)}
                                  >
                                    Approve {approval.selectedMemberIds.length} member{approval.selectedMemberIds.length === 1 ? '' : 's'}
                                  </button>
                                </div>
                              )}
                              {approval.status === 'approving' && (
                                <p className="mutation-applying">Adding approved members in one bulk action…</p>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                    {item.pendingSkillChanges && item.pendingSkillChanges.length > 0 && (
                      <div className="skill-change-list">
                        {item.pendingSkillChanges.map((change) => {
                          const approval = skillChangeApprovals[change.id] || { status: 'pending' as const };
                          const editable = !item.historical && approval.status === 'pending';
                          const preview = change.after || change.before;
                          return (
                            <section key={change.id} className={`skill-change-card ${approval.status}`}>
                              <div className="skill-change-heading">
                                <div>
                                  <strong>{change.operation === 'create' ? 'Create' : change.operation === 'update' ? 'Update' : 'Delete'} custom skill</strong>
                                  <small>{preview?.name || change.skillId}</small>
                                </div>
                                <span>{approval.status === 'approved' ? 'Applied' : approval.status === 'rejected' ? 'Rejected' : approval.status === 'error' ? 'Failed' : item.historical ? 'Expired preview' : 'Approval required'}</span>
                              </div>
                              <div className="skill-change-details">
                                <div><span>Skill ID</span><code>{change.skillId}</code></div>
                                <div><span>Name</span><strong>{change.before?.name || 'New'} → {change.after?.name || 'Deleted'}</strong></div>
                                <div><span>Version</span><strong>{change.before?.version || 'New'} → {change.after?.version || 'Deleted'}</strong></div>
                                <div><span>Inputs</span><strong>{change.before?.inputs.length ?? 0} → {change.after?.inputs.length ?? 0}</strong></div>
                                <div><span>Steps</span><strong>{change.before?.steps.length ?? 0} → {change.after?.steps.length ?? 0}</strong></div>
                                <div className="skill-change-tools">
                                  <span>Allowed tools before change</span>
                                  <small>{change.before?.allowedTools.join(', ') || 'None'}</small>
                                </div>
                                <div className="skill-change-tools">
                                  <span>Allowed tools after change</span>
                                  <small>{change.after?.allowedTools.join(', ') || 'None — skill will be deleted'}</small>
                                </div>
                                {change.after && (
                                  <>
                                    <div className="skill-change-tools">
                                      <span>Proposed description</span>
                                      <small>{change.after.description}</small>
                                    </div>
                                    <div className="skill-change-tools">
                                      <span>Proposed instructions</span>
                                      <small>{change.after.instructions}</small>
                                    </div>
                                  </>
                                )}
                                {change.after && (
                                  <div className="skill-change-workflow">
                                    <span>Proposed workflow</span>
                                    <ol>
                                      {change.after.steps.map((step) => <li key={step.id}>{step.instruction}</li>)}
                                    </ol>
                                  </div>
                                )}
                              </div>
                              <p className="mutation-note">{item.historical ? 'This historical skill preview cannot be applied. Prepare a fresh preview to continue.' : 'Only this custom skill will change. Bundled skills and extension settings are not accessible.'}</p>
                              {approval.error && <p className="mutation-error">{approval.error}</p>}
                              {approval.status === 'approved' && approval.result && (
                                <p className="mutation-success">{approval.result.skillName} was {approval.result.operation === 'create' ? 'created' : approval.result.operation === 'update' ? 'updated' : 'deleted'}.</p>
                              )}
                              {editable && (
                                <div className="mutation-actions">
                                  <button type="button" className="mutation-reject" onClick={() => rejectSkillChange(change.id)}>Reject</button>
                                  <button type="button" className={change.operation === 'delete' ? 'skill-delete-approve' : 'mutation-approve'} onClick={() => void approveSkillChange(change)}>
                                    Approve {change.operation}
                                  </button>
                                </div>
                              )}
                              {approval.status === 'approving' && <p className="mutation-applying">Applying approved skill change…</p>}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  item.content
                )}
              </div>
            </article>
          ))}
          {sending && (
            <article className="message assistant pending">
              <span>Oddy</span>
              <div className={navigationProgress ? `navigation-progress ${navigationProgress.stage}` : undefined}>
                {navigationProgress ? (
                  <>
                    <strong>{navigationProgress.label}</strong>
                    {navigationProgress.detail && <small>{navigationProgress.detail}</small>}
                  </>
                ) : (
                  <>Thinking<span className="dots">…</span></>
                )}
              </div>
            </article>
          )}
        </section>
      )}

      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="question">Ask about Dataverse</label>
        <textarea
          id="question"
          rows={4}
          placeholder="Ask Oddy… Enter to send, Shift+Enter for a new line."
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />

        <label className="context-toggle">
          <input
            type="checkbox"
            checked={includeContext}
            disabled={!context?.isDataverse}
            onChange={(event) => setIncludeContext(event.target.checked)}
          />
          <span>Include record context and allow Dataverse tools</span>
        </label>
        {includeContext && context?.isDataverse && (
          <small className="tool-consent">
            Dataverse primitives may run queries, manage the AI Result personal view, prepare record changes for your approval, and navigate the active tab. Business-record writes only run after you approve the preview.
          </small>
        )}

        <label className="context-toggle">
          <input
            type="checkbox"
            checked={allowSkillManagement}
            onChange={(event) => setAllowSkillManagement(event.target.checked)}
          />
          <span>Allow Oddy to inspect and propose custom skill changes</span>
        </label>
        {allowSkillManagement && (
          <small className="tool-consent">
            Oddy can read custom skills and prepare create, update, or delete previews. Local skill storage changes only after you approve the preview.
          </small>
        )}

        {includeContext && context?.isDataverse && (
          <details className="data-preview">
            <summary>{fieldsToSend.length} of {availableFields.length} fields will be sent</summary>
            {availableFields.length > 0 && (
              <div className="field-picker">
                {availableFields.map((field) => (
                  <label key={field.logicalName} title={field.logicalName}>
                    <input
                      type="checkbox"
                      checked={selectedFields.has(field.logicalName)}
                      onChange={() => toggleField(field.logicalName)}
                    />
                    <span>{field.label}</span>
                    <code>{field.logicalName}</code>
                  </label>
                ))}
              </div>
            )}
            <pre>{contextAsText(context, fieldsToSend)}</pre>
          </details>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="composer-footer">
          <span>Ctrl/⌘ + Enter to send</span>
          <button type="submit" disabled={!question.trim() || sending || !configured}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      <footer className="privacy-footer">
        Review the data preview before sending record information.
        {settings?.conversationHistory.enabled && ' Conversation history is saved locally in this Chrome profile.'}
      </footer>
    </main>
  );
}
