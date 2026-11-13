import type { DataversePrimitiveResult } from '../dataverse-primitives';
import type { ToolActivity } from '../types';
import type { NavigationResult } from '../browser/navigation';
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
    if (result.action === 'list_schema_solutions')
      return {
        name: toolName,
        label: 'Listed unmanaged solutions',
        summary: `${result.solutions?.length || 0} selectable solutions · ${result.solutionIssues?.length || 0} unavailable entries${result.nextAfterUniqueName ? ' · more pages remain' : ''}`,
        details: result.solutionIssues?.length ? JSON.stringify(result.solutionIssues) : undefined
      };
    if (result.action === 'get_table_definition')
      return {
        name: toolName,
        label: 'Read latest table definition',
        summary: result.tableDefinition?.logicalName || 'Dataverse metadata'
      };
    if (result.action === 'list_forms')
      return {
        name: toolName,
        label: 'Listed table forms',
        summary: `${result.forms?.length || 0} form${result.forms?.length === 1 ? '' : 's'}${result.moreForms ? ' · more not shown' : ''}`,
        details: result.forms?.map((form) => `${form.name} (${form.type})`).join('; ')
      };
    if (result.action === 'get_form_definition') {
      const form = result.formDefinition;
      const fields = form?.tabs
        .flatMap((tab) => tab.sections)
        .flatMap((section) => section.controls)
        .filter((control) => control.kind === 'field').length;
      return {
        name: toolName,
        label: 'Read form layout',
        summary: form
          ? `${form.name} · ${form.tabs.length} tab${form.tabs.length === 1 ? '' : 's'} · ${fields} field${fields === 1 ? '' : 's'}${form.source === 'published' ? ' · published version' : ''}`
          : 'Dataverse form'
      };
    }
    if (result.action === 'prepare_schema_change')
      return {
        name: toolName,
        label: 'Prepared schema change',
        summary: 'Awaiting explicit approval; no metadata written or published',
        details: result.schemaChange
          ? `${result.schemaChange.plan.operation} · ${result.schemaChange.tableLogicalName}`
          : undefined
      };
    if (result.action === 'execute_schema_change')
      return {
        name: toolName,
        label: 'Applied approved schema change',
        summary: result.schemaChangeResult?.message || 'Schema request completed',
        details: JSON.stringify(result.schemaChangeResult)
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
    if (result.action === 'list_flows') {
      const page = result.flowPage;
      const matches =
        result.flows
          ?.map(
            (flow) =>
              `${flow.name} (${flow.workflowId}) · ${{ draft: 'Off', activated: 'On', suspended: 'Suspended' }[flow.state]} · ${flow.definitionVersion} definition · ${flow.triggers.map((trigger) => `${trigger.table || trigger.type}: ${trigger.events?.join('/') || trigger.operationId || 'event unknown'}`).join(', ')}`
          )
          .join('; ') || 'No matching flows on this page.';
      return {
        name: toolName,
        label: 'Listed solution cloud flows',
        summary: `${result.flows?.length || 0} matching flow${result.flows?.length === 1 ? '' : 's'}${page ? ` · ${page.scanned} candidates · ${page.definitionScope} · ${page.hasMore ? 'more pages remain' : 'last page'}${page.uninspectable ? ` · ${page.uninspectable} uninspectable` : ''}` : ''}`,
        details: [matches, ...(page?.warnings || [])].join('\n')
      };
    }
    if (result.action === 'get_flow') {
      return {
        name: toolName,
        label: `Read ${result.flow?.name || 'cloud flow'}`,
        summary: result.flow?.oddyEditable
          ? 'Definition loaded · edits require approval'
          : 'Inspection only',
        details: result.flow
          ? `${result.flow.workflowId} · ${result.flow.state}${result.flow.warnings?.length ? ` · ${result.flow.warnings.join(' ')}` : ''}`
          : undefined
      };
    }
    if (result.action === 'list_flow_connection_references') {
      return {
        name: toolName,
        label: 'Listed flow connections',
        summary: `${result.connectionReferences?.length || 0} connection reference${result.connectionReferences?.length === 1 ? '' : 's'}`,
        details: result.connectionReferences
          ?.map((connection) => `${connection.displayName} (${connection.logicalName})`)
          .join('; ')
      };
    }
    if (result.action === 'prepare_flow_change') {
      return {
        name: toolName,
        label: `Prepared cloud-flow ${result.flowChange?.operation || 'change'}`,
        summary: 'Complete definition changes awaiting approval',
        details: result.flowChange
          ? `${result.flowChange.after.name}; no flow definition was written.`
          : 'No flow definition was written.'
      };
    }
    if (result.action === 'execute_flow_change') {
      return {
        name: toolName,
        label:
          result.flowChangeResult?.savedAs === 'unpublished-draft'
            ? 'Saved approved cloud-flow draft'
            : 'Applied approved cloud-flow change',
        summary:
          result.flowChangeResult?.savedAs === 'unpublished-draft'
            ? `${result.flowChangeResult.name} · unpublished draft saved; not published or activated`
            : `${result.flowChangeResult?.name || 'Cloud flow'} · ${result.flowChangeResult?.state || 'unknown'}`,
        details: result.flowChangeResult?.workflowId
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
        summary: result.recordPage
          ? `${result.recordPage.returned} rows returned · ${result.recordPage.completeness}`
          : `${result.totalCount || 0} matching record${result.totalCount === 1 ? '' : 's'}`,
        details: result.fetchXml
          ? `Native read-only FetchXML. ${result.warnings?.join(' ') || ''}`.trim()
          : `Structured read-only query: ${JSON.stringify(result.query)}.`
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
        details: `View ${result.view?.id}; complete native FetchXML and layout XML returned.`
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
        details: `View ${result.view?.id}; complete native definitions saved.`
      };
    }
    const dataverseResult = result as DataversePrimitiveResult;
    return {
      name: toolName,
      label: `Executed ${dataverseResult.view?.name || 'personal view'}`,
      summary: `${dataverseResult.records?.length || 0} record${dataverseResult.records?.length === 1 ? '' : 's'} returned${dataverseResult.recordPage ? ` · ${dataverseResult.recordPage.completeness}` : ''}`,
      details:
        `View ${dataverseResult.view?.id}; records returned in configured filter and sort order. ${dataverseResult.warnings?.join(' ') || ''}`.trim()
    };
  }

  if (result.navigationMethod === 'power-automate-url') {
    return {
      name: toolName,
      label: `Opened ${result.flowName || 'cloud flow'} in Power Automate`,
      summary: 'Designer tab opened',
      details: result.url
    };
  }

  const navigationResult = result as NavigationResult;
  const loaded = navigationResult.navigationState === 'loaded';
  return {
    name: toolName,
    label: `${loaded ? 'Loaded' : 'Opening'} ${navigationResult.tableLogicalName || 'Dataverse'}`,
    summary: loaded
      ? `${navigationResult.target} destination finished loading`
      : `${navigationResult.target} navigation started; Dataverse is still loading`,
    details: `${navigationResult.navigationMethod === 'xrm' ? 'Xrm.Navigation.navigateTo' : 'Browser URL fallback'}; target URL: ${navigationResult.url}`
  };
}
