import type { AzureToolDefinition } from '../azure-openai';
import { bulkToolDefinitions } from '../bulk/tool-catalog';
import { SCHEMA_TOOLS, SCHEMA_TOOL_OPTIONS } from '../schema/tool-catalog';
import type { OddySkillToolName } from '../types';

export const SKILL_TOOL_OPTIONS: Array<{
  name: OddySkillToolName;
  label: string;
  description: string;
}> = [
  ...SCHEMA_TOOL_OPTIONS,
  {
    name: 'resolve_dataverse_schema',
    label: 'Resolve schema',
    description: 'Resolve table and column names.'
  },
  {
    name: 'query_dataverse_records',
    label: 'Query records',
    description: 'Run native FetchXML reads with paging.'
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
    description: 'Filter and page cloud flows, including exact Dataverse row-trigger matching.'
  },
  {
    name: 'get_dataverse_flow',
    label: 'Read cloud flow',
    description: 'Read a cloud flow, its complete saved definition, and row version.'
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
    description: 'Prepare a complete flow definition for approved creation or editing.'
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

const NATIVE_FETCH_SCHEMA = {
  type: ['string', 'null'],
  description:
    'Complete native FetchXML using logical table/column names. Null when continuing a cursor.'
};
const QUERY_PAGE_SIZE_SCHEMA = { type: ['integer', 'null'], minimum: 1, maximum: 100 };
const QUERY_CURSOR_SCHEMA = {
  type: ['string', 'null'],
  description:
    'Opaque nextCursor from the prior page. Continue unchanged with other query arguments null.'
};

export const DATAVERSE_TOOLS: AzureToolDefinition[] = [
  ...SCHEMA_TOOLS,
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
        'Execute a signed-in, read-only native FetchXML query. Supports Dataverse operators, nested AND/OR, IN lists, link-entity joins, aliases, distinct and aggregates; Dataverse validates query semantics. Prefer one IN query for known IDs instead of repeated exact-ID calls. Resolve logical names first. Select needed fields and the primary ID when record identity is needed; aggregate/distinct rows may not have IDs. Reads one bounded page (default 50, maximum 100). Do not supply page or paging-cookie; use nextCursor with other arguments null. Continue all pages before claiming completeness; missing records may be inaccessible. top must fit one page and is explicitly top-limited. Results retain aliases and formatted values. No automatic count query or writes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fetchXml: NATIVE_FETCH_SCHEMA,
          pageSize: QUERY_PAGE_SIZE_SCHEMA,
          cursor: QUERY_CURSOR_SCHEMA
        },
        required: ['fetchXml', 'pageSize', 'cursor']
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
        'Get or save the AI Result personal view for a logical table name. get returns complete original FetchXML, layout XML and ETag; it never flattens filters or joins. Before editing, get the existing view and preserve unrelated native definition/layout content. upsert requires complete fetchXml and layoutXml, plus the exact ETag for updates (null for creation). A stale or missing update ETag fails without retry. Native query semantics remain Dataverse responsibilities. Scope remains AI Result only, not arbitrary views or business-record writes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'upsert'] },
          table: {
            type: 'string',
            description: 'Table logical name. Resolve display names first.'
          },
          fetchXml: NATIVE_FETCH_SCHEMA,
          layoutXml: {
            type: ['string', 'null'],
            description: 'Complete native grid layout XML for upsert; null for get.'
          },
          etag: {
            type: ['string', 'null'],
            description: 'Exact ETag from get for updates; null for creation or get.'
          }
        },
        required: ['action', 'table', 'fetchXml', 'layoutXml', 'etag']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_dataverse_view',
      description:
        'Read one bounded page from the AI Result personal view without flattening its FetchXML. Returns joined/aliased/aggregate fields and explicit paging/completeness. Default page size 50; maximum 100. Continue nextCursor unchanged with table and pageSize null. The cursor freezes the read definition, not a database snapshot. No writes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: {
            type: ['string', 'null'],
            description: 'Logical table name for the initial read; null for continuation.'
          },
          pageSize: QUERY_PAGE_SIZE_SCHEMA,
          cursor: QUERY_CURSOR_SCHEMA
        },
        required: ['table', 'pageSize', 'cursor']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dataverse_flows',
      description:
        'Read-only, paged listing of accessible solution-aware cloud flows. Filter workflow fields on the server and optionally inspect native trigger JSON locally for an exact Dataverse table/event. Resolve the table logical name first; do not filter by flow name to infer which table triggers it. For enabled flows on voucher creation use definitionScope published, filters.state activated, and trigger with the resolved voucher table and event create. Combined create/update/delete triggers match every included event. Use latest scope to find drafts for editing. Runtime state draft means Off; it is separate from definitionVersion unpublished. Returns compact trigger details, conditions, scope, coverage counts, inspection issues, and nextCursor, never full definitions. pageSize counts candidate rows BEFORE trigger filtering: a page can return no matches while hasMore is true. Continue every nextCursor unchanged with other arguments null, aggregate results, and disclose incomplete coverage or uninspectable candidates. Published configuration is not execution/run-history evidence. This tool never changes flows.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageSize: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 100,
            description:
              'Candidate rows per page, not matching rows. Defaults to 100 for trigger searches, otherwise 20. Null when continuing a cursor.'
          },
          filters: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              name: { type: ['string', 'null'] },
              nameMatch: {
                type: ['string', 'null'],
                enum: ['eq', 'contains', 'starts-with', null]
              },
              state: {
                type: ['string', 'null'],
                enum: ['draft', 'activated', 'suspended', null],
                description: 'Runtime state: draft=Off, activated=On, suspended=Suspended.'
              },
              isManaged: { type: ['boolean', 'null'] }
            },
            required: ['name', 'nameMatch', 'state', 'isManaged']
          },
          orderBy: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              field: { type: ['string', 'null'], enum: ['name', 'modifiedon', 'statecode', null] },
              direction: { type: ['string', 'null'], enum: ['asc', 'desc', null] }
            },
            required: ['field', 'direction']
          },
          definitionScope: {
            type: ['string', 'null'],
            enum: ['published', 'latest', null],
            description:
              'Published for enabled-trigger questions; latest (default) includes saved drafts for editing.'
          },
          trigger: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              table: {
                type: ['string', 'null'],
                description:
                  'Exact Dataverse logical table name from schema resolution, not a display name or guessed plural.'
              },
              event: { type: ['string', 'null'], enum: ['create', 'update', 'delete', null] }
            },
            required: ['table', 'event']
          },
          cursor: {
            type: ['string', 'null'],
            description:
              'Opaque nextCursor from the prior result. Copy exactly, keep all other arguments null, and stay in the same environment.'
          }
        },
        required: ['pageSize', 'filters', 'orderBy', 'definitionScope', 'trigger', 'cursor']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dataverse_flow',
      description:
        'Read one modern cloud flow by exact workflow ID, including its latest complete definition and ETag. Any unmanaged flow with a readable definition can be edited after approval, regardless of creator or legacy metadata. Revise the complete definition and preserve unrelated content. Managed flows are read-only.',
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
        'List existing connection references for all connectors available for cloud-flow creation or editing. Use exact logical names and matching connector IDs in the native definition; never invent a reference or credentials.',
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
        'Prepare a complete native Power Automate definition for explicit approval; never writes. Use the same definition object (name, description, complete clientData JSON string) for both create and update. For create pass null workflowId and etag, resolve Dataverse metadata, list existing connection references, and supply a complete properties.definition and properties.connectionReferences document. For update first get_dataverse_flow, use its exact workflowId and etag, and preserve unrelated content, designer metadata, nested actions, expressions, and connection references. Conditions, loops, branches, and existing connectors are supported. Action entityName must use the metadata entity-set name (contacts), while webhook subscriptionRequest/entityname uses the logical name (contact). Static Dataverse tables/columns, connector references, and graph structure are validated. Expressions and full connector schemas still need Power Automate validation. Never invent references or credentials. There is no typed spec or ownership requirement. Creates remain Off; updates save an unpublished draft only, never publish or activate. Managed flows remain read-only.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['create', 'update'] },
          workflowId: {
            type: ['string', 'null'],
            description: 'Exact workflow ID for update; null for create.'
          },
          etag: {
            type: ['string', 'null'],
            description: 'Exact ETag from get_dataverse_flow for update; null for create.'
          },
          definition: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: {
                type: ['string', 'null'],
                description: 'Text, empty text to clear, or null to preserve on update.'
              },
              clientData: {
                type: 'string',
                description:
                  'Complete native clientdata JSON, not a patch. For create include schemaVersion 1.0.0.0 and properties with connectionReferences and a definition containing the Logic Apps $schema, contentVersion, parameters, triggers, actions, and outputs. Use valid connector host/operationId/parameters and authentication expressions. For update preserve unrelated fields and metadata from the exact read.'
              }
            },
            required: ['name', 'description', 'clientData']
          }
        },
        required: ['operation', 'workflowId', 'etag', 'definition']
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
