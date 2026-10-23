import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import {
  buildChatMessages,
  contextAsText,
  filterContextFields,
  QUICK_ACTIONS
} from '../../lib/prompts';
import { getSettings, isAzureOpenAIConfigured } from '../../lib/storage';
import type {
  DataverseContext,
  DataverseMutationExecutionResult,
  ExtensionMessage,
  ExtensionSettings,
  LlmResponse,
  NavigationProgress,
  PreparedDataverseMutation,
  ToolActivity
} from '../../lib/types';

interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolActivity[];
  pendingMutations?: PreparedDataverseMutation[];
}

interface MutationApprovalState {
  selectedColumns: string[];
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: DataverseMutationExecutionResult;
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
  if (typeof value === 'object') return JSON.stringify(value);
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
  const [question, setQuestion] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [loadingContext, setLoadingContext] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [navigationProgress, setNavigationProgress] = useState<NavigationProgress>();
  const [mutationApprovals, setMutationApprovals] = useState<Record<string, MutationApprovalState>>({});
  const activeRequestId = useRef<string | undefined>(undefined);

  const loadSettings = useCallback(async () => {
    const loaded = await getSettings();
    setSettings(loaded);
    setIncludeContext(loaded.privacy.includeRecordContextByDefault);
    return loaded;
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

    const messageListener = (message: ExtensionMessage) => {
      if (message.type === 'CONTEXT_CHANGED') void loadContext();
      if (
        message.type === 'NAVIGATION_STATUS' &&
        message.payload.requestId === activeRequestId.current
      ) {
        setNavigationProgress(message.payload);
      }
    };
    const storageListener = () => void loadSettings();

    chrome.runtime.onMessage.addListener(messageListener);
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, [loadContext, loadSettings]);

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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || !settings || sending) return;
    if (!configured) {
      setError('Configure Azure OpenAI before sending a request.');
      return;
    }

    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setNavigationProgress(undefined);
    setSending(true);
    setError(undefined);
    setQuestion('');
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
          requestId
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
      setTranscript((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.data!.content,
          toolsUsed: result.data!.toolsUsed,
          pendingMutations: result.data!.pendingMutations
        }
      ]);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      activeRequestId.current = undefined;
      setNavigationProgress(undefined);
      setSending(false);
    }
  };

  const toggleMutationField = (mutationId: string, logicalName: string) => {
    setMutationApprovals((current) => {
      const state = current[mutationId];
      if (!state || state.status !== 'pending' && state.status !== 'error') return current;
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

  const approveMutation = async (mutation: PreparedDataverseMutation) => {
    const state = mutationApprovals[mutation.id];
    if (!state || state.selectedColumns.length === 0 || state.status === 'approving') return;
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
      void loadContext();
    } catch (approvalError) {
      setMutationApprovals((current) => ({
        ...current,
        [mutation.id]: {
          ...state,
          status: 'error',
          error: errorMessage(approvalError)
        }
      }));
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
          {transcript.length > 0 && (
            <button
              type="button"
              className="icon-button"
              title="Start a new conversation"
              onClick={() => {
                setTranscript([]);
                setMutationApprovals({});
                setError(undefined);
              }}
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

      <section className="quick-section">
        <p className="section-label">Quick actions</p>
        <div className="quick-grid">
          {QUICK_ACTIONS.map((action) => (
            <button key={action.id} type="button" onClick={() => setQuestion(action.prompt)}>
              {action.label}
            </button>
          ))}
        </div>
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
                          const editable = approval.status === 'pending' || approval.status === 'error';
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
                                <span>{approval.status === 'approved' ? 'Applied' : approval.status === 'rejected' ? 'Rejected' : 'Approval required'}</span>
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
                                          {formatPreviewValue(field.proposedValue, 'Empty text', 'Clear value')}
                                        </span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>

                              <p className="mutation-note">
                                Only selected fields will be written using your current Dataverse permissions.
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

      <footer className="privacy-footer">Review the data preview before sending record information.</footer>
    </main>
  );
}
