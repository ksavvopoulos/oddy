import type { ExtensionSettings } from './types';
import { DEFAULT_HISTORY_LIMITS } from './history-policy';

export const SETTINGS_KEY = 'dataverseCopilot.settings';

const LEGACY_READ_ONLY_SYSTEM_PROMPT =
  'You are a careful Microsoft Dataverse assistant. Be concise, distinguish facts from assumptions, and never invent schema details. When record context is supplied, use only the supplied fields.';
const DEFAULT_SYSTEM_PROMPT =
  'You are a careful Microsoft Dataverse assistant. Be concise, distinguish facts from assumptions, and never invent schema details. When record context is supplied, use only the supplied fields. Business-record creates and updates must always be prepared as previews and require explicit user approval before execution.';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  azureOpenAI: {
    endpoint: '',
    deployment: '',
    apiVersion: '2024-10-21',
    apiKey: '',
    temperature: 0.2,
    systemPrompt: DEFAULT_SYSTEM_PROMPT
  },
  privacy: {
    includeRecordContextByDefault: true,
    excludedFields: []
  },
  skills: {
    allowModelManagementByDefault: false
  },
  conversationHistory: {
    enabled: false,
    ...DEFAULT_HISTORY_LIMITS
  }
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;

  const azureOpenAI = {
    ...DEFAULT_SETTINGS.azureOpenAI,
    ...value?.azureOpenAI
  };
  if (azureOpenAI.systemPrompt === LEGACY_READ_ONLY_SYSTEM_PROMPT) {
    azureOpenAI.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  return {
    azureOpenAI,
    privacy: {
      ...DEFAULT_SETTINGS.privacy,
      ...value?.privacy
    },
    skills: {
      ...DEFAULT_SETTINGS.skills,
      ...value?.skills
    },
    conversationHistory: {
      ...DEFAULT_SETTINGS.conversationHistory,
      ...value?.conversationHistory
    }
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function isAzureOpenAIConfigured(settings: ExtensionSettings): boolean {
  const config = settings.azureOpenAI;
  return Boolean(
    config.endpoint.trim() &&
    config.deployment.trim() &&
    config.apiVersion.trim() &&
    config.apiKey.trim()
  );
}
