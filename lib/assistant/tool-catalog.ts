import type { AzureToolDefinition } from '../azure-openai';
import { bulkToolDefinitions } from '../bulk/tool-catalog';
import type { OddySkillToolName } from '../types';

export const SKILL_TOOL_OPTIONS: Array<{
  name: OddySkillToolName;
  label: string;
  description: string;
}> = [
  {
    name: 'resolve_dataverse_schema',
    label: 'Resolve schema',
    description: 'Resolve table and column names.'
  },
  {
    name: 'query_dataverse_records',
    label: 'Query records',
    description: 'Run structured, read-only Dataverse queries.'
  },
  {
    name: 'discover_dataverse_relationships',
    label: 'Discover relationships',
    description: 'Inspect direct table relationships.'
  },
  {
    name: 'manage_dataverse_view',
    label: 'Manage AI Result view',
    description: 'Read or update the managed personal view.'
  },
  {
    name: 'execute_dataverse_view',
    label: 'Execute AI Result view',
    description: 'Read records from the managed personal view.'
  },
  {
    name: 'list_dataverse_flows',
    label: 'List cloud flows',
    description: 'List solution-aware cloud flows and whether Oddy can safely edit them.'
  },
  {
    name: 'get_dataverse_flow',
    label: 'Read cloud flow',
    description: 'Read a cloud flow and its typed Oddy definition when supported.'
  },
  {
    name: 'open_dataverse_flow_designer',
    label: 'Open cloud-flow designer',
    description: 'Open an exact cloud flow in the Power Automate designer.'
  },
  {
    name: 'list_dataverse_flow_connections',
    label: 'List flow connections',
    description: 'List existing Dataverse connection references available to cloud flows.'
  },
  {
    name: 'prepare_dataverse_flow_change',
    label: 'Prepare cloud-flow change',
    description: 'Prepare a typed cloud-flow create or edit proposal that requires approval.'
  },
  {
    name: 'prepare_dataverse_record_change',
    label: 'Prepare record change',
    description: 'Prepare a create or update proposal that requires approval.'
  },
  {
    name: 'prepare_marketing_list_membership',
    label: 'Prepare marketing-list members',
    description: 'Prepare one bulk AddListMembersList proposal that requires approval.'
  },
  {
    name: 'prepare_bulk_job',
    label: 'Prepare bulk job',
    description:
      'Prepare query-backed updates, related counts, creates, or membership jobs; approval required.'
  },
  {
    name: 'prepare_bulk_job_remaining',
    label: 'Prepare remaining bulk work',
    description: 'Reconcile stopped work into a fresh approval preview.'
  },
  {
    name: 'get_bulk_job',
    label: 'Read bulk job status',
    description: 'Read compact counts and outcomes, never execute.'
  },
  {
    name: 'list_bulk_datasets',
    label: 'List local datasets',
    description: 'Read uploaded dataset handles and columns, not rows.'
  },
  {
    name: 'navigate_dataverse',
    label: 'Navigate Dataverse',
    description: 'Open a list, view, or record in the active tab.'
  }
];

const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    column: {
      type: 'string',
      description: 'Column logical name or display name.'
    },
    operator: {
      type: 'string',
      enum: [
        'not-null',
        'null',
        'eq',
        'ne',
        'contains',
        'begins-with',
        'ends-with',
        'gt',
        'ge',
        'lt',
        'le',
        'on',
        'on-or-after',
        'on-or-before'
      ],
      description: 'FetchXML operator. Use not-null for contains data.'
    },
    value: {
      type: 'string',
      description: 'Value for operators that require one.'
    },
    entityType: {
      type: 'string',
      description: 'Optional table logical name for polymorphic lookup values.'
    }
  },
  required: ['column', 'operator']
};

const FLOW_FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    column: { type: 'string', description: 'Dataverse column logical or display name.' },
    operator: {
      type: 'string',
      enum: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'begins-with', 'ends-with']
    },
    value: { type: ['string', 'number', 'boolean', 'null'] }
  },
  required: ['column', 'operator', 'value']
};

const FLOW_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['literal', 'trigger-column', 'action-output'] },
    value: {
      type: ['string', 'number', 'boolean', 'null'],
      description: 'Required only for literal values.'
    },
    column: {
      type: 'string',
      description: 'Required for trigger-column and action-output values.'
    },
    actionId: {
      type: 'string',
      description: 'Earlier action ID, required only for action-output values.'
    }
  },
  required: ['kind']
};

const FLOW_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Stable action identifier using letters, digits, and underscores.'
    },
    kind: { type: 'string', enum: ['list-rows', 'get-row', 'add-row', 'update-row'] },
    table: { type: 'string', description: 'Dataverse table logical or display name.' },
    rowId: FLOW_VALUE_SCHEMA,
    selectColumns: { type: 'array', maxItems: 20, items: { type: 'string' } },
    filters: { type: 'array', maxItems: 20, items: FLOW_FILTER_SCHEMA },
    orderBy: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          column: { type: 'string' },
          direction: { type: 'string', enum: ['asc', 'desc'] }
        },
        required: ['column', 'direction']
      }
    },
    top: { type: 'integer', minimum: 1, maximum: 5000 },
    values: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          column: { type: 'string' },
          value: FLOW_VALUE_SCHEMA
        },
        required: ['column', 'value']
      }
    }
  },
  required: ['id', 'kind', 'table']
};

const FLOW_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    connectionReferenceLogicalName: {
      type: 'string',
      description: 'Exact logical name returned by list_dataverse_flow_connections.'
    },
    trigger: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['manual', 'dataverse-row'] },
        table: { type: 'string' },
        change: { type: 'string', enum: ['create', 'update', 'delete'] },
        scope: {
          type: 'string',
          enum: ['user', 'business-unit', 'parent-child-business-units', 'organization']
        },
        selectColumns: { type: 'array', maxItems: 20, items: { type: 'string' } },
        filters: { type: 'array', maxItems: 20, items: FLOW_FILTER_SCHEMA }
      },
      required: ['kind']
    },
    actions: { type: 'array', maxItems: 20, items: FLOW_ACTION_SCHEMA }
  },
  required: ['name', 'connectionReferenceLogicalName', 'trigger', 'actions']
};

const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    column: {
      type: 'string',
      description: 'Column logical name or display name.'
    },
    direction: {
      type: 'string',
      enum: ['asc', 'desc']
    }
  },
  required: ['column', 'direction']
};

export const DATAVERSE_TOOLS: AzureToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'resolve_dataverse_schema',
      description:
        'Resolve a table and optional column display names to Dataverse logical metadata. Use when a logical name is needed for navigation or ambiguity must be checked.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', description: 'Table logical or display name.' },
          columns: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string' },
            description: 'Optional column logical or display names.'
          }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_dataverse_records',
      description:
        'Run a signed-in, read-only Dataverse query using structured columns, filters, sorting, and a row limit. Display names are accepted and record IDs are returned.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', description: 'Table logical or display name.' },
          columns: { type: 'array', maxItems: 20, items: { type: 'string' } },
          filters: { type: 'array', maxItems: 20, items: FILTER_SCHEMA },
          orderBy: { type: 'array', maxItems: 5, items: ORDER_SCHEMA },
          top: { type: 'integer', minimum: 1, maximum: 50 }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'discover_dataverse_relationships',
      description:
        'Discover direct one-to-many or many-to-one relationship metadata between two tables, including the lookup column and direction.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceTable: { type: 'string', description: 'Source table logical or display name.' },
          targetTable: { type: 'string', description: 'Target table logical or display name.' }
        },
        required: ['sourceTable', 'targetTable']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_dataverse_view',
      description:
        'Get or upsert a reusable personal view from a complete structured query. Use get before modifying an existing view, then upsert the full revised definition. Defaults to AI Result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'upsert'] },
          table: { type: 'string', description: 'Table logical or display name.' },
          columns: { type: 'array', maxItems: 20, items: { type: 'string' } },
          filters: { type: 'array', maxItems: 20, items: FILTER_SCHEMA },
          orderBy: { type: 'array', maxItems: 5, items: ORDER_SCHEMA },
          layoutColumns: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string' },
            description: 'Columns visible in the grid layout.'
          }
        },
        required: ['action', 'table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_dataverse_view',
      description:
        'Execute a personal view and return its first records in the view’s existing filter and sort order. Defaults to AI Result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', description: 'Table logical or display name.' },
          top: { type: 'integer', minimum: 1, maximum: 50 }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dataverse_flows',
      description:
        'List solution-aware modern cloud flows in the active Dataverse environment. Returns whether each flow is managed and whether its definition can be edited safely by Oddy.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { top: { type: 'integer', minimum: 1, maximum: 50 } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dataverse_flow',
      description:
        'Read one modern cloud flow by exact workflow ID. Oddy-created flows include a complete typed specification that must be preserved and revised for edits. Other flows are inspection-only.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { workflowId: { type: 'string' } },
        required: ['workflowId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_dataverse_flow_designer',
      description:
        'Open the exact modern cloud flow in a new Power Automate designer tab. Resolve or list the flow first and pass its exact workflow ID. Perform this navigation instead of returning manual instructions or a link.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { workflowId: { type: 'string' } },
        required: ['workflowId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dataverse_flow_connections',
      description:
        'List existing Microsoft Dataverse connection references available for cloud-flow creation. Use the exact logical name in a flow specification; never invent a connection reference.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { top: { type: 'integer', minimum: 1, maximum: 100 } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_dataverse_flow_change',
      description:
        'Prepare, but never execute, a typed Dataverse-only cloud-flow create or update. For updates, read the exact flow first and submit its complete revised specification. V1 supports manual or Dataverse row triggers and sequential list/get/add/update row actions with scalar text, number, boolean, date, GUID, trigger-column, or earlier single-row output values. Choice, lookup, collection-to-scalar, and arbitrary expression writes are rejected. New flows are created Off in the default solution. Updates save an unpublished draft only and never publish or activate the flow; publishing remains a separate Power Automate step. Only Oddy-created unmanaged flows can be edited.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['create', 'update'] },
          workflowId: { type: 'string', description: 'Required for update.' },
          spec: FLOW_SPEC_SCHEMA
        },
        required: ['operation', 'spec']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_dataverse_record_change',
      description:
        'Prepare a create or update proposal for explicit user approval. For updates, query the target record first and pass its exact record ID. For a lookup, resolve the column to discover its target table, query the target record, and pass lookup with that table and exact record ID. This tool never writes data. It returns a field-level before/after preview. Scalar values and single-record Lookup, Customer, and Owner fields are supported; party-list and multi-select fields are not.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['create', 'update'] },
          table: { type: 'string', description: 'Table logical or display name.' },
          recordId: {
            type: 'string',
            description: 'Required for update. Exact GUID returned by a record query.'
          },
          values: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                column: { type: 'string', description: 'Column logical or display name.' },
                value: {
                  type: ['string', 'number', 'boolean', 'null'],
                  description:
                    'Proposed scalar value. Choice fields accept either the localized option label or numeric option value; Oddy validates and stores the numeric value.'
                },
                lookup: {
                  type: 'object',
                  additionalProperties: false,
                  description:
                    'Proposed lookup target. Query the target record first and use its exact ID.',
                  properties: {
                    table: { type: 'string', description: 'Target table logical or display name.' },
                    recordId: { type: 'string', description: 'Exact target record GUID.' },
                    recordName: {
                      type: 'string',
                      description: 'Optional target display name for the approval preview.'
                    }
                  },
                  required: ['table', 'recordId']
                }
              },
              required: ['column']
            }
          }
        },
        required: ['operation', 'table', 'values']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_marketing_list_membership',
      description:
        'Prepare one bulk AddListMembersList proposal for explicit approval. Query the exact static marketing list and all intended account, contact, or lead records first, then pass their IDs. All members must belong to the same table and match the list member type. The extension validates the tenant action metadata and never writes data during preparation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listId: {
            type: 'string',
            description: 'Exact marketing-list GUID returned by a list record query.'
          },
          members: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                table: {
                  type: 'string',
                  description:
                    'Member table logical or display name. Use account, contact, or lead.'
                },
                recordId: {
                  type: 'string',
                  description: 'Exact member GUID returned by a record query.'
                }
              },
              required: ['table', 'recordId']
            }
          }
        },
        required: ['listId', 'members']
      }
    }
  },
  ...bulkToolDefinitions(FILTER_SCHEMA),
  {
    type: 'function',
    function: {
      name: 'navigate_dataverse',
      description:
        'Navigate the active tab to a table list, a specific saved/personal view, or a record. Requires a table logical name; resolve it first when necessary. Perform navigation instead of returning a link.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', enum: ['list', 'view', 'record'] },
          tableLogicalName: { type: 'string' },
          recordId: { type: 'string' },
          viewId: { type: 'string' },
          viewType: { type: 'string', enum: ['userquery', 'savedquery'] }
        },
        required: ['target', 'tableLogicalName']
      }
    }
  }
];

/** Skill execution is limited to its declared tools, never custom-skill management. */
export function selectAssistantTools(options: {
  allowDataverseTools: boolean;
  allowSkillTools: boolean;
  skillTools?: OddySkillToolName[];
}): AzureToolDefinition[] {
  if (options.skillTools) {
    return options.allowDataverseTools
      ? DATAVERSE_TOOLS.filter((tool) =>
          options.skillTools?.includes(tool.function.name as OddySkillToolName)
        )
      : [];
  }
  return [
    ...(options.allowDataverseTools ? DATAVERSE_TOOLS : []),
    ...(options.allowSkillTools ? ODDY_SKILL_TOOLS : [])
  ];
}

export const ODDY_SKILL_TOOLS: AzureToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_oddy_skills',
      description:
        'List user-created Oddy skills. Bundled skills are immutable and are not returned by this tool.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_oddy_skill',
      description:
        'Read the complete definition of one user-created Oddy skill before preparing an update or deletion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skillId: {
            type: 'string',
            description: 'Exact custom skill ID returned by list_oddy_skills.'
          }
        },
        required: ['skillId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_oddy_skill_change',
      description:
        'Prepare creation, full-definition update, or deletion of a user-created Oddy skill for explicit user approval. Call get_oddy_skill before update or delete. This tool never changes storage. Bundled skills cannot be modified.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
          skillId: {
            type: 'string',
            description: 'Required for update or delete. Exact custom skill ID.'
          },
          baseRevision: {
            type: 'string',
            description: 'Required for update or delete. Exact revision returned by get_oddy_skill.'
          },
          skill: {
            type: 'object',
            additionalProperties: false,
            description: 'Complete replacement definition required for create or update.',
            properties: {
              id: { type: 'string', description: 'Optional ID for creation; ignored for updates.' },
              name: { type: 'string' },
              description: { type: 'string' },
              version: { type: 'string' },
              enabled: { type: 'boolean' },
              instructions: { type: 'string' },
              allowedTools: {
                type: 'array',
                minItems: 1,
                maxItems: SKILL_TOOL_OPTIONS.length,
                items: {
                  type: 'string',
                  enum: SKILL_TOOL_OPTIONS.map((tool) => tool.name)
                }
              },
              inputs: {
                type: 'array',
                maxItems: 20,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    type: { type: 'string', enum: ['text', 'number', 'select'] },
                    required: { type: 'boolean' },
                    options: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['id', 'label', 'type', 'required']
                }
              },
              steps: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    instruction: { type: 'string' }
                  },
                  required: ['id', 'instruction']
                }
              }
            },
            required: [
              'name',
              'description',
              'version',
              'enabled',
              'instructions',
              'allowedTools',
              'inputs',
              'steps'
            ]
          }
        },
        required: ['operation']
      }
    }
  }
];
