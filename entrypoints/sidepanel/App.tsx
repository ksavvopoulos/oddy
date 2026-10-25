import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { TranscriptMessage } from './TranscriptMessage';
import {
  clearConversations,
  deleteConversation,
  getConversation,
  listConversations,
  saveConversation,
  type ConversationSummary,
  type StoredConversation
} from '../../lib/conversations';
import {
  conversationMessages,
  restoreConversation,
  type StoredTranscriptItem as TranscriptItem
} from '../../lib/conversation-model';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import { buildChatMessages, contextAsText, filterContextFields } from '../../lib/prompts';
import { getAvailableSkills, SKILLS_KEY, validateSkillRunInputs } from '../../lib/skills';
import { getSettings, isAzureOpenAIConfigured, SETTINGS_KEY } from '../../lib/storage';
import type {
  DataverseContext,
  ExtensionMessage,
  ExtensionSettings,
  LlmResponse,
  NavigationProgress,
  OddySkill,
  OddySkillRun
} from '../../lib/types';

import { useApprovals } from './useApprovals';

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
  const [skills, setSkills] = useState<OddySkill[]>([]);
  const [activeSkill, setActiveSkill] = useState<OddySkill>();
  const [skillInputValues, setSkillInputValues] = useState<Record<string, string>>({});
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [conversationCreatedAt, setConversationCreatedAt] = useState(() =>
    new Date().toISOString()
  );
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
      const restored = restoreConversation(stored);
      setTranscript(restored.transcript);
      setMutationApprovals(restored.mutationApprovals);
      setListMembershipApprovals(restored.listMembershipApprovals);
      setSkillChangeApprovals(restored.skillChangeApprovals);
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
      if (!result.ok || !result.data)
        throw new Error(result.error || 'Could not inspect the active tab.');
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

  const approvals = useApprovals({ transcript, setTranscript, loadContext, loadSkills });
  const {
    mutationApprovals,
    setMutationApprovals,
    listMembershipApprovals,
    setListMembershipApprovals,
    skillChangeApprovals,
    setSkillChangeApprovals,
    registerResponse,
    approving
  } = approvals;
  const busy = sending || approving;

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
    () =>
      context && settings ? filterContextFields(context, settings.privacy.excludedFields) : [],
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
    if (!prompt || !settings || busy) return;
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
      const history = conversationMessages(transcript);
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
      if (!result.ok || !result.data)
        throw new Error(result.error || 'The model returned no response.');
      registerResponse(result.data);
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
    if (!prompt || !settings || busy) return;
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
        skill.inputs.map((input) => [
          input.id,
          input.type === 'select' ? input.options?.[0] || '' : ''
        ])
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
    void sendPrompt(`Run skill: ${activeSkill.name}\n${inputSummary}`, {
      skillId: activeSkill.id,
      inputValues: skillInputValues
    });
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
            disabled={busy}
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
              disabled={busy}
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
              <button
                type="button"
                className="history-clear"
                disabled={busy}
                onClick={() => void removeAllStoredConversations()}
              >
                Clear all
              </button>
            )}
          </div>

          {!settings?.conversationHistory.enabled && (
            <div className="history-notice">
              History saving is disabled. Existing local conversations remain available until
              deleted.
              <button
                type="button"
                onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}
              >
                Open settings
              </button>
            </div>
          )}

          {historyLoading ? (
            <p className="history-empty">Loading history…</p>
          ) : conversationHistory.length === 0 ? (
            <p className="history-empty">No saved conversations.</p>
          ) : (
            <div className="history-list">
              {conversationHistory.map((conversation) => (
                <article
                  key={conversation.id}
                  className={conversation.id === conversationId ? 'current' : undefined}
                >
                  <button
                    type="button"
                    className="history-open"
                    disabled={busy}
                    onClick={() => void loadStoredConversation(conversation.id)}
                  >
                    <strong>{conversation.title}</strong>
                    <span>
                      {new Date(conversation.updatedAt).toLocaleString()} ·{' '}
                      {conversation.messageCount} messages
                    </span>
                    {(conversation.environmentName || conversation.tableLogicalName) && (
                      <small>
                        {[conversation.environmentName, conversation.tableLogicalName]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    )}
                  </button>
                  <button
                    type="button"
                    className="history-delete"
                    title={`Delete ${conversation.title}`}
                    disabled={busy}
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
          <button type="button" onClick={() => void sendExtensionMessage({ type: 'OPEN_OPTIONS' })}>
            Manage
          </button>
        </div>
        <div className="skill-grid">
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              disabled={busy}
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
                <span>
                  {activeSkill.steps.length} workflow steps · {activeSkill.allowedTools.length}{' '}
                  allowed tools
                </span>
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
                  <span>
                    {input.label}
                    {input.required ? ' *' : ''}
                  </span>
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
                        <option key={option} value={option}>
                          {option}
                        </option>
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
              <small>
                Runs only the tools allowed by this skill. Record writes still require approval.
              </small>
              <button
                type="button"
                disabled={busy || !configured || !includeContext || !context?.isDataverse}
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
            <TranscriptMessage key={item.id} item={item} approvals={approvals} />
          ))}
          {sending && (
            <article className="message assistant pending">
              <span>Oddy</span>
              <div
                className={
                  navigationProgress ? `navigation-progress ${navigationProgress.stage}` : undefined
                }
              >
                {navigationProgress ? (
                  <>
                    <strong>{navigationProgress.label}</strong>
                    {navigationProgress.detail && <small>{navigationProgress.detail}</small>}
                  </>
                ) : (
                  <>
                    Thinking<span className="dots">…</span>
                  </>
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
            Dataverse primitives may run queries, manage the AI Result personal view, prepare record
            changes for your approval, and navigate the active tab. Business-record writes only run
            after you approve the preview.
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
            Oddy can read custom skills and prepare create, update, or delete previews. Local skill
            storage changes only after you approve the preview.
          </small>
        )}

        {includeContext && context?.isDataverse && (
          <details className="data-preview">
            <summary>
              {fieldsToSend.length} of {availableFields.length} fields will be sent
            </summary>
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
        {settings?.conversationHistory.enabled &&
          ' Conversation history is saved locally in this Chrome profile.'}
      </footer>
    </main>
  );
}
