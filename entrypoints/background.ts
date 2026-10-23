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
import { getSettings, isAzureOpenAIConfigured } from '../lib/storage';
import type {
  AzureOpenAISettings,
  ChatMessage,
  DataverseContext,
  DataverseMutationExecutionResult,
  PreparedDataverseMutation,
  ExtensionMessage,
  LlmResponse,
  MessageResult,
  NavigationProgress,
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
      const response = await runDataverseAssistant(
        settings.azureOpenAI,
        message.payload.messages,
        message.payload.allowDataverseTools === true,
        message.payload.requestId
      );
      return { ok: true, data: response };
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
        'Prepare a create or update proposal for explicit user approval. For updates, query the target record first and pass its exact record ID. This tool never writes data. It returns a field-level before/after preview. Scalar text, number, boolean, date/choice values, and null are supported; lookups and complex values are not yet supported.',
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
                  description: 'Proposed scalar value. Use null to clear a field.'
                }
              },
              required: ['column', 'value']
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
  requestId?: string
): Promise<LlmResponse> {
  if (!allowDataverseTools) return callAzureOpenAI(settings, inputMessages);

  const context = await getActiveDataverseContext();
  if (!context.isDataverse || !context.origin) return callAzureOpenAI(settings, inputMessages);

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
      `For a new business record: prepare a create proposal with all known scalar field values. ` +
      `Prepared record changes require an explicit approval click in the extension; never claim a proposed change was applied. ` +
      `Navigation results report whether the destination loaded or only started; never claim it loaded when navigationState is started. ` +
      `Never ask the user to click a row, supply a record ID, apply a manual filter, or follow a link when these primitives can complete the request. ` +
      `Never execute business-record writes yourself. Only prepare proposals; the extension performs approved writes outside the model tool loop. ` +
      `Prior messages may include an “Extension tool audit (authoritative)” section; treat it as the execution source of truth.`
  };
  conversation.splice(conversation[0]?.role === 'system' ? 1 : 0, 0, instruction);

  const toolsUsed: ToolActivity[] = [];
  const pendingMutations: PreparedDataverseMutation[] = [];
  let completion = await callAzureOpenAIResponses(settings, {
    messages: conversation,
    tools: DATAVERSE_TOOLS
  });

  for (let round = 0; round < 12; round += 1) {
    if (completion.toolCalls.length === 0) {
      if (!completion.content) throw new Error('Azure OpenAI returned no answer after tool execution.');
      return {
        content: completion.content,
        toolsUsed: toolsUsed.length ? toolsUsed : undefined,
        pendingMutations: pendingMutations.length ? pendingMutations : undefined
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
      tools: DATAVERSE_TOOLS
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

async function executeAssistantTool(
  context: DataverseContext,
  toolName: string,
  rawArguments: string,
  requestId?: string
): Promise<DataversePrimitiveResult | NavigationResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArguments || '{}') as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The model supplied invalid JSON tool arguments.' };
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
  } else {
    return { ok: false, error: `Unsupported tool: ${toolName}` };
  }

  return executePrimitiveInActiveTab(context, request);
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

function mutationValueArray(
  value: unknown
): Array<{ column: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      column: stringValue(item.column),
      value: item.value
    }))
    .filter((item) => item.column && (
      item.value == null ||
      typeof item.value === 'string' ||
      typeof item.value === 'number' ||
      typeof item.value === 'boolean'
    ))
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
  result: DataversePrimitiveResult | NavigationResult
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
    if (result.action === 'upsert_view') {
      return {
        name: toolName,
        label: `${result.view?.created ? 'Created' : 'Updated'} ${result.view?.name || 'personal view'}`,
        summary: 'View definition saved',
        details: `View ${result.view?.id}; query: ${JSON.stringify(result.view?.query)}.`
      };
    }
    return {
      name: toolName,
      label: `Executed ${result.view?.name || 'personal view'}`,
      summary: `${result.records?.length || 0} record${result.records?.length === 1 ? '' : 's'} returned`,
      details: `View ${result.view?.id}; records returned in configured filter and sort order.`
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
