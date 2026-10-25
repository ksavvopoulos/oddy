import {
  callAzureOpenAI,
  callAzureOpenAIResponses,
  type AzureChatMessage,
  type AzureResponseFunctionOutput,
  type AzureToolDefinition
} from '../lib/azure-openai';
import {
  collectDataverseWebApiContext,
  collectXrmPageContext,
  contextFromUrl,
  isDataverseUrl,
  mergePageContext,
  pickBestPageContext,
  type PageContextSnapshot,
  type WebApiContextRequest
} from '../lib/dataverse-context';
import {
  executeDataversePrimitive,
  type DataverseFilterOperator,
  type DataverseFilterSpec,
  type DataverseOrderSpec,
  type DataversePrimitiveRequest,
  type DataversePrimitiveResult,
  type DataverseQuerySpec
} from '../lib/dataverse-primitives';
import { errorMessage } from '../lib/messages';
import {
  buildSkillExecutionInstruction,
  executeOddySkillChange,
  getSkillById,
  getUserSkills,
  prepareOddySkillChange,
  skillRevision
} from '../lib/skills';
import { getSettings, isAzureOpenAIConfigured } from '../lib/storage';
import type {
  AzureOpenAISettings,
  ChatMessage,
  DataverseContext,
  DataverseMutationExecutionResult,
  DataverseMutationValueInput,
  MarketingListMembershipExecutionResult,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  ExtensionMessage,
  LlmResponse,
  MessageResult,
  NavigationProgress,
  OddySkill,
  OddySkillRun,
  OddySkillToolName,
  PreparedOddySkillChange,
  ToolActivity
} from '../lib/types';

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    void configureAllSidePanels();
  });

  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void configureAllSidePanels();

  chrome.tabs.onCreated.addListener((tab) => {
    void configureSidePanelForTab(tab);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs.get(tabId).then((tab) => configureSidePanelForTab(tab)).catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      void configureSidePanelForTab(tab);
    }
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
      if (tab) return configureSidePanelForTab(tab);
    }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse: (response: MessageResult<unknown>) => void) => {
      void handleMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }
  );
});

async function configureAllSidePanels(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => configureSidePanelForTab(tab)));
}

async function configureSidePanelForTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  const enabled = Boolean(tab.url && isDataverseUrl(tab.url));
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled
  });
}

async function handleMessage(message: ExtensionMessage): Promise<MessageResult<unknown>> {
  switch (message.type) {
    case 'GET_ACTIVE_CONTEXT':
      return { ok: true, data: await getActiveDataverseContext() };

    case 'LLM_CHAT': {
      const settings = await getSettings();
      if (!isAzureOpenAIConfigured(settings)) {
        throw new Error('Configure Azure OpenAI in extension settings first.');
      }
      const skillRun = message.payload.skillRun;
      const skill = skillRun ? await getSkillById(skillRun.skillId) : undefined;
      if (skillRun && !skill) {
        throw new Error('The selected Oddy skill is unavailable or disabled.');
      }
      if (skill && message.payload.allowDataverseTools !== true) {
        throw new Error('Oddy skills require Dataverse tools to be enabled for this request.');
      }
      const response = await runDataverseAssistant(
        settings.azureOpenAI,
        message.payload.messages,
        message.payload.allowDataverseTools === true,
        message.payload.allowSkillTools === true,
        message.payload.requestId,
        skill && skillRun ? { skill, run: skillRun } : undefined
      );
      return { ok: true, data: response };
    }

    case 'EXECUTE_ODDY_SKILL_CHANGE': {
      return { ok: true, data: await executeOddySkillChange(message.payload.change) };
    }

    case 'EXECUTE_MARKETING_LIST_MEMBERSHIP': {
      const context = await getActiveDataverseContext();
      if (!context.origin || context.origin !== message.payload.membership.environmentOrigin) {
        throw new Error('Return to the Dataverse environment where this preview was prepared before approving it.');
      }
      const result = await executePrimitiveInActiveTab(context, {
        action: 'execute_list_membership',
        origin: context.origin,
        membership: message.payload.membership,
        selectedMemberIds: message.payload.selectedMemberIds
      });
      if (!result.ok || !result.listMembershipResult) {
        throw new Error(result.error || 'Dataverse did not add the approved marketing-list members.');
      }
      return { ok: true, data: result.listMembershipResult };
    }

    case 'EXECUTE_DATAVERSE_MUTATION': {
      const context = await getActiveDataverseContext();
      if (!context.origin || context.origin !== message.payload.mutation.environmentOrigin) {
        throw new Error('Return to the Dataverse environment where this preview was prepared before approving it.');
      }
      const result = await executePrimitiveInActiveTab(context, {
        action: 'execute_mutation',
        origin: context.origin,
        mutation: message.payload.mutation,
        selectedColumns: message.payload.selectedColumns
      });
      if (!result.ok || !result.mutationResult) {
        throw new Error(result.error || 'Dataverse did not apply the approved change.');
      }
      const refresh = await refreshAfterMutation(context, result.mutationResult);
      return {
        ok: true,
        data: { ...result.mutationResult, ...refresh }
      };
    }

    case 'TEST_LLM_CONNECTION': {
      const response = await callAzureOpenAI(message.payload, [
        { role: 'system', content: 'Reply with exactly: Connection successful' },
        { role: 'user', content: 'Test connection' }
      ]);
      return { ok: true, data: response };
    }

    case 'OPEN_DATAVERSE_RECORD': {
      const context = await getActiveDataverseContext();
      const result = await navigateDataverse(context, {
        target: 'record',
        tableLogicalName: message.payload.tableLogicalName,
        recordId: message.payload.recordId
      });
      return result.ok ? { ok: true, data: result } : { ok: false, error: result.error };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'CONTEXT_CHANGED':
    case 'NAVIGATION_STATUS':
      return { ok: true };

    default:
      throw new Error('Unsupported extension message.');
  }
}

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

const DATAVERSE_TOOLS: AzureToolDefinition[] = [
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
                  description: 'Proposed scalar value. Choice fields accept either the localized option label or numeric option value; Oddy validates and stores the numeric value.'
                },
                lookup: {
                  type: 'object',
                  additionalProperties: false,
                  description: 'Proposed lookup target. Query the target record first and use its exact ID.',
                  properties: {
                    table: { type: 'string', description: 'Target table logical or display name.' },
                    recordId: { type: 'string', description: 'Exact target record GUID.' },
                    recordName: { type: 'string', description: 'Optional target display name for the approval preview.' }
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
                  description: 'Member table logical or display name. Use account, contact, or lead.'
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

const ODDY_SKILL_TOOLS: AzureToolDefinition[] = [
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
          skillId: { type: 'string', description: 'Exact custom skill ID returned by list_oddy_skills.' }
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
                maxItems: 8,
                items: {
                  type: 'string',
                  enum: [
                    'resolve_dataverse_schema',
                    'query_dataverse_records',
                    'discover_dataverse_relationships',
                    'manage_dataverse_view',
                    'execute_dataverse_view',
                    'prepare_dataverse_record_change',
                    'prepare_marketing_list_membership',
                    'navigate_dataverse'
                  ]
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

const ALLOWED_OPERATORS = new Set<DataverseFilterOperator>([
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
]);

async function runDataverseAssistant(
  settings: AzureOpenAISettings,
  inputMessages: ChatMessage[],
  allowDataverseTools: boolean,
  allowSkillTools: boolean,
  requestId?: string,
  skillExecution?: { skill: OddySkill; run: OddySkillRun }
): Promise<LlmResponse> {
  if (!allowDataverseTools && !allowSkillTools) {
    return callAzureOpenAI(settings, inputMessages);
  }

  const context = await getActiveDataverseContext();
  if (allowDataverseTools && (!context.isDataverse || !context.origin)) {
    if (skillExecution) {
      throw new Error('Return to an active Dataverse page before running this skill.');
    }
    return callAzureOpenAI(settings, inputMessages);
  }

  const conversation: AzureChatMessage[] = inputMessages.map((message) => ({
    role: message.role,
    content: message.content
  }));
  const currentPage = `${context.tableLogicalName || 'Dataverse app'}${
    context.recordId ? ` record ${context.recordId}` : ' page'
  }`;
  const instruction: AzureChatMessage = {
    role: 'system',
    content:
      `You have composable Dataverse primitives. Current page: ${currentPage}. ` +
      `Build workflows from schema resolution, record queries, relationship discovery, personal-view management, view execution, and navigation. ` +
      `For a filtered list: upsert AI Result with the complete query, then navigate to the returned view ID. ` +
      `For related records of a named record: query the source record, discover the relationship, upsert the target AI Result using the returned lookup column and source ID, then navigate to the view. ` +
      `For modifying AI Result: get the existing view, preserve its filters, revise columns/order, then upsert the full definition. ` +
      `For opening the first/newest/oldest result: execute the view with top 1, then navigate to the returned record ID. ` +
      `For an unfiltered list: resolve the table and navigate to its logical name. ` +
      `For a business-record update: query and uniquely identify the record, then prepare a field-level change proposal. ` +
      `For a new business record: prepare a create proposal with all known field values. Choice labels may be passed directly and are resolved to numeric options from Dataverse metadata. For lookup fields, resolve the column targets, query the exact target record, and pass its table and record ID in the lookup value. ` +
      `For adding accounts, contacts, or leads to a marketing list: query the exact list and every intended member, then prepare one bulk marketing-list membership proposal. Do not use ordinary record creation or claim members were added before approval. ` +
      `Prepared record and marketing-list membership changes require an explicit approval click in the extension; never claim a proposed change was applied. ` +
      `Navigation results report whether the destination loaded or only started; never claim it loaded when navigationState is started. ` +
      `Never ask the user to click a row, supply a record ID, apply a manual filter, or follow a link when these primitives can complete the request. ` +
      `Never execute business-record writes yourself. Only prepare proposals; the extension performs approved writes outside the model tool loop. ` +
      `Prior messages may include an “Extension tool audit (authoritative)” section; treat it as the execution source of truth. ` +
      (allowSkillTools
        ? `You may inspect user-created Oddy skills and prepare skill changes only when the user explicitly asks. Always read the full existing skill before an update or deletion. Never modify bundled skills, never claim a proposed skill change was applied, and never prepare an unrelated self-modification.`
        : '')
  };
  const instructionIndex = conversation[0]?.role === 'system' ? 1 : 0;
  conversation.splice(instructionIndex, 0, instruction);

  if (skillExecution) {
    conversation.splice(instructionIndex + 1, 0, {
      role: 'system',
      content: buildSkillExecutionInstruction(skillExecution.skill, skillExecution.run)
    });
  }

  const activeTools = skillExecution
    ? DATAVERSE_TOOLS.filter((tool) =>
        skillExecution.skill.allowedTools.includes(
          tool.function.name as OddySkill['allowedTools'][number]
        )
      )
    : [
        ...(allowDataverseTools ? DATAVERSE_TOOLS : []),
        ...(allowSkillTools ? ODDY_SKILL_TOOLS : [])
      ];
  if (activeTools.length === 0) {
    throw new Error('The selected Oddy skill has no supported tools enabled.');
  }

  const toolsUsed: ToolActivity[] = [];
  const pendingMutations: PreparedDataverseMutation[] = [];
  const pendingListMemberships: PreparedMarketingListMembership[] = [];
  const pendingSkillChanges: PreparedOddySkillChange[] = [];
  let completion = await callAzureOpenAIResponses(settings, {
    messages: conversation,
    tools: activeTools
  });

  for (let round = 0; round < 12; round += 1) {
    if (completion.toolCalls.length === 0) {
      if (!completion.content) throw new Error('Azure OpenAI returned no answer after tool execution.');
      return {
        content: completion.content,
        toolsUsed: toolsUsed.length ? toolsUsed : undefined,
        pendingMutations: pendingMutations.length ? pendingMutations : undefined,
        pendingListMemberships: pendingListMemberships.length ? pendingListMemberships : undefined,
        pendingSkillChanges: pendingSkillChanges.length ? pendingSkillChanges : undefined
      };
    }

    const outputs: AzureResponseFunctionOutput[] = [];
    for (const toolCall of completion.toolCalls) {
      const result = await executeAssistantTool(
        context,
        toolCall.name,
        toolCall.arguments,
        requestId
      );
      if ('action' in result && result.action === 'prepare_mutation' && result.mutation) {
        pendingMutations.push(result.mutation);
      }
      if ('action' in result && result.action === 'prepare_list_membership' && result.listMembership) {
        pendingListMemberships.push(result.listMembership);
      }
      if ('action' in result && result.action === 'prepare_skill_change' && result.change) {
        pendingSkillChanges.push(result.change);
      }
      toolsUsed.push(activityForTool(toolCall.name, result));
      outputs.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(result)
      });
    }

    completion = await callAzureOpenAIResponses(settings, {
      previousResponseId: completion.id,
      input: outputs,
      tools: activeTools
    });
  }

  throw new Error('The assistant exceeded the maximum number of Dataverse primitive calls.');
}

interface NavigationArguments {
  target: 'list' | 'view' | 'record';
  tableLogicalName: string;
  recordId?: string;
  viewId?: string;
  viewType?: 'userquery' | 'savedquery';
}

interface NavigationResult {
  ok: boolean;
  navigationState?: 'started' | 'loaded';
  navigationMethod?: 'xrm' | 'url';
  target?: NavigationArguments['target'];
  tableLogicalName?: string;
  recordId?: string;
  viewId?: string;
  url?: string;
  error?: string;
}

interface XrmNavigationRequest {
  target: NavigationArguments['target'];
  tableLogicalName: string;
  recordId?: string;
  viewId?: string;
  viewType?: 'userquery' | 'savedquery';
}

interface XrmNavigationResult {
  ok: boolean;
  error?: string;
}

interface OddySkillToolResult {
  ok: boolean;
  action: 'list_skills' | 'get_skill' | 'prepare_skill_change';
  skills?: Array<Pick<OddySkill, 'id' | 'name' | 'description' | 'version' | 'enabled'>>;
  skill?: OddySkill;
  revision?: string;
  change?: PreparedOddySkillChange;
  error?: string;
}

async function executeAssistantTool(
  context: DataverseContext,
  toolName: string,
  rawArguments: string,
  requestId?: string
): Promise<DataversePrimitiveResult | NavigationResult | OddySkillToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArguments || '{}') as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The model supplied invalid JSON tool arguments.' };
  }

  if (toolName === 'list_oddy_skills') {
    const skills = await getUserSkills();
    return {
      ok: true,
      action: 'list_skills',
      skills: skills.map(({ id, name, description, version, enabled }) => ({
        id,
        name,
        description,
        version,
        enabled
      }))
    };
  }

  if (toolName === 'get_oddy_skill') {
    const skillId = stringValue(args.skillId);
    const skill = (await getUserSkills()).find((item) => item.id === skillId);
    return skill
      ? { ok: true, action: 'get_skill', skill, revision: skillRevision(skill) }
      : {
          ok: false,
          action: 'get_skill',
          error: 'The requested custom skill was not found. Bundled skills are immutable.'
        };
  }

  if (toolName === 'prepare_oddy_skill_change') {
    const operation = args.operation;
    if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
      return { ok: false, action: 'prepare_skill_change', error: 'A valid skill-change operation is required.' };
    }
    try {
      const skill = operation === 'delete' ? undefined : skillFromToolArguments(args.skill);
      const change = await prepareOddySkillChange({
        operation,
        skillId: optionalString(args.skillId),
        skill,
        baseRevision: optionalString(args.baseRevision)
      });
      return { ok: true, action: 'prepare_skill_change', change };
    } catch (error) {
      return {
        ok: false,
        action: 'prepare_skill_change',
        error: errorMessage(error)
      };
    }
  }

  if (toolName === 'navigate_dataverse') {
    return navigateDataverse(context, {
      target:
        args.target === 'view' || args.target === 'record' ? args.target : 'list',
      tableLogicalName: stringValue(args.tableLogicalName),
      recordId: optionalString(args.recordId),
      viewId: optionalString(args.viewId),
      viewType: args.viewType === 'savedquery' ? 'savedquery' : 'userquery'
    }, requestId);
  }

  if (!context.origin) {
    return { ok: false, action: 'resolve_schema', error: 'The Dataverse origin is unavailable.' };
  }

  let request: DataversePrimitiveRequest;
  if (toolName === 'resolve_dataverse_schema') {
    request = {
      action: 'resolve_schema',
      origin: context.origin,
      table: stringValue(args.table),
      columns: stringArray(args.columns, 20)
    };
  } else if (toolName === 'query_dataverse_records') {
    request = {
      action: 'query_records',
      origin: context.origin,
      query: queryFromArguments(args)
    };
  } else if (toolName === 'discover_dataverse_relationships') {
    request = {
      action: 'discover_relationships',
      origin: context.origin,
      sourceTable: stringValue(args.sourceTable),
      targetTable: stringValue(args.targetTable)
    };
  } else if (toolName === 'manage_dataverse_view') {
    const action = args.action === 'upsert' ? 'upsert' : 'get';
    request =
      action === 'get'
        ? {
            action: 'get_view',
            origin: context.origin,
            table: stringValue(args.table)
          }
        : {
            action: 'upsert_view',
            origin: context.origin,
            query: queryFromArguments(args),
            layoutColumns: stringArray(args.layoutColumns, 12)
          };
  } else if (toolName === 'execute_dataverse_view') {
    request = {
      action: 'execute_view',
      origin: context.origin,
      table: stringValue(args.table),
      top: numberValue(args.top, 10, 1, 50)
    };
  } else if (toolName === 'prepare_dataverse_record_change') {
    request = {
      action: 'prepare_mutation',
      origin: context.origin,
      mutation: {
        operation: args.operation === 'create' ? 'create' : 'update',
        table: stringValue(args.table),
        recordId: optionalString(args.recordId),
        values: mutationValueArray(args.values)
      }
    };
  } else if (toolName === 'prepare_marketing_list_membership') {
    request = {
      action: 'prepare_list_membership',
      origin: context.origin,
      listId: stringValue(args.listId),
      members: marketingListMemberArray(args.members)
    };
  } else {
    return { ok: false, error: `Unsupported tool: ${toolName}` };
  }

  return executePrimitiveInActiveTab(context, request);
}

function skillFromToolArguments(value: unknown): OddySkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A complete skill definition is required.');
  }
  const candidate = value as Record<string, unknown>;
  const allowedTools = stringArray(candidate.allowedTools, 8) as OddySkillToolName[];
  const inputs = Array.isArray(candidate.inputs)
    ? candidate.inputs
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => {
          const type: OddySkill['inputs'][number]['type'] =
            item.type === 'number' || item.type === 'select' ? item.type : 'text';
          return {
            id: stringValue(item.id),
            label: stringValue(item.label),
            type,
            required: item.required === true,
            ...(type === 'select' ? { options: stringArray(item.options, 50) } : {})
          };
        })
        .slice(0, 20)
    : [];
  const steps = Array.isArray(candidate.steps)
    ? candidate.steps
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          id: stringValue(item.id),
          instruction: stringValue(item.instruction)
        }))
        .slice(0, 20)
    : [];

  return {
    id: stringValue(candidate.id),
    name: stringValue(candidate.name),
    description: stringValue(candidate.description),
    version: stringValue(candidate.version),
    source: 'user',
    enabled: candidate.enabled !== false,
    instructions: stringValue(candidate.instructions),
    allowedTools,
    inputs,
    steps
  };
}

function queryFromArguments(args: Record<string, unknown>): DataverseQuerySpec {
  return {
    table: stringValue(args.table),
    columns: stringArray(args.columns, 20),
    filters: filterArray(args.filters),
    orderBy: orderArray(args.orderBy),
    ...(typeof args.top === 'number'
      ? { top: numberValue(args.top, 10, 1, 50) }
      : {})
  };
}

function marketingListMemberArray(value: unknown): Array<{ table: string; recordId: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      table: stringValue(item.table),
      recordId: stringValue(item.recordId)
    }))
    .filter((item) => item.table && item.recordId)
    .slice(0, 50);
}

function mutationValueArray(value: unknown): DataverseMutationValueInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): DataverseMutationValueInput | undefined => {
      const column = stringValue(item.column);
      const hasScalarValue = Object.prototype.hasOwnProperty.call(item, 'value') && (
        item.value == null ||
        typeof item.value === 'string' ||
        typeof item.value === 'number' ||
        typeof item.value === 'boolean'
      );
      const lookupValue = item.lookup && typeof item.lookup === 'object' && !Array.isArray(item.lookup)
        ? item.lookup as Record<string, unknown>
        : undefined;
      const lookupRecordName = lookupValue ? optionalString(lookupValue.recordName) : undefined;
      const lookup = lookupValue
        ? {
            table: stringValue(lookupValue.table),
            recordId: stringValue(lookupValue.recordId),
            ...(lookupRecordName ? { recordName: lookupRecordName } : {})
          }
        : undefined;
      if (!column || (!hasScalarValue && (!lookup?.table || !lookup.recordId))) return undefined;
      return {
        column,
        ...(hasScalarValue ? { value: item.value } : {}),
        ...(lookup?.table && lookup.recordId ? { lookup } : {})
      } satisfies DataverseMutationValueInput;
    })
    .filter((item): item is DataverseMutationValueInput => Boolean(item))
    .slice(0, 20);
}

function filterArray(value: unknown): DataverseFilterSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const operator = stringValue(item.operator) as DataverseFilterOperator;
      if (!ALLOWED_OPERATORS.has(operator)) return undefined;
      const column = stringValue(item.column);
      if (!column) return undefined;
      return {
        column,
        operator,
        ...(item.value != null ? { value: String(item.value) } : {}),
        ...(typeof item.entityType === 'string' && item.entityType.trim()
          ? { entityType: item.entityType.trim() }
          : {})
      } satisfies DataverseFilterSpec;
    })
    .filter((item): item is DataverseFilterSpec => Boolean(item))
    .slice(0, 20);
}

function orderArray(value: unknown): DataverseOrderSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const column = stringValue(item.column);
      if (!column) return undefined;
      return {
        column,
        direction: item.direction === 'desc' ? 'desc' : 'asc'
      } satisfies DataverseOrderSpec;
    })
    .filter((item): item is DataverseOrderSpec => Boolean(item))
    .slice(0, 5);
}

async function executePrimitiveInActiveTab(
  context: DataverseContext,
  request: DataversePrimitiveRequest
): Promise<DataversePrimitiveResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !context.origin || new URL(tab.url).origin !== context.origin) {
    return { ok: false, action: request.action, error: 'The active browser tab changed.' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: executeDataversePrimitive,
      args: [request]
    });
    return (
      (results[0]?.result as DataversePrimitiveResult | undefined) || {
        ok: false,
        action: request.action,
        error: 'The Dataverse primitive returned no result.'
      }
    );
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: `Dataverse primitive failed: ${errorMessage(error)}`
    };
  }
}

async function refreshAfterMutation(
  context: DataverseContext,
  mutation: DataverseMutationExecutionResult
): Promise<Pick<DataverseMutationExecutionResult, 'refreshStatus' | 'refreshMessage'>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !context.origin || new URL(tab.url).origin !== context.origin) {
    return {
      refreshStatus: 'failed',
      refreshMessage: 'The active tab changed before Oddy could refresh it.'
    };
  }
  if (context.tableLogicalName?.toLowerCase() !== mutation.tableLogicalName.toLowerCase()) {
    return {
      refreshStatus: 'not-applicable',
      refreshMessage: 'The change was applied; the currently open page belongs to another table.'
    };
  }

  const activeRecordId = context.recordId?.replace(/[{}]/g, '').toLowerCase();
  const changedRecordId = mutation.recordId.replace(/[{}]/g, '').toLowerCase();
  if (activeRecordId) {
    if (mutation.operation !== 'update' || activeRecordId !== changedRecordId) {
      return {
        refreshStatus: 'not-applicable',
        refreshMessage: 'The change was applied; the currently open form is a different record.'
      };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: refreshMatchingDataverseForm,
        args: [mutation.tableLogicalName, mutation.recordId]
      });
      const outcome = results
        .map((result) => result.result as { matched?: boolean; refreshed?: boolean; dirty?: boolean; error?: string } | undefined)
        .find((result) => result?.matched);
      if (outcome?.refreshed) {
        return {
          refreshStatus: 'form-refreshed',
          refreshMessage: 'The open Dataverse form was refreshed with the saved values.'
        };
      }
      if (outcome?.dirty) {
        return {
          refreshStatus: 'skipped-dirty',
          refreshMessage: 'The record was updated, but the form was not refreshed because it has other unsaved changes.'
        };
      }
      return {
        refreshStatus: 'failed',
        refreshMessage: outcome?.error || 'The record was updated, but the form refresh API was unavailable.'
      };
    } catch (error) {
      return {
        refreshStatus: 'failed',
        refreshMessage: `The record was updated, but the form could not be refreshed: ${errorMessage(error)}`
      };
    }
  }

  const pageType = context.pageType || getSearchParam(new URL(tab.url), 'pagetype');
  if (pageType?.toLowerCase() !== 'entitylist') {
    return {
      refreshStatus: 'not-applicable',
      refreshMessage: 'The change was applied; no matching open form or list needed refreshing.'
    };
  }

  try {
    const currentUrl = tab.url;
    await chrome.tabs.reload(tab.id);
    const loaded = await waitForTabNavigation(tab.id, currentUrl, 30_000);
    return loaded
      ? {
          refreshStatus: 'page-refreshed',
          refreshMessage: 'The open Dataverse list was refreshed with the saved changes.'
        }
      : {
          refreshStatus: 'failed',
          refreshMessage: 'The change was applied and the list reload started, but Dataverse is still loading.'
        };
  } catch (error) {
    return {
      refreshStatus: 'failed',
      refreshMessage: `The change was applied, but the list could not be refreshed: ${errorMessage(error)}`
    };
  }
}

/** Runs in every accessible Dataverse frame's MAIN world. */
async function refreshMatchingDataverseForm(
  tableLogicalName: string,
  recordId: string
): Promise<{ matched: boolean; refreshed?: boolean; dirty?: boolean; error?: string }> {
  type XrmPage = {
    data?: {
      refresh?: (save?: boolean) => Promise<unknown>;
      entity?: {
        getEntityName?: () => string;
        getId?: () => string;
        getIsDirty?: () => boolean;
      };
    };
  };
  try {
    const xrm = (window as typeof window & { Xrm?: { Page?: XrmPage } }).Xrm;
    const page = xrm?.Page;
    const entity = page?.data?.entity;
    const currentTable = entity?.getEntityName?.()?.toLowerCase();
    const currentId = entity?.getId?.()?.replace(/[{}]/g, '').toLowerCase();
    if (
      currentTable !== tableLogicalName.toLowerCase() ||
      currentId !== recordId.replace(/[{}]/g, '').toLowerCase()
    ) {
      return { matched: false };
    }
    if (entity?.getIsDirty?.()) return { matched: true, dirty: true };
    if (!page?.data?.refresh) {
      return { matched: true, error: 'Xrm.Page.data.refresh is unavailable.' };
    }
    await page.data.refresh(false);
    return { matched: true, refreshed: true };
  } catch (error) {
    return {
      matched: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function navigateDataverse(
  context: DataverseContext,
  args: NavigationArguments,
  requestId?: string
): Promise<NavigationResult> {
  const tableLogicalName = args.tableLogicalName.trim();
  if (!context.origin || !/^[a-z0-9_]+$/i.test(tableLogicalName)) {
    return { ok: false, error: 'A valid table logical name is required for navigation.' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || new URL(tab.url).origin !== context.origin) {
    return { ok: false, error: 'The active browser tab changed before navigation.' };
  }

  let recordId: string | undefined;
  let viewId: string | undefined;
  const url = new URL('/main.aspx', context.origin);
  if (args.target !== 'view' && context.appId) url.searchParams.set('appid', context.appId);
  url.searchParams.set('pagetype', args.target === 'record' ? 'entityrecord' : 'entitylist');
  url.searchParams.set('etn', tableLogicalName);

  if (args.target === 'record') {
    recordId = args.recordId?.replace(/[{}]/g, '').trim() || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
      return { ok: false, error: 'A valid record GUID is required.' };
    }
    url.searchParams.set('id', recordId);
  }

  if (args.target === 'view') {
    viewId = args.viewId?.replace(/[{}]/g, '').trim() || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewId)) {
      return { ok: false, error: 'A valid view GUID is required.' };
    }
    url.searchParams.set('viewid', `{${viewId}}`);
    url.searchParams.set('viewtype', args.viewType === 'savedquery' ? '1039' : '4230');
  }

  const navigationLabel =
    args.target === 'view'
      ? `AI Result (${tableLogicalName})`
      : args.target === 'record'
        ? `${tableLogicalName} record`
        : `${tableLogicalName} list`;
  const expectedUrl = url.toString();
  const sameDestination = navigationUrlsMatch(tab.url, expectedUrl);

  notifyNavigationProgress(requestId, {
    stage: 'opening',
    label: `Opening ${navigationLabel}`,
    detail: sameDestination
      ? 'Refreshing the current Dataverse destination.'
      : 'Using Dataverse native navigation.'
  });

  if (!sameDestination) {
    const nativeResult = await executeXrmNavigation(tab.id, {
      target: args.target,
      tableLogicalName,
      recordId,
      viewId,
      viewType: args.viewType
    });

    if (nativeResult.ok) {
      const navigatedTab = await waitForExpectedTabUrl(tab.id, expectedUrl, 3_000);
      if (navigatedTab?.url) {
        notifyNavigationProgress(requestId, {
          stage: 'loaded',
          label: `${navigationLabel} loaded`,
          detail: 'Dataverse completed the native navigation.'
        });
        return {
          ok: true,
          navigationState: 'loaded',
          navigationMethod: 'xrm',
          target: args.target,
          tableLogicalName,
          recordId,
          viewId,
          url: navigatedTab.url
        };
      }
    }

    notifyNavigationProgress(requestId, {
      stage: 'opening',
      label: `Opening ${navigationLabel}`,
      detail: 'Native navigation was unavailable or did not reach the requested destination; using the browser fallback.'
    });
  }

  try {
    if (sameDestination) {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
    } else {
      await chrome.tabs.update(tab.id, { url: expectedUrl });
    }

    const loaded = await waitForTabNavigation(tab.id, expectedUrl, 30_000);
    notifyNavigationProgress(requestId, loaded
      ? {
          stage: 'loaded',
          label: `${navigationLabel} loaded`,
          detail: 'The destination page finished loading through the browser fallback.'
        }
      : {
          stage: 'delayed',
          label: `${navigationLabel} is still loading`,
          detail: 'Navigation started, but Dataverse did not report completion within 30 seconds.'
        });

    return {
      ok: true,
      navigationState: loaded ? 'loaded' : 'started',
      navigationMethod: 'url',
      target: args.target,
      tableLogicalName,
      recordId,
      viewId,
      url: expectedUrl
    };
  } catch (error) {
    return { ok: false, error: `Navigation failed: ${errorMessage(error)}` };
  }
}

async function executeXrmNavigation(
  tabId: number,
  request: XrmNavigationRequest
): Promise<XrmNavigationResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: navigateWithXrm,
      args: [request]
    });
    return (results[0]?.result as XrmNavigationResult | undefined) || {
      ok: false,
      error: 'Dataverse native navigation returned no result.'
    };
  } catch (error) {
    return { ok: false, error: `Dataverse native navigation failed: ${errorMessage(error)}` };
  }
}

/** Runs in the Dataverse page MAIN world. */
async function navigateWithXrm(request: XrmNavigationRequest): Promise<XrmNavigationResult> {
  type PageInput = Record<string, string>;
  type XrmWindow = typeof window & {
    Xrm?: {
      Navigation?: {
        navigateTo?: (pageInput: PageInput) => Promise<unknown>;
      };
    };
  };

  try {
    const navigation = (window as XrmWindow).Xrm?.Navigation;
    if (!navigation?.navigateTo) {
      return { ok: false, error: 'Xrm.Navigation.navigateTo is unavailable.' };
    }

    const pageInput: PageInput = request.target === 'record'
      ? {
          pageType: 'entityrecord',
          entityName: request.tableLogicalName,
          entityId: request.recordId || ''
        }
      : {
          pageType: 'entitylist',
          entityName: request.tableLogicalName,
          ...(request.target === 'view' && request.viewId
            ? {
                viewId: request.viewId,
                viewType: request.viewType === 'savedquery' ? 'savedquery' : 'userquery'
              }
            : {})
        };

    await navigation.navigateTo(pageInput);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function notifyNavigationProgress(
  requestId: string | undefined,
  progress: Omit<NavigationProgress, 'requestId'>
): void {
  if (!requestId) return;
  void chrome.runtime.sendMessage({
    type: 'NAVIGATION_STATUS',
    payload: { requestId, ...progress }
  } satisfies ExtensionMessage).catch(() => undefined);
}

async function waitForExpectedTabUrl(
  tabId: number,
  expectedUrl: string,
  timeoutMs: number
): Promise<chrome.tabs.Tab | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return undefined;
    if (tab.url && navigationUrlsMatch(tab.url, expectedUrl)) return tab;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return undefined;
}

async function waitForTabNavigation(
  tabId: number,
  expectedUrl: string,
  timeoutMs: number
): Promise<boolean> {
  const isExpectedAndComplete = (tab?: chrome.tabs.Tab): boolean =>
    Boolean(tab?.status === 'complete' && tab.url && navigationUrlsMatch(tab.url, expectedUrl));

  try {
    if (isExpectedAndComplete(await chrome.tabs.get(tabId))) return true;
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeout);
      resolve(loaded);
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }, updatedTab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return;
      if (
        (changeInfo.status === 'complete' || updatedTab.status === 'complete') &&
        navigationUrlsMatch(updatedTab.url || '', expectedUrl)
      ) {
        finish(true);
      }
    };
    const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function navigationUrlsMatch(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;

    return ['pagetype', 'etn', 'id', 'viewid'].every((key) => {
      const expectedValue = getSearchParam(expected, key);
      if (expectedValue == null) return true;
      return (getSearchParam(actual, key) || '').replace(/[{}]/g, '').toLowerCase() ===
        expectedValue.replace(/[{}]/g, '').toLowerCase();
    });
  } catch {
    return false;
  }
}

function getSearchParam(url: URL, name: string): string | null {
  const match = [...url.searchParams.entries()].find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match?.[1] ?? null;
}

function activityForTool(
  toolName: string,
  result: DataversePrimitiveResult | NavigationResult | OddySkillToolResult
): ToolActivity {
  if (!result.ok) {
    return {
      name: toolName,
      label: toolName,
      summary: 'Failed',
      details: result.error || 'Unknown error'
    };
  }

  if ('action' in result) {
    if (result.action === 'list_skills') {
      return {
        name: toolName,
        label: 'Listed custom skills',
        summary: `${result.skills?.length || 0} custom skill${result.skills?.length === 1 ? '' : 's'}`,
        details: result.skills?.map((skill) => `${skill.name} (${skill.id})`).join('; ') || 'No custom skills.'
      };
    }
    if (result.action === 'get_skill') {
      return {
        name: toolName,
        label: `Read ${result.skill?.name || 'custom skill'}`,
        summary: 'Full skill definition loaded',
        details: result.skill ? `${result.skill.steps.length} steps; ${result.skill.allowedTools.length} allowed tools.` : undefined
      };
    }
    if (result.action === 'prepare_skill_change') {
      return {
        name: toolName,
        label: `Prepared skill ${result.change?.operation || 'change'}`,
        summary: 'Awaiting explicit approval',
        details: result.change
          ? `${result.change.skillId}; local skill storage was not changed.`
          : 'Local skill storage was not changed.'
      };
    }
    if (result.action === 'resolve_schema') {
      return {
        name: toolName,
        label: `Resolved ${result.entity?.logicalName || 'schema'}`,
        summary: `${result.resolvedColumns?.length || 0} columns resolved`,
        details: `Table: ${result.entity?.logicalName}. Unresolved: ${result.unresolvedColumns?.join(', ') || 'none'}.`
      };
    }
    if (result.action === 'query_records') {
      return {
        name: toolName,
        label: `Queried ${result.entity?.logicalName || 'Dataverse'}`,
        summary: `${result.totalCount || 0} matching record${result.totalCount === 1 ? '' : 's'}`,
        details: `Structured read-only query: ${JSON.stringify(result.query)}.`
      };
    }
    if (result.action === 'discover_relationships') {
      return {
        name: toolName,
        label: 'Discovered relationships',
        summary: `${result.relationships?.length || 0} direct relationship${result.relationships?.length === 1 ? '' : 's'}`,
        details: result.relationships?.map((relationship) => `${relationship.schemaName}: ${relationship.lookupColumn} (${relationship.direction})`).join('; ') || 'None found.'
      };
    }
    if (result.action === 'get_view') {
      return {
        name: toolName,
        label: `Read ${result.view?.name || 'personal view'}`,
        summary: 'View definition loaded',
        details: `View ${result.view?.id}; query: ${JSON.stringify(result.view?.query)}.`
      };
    }
    if (result.action === 'prepare_mutation') {
      return {
        name: toolName,
        label: `Prepared ${result.mutation?.operation || 'record'} proposal`,
        summary: `${result.mutation?.fields.length || 0} field${result.mutation?.fields.length === 1 ? '' : 's'} awaiting approval`,
        details: result.mutation
          ? `${result.mutation.tableLogicalName}${result.mutation.recordId ? ` ${result.mutation.recordId}` : ''}; no business data was written.`
          : 'No business data was written.'
      };
    }
    if (result.action === 'execute_mutation') {
      return {
        name: toolName,
        label: 'Applied approved record change',
        summary: `${result.mutationResult?.changedColumns.length || 0} fields changed`,
        details: result.mutationResult?.recordId
      };
    }
    if (result.action === 'prepare_list_membership') {
      return {
        name: toolName,
        label: `Prepared members for ${result.listMembership?.listName || 'marketing list'}`,
        summary: `${result.listMembership?.members.length || 0} member${result.listMembership?.members.length === 1 ? '' : 's'} awaiting approval`,
        details: result.listMembership
          ? `Bulk AddListMembersList proposal for ${result.listMembership.memberTableLogicalName}; ${result.listMembership.alreadyMembers.length} existing member${result.listMembership.alreadyMembers.length === 1 ? '' : 's'} excluded; no membership was changed.`
          : 'No marketing-list membership was changed.'
      };
    }
    if (result.action === 'execute_list_membership') {
      return {
        name: toolName,
        label: `Added members to ${result.listMembershipResult?.listName || 'marketing list'}`,
        summary: `${result.listMembershipResult?.addedMemberIds.length || 0} member${result.listMembershipResult?.addedMemberIds.length === 1 ? '' : 's'} added`,
        details: result.listMembershipResult?.listId
      };
    }
    if (result.action === 'upsert_view') {
      return {
        name: toolName,
        label: `${result.view?.created ? 'Created' : 'Updated'} ${result.view?.name || 'personal view'}`,
        summary: 'View definition saved',
        details: `View ${result.view?.id}; query: ${JSON.stringify(result.view?.query)}.`
      };
    }
    const dataverseResult = result as DataversePrimitiveResult;
    return {
      name: toolName,
      label: `Executed ${dataverseResult.view?.name || 'personal view'}`,
      summary: `${dataverseResult.records?.length || 0} record${dataverseResult.records?.length === 1 ? '' : 's'} returned`,
      details: `View ${dataverseResult.view?.id}; records returned in configured filter and sort order.`
    };
  }

  const loaded = result.navigationState === 'loaded';
  return {
    name: toolName,
    label: `${loaded ? 'Loaded' : 'Opening'} ${result.tableLogicalName || 'Dataverse'}`,
    summary: loaded
      ? `${result.target} destination finished loading`
      : `${result.target} navigation started; Dataverse is still loading`,
    details: `${result.navigationMethod === 'xrm' ? 'Xrm.Navigation.navigateTo' : 'Browser URL fallback'}; target URL: ${result.url}`
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result || undefined;
}

function stringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];
}

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

async function getActiveDataverseContext(): Promise<DataverseContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) throw new Error('No active browser tab is available.');

  const base = contextFromUrl(tab.url, tab.title);
  if (!base.isDataverse || !tab.id || !isDataverseUrl(tab.url)) return base;

  let context = base;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: collectXrmPageContext
    });
    const snapshot = pickBestPageContext(
      results.map((result) => result.result as PageContextSnapshot | undefined)
    );
    context = mergePageContext(base, snapshot);
  } catch (error) {
    context = { ...base, warning: `Form context could not be read: ${errorMessage(error)}` };
  }

  if (context.fields.length > 0) return context;

  if (context.origin && context.tableLogicalName && context.recordId) {
    const request: WebApiContextRequest = {
      origin: context.origin,
      tableLogicalName: context.tableLogicalName,
      recordId: context.recordId
    };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: 'MAIN',
        func: collectDataverseWebApiContext,
        args: [request]
      });
      return mergePageContext(context, results[0]?.result as PageContextSnapshot | undefined);
    } catch (error) {
      return {
        ...context,
        warning: `Dataverse Web API fallback could not run: ${errorMessage(error)}`
      };
    }
  }

  return {
    ...context,
    warning: context.warning || 'No active Dataverse record is selected; list-level tools remain available.'
  };
}
