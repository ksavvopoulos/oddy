import { useEffect, useState } from 'react';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../../lib/storage';
import type { ExtensionSettings, LlmResponse } from '../../lib/types';

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [excludedFieldsText, setExcludedFieldsText] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string }>();

  useEffect(() => {
    void getSettings().then((loaded) => {
      setSettings(loaded);
      setExcludedFieldsText(loaded.privacy.excludedFields.join('\n'));
    });
  }, []);

  const updateAzure = <K extends keyof ExtensionSettings['azureOpenAI']>(
    key: K,
    value: ExtensionSettings['azureOpenAI'][K]
  ) => {
    setSettings((current) => ({
      ...current,
      azureOpenAI: { ...current.azureOpenAI, [key]: value }
    }));
  };

  const settingsForSave = (): ExtensionSettings => ({
    ...settings,
    privacy: {
      ...settings.privacy,
      excludedFields: excludedFieldsText
        .split(/[\n,]/)
        .map((field) => field.trim())
        .filter(Boolean)
    }
  });

  const handleSave = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const next = settingsForSave();
      await saveSettings(next);
      setSettings(next);
      setStatus({ kind: 'success', message: 'Settings saved locally in this Chrome profile.' });
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await sendExtensionMessage<LlmResponse>({
        type: 'TEST_LLM_CONNECTION',
        payload: settings.azureOpenAI
      });
      if (!result.ok) throw new Error(result.error || 'Connection test failed.');
      setStatus({ kind: 'success', message: result.data?.content || 'Connection successful.' });
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="settings-shell">
      <header className="hero">
        <img className="brand-mark" src="/icons/oddy.svg" alt="" aria-hidden="true" />
        <div>
          <p className="eyebrow">Oddy</p>
          <h1>Extension settings</h1>
          <p>Connect an Azure OpenAI deployment and choose what record data may be included.</p>
        </div>
      </header>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="step">01</p>
            <h2>Azure OpenAI</h2>
          </div>
          <span className="pill">API key authentication</span>
        </div>

        <div className="field-grid">
          <label className="field field-wide">
            <span>Endpoint</span>
            <input
              type="url"
              placeholder="https://your-resource.openai.azure.com"
              value={settings.azureOpenAI.endpoint}
              onChange={(event) => updateAzure('endpoint', event.target.value)}
            />
            <small>Enter the base resource endpoint, without an API path.</small>
          </label>

          <label className="field">
            <span>Deployment name</span>
            <input
              placeholder="gpt-4o"
              value={settings.azureOpenAI.deployment}
              onChange={(event) => updateAzure('deployment', event.target.value)}
            />
          </label>

          <label className="field">
            <span>API version</span>
            <input
              value={settings.azureOpenAI.apiVersion}
              onChange={(event) => updateAzure('apiVersion', event.target.value)}
            />
          </label>

          <label className="field field-wide">
            <span>API key</span>
            <div className="secret-input">
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                value={settings.azureOpenAI.apiKey}
                onChange={(event) => updateAzure('apiKey', event.target.value)}
              />
              <button type="button" className="text-button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <small>The key is stored in <code>chrome.storage.local</code> and is never synced.</small>
          </label>

          <label className="field field-wide">
            <span>System prompt</span>
            <textarea
              rows={5}
              value={settings.azureOpenAI.systemPrompt}
              onChange={(event) => updateAzure('systemPrompt', event.target.value)}
            />
          </label>

          <label className="field">
            <span>Temperature: {settings.azureOpenAI.temperature.toFixed(1)}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settings.azureOpenAI.temperature}
              onChange={(event) => updateAzure('temperature', Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="step">02</p>
            <h2>Data controls</h2>
          </div>
        </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.privacy.includeRecordContextByDefault}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                privacy: {
                  ...current.privacy,
                  includeRecordContextByDefault: event.target.checked
                }
              }))
            }
          />
          <span>
            <strong>Include record context by default</strong>
            <small>The side panel previews outbound context. Any proposed business-record create or update receives a separate field-level approval before it can run.</small>
          </span>
        </label>

        <label className="field">
          <span>Always excluded field logical names</span>
          <textarea
            rows={5}
            placeholder={'creditcardnumber\nsecret_notes\nssn'}
            value={excludedFieldsText}
            onChange={(event) => setExcludedFieldsText(event.target.value)}
          />
          <small>Use one field per line, or separate values with commas.</small>
        </label>
      </section>

      {status && <div className={`status ${status.kind}`}>{status.message}</div>}

      <footer className="actions">
        <button type="button" className="secondary" disabled={busy} onClick={handleTest}>
          Test connection
        </button>
        <button type="button" className="primary" disabled={busy} onClick={handleSave}>
          {busy ? 'Working…' : 'Save settings'}
        </button>
      </footer>

      <aside className="security-note">
        <strong>Security note</strong>
        <p>
          API keys inside browser extensions cannot be treated as fully secret. For team or production use,
          route requests through an authenticated backend using Microsoft Entra ID.
        </p>
      </aside>
    </main>
  );
}
