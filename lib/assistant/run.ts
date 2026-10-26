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
      `For a filtered list: upsert AI Result with the complete query, then navigate to the returned view ID. ` +
      `For related records of a named record: query the source record, discover the relationship, upsert the target AI Result using the returned lookup column and source ID, then navigate to the view. ` +
      `For modifying AI Result: get the existing view, preserve its filters, revise columns/order, then upsert the full definition. ` +
      `For opening the first/newest/oldest result: execute the view with top 1, then navigate to the returned record ID. ` +
      `For an unfiltered list: resolve the table and navigate to its logical name. ` +
      `For a business-record update: query and uniquely identify the record, then prepare a field-level change proposal. ` +
      `For a new business record: prepare a create proposal with all known field values. Choice labels may be passed directly and are resolved to numeric options from Dataverse metadata. For lookup fields, resolve the column targets, query the exact target record, and pass its table and record ID in the lookup value. ` +
      `For all matching records, many records, or potentially thousands: use prepare_bulk_job with the complete selection query; never loop 50-row queries or put thousands of IDs into the conversation. Bulk jobs support constant updates, related-record counts, uploaded-dataset creates, and static marketing-list membership. Resolve the exact list first; never recreate an existing list. Explicit small ID selections may use prepare_marketing_list_membership. ` +
      `For related counts, resolve the source lookup and clarify ambiguous relationships/status scope. Counts include only readable records, include zero, and are a one-off calculation, not ongoing automation. For bulk creates, list_bulk_datasets gives uploaded handles/columns without rows. Do not invent a dataset or generate thousands of rows in a tool call. ` +
      `Bulk preparation writes no Dataverse data. Bulk row samples stay in the local approval UI, not your tool outputs; report supplied counts and never invent example record names or per-row results. One explicit approval covers frozen rows executed in bounded chunks, not a global transaction. Only a completed job audit establishes success; failed/stopped jobs can be reconciled with prepare_bulk_job_remaining into a NEW preview. Never retry a job blindly or turn creates into upserts. ` +
      `For multi-step requests, stop at each approval boundary. After a successful approval the extension sends an automatic continuation with the original request and exact result IDs; complete only the unfinished steps and never repeat the successful write. ` +
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
