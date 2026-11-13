import { approvalStatusLabel, canEditApproval } from '../../lib/approvals';
import type { StoredTranscriptItem } from '../../lib/conversation-model';
import type { ApprovalActions } from './useApprovals';
import type { SchemaColumnDefinition } from '../../lib/schema/contracts';

const titles = {
  create_table: 'Create custom table',
  create_column: 'Add custom column',
  update_table: 'Edit table settings',
  update_column: 'Edit column settings',
  publish_table: 'Publish ALL pending table customizations'
};

function columnDetails(column: SchemaColumnDefinition): string {
  switch (column.type) {
    case 'lookup':
      return `${column.targetTable} · delete: ${column.deleteBehavior} · ${column.relationshipSchemaName}`;
    case 'datetime':
      return `${column.dateTimeBehavior} · ${column.dateTimeBehavior === 'UserLocal' ? 'UTC instant, displayed locally' : 'wall time, no conversion'}`;
    case 'date':
      return 'Date only (no time)';
    case 'choice':
      return `${column.choices?.join(' / ')}${column.defaultChoice !== undefined ? ' · FORM default: ' + column.defaultChoice : ' · no form default'}`;
    case 'boolean':
      return `${column.falseLabel} / ${column.trueLabel} · default: ${column.defaultBoolean ?? false}`;
    case 'text':
    case 'multiline':
      return `Maximum length: ${column.maxLength}`;
    default:
      return `${column.minValue} – ${column.maxValue}${column.precision !== undefined ? ' · precision: ' + column.precision : ''}`;
  }
}

export function SchemaChangeCards({
  item,
  approvals
}: {
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}) {
  return (
    <div className="mutation-list">
      {item.pendingSchemaChanges?.map((change) => {
        const state = approvals.schemaChangeApprovals[change.id] || { status: 'pending' as const };
        const editable =
          !approvals.blocked &&
          approvals.allowDataverseWrites &&
          change.mode === 'schema-v2' &&
          Boolean(change.steps?.length) &&
          canEditApproval(state, item.historical);
        const columns: SchemaColumnDefinition[] =
          change.plan.operation === 'create_table'
            ? [{ ...change.plan.primaryName, type: 'text' }, ...(change.plan.columns ?? [])]
            : change.plan.operation === 'create_column'
              ? [change.plan.column]
              : [];
        return (
          <section key={change.id} className={`mutation-card ${state.status}`}>
            <div className="mutation-heading">
              <div>
                <strong>{titles[change.plan.operation]}</strong>
                <small>
                  {change.tableLogicalName}
                  {change.columnLogicalName ? '.' + change.columnLogicalName : ''}
                </small>
              </div>
              <span>{approvalStatusLabel(state, item.historical)}</span>
            </div>
            <p className="mutation-note">
              Environment: {change.environmentOrigin}
              <br />
              Solution: {change.solution.displayName} ({change.solution.uniqueName})<br />
              Publisher prefix: {change.solution.prefix}_ · Label LCID: {change.plan.languageCode}
            </p>
            {change.plan.operation === 'create_table' && (
              <p className="mutation-note">
                Ownership: {change.plan.ownership}. No record-access roles are granted by this plan.
              </p>
            )}
            {columns.length > 0 && (
              <table aria-label="Complete proposed columns">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Settings</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column) => (
                    <tr key={column.schemaName}>
                      <td>
                        <strong>{column.displayName}</strong>
                        <br />
                        <code>{column.schemaName}</code>
                      </td>
                      <td>{column.type}</td>
                      <td>{columnDetails(column)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details className="data-preview" open>
              <summary>Requested settings</summary>
              <pre>{JSON.stringify(change.plan, null, 2)}</pre>
            </details>
            {change.before && (
              <details className="data-preview">
                <summary>Before — saved metadata snapshot</summary>
                <pre>{JSON.stringify(change.before, null, 2)}</pre>
              </details>
            )}
            <details className="data-preview">
              <summary>
                {change.plan.operation === 'publish_table'
                  ? 'Exact table-scoped publish request'
                  : 'After — complete request definition'}
              </summary>
              <pre>{JSON.stringify(change.after, null, 2)}</pre>
            </details>
            {change.steps && (
              <details className="data-preview" open>
                <summary>
                  Complete approved execution plan · {change.steps.length} request(s)
                </summary>
                <ol>
                  {change.steps.map((step, index) => (
                    <li key={index}>
                      <strong>
                        {step.kind}: {step.components.join(', ')}
                      </strong>
                      <small>
                        {step.method} {step.path}
                      </small>
                      <pre>{JSON.stringify(step.body, null, 2)}</pre>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {change.mode !== 'schema-v2' && (
              <p className="mutation-note">
                Older schema preview — prepare a fresh complete preview before execution.
              </p>
            )}
            {change.warnings.map((warning) => (
              <p className="mutation-note" key={warning}>
                {warning}
              </p>
            ))}
            {item.historical && (
              <p className="mutation-note">
                Historical preview — prepare a fresh preview before making changes.
              </p>
            )}
            {state.error && <p className="error">{state.error}</p>}
            {state.result && (
              <>
                <p className="mutation-note">{state.result.message}</p>
                <ul>
                  {state.result.outcomes?.map((outcome, index) => (
                    <li key={index}>
                      <strong>{outcome.status}</strong>: {outcome.components.join(', ')}
                      {outcome.message && <small>{outcome.message}</small>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mutation-actions">
              <button
                type="button"
                disabled={!editable}
                className="mutation-reject"
                onClick={() => approvals.rejectSchemaChange(change.id)}
              >
                Reject
              </button>
              <button
                type="button"
                disabled={!editable}
                className="mutation-approve"
                onClick={() => void approvals.approveSchemaChange(change)}
              >
                {change.plan.operation === 'publish_table'
                  ? 'Approve table publishing'
                  : 'Approve schema change'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
