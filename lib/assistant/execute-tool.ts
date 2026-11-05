import type { DataversePrimitiveRequest } from '../dataverse-primitives';
import { executePrimitiveInActiveTab } from '../browser/primitives';
import { executeFlowPrimitiveInActiveTab } from '../browser/flows';
import { activeBulkEngine } from '../browser/bulk';
import { parseBulkPlan } from '../bulk/plan';
import { bulkRepository } from '../bulk/repository';
import { navigateDataverse } from '../browser/navigation';
import { openDataverseFlowDesigner } from '../browser/flow-navigation';
import { errorMessage } from '../messages';
import { getUserSkills, prepareOddySkillChange, skillRevision } from '../skills';
import type { DataverseContext } from '../types';
import type { DataverseFlowListOptions } from '../flows/contracts';
import type { AssistantToolResult } from './contracts';
import {
  stringValue,
  optionalString,
  stringArray,
  numberValue,
  mutationValueArray,
  marketingListMemberArray,
  skillFromToolArguments
} from './arguments';

export async function executeAssistantTool(
  context: DataverseContext,
  toolName: string,
  rawArguments: string,
  requestId?: string
): Promise<AssistantToolResult> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The model supplied invalid JSON tool arguments.' };
  }

  if (toolName === 'list_bulk_datasets') {
    try {
      await bulkRepository.prune();
      return { ok: true, action: 'list_bulk_datasets', datasets: await bulkRepository.datasets() };
    } catch (error) {
      return { ok: false, action: 'list_bulk_datasets', error: errorMessage(error) };
    }
  }
  if (
    toolName === 'prepare_bulk_job' ||
    toolName === 'prepare_bulk_job_remaining' ||
    toolName === 'get_bulk_job'
  ) {
    try {
      const engine = activeBulkEngine(context);
      const job =
        toolName === 'prepare_bulk_job'
          ? await engine.prepare(parseBulkPlan(args.plan))
          : toolName === 'prepare_bulk_job_remaining'
            ? await engine.remaining(stringValue(args.jobId))
            : await engine.inspect(stringValue(args.jobId));
      return { ok: true, action: toolName, job };
    } catch (error) {
      return { ok: false, action: toolName, error: errorMessage(error) };
    }
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
      return {
        ok: false,
        action: 'prepare_skill_change',
        error: 'A valid skill-change operation is required.'
      };
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

  if (toolName === 'open_dataverse_flow_designer') {
    return openDataverseFlowDesigner(context, stringValue(args.workflowId));
  }

  if (toolName === 'navigate_dataverse') {
    return navigateDataverse(
      context,
      {
        target: args.target === 'view' || args.target === 'record' ? args.target : 'list',
        tableLogicalName: stringValue(args.tableLogicalName),
        recordId: optionalString(args.recordId),
        viewId: optionalString(args.viewId),
        viewType: args.viewType === 'savedquery' ? 'savedquery' : 'userquery'
      },
      requestId
    );
  }

  if (!context.origin) {
    return { ok: false, action: 'resolve_schema', error: 'The Dataverse origin is unavailable.' };
  }

  if (toolName === 'list_dataverse_flows') {
    const options = args as DataverseFlowListOptions & { top?: number };
    return executeFlowPrimitiveInActiveTab(context, {
      action: 'list_flows',
      origin: context.origin,
      pageSize: options.pageSize,
      filters: options.filters,
      orderBy: options.orderBy,
      definitionScope: options.definitionScope,
      trigger: options.trigger,
      cursor: options.cursor,
      top: options.top
    });
  }
  if (toolName === 'get_dataverse_flow') {
    return executeFlowPrimitiveInActiveTab(context, {
      action: 'get_flow',
      origin: context.origin,
      workflowId: stringValue(args.workflowId)
    });
  }
  if (toolName === 'list_dataverse_flow_connections') {
    return executeFlowPrimitiveInActiveTab(context, {
      action: 'list_flow_connection_references',
      origin: context.origin,
      top: numberValue(args.top, 50, 1, 100)
    });
  }
  if (toolName === 'prepare_dataverse_flow_change') {
    try {
      if (args.operation !== 'create' && args.operation !== 'update') {
        throw new Error('A valid flow-change operation is required.');
      }
      if (args.spec != null)
        throw new Error(
          'Typed flow specs are no longer supported. Pass a complete definition for create or update.'
        );
      if (!args.definition || typeof args.definition !== 'object' || Array.isArray(args.definition))
        throw new Error('A complete flow definition is required.');
      const definition = args.definition as Record<string, unknown>;
      return executeFlowPrimitiveInActiveTab(context, {
        action: 'prepare_flow_change',
        origin: context.origin,
        operation: args.operation,
        workflowId: optionalString(args.workflowId),
        etag: optionalString(args.etag),
        definition: {
          name: stringValue(definition.name),
          ...(definition.description != null
            ? { description: definition.description as string }
            : {}),
          clientData: stringValue(definition.clientData)
        }
      });
    } catch (error) {
      return {
        ok: false,
        action: 'prepare_flow_change',
        error: errorMessage(error)
      };
    }
  }

  const nativeKeys: Record<string, string[]> = {
    query_dataverse_records: ['fetchXml', 'pageSize', 'cursor'],
    manage_dataverse_view: ['action', 'table', 'fetchXml', 'layoutXml', 'etag'],
    execute_dataverse_view: ['table', 'pageSize', 'cursor']
  };
  const keys = Object.hasOwn(nativeKeys, toolName) ? nativeKeys[toolName] : undefined;
  if (keys) {
    const invalid = Object.keys(args).find(
      (key) =>
        !keys.includes(key) ||
        (args[key] != null && typeof args[key] !== (key === 'pageSize' ? 'number' : 'string'))
    );
    if (invalid)
      return {
        ok: false,
        error: `Invalid native tool argument: ${invalid}. Use the advertised native XML/paging interface.`
      };
    if (toolName === 'manage_dataverse_view' && args.action !== 'get' && args.action !== 'upsert')
      return { ok: false, error: 'View action must be get or upsert.' };
    if (
      toolName === 'manage_dataverse_view' &&
      args.action === 'get' &&
      (args.fetchXml != null || args.layoutXml != null || args.etag != null)
    )
      return {
        ok: false,
        error: 'View get accepts table only; definition and ETag arguments must be null.'
      };
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
      fetchXml: typeof args.fetchXml === 'string' ? args.fetchXml : undefined,
      pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
      cursor: optionalString(args.cursor)
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
            table: stringValue(args.table),
            fetchXml: typeof args.fetchXml === 'string' ? args.fetchXml : '',
            layoutXml: typeof args.layoutXml === 'string' ? args.layoutXml : '',
            etag: optionalString(args.etag)
          };
  } else if (toolName === 'execute_dataverse_view') {
    request = {
      action: 'execute_view',
      origin: context.origin,
      table: optionalString(args.table),
      pageSize: typeof args.pageSize === 'number' ? args.pageSize : undefined,
      cursor: optionalString(args.cursor)
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
