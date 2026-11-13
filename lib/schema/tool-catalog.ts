import type { AzureToolDefinition } from '../azure-openai';
import type { OddySkillToolName } from '../types';

export const SCHEMA_TOOL_OPTIONS: Array<{
  name: OddySkillToolName;
  label: string;
  description: string;
}> = [
  {
    name: 'list_dataverse_solutions',
    label: 'Find unmanaged solutions',
    description: 'Search solution display/unique names and inspect publisher validation issues.'
  },
  {
    name: 'get_dataverse_table_definition',
    label: 'Read table definition',
    description: 'Inspect latest metadata and its snapshot revision before schema edits.'
  },
  {
    name: 'prepare_dataverse_schema_change',
    label: 'Prepare schema change',
    description:
      'Prepare a complete table with columns/lookups, safe settings edits, or separate table publishing.'
  }
];
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const requiredLevel = {
  type: ['string', 'null'],
  enum: ['None', 'Recommended', 'ApplicationRequired', null]
};
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties)
});
const common = {
  solutionUniqueName: string,
  languageCode: { type: 'integer', description: 'Intended label language LCID, e.g. 1033.' }
};
const target = {
  tableLogicalName: string,
  baseRevision: {
    type: 'string',
    description:
      'Exact latest get_dataverse_table_definition revision. Re-read after a saved operation.'
  }
};
const column = object({
  schemaName: string,
  displayName: string,
  description: nullableString,
  type: {
    type: 'string',
    enum: [
      'text',
      'multiline',
      'integer',
      'decimal',
      'date',
      'datetime',
      'boolean',
      'choice',
      'lookup'
    ]
  },
  requiredLevel,
  maxLength: nullableInteger,
  minValue: nullableNumber,
  maxValue: nullableNumber,
  precision: nullableInteger,
  choices: { type: ['array', 'null'], items: string, minItems: 1, maxItems: 100 },
  falseLabel: nullableString,
  trueLabel: nullableString,
  defaultBoolean: { type: ['boolean', 'null'] },
  defaultChoice: {
    ...nullableString,
    description:
      'Exact local Choice label for the FORM default. API producers must explicitly set their desired value.'
  },
  dateTimeBehavior: {
    type: ['string', 'null'],
    enum: ['UserLocal', 'TimeZoneIndependent', null],
    description:
      'Required for datetime: UserLocal stores an instant in UTC and displays local time. TimeZoneIndependent stores wall time without conversions. date is date-only.'
  },
  targetTable: {
    ...nullableString,
    description: 'For lookup only: exact existing referenced table logical name, e.g. contact.'
  },
  relationshipSchemaName: {
    ...nullableString,
    description:
      'For lookup only: globally unique relationship schema name using selected publisher prefix.'
  },
  deleteBehavior: {
    type: ['string', 'null'],
    enum: ['Restrict', 'RemoveLink', null],
    description:
      'Required for lookup. Restrict prevents deleting a referenced row; RemoveLink clears the lookup. Cascading deletion is not supported.'
  }
});
const plan = {
  anyOf: [
    object({
      ...common,
      operation: { enum: ['create_table'], type: 'string' },
      schemaName: string,
      displayName: string,
      pluralName: string,
      description: nullableString,
      ownership: { type: 'string', enum: ['UserOwned', 'OrganizationOwned'] },
      primaryName: object({
        schemaName: string,
        displayName: string,
        maxLength: { type: 'integer', minimum: 1, maximum: 850 }
      }),
      columns: {
        type: 'array',
        items: column,
        maxItems: 20,
        description:
          'All additional requested columns, including lookups. Use [] for a table with only its primary name. One approval covers the entire ordered plan, not a global transaction.'
      }
    }),
    object({
      ...common,
      ...target,
      operation: { enum: ['create_column'], type: 'string' },
      column
    }),
    object({
      ...common,
      ...target,
      operation: { enum: ['update_table'], type: 'string' },
      changes: object({
        displayName: nullableString,
        pluralName: nullableString,
        description: nullableString
      })
    }),
    object({
      ...common,
      ...target,
      operation: { enum: ['update_column'], type: 'string' },
      columnLogicalName: string,
      changes: object({
        displayName: nullableString,
        description: nullableString,
        requiredLevel,
        maxLength: nullableInteger
      })
    }),
    object({ ...common, ...target, operation: { enum: ['publish_table'], type: 'string' } })
  ]
};
export const SCHEMA_TOOLS: AzureToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_dataverse_solutions',
      description:
        'Find readable unmanaged solutions by display name or unique name. Search the user-provided name before asking them to repeat it. Return selectable solutions plus per-entry solutionIssues: one invalid publisher never invalidates unrelated solutions. Resolve exact uniqueName/ID from results; duplicate display names need clarification. Continue nextAfterUniqueName using the SAME search, even if no selectable solutions appear on a page. Never guess a prefix.',
      parameters: object({
        search: {
          ...nullableString,
          description:
            'Display/unique-name substring, e.g. test table. Null lists all. Repeat unchanged on later pages.'
        },
        afterUniqueName: {
          ...nullableString,
          description: 'Null for first page, then nextAfterUniqueName.'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dataverse_table_definition',
      description:
        'Read latest table/column/lookup metadata including unpublished changes, and a snapshot revision. Exact logical name required. Existing schema edits are restricted to unmanaged standard custom tables; lookup references may target eligible existing system/managed tables such as contact.',
      parameters: object({ tableLogicalName: string })
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_dataverse_schema_change',
      description:
        'Prepare schema for explicit approval; NEVER writes. For a new table include ALL requested columns in create_table.columns so the user reviews one complete plan. Initial scalar columns are created with the table; each single-target lookup uses a separate non-cascading RelationshipDefinitions request. Confirm deletion behavior and datetime behavior rather than silently changing semantics. Preflight validates names, targets, relationships, defaults, and the selected unmanaged solution publisher. Existing targets need the exact baseRevision. A Choice default is DefaultFormValue, not a guarantee for API-created records. No substitute text GUIDs or date-only for timestamps. Failed/partial/uncertain execution stops and must be inspected before a NEW approval, never blind recreation. No deletion, type/ownership conversions, existing relationship edits, global Choice edits, or managed-component writes. publish_table is separately requested/approved and publishes ALL pending customizations for the exact table, including other makers and related forms/views; never publish-all. Pass null for irrelevant column options.',
      parameters: object({ plan })
    }
  }
];
