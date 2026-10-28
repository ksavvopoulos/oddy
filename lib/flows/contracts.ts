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
  | { action: 'list_flows'; origin: string; top?: number }
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
  flows?: DataverseFlowSummary[];
  flow?: DataverseFlowDetail;
  connectionReferences?: DataverseConnectionReferenceSummary[];
  flowDesignerTarget?: DataverseFlowDesignerTarget;
  flowChange?: PreparedDataverseFlowChange;
  flowChangeResult?: DataverseFlowChangeExecutionResult;
  error?: string;
}
