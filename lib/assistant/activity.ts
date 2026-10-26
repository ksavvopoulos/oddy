import type { DataversePrimitiveResult } from '../dataverse-primitives';
import type { ToolActivity } from '../types';
import type { AssistantToolResult } from './contracts';

export function activityForTool(toolName: string, result: AssistantToolResult): ToolActivity {
  if (!result.ok) {
    return {
      name: toolName,
      label: toolName,
      summary: 'Failed',
      details: result.error || 'Unknown error'
    };
  }

  if ('action' in result) {
    if (
      result.action === 'prepare_bulk_job' ||
      result.action === 'prepare_bulk_job_remaining' ||
      result.action === 'get_bulk_job'
    ) {
      return {
        name: toolName,
        label: result.action === 'get_bulk_job' ? 'Read bulk job status' : 'Prepared bulk job',
        summary: `${result.job?.total || 0} rows · ${result.job?.status || 'unknown'}`,
        details: result.job
          ? `Job ${result.job.id}; ${result.job.matched} matched, ${result.job.unchanged} already match/exist; ${result.job.succeeded} confirmed successful. No row arrays or execution tokens are included.`
          : undefined
      };
    }
    if (result.action === 'list_bulk_datasets')
      return {
        name: toolName,
        label: 'Listed local bulk datasets',
        summary: `${result.datasets?.length || 0} datasets`,
        details: result.datasets
          ?.map(
            (dataset) => `${dataset.id}: ${dataset.rowCount} rows; ${dataset.columns.join(', ')}`
          )
          .join('; ')
      };
    if (result.action === 'list_skills') {
      return {
        name: toolName,
        label: 'Listed custom skills',
        summary: `${result.skills?.length || 0} custom skill${result.skills?.length === 1 ? '' : 's'}`,
        details:
          result.skills?.map((skill) => `${skill.name} (${skill.id})`).join('; ') ||
          'No custom skills.'
      };
    }
    if (result.action === 'get_skill') {
      return {
        name: toolName,
        label: `Read ${result.skill?.name || 'custom skill'}`,
        summary: 'Full skill definition loaded',
        details: result.skill
          ? `${result.skill.steps.length} steps; ${result.skill.allowedTools.length} allowed tools.`
          : undefined
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
        details:
          result.relationships
            ?.map(
              (relationship) =>
                `${relationship.schemaName}: ${relationship.lookupColumn} (${relationship.direction})`
            )
            .join('; ') || 'None found.'
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
