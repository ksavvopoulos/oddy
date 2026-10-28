export type DataverseFlowOperation = 'create' | 'update';
export type DataverseFlowState = 'draft' | 'activated' | 'suspended';
export type DataverseFlowTriggerChange = 'create' | 'update' | 'delete';
export type DataverseFlowTriggerScope =
  'user' | 'business-unit' | 'parent-child-business-units' | 'organization';

export type DataverseFlowScalar = string | number | boolean | null;

export type DataverseFlowValue =
  | { kind: 'literal'; value: DataverseFlowScalar }
  | { kind: 'trigger-column'; column: string }
  | { kind: 'action-output'; actionId: string; column: string };

export interface DataverseFlowFilter {
  column: string;
  operator: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains' | 'begins-with' | 'ends-with';
  value: DataverseFlowScalar;
}

export type DataverseFlowTrigger =
  | { kind: 'manual' }
  | {
      kind: 'dataverse-row';
      table: string;
      change: DataverseFlowTriggerChange;
      scope: DataverseFlowTriggerScope;
      selectColumns?: string[];
      filters?: DataverseFlowFilter[];
    };

export interface DataverseFlowFieldValue {
  column: string;
  value: DataverseFlowValue;
}

export type DataverseFlowAction =
  | {
      id: string;
      kind: 'list-rows';
      table: string;
      selectColumns?: string[];
      filters?: DataverseFlowFilter[];
      orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>;
      top?: number;
    }
  | {
      id: string;
      kind: 'get-row';
      table: string;
      rowId: DataverseFlowValue;
      selectColumns?: string[];
    }
  | {
      id: string;
      kind: 'add-row';
      table: string;
      values: DataverseFlowFieldValue[];
    }
  | {
      id: string;
      kind: 'update-row';
      table: string;
      rowId: DataverseFlowValue;
      values: DataverseFlowFieldValue[];
    };

export interface DataverseFlowSpec {
  name: string;
  description?: string;
  connectionReferenceLogicalName: string;
  trigger: DataverseFlowTrigger;
  actions: DataverseFlowAction[];
}

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
  etag?: string;
  spec?: DataverseFlowSpec;
  warnings?: string[];
}

export interface PreparedDataverseFlowChange {
  id: string;
  operation: DataverseFlowOperation;
  environmentOrigin: string;
  workflowId?: string;
  etag?: string;
  before?: DataverseFlowDetail;
  after: DataverseFlowSpec;
  generatedClientData: string;
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
      spec: DataverseFlowSpec;
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
