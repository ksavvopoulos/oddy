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

export interface SkillSettings {
  allowModelManagementByDefault: boolean;
}

export interface ConversationHistorySettings {
  enabled: boolean;
  maxConversations: number;
  retentionDays: number;
}

export interface ExtensionSettings {
  azureOpenAI: AzureOpenAISettings;
  privacy: PrivacySettings;
  skills: SkillSettings;
  conversationHistory: ConversationHistorySettings;
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

export interface DataverseLookupValueInput {
  table: string;
  recordId: string;
  recordName?: string;
}

export interface DataverseMutationValueInput {
  column: string;
  value?: unknown;
  lookup?: DataverseLookupValueInput;
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
  proposedFormattedValue?: string;
  lookup?: {
    tableLogicalName: string;
    entitySetName: string;
    recordId: string;
    recordName?: string;
    navigationPropertyName: string;
  };
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

export interface MarketingListMemberInput {
  table: string;
  recordId: string;
}

export interface PreparedMarketingListMember {
  tableLogicalName: string;
  primaryIdAttribute: string;
  recordId: string;
  recordName?: string;
}

export interface DataverseActionSignature {
  name: string;
  isBound: boolean;
  parameters: Array<{ name: string; type: string }>;
}

export interface PreparedMarketingListMembership {
  id: string;
  environmentOrigin: string;
  listId: string;
  listName: string;
  listEntitySetName: string;
  memberTableLogicalName: string;
  memberTableDisplayName?: string;
  memberObjectTypeCode: number;
  members: PreparedMarketingListMember[];
  alreadyMembers: PreparedMarketingListMember[];
  actionSignature: DataverseActionSignature;
}

export interface MarketingListMembershipExecutionResult {
  listId: string;
  listName: string;
  memberTableLogicalName: string;
  addedMemberIds: string[];
  addedMemberNames: string[];
}

export type OddySkillToolName =
  | 'resolve_dataverse_schema'
  | 'query_dataverse_records'
  | 'discover_dataverse_relationships'
  | 'manage_dataverse_view'
  | 'execute_dataverse_view'
  | 'prepare_dataverse_record_change'
  | 'prepare_marketing_list_membership'
  | 'navigate_dataverse';

export interface OddySkillInput {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select';
  required: boolean;
  options?: string[];
}

export interface OddySkillStep {
  id: string;
  instruction: string;
}

export interface OddySkill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'built-in' | 'user';
  enabled: boolean;
  instructions: string;
  allowedTools: OddySkillToolName[];
  inputs: OddySkillInput[];
  steps: OddySkillStep[];
}

export interface OddySkillRun {
  skillId: string;
  inputValues: Record<string, string>;
}

export type OddySkillChangeOperation = 'create' | 'update' | 'delete';

export interface PreparedOddySkillChange {
  id: string;
  operation: OddySkillChangeOperation;
  skillId: string;
  before?: OddySkill;
  after?: OddySkill;
  baseRevision?: string;
}

export interface OddySkillChangeExecutionResult {
  operation: OddySkillChangeOperation;
  skillId: string;
  skillName: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  allowDataverseTools?: boolean;
  allowSkillTools?: boolean;
  requestId?: string;
  skillRun?: OddySkillRun;
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
  pendingListMemberships?: PreparedMarketingListMembership[];
  pendingSkillChanges?: PreparedOddySkillChange[];
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
  | {
      type: 'EXECUTE_MARKETING_LIST_MEMBERSHIP';
      payload: { membership: PreparedMarketingListMembership; selectedMemberIds: string[] };
    }
  | {
      type: 'EXECUTE_ODDY_SKILL_CHANGE';
      payload: { change: PreparedOddySkillChange };
    }
  | { type: 'TEST_LLM_CONNECTION'; payload: AzureOpenAISettings }
  | { type: 'OPEN_DATAVERSE_RECORD'; payload: { tableLogicalName: string; recordId: string } }
  | { type: 'OPEN_OPTIONS' };

export interface MessageResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
