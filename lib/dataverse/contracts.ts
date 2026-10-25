import type {
  DataverseMutationExecutionResult,
  DataverseMutationInput,
  MarketingListMemberInput,
  MarketingListMembershipExecutionResult,
  PreparedDataverseMutation,
  PreparedMarketingListMembership
} from '../types';

export type DataverseFilterOperator =
  | 'not-null'
  | 'null'
  | 'eq'
  | 'ne'
  | 'contains'
  | 'begins-with'
  | 'ends-with'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'on'
  | 'on-or-after'
  | 'on-or-before';

export interface DataverseFilterSpec {
  column: string;
  operator: DataverseFilterOperator;
  value?: string;
  entityType?: string;
}

export interface DataverseOrderSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DataverseQuerySpec {
  table: string;
  columns?: string[];
  filters?: DataverseFilterSpec[];
  orderBy?: DataverseOrderSpec[];
  top?: number;
}

export type DataversePrimitiveRequest =
  | {
      action: 'resolve_schema';
      origin: string;
      table: string;
      columns?: string[];
    }
  | {
      action: 'query_records';
      origin: string;
      query: DataverseQuerySpec;
    }
  | {
      action: 'discover_relationships';
      origin: string;
      sourceTable: string;
      targetTable: string;
    }
  | {
      action: 'get_view';
      origin: string;
      table: string;
    }
  | {
      action: 'upsert_view';
      origin: string;
      query: DataverseQuerySpec;
      layoutColumns?: string[];
    }
  | {
      action: 'execute_view';
      origin: string;
      table: string;
      top?: number;
    }
  | {
      action: 'prepare_mutation';
      origin: string;
      mutation: DataverseMutationInput;
    }
  | {
      action: 'execute_mutation';
      origin: string;
      mutation: PreparedDataverseMutation;
      selectedColumns: string[];
    }
  | {
      action: 'prepare_list_membership';
      origin: string;
      listId: string;
      members: MarketingListMemberInput[];
    }
  | {
      action: 'execute_list_membership';
      origin: string;
      membership: PreparedMarketingListMembership;
      selectedMemberIds: string[];
    };

export interface ResolvedDataverseEntity {
  logicalName: string;
  entitySetName: string;
  primaryIdAttribute: string;
  primaryNameAttribute?: string;
  objectTypeCode?: number;
  displayName?: string;
  displayCollectionName?: string;
}

export interface ResolvedDataverseColumn {
  requestedName: string;
  logicalName: string;
  displayName?: string;
  attributeType?: string;
  targets?: string[];
}

export interface DataverseRelationship {
  schemaName: string;
  sourceTable: string;
  targetTable: string;
  lookupColumn: string;
  direction: 'source-parent' | 'source-child';
  referencedNavigationPropertyName?: string;
  referencingNavigationPropertyName?: string;
}

export interface DataversePrimitiveResult {
  ok: boolean;
  action: DataversePrimitiveRequest['action'];
  entity?: ResolvedDataverseEntity;
  resolvedColumns?: ResolvedDataverseColumn[];
  unresolvedColumns?: string[];
  query?: DataverseQuerySpec;
  fetchXml?: string;
  layoutXml?: string;
  records?: Array<Record<string, unknown>>;
  totalCount?: number;
  relationships?: DataverseRelationship[];
  view?: {
    id: string;
    name: string;
    tableLogicalName: string;
    created?: boolean;
    query?: DataverseQuerySpec;
    layoutColumns?: string[];
  };
  mutation?: PreparedDataverseMutation;
  mutationResult?: DataverseMutationExecutionResult;
  listMembership?: PreparedMarketingListMembership;
  listMembershipResult?: MarketingListMembershipExecutionResult;
  warnings?: string[];
  error?: string;
}
