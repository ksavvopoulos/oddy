export type SchemaColumnType =
  | 'text'
  | 'multiline'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'choice'
  | 'lookup';

export interface SchemaColumnDefinition {
  schemaName: string;
  displayName: string;
  description?: string;
  type: SchemaColumnType;
  requiredLevel?: 'None' | 'Recommended' | 'ApplicationRequired';
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  precision?: number;
  choices?: string[];
  falseLabel?: string;
  trueLabel?: string;
  defaultBoolean?: boolean;
  /** DefaultFormValue is a form default, not a server-side API invariant. */
  defaultChoice?: string;
  dateTimeBehavior?: 'UserLocal' | 'TimeZoneIndependent';
  targetTable?: string;
  relationshipSchemaName?: string;
  deleteBehavior?: 'Restrict' | 'RemoveLink';
}

export interface SchemaEdit {
  displayName?: string;
  pluralName?: string;
  description?: string;
  requiredLevel?: 'None' | 'Recommended' | 'ApplicationRequired';
  maxLength?: number;
}

export type SchemaPlan = {
  solutionUniqueName: string;
  languageCode: number;
} & (
  | {
      operation: 'create_table';
      schemaName: string;
      displayName: string;
      pluralName: string;
      description?: string;
      ownership: 'UserOwned' | 'OrganizationOwned';
      primaryName: { schemaName: string; displayName: string; maxLength: number };
      /** Up to 20 additional columns; lookup relationships are separate approved steps. */
      columns?: SchemaColumnDefinition[];
    }
  | {
      operation: 'create_column';
      tableLogicalName: string;
      baseRevision: string;
      column: SchemaColumnDefinition;
    }
  | {
      operation: 'update_table' | 'update_column';
      tableLogicalName: string;
      columnLogicalName?: string;
      baseRevision: string;
      changes: SchemaEdit;
    }
  | {
      operation: 'publish_table';
      tableLogicalName: string;
      baseRevision: string;
    }
);

export interface SchemaSolution {
  id: string;
  uniqueName: string;
  displayName: string;
  publisherId: string;
  prefix: string;
  optionValuePrefix: number;
}

export interface SchemaTableDefinition {
  logicalName: string;
  metadataId: string;
  revision: string;
  /** Bounded discovery projection of latest metadata, including unpublished changes. */
  metadata: Record<string, unknown>;
}

export interface PreparedSchemaStep {
  kind: 'table' | 'column' | 'relationship' | 'publish';
  components: string[];
  method: 'POST' | 'PUT';
  path: string;
  body: Record<string, unknown>;
}

export interface SchemaStepOutcome {
  components: string[];
  status: 'succeeded' | 'failed' | 'unknown' | 'not-attempted';
  message?: string;
}

export interface PreparedSchemaChange {
  mode: 'schema-v1' | 'schema-v2';
  id: string;
  environmentOrigin: string;
  plan: SchemaPlan;
  solution: SchemaSolution;
  tableLogicalName: string;
  columnLogicalName?: string;
  /** Snapshot hash, not a server-enforced ETag. */
  baseRevision?: string;
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
  warnings: string[];
  /** Generated locally and rebuilt before execution. Legacy v1 previews cannot execute. */
  steps?: PreparedSchemaStep[];
  referenceRevisions?: Record<string, string>;
}

export interface SchemaChangeResult {
  operation: SchemaPlan['operation'];
  tableLogicalName: string;
  columnLogicalName?: string;
  solutionUniqueName: string;
  status: 'saved' | 'published' | 'partial' | 'failed';
  message: string;
  outcomes?: SchemaStepOutcome[];
}

export type SchemaPrimitiveRequest =
  | { action: 'list_schema_solutions'; origin: string; afterUniqueName?: string; search?: string }
  | { action: 'get_table_definition'; origin: string; tableLogicalName: string }
  | { action: 'prepare_schema_change'; origin: string; plan: SchemaPlan }
  | { action: 'execute_schema_change'; origin: string; change: PreparedSchemaChange };

export interface SchemaPrimitiveResult {
  ok: boolean;
  action: SchemaPrimitiveRequest['action'];
  solutions?: SchemaSolution[];
  nextAfterUniqueName?: string;
  solutionIssues?: Array<{
    id?: string;
    uniqueName?: string;
    displayName?: string;
    reason: string;
  }>;
  scannedSolutions?: number;
  tableDefinition?: SchemaTableDefinition;
  schemaChange?: PreparedSchemaChange;
  schemaChangeResult?: SchemaChangeResult;
  error?: string;
}
