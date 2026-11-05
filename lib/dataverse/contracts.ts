import type { BulkPage, BulkPageCursor } from '../bulk/contracts';
import type {
  DataverseMutationExecutionResult,
  DataverseMutationValueInput,
  PreparedDataverseMutationField,
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

export interface DataverseNativeReadOptions {
  fetchXml?: string;
  pageSize?: number;
  cursor?: string;
}

export type DataversePrimitiveRequest =
  | { action: 'bulk_identity'; origin: string }
  | {
      action: 'bulk_fields';
      origin: string;
      operation: 'create' | 'update';
      table: string;
      values: DataverseMutationValueInput[][];
    }
  | {
      action: 'bulk_page';
      origin: string;
      query: DataverseQuerySpec;
      cursor?: BulkPageCursor;
      requireConcurrency?: boolean;
    }
  | {
      action: 'bulk_read_versions';
      origin: string;
      table: string;
      ids: string[];
      columns: string[];
      requireConcurrency?: boolean;
    }
  | { action: 'bulk_list_info'; origin: string; table: string; listId: string }
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
  | ({ action: 'query_records'; origin: string } & DataverseNativeReadOptions)
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
      action: 'upsert_view';
      origin: string;
      table: string;
      fetchXml: string;
      layoutXml: string;
      etag?: string;
    }
  | {
      action: 'execute_view';
      origin: string;
      table?: string;
      pageSize?: number;
      cursor?: string;
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
      expectedUserId?: string;
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
  optimisticConcurrencyEnabled?: boolean;
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

/** Private, in-memory metadata for one preparation only; never persisted or model-facing. */
export interface DataversePreparationMetadata {
  origin: string;
  entities: Record<string, ResolvedDataverseEntity>;
  responses: Record<string, unknown>;
}

export interface DataversePrimitiveResult {
  preparationMetadata?: DataversePreparationMetadata;
  ok: boolean;
  action: DataversePrimitiveRequest['action'];
  entity?: ResolvedDataverseEntity;
  resolvedColumns?: ResolvedDataverseColumn[];
  unresolvedColumns?: string[];
  query?: DataverseQuerySpec;
  fetchXml?: string;
  layoutXml?: string;
  records?: Array<Record<string, unknown>>;
  userId?: string;
  bulkFields?: PreparedDataverseMutationField[][];
  bulkPage?: BulkPage;
  bulkList?: PreparedMarketingListMembership;
  totalCount?: number;
  recordPage?: {
    page: number;
    pageSize: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
    completeness: 'more-pages' | 'complete' | 'top-limited' | 'incomplete';
    pagingMode: 'cookie' | 'simple' | 'none';
  };
  relationships?: DataverseRelationship[];
  view?: {
    id: string;
    name: string;
    tableLogicalName: string;
    created?: boolean;
    query?: DataverseQuerySpec;
    layoutColumns?: string[];
    etag?: string;
  };
  mutation?: PreparedDataverseMutation;
  mutationResult?: DataverseMutationExecutionResult;
  listMembership?: PreparedMarketingListMembership;
  listMembershipResult?: MarketingListMembershipExecutionResult;
  warnings?: string[];
  error?: string;
}
