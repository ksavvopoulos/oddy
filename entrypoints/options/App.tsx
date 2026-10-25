import { useEffect, useState } from 'react';
import { pruneConversations } from '../../lib/conversations';
import { normalizeHistoryLimits } from '../../lib/history-policy';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import {
  BUILT_IN_SKILLS,
  buildOddyWorkflow,
  buildSkillMarkdown,
  getUserSkills,
  saveUserSkills,
  SKILL_TOOL_OPTIONS,
  skillInputFromParts,
  slugifySkillName,
  validateSkill
} from '../../lib/skills';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../../lib/storage';
import type {
  ExtensionSettings,
  LlmResponse,
  OddySkill,
  OddySkillInput,
  OddySkillToolName
} from '../../lib/types';

interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  version: string;
  inputsText: string;
  stepsText: string;
  allowedTools: OddySkillToolName[];
}

const EMPTY_SKILL_DRAFT: SkillDraft = {
  name: '',
  description: '',
  instructions: '',
  version: '1.0',
  inputsText: '',
  stepsText: '',
  allowedTools: ['resolve_dataverse_schema']
};

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [excludedFieldsText, setExcludedFieldsText] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string }>();
  const [userSkills, setUserSkills] = useState<OddySkill[]>([]);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(EMPTY_SKILL_DRAFT);

  useEffect(() => {
    void Promise.all([getSettings(), getUserSkills()]).then(([loaded, skills]) => {
      setSettings(loaded);
      setExcludedFieldsText(loaded.privacy.excludedFields.join('\n'));
      setUserSkills(skills);
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
    },
    conversationHistory: {
      ...settings.conversationHistory,
      ...normalizeHistoryLimits(settings.conversationHistory)
    }
  });

  const handleSave = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const next = settingsForSave();
      await saveSettings(next);
      if (next.conversationHistory.enabled) {
        await pruneConversations({
          maxConversations: next.conversationHistory.maxConversations,
          retentionDays: next.conversationHistory.retentionDays
        });
      }
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

  const updateSkillDraft = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    setSkillDraft((current) => ({ ...current, [key]: value }));
  };

  const toggleSkillTool = (tool: OddySkillToolName) => {
    setSkillDraft((current) => ({
      ...current,
      allowedTools: current.allowedTools.includes(tool)
        ? current.allowedTools.filter((item) => item !== tool)
        : [...current.allowedTools, tool]
    }));
  };

  const handleCreateSkill = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const baseId = slugifySkillName(skillDraft.name);
      if (!baseId) throw new Error('Enter a skill name that contains letters or numbers.');
      const existingIds = new Set([
        ...BUILT_IN_SKILLS.map((skill) => skill.id),
        ...userSkills.map((skill) => skill.id)
      ]);
      let id = baseId;
      let suffix = 2;
      while (existingIds.has(id)) {
        id = `${baseId.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
        suffix += 1;
      }

      const inputLines = skillDraft.inputsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const inputs = inputLines.map((line) => skillInputFromParts(line.split('|')));
      const invalidInputIndex = inputs.findIndex((input) => !input);
      if (invalidInputIndex >= 0) {
        throw new Error(
          `Input line ${invalidInputIndex + 1} is invalid. Use: id | Label | text, number, or select | options | required or optional.`
        );
      }

      const steps = skillDraft.stepsText
        .split('\n')
        .map((instruction) => instruction.trim())
        .filter(Boolean)
        .map((instruction, index) => ({ id: `step-${index + 1}`, instruction }));
      const skill: OddySkill = {
        id,
        name: skillDraft.name.trim(),
        description: skillDraft.description.trim(),
        version: skillDraft.version.trim(),
        source: 'user',
        enabled: true,
        instructions: skillDraft.instructions.trim(),
        allowedTools: skillDraft.allowedTools,
        inputs: inputs.filter((input): input is OddySkillInput => Boolean(input)),
        steps
      };
      const errors = validateSkill(skill);
      if (errors.length) throw new Error(errors.join(' '));

      const next = [...userSkills, skill];
      await saveUserSkills(next);
      setUserSkills(next);
      setSkillDraft(EMPTY_SKILL_DRAFT);
      setStatus({ kind: 'success', message: `Skill “${skill.name}” is ready in the side panel.` });
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const updateStoredSkills = async (next: OddySkill[], message: string) => {
    setBusy(true);
    setStatus(undefined);
    try {
      await saveUserSkills(next);
      setUserSkills(next);
      setStatus({ kind: 'success', message });
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const downloadSkillFile = (skill: OddySkill, kind: 'markdown' | 'workflow') => {
    const content =
      kind === 'markdown'
        ? buildSkillMarkdown(skill)
        : JSON.stringify(buildOddyWorkflow(skill), null, 2);
    const filename =
      kind === 'markdown' ? `${skill.id}.SKILL.md` : `${skill.id}.oddy.workflow.json`;
    const url = URL.createObjectURL(
      new Blob([content], { type: kind === 'markdown' ? 'text/markdown' : 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
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
              <button
                type="button"
                className="text-button"
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <small>
              The key is stored in <code>chrome.storage.local</code> and is never synced.
            </small>
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
            <small>
              The side panel previews outbound context. Any proposed business-record create or
              update receives a separate field-level approval before it can run.
            </small>
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

        <div className="history-settings">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.conversationHistory.enabled}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  conversationHistory: {
                    ...current.conversationHistory,
                    enabled: event.target.checked
                  }
                }))
              }
            />
            <span>
              <strong>Save conversation history locally</strong>
              <small>
                Stores visible messages, tool audits, and approval outcomes in this Chrome profile
                using IndexedDB. Record-context payloads are not stored separately.
              </small>
            </span>
          </label>

          {settings.conversationHistory.enabled && (
            <div className="field-grid history-limits">
              <label className="field">
                <span>Maximum conversations</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={settings.conversationHistory.maxConversations}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      conversationHistory: {
                        ...current.conversationHistory,
                        maxConversations: Number(event.target.value)
                      }
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>Retention days</span>
                <input
                  type="number"
                  min="1"
                  max="3650"
                  value={settings.conversationHistory.retentionDays}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      conversationHistory: {
                        ...current.conversationHistory,
                        retentionDays: Number(event.target.value)
                      }
                    }))
                  }
                />
              </label>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <p className="step">03</p>
            <h2>Skills</h2>
          </div>
          <span className="pill">Local workflow builder</span>
        </div>

        <p className="section-copy">
          Skills combine standard SKILL.md instructions with a restricted Oddy workflow. They can
          only use selected Dataverse tools, and record writes still require explicit approval.
        </p>

        <label className="toggle-row skill-management-toggle">
          <input
            type="checkbox"
            checked={settings.skills.allowModelManagementByDefault}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                skills: {
                  ...current.skills,
                  allowModelManagementByDefault: event.target.checked
                }
              }))
            }
          />
          <span>
            <strong>Allow Oddy to prepare custom skill changes by default</strong>
            <small>
              Oddy may inspect custom skills and prepare create, update, or delete previews. Nothing
              changes until you approve it in the side panel.
            </small>
          </span>
        </label>

        <div className="built-in-skill">
          <div>
            <strong>{BUILT_IN_SKILLS[0]?.name}</strong>
            <span>Built in · {BUILT_IN_SKILLS[0]?.description}</span>
          </div>
          <span className="skill-state">Enabled</span>
        </div>

        {userSkills.length > 0 && (
          <div className="saved-skills">
            <h3>Custom skills</h3>
            {userSkills.map((skill) => (
              <article key={skill.id} className="saved-skill">
                <div className="saved-skill-heading">
                  <div>
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                  </div>
                  <label className="compact-toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void updateStoredSkills(
                          userSkills.map((item) =>
                            item.id === skill.id ? { ...item, enabled: event.target.checked } : item
                          ),
                          `${skill.name} ${event.target.checked ? 'enabled' : 'disabled'}.`
                        )
                      }
                    />
                    <span>Enabled</span>
                  </label>
                </div>
                <div className="skill-metadata">
                  <span>{skill.inputs.length} inputs</span>
                  <span>{skill.steps.length} steps</span>
                  <span>{skill.allowedTools.length} tools</span>
                  <span>v{skill.version}</span>
                </div>
                <div className="saved-skill-actions">
                  <button type="button" onClick={() => downloadSkillFile(skill, 'markdown')}>
                    Export SKILL.md
                  </button>
                  <button type="button" onClick={() => downloadSkillFile(skill, 'workflow')}>
                    Export workflow
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={busy}
                    onClick={() =>
                      void updateStoredSkills(
                        userSkills.filter((item) => item.id !== skill.id),
                        `${skill.name} deleted.`
                      )
                    }
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="skill-builder">
          <h3>Create a custom skill</h3>
          <div className="field-grid">
            <label className="field">
              <span>Name</span>
              <input
                placeholder="Review inactive contacts"
                value={skillDraft.name}
                onChange={(event) => updateSkillDraft('name', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Version</span>
              <input
                value={skillDraft.version}
                onChange={(event) => updateSkillDraft('version', event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>Description</span>
              <input
                placeholder="What the skill does and when Oddy should use it"
                value={skillDraft.description}
                onChange={(event) => updateSkillDraft('description', event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>Instructions</span>
              <textarea
                rows={4}
                placeholder="Safety rules, expected behavior, and completion criteria"
                value={skillDraft.instructions}
                onChange={(event) => updateSkillDraft('instructions', event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>Inputs</span>
              <textarea
                rows={4}
                placeholder={
                  'table | Table name | text | | required\ndays | Inactive days | number | | required\nstatus | Status | select | active, inactive | optional'
                }
                value={skillDraft.inputsText}
                onChange={(event) => updateSkillDraft('inputsText', event.target.value)}
              />
              <small>
                One input per line: ID | Label | text, number, or select | comma-separated options |
                required or optional.
              </small>
            </label>
            <label className="field field-wide">
              <span>Workflow steps</span>
              <textarea
                rows={5}
                placeholder={
                  'Resolve the requested table and columns.\nQuery records using the supplied inputs.\nCreate or update AI Result.\nNavigate to the resulting view.'
                }
                value={skillDraft.stepsText}
                onChange={(event) => updateSkillDraft('stepsText', event.target.value)}
              />
              <small>Enter one ordered workflow step per line.</small>
            </label>
          </div>

          <fieldset className="tool-picker">
            <legend>Allowed tools</legend>
            {SKILL_TOOL_OPTIONS.map((tool) => (
              <label key={tool.name}>
                <input
                  type="checkbox"
                  checked={skillDraft.allowedTools.includes(tool.name)}
                  onChange={() => toggleSkillTool(tool.name)}
                />
                <span>
                  <strong>{tool.label}</strong>
                  <small>{tool.description}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="skill-builder-actions">
            <small>Custom skills are stored only in this Chrome profile.</small>
            <button type="button" className="primary" disabled={busy} onClick={handleCreateSkill}>
              Create skill
            </button>
          </div>
        </div>
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
          API keys inside browser extensions cannot be treated as fully secret. For team or
          production use, route requests through an authenticated backend using Microsoft Entra ID.
        </p>
      </aside>
    </main>
  );
}
