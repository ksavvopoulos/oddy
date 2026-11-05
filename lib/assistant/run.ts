import {
  callAzureOpenAI,
  callAzureOpenAIResponses,
  type AzureChatMessage,
  type AzureResponseFunctionOutput
} from '../azure-openai';
import { getActiveDataverseContext } from '../browser/context';
import { buildSkillExecutionInstruction } from '../skills';
import type {
  AzureOpenAISettings,
  ChatMessage,
  LlmResponse,
  OddySkill,
  OddySkillRun,
  OddySkillToolName,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange,
  ToolActivity
} from '../types';
import type { BulkJobSummary } from '../bulk/contracts';
import type { PreparedDataverseFlowChange } from '../flows/contracts';
import { selectAssistantTools } from './tool-catalog';
import type { AssistantToolResult } from './contracts';
import { executeAssistantTool } from './execute-tool';
import { activityForTool } from './activity';
import { withRuntimeClock } from './runtime-clock';

export async function runDataverseAssistant(
  settings: AzureOpenAISettings,
  inputMessages: ChatMessage[],
  allowDataverseTools: boolean,
  allowSkillTools: boolean,
  requestId?: string,
  skillExecution?: { skill: OddySkill; run: OddySkillRun },
  limits: { expectedOrigin?: string; skillToolLimit?: OddySkillToolName[] } = {}
): Promise<LlmResponse> {
  if (!allowDataverseTools && !allowSkillTools) {
    return callAzureOpenAI(settings, withRuntimeClock(inputMessages));
  }

  const context = await getActiveDataverseContext({ includeUserSettings: allowDataverseTools });
  inputMessages = withRuntimeClock(
    inputMessages,
    new Date(),
    allowDataverseTools ? context.currentUser : undefined
  );
  if (limits.expectedOrigin && context.origin !== limits.expectedOrigin) {
    throw new Error(
      'The active Dataverse environment changed. Return to the original environment before continuing.'
    );
  }
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
      `Use native FetchXML for record queries and view definitions. Resolve logical names with schema tools; XML-escape literal user data, never concatenate it as XML structure. Prefer one IN condition for multiple known IDs instead of per-ID reads. Native operators, nested AND/OR groups, link-entity joins, aliases, distinct and aggregates are supported by Dataverse, not a reduced tool query language. Select only needed fields and include the primary ID when record identity is needed. ` +
      `Record reads and view execution return one bounded page with recordPage, not an automatic total count. Continue recordPage.nextCursor unchanged with other query arguments null and aggregate pages before claiming completeness. Report incomplete and top-limited results honestly; an unreturned record may be inaccessible, not invalid. Use deterministic ordering for paging. Never fabricate record IDs for aggregate or distinct rows. ` +
      `For a filtered list: get AI Result first if it exists, then upsert complete native FetchXML and grid layout XML, using the exact returned ETag for updates or null for creation, then navigate to the returned view ID. ` +
      `For related records of a named record: query the source record, discover the relationship, upsert the target AI Result using the returned lookup column and source ID, then navigate to the view. ` +
      `For modifying AI Result: get its complete original FetchXML and layout XML, preserve all unrelated conditions, group nesting, joins, aliases and layout attributes, and upsert the full revised definitions with the exact ETag. Missing/stale ETags require a fresh read; never retry writes blindly. View saves remain scoped to AI Result. ` +
      `For opening the first/newest/oldest view result: execute the view with pageSize 1, then navigate to its returned record ID; for a native record query use explicit order and top 1. ` +
      `For an unfiltered list: resolve the table and navigate to its logical name. ` +
      `For cloud flows: use list_dataverse_flows with structured filters, ordering, pageSize and cursor. To find flows triggered by a table/event, resolve its logical name and use trigger.table/event, not a flow-name or action-text substring search. For enabled trigger questions use published definition scope and activated runtime state; for finding/editing saved drafts use latest scope. Continue nextCursor even when a matching page is empty. Aggregate all pages; disclose unreadable/unsupported candidates or incomplete scans and never claim exhaustive absence from a partial page. Trigger configuration is not proof of an actual run; run history is not available. List flows to identify the exact workflow, read it before editing, and list existing connection references before creating. When the user asks to show or open a flow in Power Automate, use open_dataverse_flow_designer with the exact workflow ID instead of giving manual instructions or a link. Use complete native Power Automate definitions for both creation and editing; no typed spec or ownership marker is required. New flows are created Off in the default solution. Any unmanaged flow with a readable definition can be edited after approval, regardless of creator. For existing flows submit a complete definition based on get_dataverse_flow and its exact ETag, preserving all unrelated fields, nested actions, expressions, designer metadata, and connection references. For creates pass null workflowId and etag. Use action entity-set names and trigger logical table names from metadata; never guess plural names. Never invent connection references or credentials. Flow creates and edits require explicit approval. Flow updates save an unpublished draft only, never publish or activate it; explain that publishing is a separate Power Automate step and do not claim that live automation changed after a draft-save audit. ` +
      `For a business-record update: query and uniquely identify the record, then prepare a field-level change proposal. ` +
      `For a new business record: prepare a create proposal with all known field values. Choice labels may be passed directly and are resolved to numeric options from Dataverse metadata. For lookup fields, resolve the column targets, query the exact target record, and pass its table and record ID in the lookup value. ` +
      `For all matching records, many records, or potentially thousands: use prepare_bulk_job with the complete selection query; never enumerate ordinary query pages for bulk writes or put thousands of IDs into the conversation. Bulk selection retains its separate validated structured plan; native record reads do not replace the bulk approval pipeline. Bulk jobs support constant updates, related-record counts, uploaded-dataset creates, and static marketing-list membership. Resolve the exact list first; never recreate an existing list. Explicit small ID selections may use prepare_marketing_list_membership. ` +
      `For related counts, resolve the source lookup and clarify ambiguous relationships/status scope. Counts include only readable records, include zero, and are a one-off calculation, not ongoing automation. For bulk creates, list_bulk_datasets gives uploaded handles/columns without rows. Do not invent a dataset or generate thousands of rows in a tool call. ` +
      `Bulk preparation writes no Dataverse data. Bulk row samples stay in the local approval UI, not your tool outputs; report supplied counts and never invent example record names or per-row results. One explicit approval covers frozen rows executed in bounded chunks, not a global transaction. Only a completed job audit establishes success; failed/stopped jobs can be reconciled with prepare_bulk_job_remaining into a NEW preview. Never retry a job blindly or turn creates into upserts. Bulk automation bypass is selected only by the user in the approval card, defaults off, and is recorded in executionOptions in the job audit. Do not select it yourself or claim automation was bypassed without that audit. It does not disable flows globally, stop existing flow runs, or bypass Microsoft system logic. ` +
      `For multi-step requests, stop at each approval boundary. After a successful approval the extension sends an automatic continuation with the original request and exact result IDs; complete only the unfinished steps and never repeat the successful write. ` +
      `Prepared record, cloud-flow, and marketing-list membership changes require an explicit approval click in the extension; never claim a proposed change was applied. ` +
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

  const activeTools = selectAssistantTools({
    allowDataverseTools,
    allowSkillTools,
    skillTools: skillExecution?.skill.allowedTools.filter(
      (tool) => !limits.skillToolLimit || limits.skillToolLimit.includes(tool)
    )
  });
  const allowedToolNames = new Set(activeTools.map((tool) => tool.function.name));
  if (activeTools.length === 0) {
    throw new Error('The selected Oddy skill has no supported tools enabled.');
  }

  const userTime = allowDataverseTools ? context.currentUser : undefined;
  const toolsUsed: ToolActivity[] = userTime
    ? [
        {
          name: 'read_dataverse_user_settings',
          label:
            userTime.source === 'unavailable'
              ? 'Current user time settings unavailable'
              : 'Read current user time settings',
          summary:
            userTime.source === 'unavailable'
              ? 'Lookup failed; rolling UTC clock remains available'
              : [
                  userTime.localDate,
                  userTime.timeZoneDisplayName ||
                    userTime.timeZoneStandardName ||
                    (userTime.timeZoneCode !== undefined
                      ? `Dataverse time-zone code ${userTime.timeZoneCode}`
                      : undefined) ||
                    (userTime.utcOffsetMinutes !== undefined
                      ? `UTC offset ${userTime.utcOffsetMinutes} minutes`
                      : undefined)
                ]
                  .filter(Boolean)
                  .join(' · '),
          details: JSON.stringify(userTime)
        }
      ]
    : [];
  const pendingMutations: PreparedDataverseMutation[] = [];
  const pendingFlowChanges: PreparedDataverseFlowChange[] = [];
  const pendingListMemberships: PreparedMarketingListMembership[] = [];
  const pendingSkillChanges: PreparedOddySkillChange[] = [];
  const pendingBulkJobs: BulkJobSummary[] = [];
  let completion = await callAzureOpenAIResponses(settings, {
    messages: conversation,
    tools: activeTools
  });

  for (let round = 0; round < 12; round += 1) {
    if (completion.toolCalls.length === 0) {
      if (!completion.content)
        throw new Error('Azure OpenAI returned no answer after tool execution.');
      return {
        content: completion.content,
        toolsUsed: toolsUsed.length ? toolsUsed : undefined,
        pendingMutations: pendingMutations.length ? pendingMutations : undefined,
        pendingFlowChanges: pendingFlowChanges.length ? pendingFlowChanges : undefined,
        pendingListMemberships: pendingListMemberships.length ? pendingListMemberships : undefined,
        pendingSkillChanges: pendingSkillChanges.length ? pendingSkillChanges : undefined,
        pendingBulkJobs: pendingBulkJobs.length ? pendingBulkJobs : undefined
      };
    }

    const outputs: AzureResponseFunctionOutput[] = [];
    for (const toolCall of completion.toolCalls) {
      // Do not trust the model to call only advertised tools.
      const result: AssistantToolResult = allowedToolNames.has(toolCall.name)
        ? await executeAssistantTool(context, toolCall.name, toolCall.arguments, requestId)
        : { ok: false, error: `Tool ${toolCall.name} is not enabled for this request.` };
      if (
        result.ok &&
        'action' in result &&
        result.action === 'prepare_mutation' &&
        result.mutation
      ) {
        pendingMutations.push(result.mutation);
      }
      if (
        result.ok &&
        'action' in result &&
        result.action === 'prepare_flow_change' &&
        result.flowChange
      ) {
        pendingFlowChanges.push(result.flowChange);
      }
      if (
        result.ok &&
        'action' in result &&
        result.action === 'prepare_list_membership' &&
        result.listMembership
      ) {
        pendingListMemberships.push(result.listMembership);
      }
      if (
        result.ok &&
        'action' in result &&
        result.action === 'prepare_skill_change' &&
        result.change
      ) {
        pendingSkillChanges.push(result.change);
      }
      toolsUsed.push(activityForTool(toolCall.name, result));
      if (
        result.ok &&
        'job' in result &&
        result.job?.status === 'pending' &&
        (result.action === 'prepare_bulk_job' || result.action === 'prepare_bulk_job_remaining')
      ) {
        if (!pendingBulkJobs.some((job) => job.id === result.job!.id))
          pendingBulkJobs.push(result.job);
      }
      outputs.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output: JSON.stringify(
          result.ok && 'job' in result && result.job
            ? { ...result, job: { ...result.job, sample: [] } }
            : result.ok && 'flowChange' in result && result.flowChange
              ? {
                  ...result,
                  flowChange: {
                    id: result.flowChange.id,
                    mode: result.flowChange.mode,
                    operation: result.flowChange.operation,
                    workflowId: result.flowChange.workflowId,
                    before: result.flowChange.before,
                    after: result.flowChange.after,
                    saveMode: result.flowChange.saveMode,
                    warnings: result.flowChange.warnings
                  }
                }
              : result
        )
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
