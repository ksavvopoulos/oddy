import type { DataverseFilterSpec } from '../dataverse/contracts';
import type {
  DataverseMutationValueInput,
  PreparedDataverseMutationField,
  PreparedMarketingListMembership
} from '../types';

export type BulkScalar = string | number | boolean | null;
export type BulkDatasetRecord = Record<string, BulkScalar>;
export interface BulkSelection {
  table: string;
  filters: DataverseFilterSpec[];
  allRecords: boolean;
}
export type BulkPlan =
  | { operation: 'update'; selection: BulkSelection; values: DataverseMutationValueInput[] }
  | {
      operation: 'count_related';
      selection: BulkSelection;
      targetColumn: string;
      related: BulkSelection & { lookupColumn: string };
    }
  | { operation: 'membership'; selection: BulkSelection; listId: string }
  | { operation: 'create'; table: string; datasetId: string; mapping: Record<string, string> };

export interface BulkDatasetSummary {
  id: string;
  name: string;
  rowCount: number;
  columns: string[];
  createdAt: string;
  expiresAt: string;
}
export interface BulkDataset {
  summary: BulkDatasetSummary;
  records: BulkDatasetRecord[];
}
export type BulkRowStatus =
  'pending' | 'succeeded' | 'skipped' | 'conflict' | 'failed' | 'uncertain';
export interface BulkRow {
  index: number;
  recordId: string;
  recordName?: string;
  etag?: string;
  fields: PreparedDataverseMutationField[];
  status: BulkRowStatus;
  error?: string;
}
export interface BulkReadRecord {
  id: string;
  name?: string;
  etag?: string;
  values: Record<string, unknown>;
  lookupTypes: Record<string, string>;
}
export interface BulkPageCursor {
  page: number;
  cookie: string;
}
export interface BulkPage {
  records: BulkReadRecord[];
  cursor?: BulkPageCursor;
}
export type BulkJobStatus =
  'preparing' | 'pending' | 'approved' | 'running' | 'completed' | 'failed' | 'paused' | 'rejected';
export interface BulkExecutionOptions {
  bypassCustomLogic?: boolean;
  bypassPowerAutomate?: boolean;
}
export interface BulkJobSummary {
  id: string;
  revision: string;
  operation: BulkPlan['operation'];
  status: BulkJobStatus;
  environmentOrigin: string;
  table: string;
  description: string;
  createdAt: string;
  preparedAt?: string;
  expiresAt: string;
  matched: number;
  unchanged: number;
  total: number;
  succeeded: number;
  skipped: number;
  conflicts: number;
  failed: number;
  uncertain: number;
  remaining: number;
  sample: Array<{
    recordId: string;
    recordName?: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }>;
  warnings: string[];
  /** User-selected at approval, fixed for the run; absent on older jobs and fresh previews. */
  executionOptions?: BulkExecutionOptions;
  error?: string;
  retryAfterSeconds?: number;
  retryAfterUtc?: string;
}
/** The manifest and rows are execution data, never transcript/model data. */
export interface BulkJob {
  summary: BulkJobSummary;
  userId: string;
  plan: BulkPlan;
  entitySetName: string;
  primaryIdAttribute: string;
  membership?: PreparedMarketingListMembership;
  nextIndex: number;
  inFlight?: { token: string; start: number; count: number };
  runToken?: string;
  preparationComplete: boolean;
}
export interface BulkChunkOutcome {
  recordId: string;
  status: Exclude<BulkRowStatus, 'pending'>;
  error?: string;
}
export interface BulkChunkResult {
  outcomes: BulkChunkOutcome[];
  retryAfterSeconds?: number;
  error?: string;
}
export interface BulkTransportRequest {
  executionOptions?: BulkExecutionOptions;
  origin: string;
  userId: string;
  operation: 'create' | 'update';
  entitySetName: string;
  primaryIdAttribute: string;
  rows: Array<{ recordId: string; etag?: string; payload: Record<string, unknown> }>;
}
