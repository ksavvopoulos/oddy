export type DataverseFlowOperation = 'create' | 'update';
export type DataverseFlowState = 'draft' | 'activated' | 'suspended';

export interface DataverseConnectionReferenceSummary {
  logicalName: string;
  displayName: string;
  connectorId: string;
  isManaged: boolean;
}

export interface DataverseFlowSummary {
  workflowId: string;
  name: string;
  description?: string;
  state: DataverseFlowState;
  isManaged: boolean;
  modifiedOn?: string;
  oddyEditable: boolean;
}

export type DataverseFlowDefinitionScope = 'published' | 'latest';
export type DataverseFlowEvent = 'create' | 'update' | 'delete';

export interface DataverseFlowListOptions {
  pageSize?: number;
  filters?: {
    name?: string;
    nameMatch?: 'eq' | 'contains' | 'starts-with';
    state?: DataverseFlowState;
    isManaged?: boolean;
  };
  orderBy?: { field: 'name' | 'modifiedon' | 'statecode'; direction: 'asc' | 'desc' };
  definitionScope?: DataverseFlowDefinitionScope;
  trigger?: { table?: string; event?: DataverseFlowEvent };
  cursor?: string;
}

export interface DataverseFlowTriggerSummary {
  id: string;
  type: string;
  connector?: string;
  operationId?: string;
  table?: string;
  events?: DataverseFlowEvent[];
  scope?: string | number;
  filterExpression?: string;
  filteringAttributes?: string;
  conditions?: unknown[];
  detailsTruncated?: boolean;
  inspection: 'recognized' | 'other' | 'unknown';
}

export interface DataverseFlowListItem extends DataverseFlowSummary {
  definitionVersion: 'published' | 'unpublished' | 'unknown';
  triggers: DataverseFlowTriggerSummary[];
  triggerInspection: 'complete' | 'incomplete';
}

export interface DataverseFlowListPage {
  definitionScope: DataverseFlowDefinitionScope;
  pageSize: number;
  /** Candidate rows examined on this page, before local trigger matching. */
  scanned: number;
  returned: number;
  /** Candidates whose trigger/version could not be conclusively inspected. */
  uninspectable: number;
  hasMore: boolean;
  nextCursor?: string;
  warnings: string[];
  inspectionIssues: Array<{ workflowId?: string; name?: string; reason: string }>;
}

export interface DataverseFlowDetail extends DataverseFlowSummary {
  /** Solution component state, distinct from runtime state (On/Off). */
  componentState?: number;
  etag?: string;
  /** Latest saved definition, including designer metadata and all connectors. */
  definition?: DataverseFlowDefinition;
  warnings?: string[];
}

export interface DataverseFlowDefinition {
  name: string;
  description?: string;
  /** Complete workflow clientdata JSON, not just properties.definition. */
  clientData: string;
}

export interface PreparedDataverseFlowChange {
  /** Identifies executable definition previews; legacy typed previews must be refreshed. */
  mode: 'definition';
  id: string;
  operation: DataverseFlowOperation;
  environmentOrigin: string;
  workflowId?: string;
  etag?: string;
  before?: DataverseFlowDetail;
  after: DataverseFlowDefinition;
  generatedClientData: string;
  /** Update approvals authorize only an unpublished draft save. */
  saveMode?: 'draft';
  warnings: string[];
}

export interface DataverseFlowDesignerTarget {
  environmentId: string;
  workflowId: string;
  flowName: string;
}

export interface DataverseFlowChangeExecutionResult {
  operation: DataverseFlowOperation;
  workflowId: string;
  name: string;
  state: DataverseFlowState;
  /** A definition save is not a publish or runtime activation. */
  savedAs?: 'unpublished-draft';
}

export type DataverseFlowPrimitiveRequest =
  | ({ action: 'list_flows'; origin: string; top?: number } & DataverseFlowListOptions)
  | { action: 'get_flow'; origin: string; workflowId: string }
  | { action: 'list_flow_connection_references'; origin: string; top?: number }
  | { action: 'get_flow_designer_target'; origin: string; workflowId: string }
  | {
      action: 'prepare_flow_change';
      origin: string;
      operation: DataverseFlowOperation;
      workflowId?: string;
      etag?: string;
      definition: DataverseFlowDefinition;
    }
  | {
      action: 'execute_flow_change';
      origin: string;
      change: PreparedDataverseFlowChange;
    };

export interface DataverseFlowPrimitiveResult {
  ok: boolean;
  action: DataverseFlowPrimitiveRequest['action'];
  flows?: DataverseFlowListItem[];
  flowPage?: DataverseFlowListPage;
  flow?: DataverseFlowDetail;
  connectionReferences?: DataverseConnectionReferenceSummary[];
  flowDesignerTarget?: DataverseFlowDesignerTarget;
  flowChange?: PreparedDataverseFlowChange;
  flowChangeResult?: DataverseFlowChangeExecutionResult;
  error?: string;
}
