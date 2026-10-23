export interface AzureOpenAISettings {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
  temperature: number;
  systemPrompt: string;
}

export interface PrivacySettings {
  includeRecordContextByDefault: boolean;
  excludedFields: string[];
}

export interface ExtensionSettings {
  azureOpenAI: AzureOpenAISettings;
  privacy: PrivacySettings;
}

export interface DataverseField {
  logicalName: string;
  label: string;
  type?: string;
  value: unknown;
  formattedValue?: string;
}

export type DataverseContextSource = 'url' | 'xrm' | 'webApi';

export interface DataverseContext {
  isDataverse: boolean;
  source: DataverseContextSource;
  origin?: string;
  environmentName?: string;
  appId?: string;
  pageType?: string;
  tableLogicalName?: string;
  recordId?: string;
  recordName?: string;
  formName?: string;
  title?: string;
  url?: string;
  fields: DataverseField[];
  capturedAt: string;
  warning?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type DataverseMutationOperation = 'create' | 'update';

export interface DataverseMutationValueInput {
  column: string;
  value: unknown;
}

export interface DataverseMutationInput {
  operation: DataverseMutationOperation;
  table: string;
  recordId?: string;
  values: DataverseMutationValueInput[];
}

export interface PreparedDataverseMutationField {
  requestedName: string;
  logicalName: string;
  displayName?: string;
  attributeType?: string;
  currentValue?: unknown;
  currentFormattedValue?: string;
  proposedValue: unknown;
}

export interface PreparedDataverseMutation {
  id: string;
  operation: DataverseMutationOperation;
  environmentOrigin: string;
  tableLogicalName: string;
  tableDisplayName?: string;
  recordId?: string;
  recordName?: string;
  etag?: string;
  fields: PreparedDataverseMutationField[];
}

export interface DataverseMutationExecutionResult {
  operation: DataverseMutationOperation;
  tableLogicalName: string;
  recordId: string;
  recordName?: string;
  changedColumns: string[];
  refreshStatus?: 'form-refreshed' | 'page-refreshed' | 'skipped-dirty' | 'not-applicable' | 'failed';
  refreshMessage?: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  allowDataverseTools?: boolean;
  requestId?: string;
}

export interface NavigationProgress {
  requestId: string;
  stage: 'opening' | 'loaded' | 'delayed';
  label: string;
  detail?: string;
}

export interface ToolActivity {
  name: string;
  label: string;
  summary: string;
  details?: string;
}

export interface LlmResponse {
  content: string;
  toolsUsed?: ToolActivity[];
  pendingMutations?: PreparedDataverseMutation[];
}

export type ExtensionMessage =
  | { type: 'GET_ACTIVE_CONTEXT' }
  | { type: 'CONTEXT_CHANGED' }
  | { type: 'NAVIGATION_STATUS'; payload: NavigationProgress }
  | { type: 'LLM_CHAT'; payload: LlmRequest }
  | {
      type: 'EXECUTE_DATAVERSE_MUTATION';
      payload: { mutation: PreparedDataverseMutation; selectedColumns: string[] };
    }
  | { type: 'TEST_LLM_CONNECTION'; payload: AzureOpenAISettings }
  | { type: 'OPEN_DATAVERSE_RECORD'; payload: { tableLogicalName: string; recordId: string } }
  | { type: 'OPEN_OPTIONS' };

export interface MessageResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
