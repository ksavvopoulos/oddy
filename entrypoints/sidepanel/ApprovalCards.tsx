import { approvalStatusLabel, canEditApproval } from '../../lib/approvals';
import type { StoredTranscriptItem } from '../../lib/conversation-model';
import type { ApprovalActions } from './useApprovals';
import { formatPreviewValue } from './formatting';

interface Props {
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}

export function RecordChangeCards({ item, approvals }: Props) {
  const { mutationApprovals, toggleMutationField, rejectMutation, approveMutation } = approvals;
  return (
    <>
      {item.pendingMutations && item.pendingMutations.length > 0 && (
        <div className="mutation-list">
          {item.pendingMutations.map((mutation) => {
            const approval = mutationApprovals[mutation.id] || {
              selectedColumns: mutation.fields.map((field) => field.logicalName),
              status: 'pending' as const
            };
            const editable = !approvals.blocked && canEditApproval(approval, item.historical);
            return (
              <section key={mutation.id} className={`mutation-card ${approval.status}`}>
                <div className="mutation-heading">
                  <div>
                    <strong>
                      {mutation.operation === 'create' ? 'Create' : 'Update'}{' '}
                      {mutation.tableDisplayName || mutation.tableLogicalName}
                    </strong>
                    <small>{mutation.recordName || mutation.recordId || 'New record'}</small>
                  </div>
                  <span>{approvalStatusLabel(approval, item.historical)}</span>
                </div>

                <div className="mutation-fields">
                  {mutation.fields.map((field) => {
                    const selected = approval.selectedColumns.includes(field.logicalName);
                    return (
                      <label key={field.logicalName} className={!selected ? 'excluded' : undefined}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!editable}
                          onChange={() => toggleMutationField(mutation.id, field.logicalName)}
                        />
                        <span className="mutation-field-name">
                          <strong>{field.displayName || field.logicalName}</strong>
                          <small>{field.logicalName}</small>
                        </span>
                        <span className="mutation-values">
                          {mutation.operation === 'update' && (
                            <span className="before-value">
                              {field.currentFormattedValue ||
                                formatPreviewValue(field.currentValue)}
                            </span>
                          )}
                          {mutation.operation === 'update' && <b aria-hidden="true">→</b>}
                          <span className="after-value">
                            {field.proposedFormattedValue ||
                              formatPreviewValue(field.proposedValue, 'Empty text', 'Clear value')}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <p className="mutation-note">
                  {item.historical
                    ? 'This is a historical preview. Ask Oddy to prepare a fresh preview before making changes.'
                    : 'Only selected fields will be written using your current Dataverse permissions.'}
                </p>
                {approval.error && <p className="mutation-error">{approval.error}</p>}
                {approval.status === 'approved' && approval.result && (
                  <>
                    <p className="mutation-success">
                      {approval.result.operation === 'create' ? 'Created' : 'Updated'} record{' '}
                      {approval.result.recordName || approval.result.recordId}.
                    </p>
                    {approval.result.refreshMessage && (
                      <p className={`mutation-refresh ${approval.result.refreshStatus || ''}`}>
                        {approval.result.refreshMessage}
                      </p>
                    )}
                  </>
                )}
                {editable && (
                  <div className="mutation-actions">
                    <button
                      type="button"
                      className="mutation-reject"
                      onClick={() => rejectMutation(mutation.id)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="mutation-approve"
                      disabled={approval.selectedColumns.length === 0}
                      onClick={() => void approveMutation(mutation)}
                    >
                      Approve {approval.selectedColumns.length} field
                      {approval.selectedColumns.length === 1 ? '' : 's'}
                    </button>
                  </div>
                )}
                {approval.status === 'approving' && (
                  <p className="mutation-applying">Applying approved changes…</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

export function FlowChangeCards({ item, approvals }: Props) {
  const { flowChangeApprovals, rejectFlowChange, approveFlowChange } = approvals;
  return (
    <>
      {item.pendingFlowChanges && item.pendingFlowChanges.length > 0 && (
        <div className="mutation-list">
          {item.pendingFlowChanges.map((change) => {
            const approval = flowChangeApprovals[change.id] || { status: 'pending' as const };
            const editable = !approvals.blocked && canEditApproval(approval, item.historical);
            const trigger =
              change.after.trigger.kind === 'manual'
                ? 'Manual button trigger'
                : `${change.after.trigger.change} on ${change.after.trigger.table} · ${change.after.trigger.scope}`;
            return (
              <section key={change.id} className={`mutation-card ${approval.status}`}>
                <div className="mutation-heading">
                  <div>
                    <strong>
                      {change.operation === 'create' ? 'Create' : 'Update'} cloud flow
                    </strong>
                    <small>{change.after.name}</small>
                  </div>
                  <span>{approvalStatusLabel(approval, item.historical)}</span>
                </div>

                <div className="skill-change-details">
                  {change.before && (
                    <div className="skill-change-tools">
                      <span>Current flow</span>
                      <small>
                        {change.before.name} · {change.before.state} · {change.before.workflowId}
                      </small>
                    </div>
                  )}
                  <div className="skill-change-tools">
                    <span>Trigger</span>
                    <small>{trigger}</small>
                    <pre className="flow-action-spec">
                      {JSON.stringify(change.after.trigger, null, 2)}
                    </pre>
                  </div>
                  <div className="skill-change-tools">
                    <span>Connection reference</span>
                    <small>{change.after.connectionReferenceLogicalName}</small>
                  </div>
                  <div className="skill-change-workflow">
                    <span>Sequential actions</span>
                    <ol>
                      {change.after.actions.map((action) => (
                        <li key={action.id}>
                          <strong>{action.id}</strong>: {action.kind} on {action.table}
                          <pre className="flow-action-spec">{JSON.stringify(action, null, 2)}</pre>
                        </li>
                      ))}
                    </ol>
                  </div>
                  {change.warnings.map((warning) => (
                    <p key={warning} className="mutation-note">
                      {warning}
                    </p>
                  ))}
                </div>

                <p className="mutation-note">
                  {item.historical
                    ? 'This historical flow preview cannot be applied. Prepare a fresh preview to continue.'
                    : 'Oddy will write only this validated flow definition. Connection credentials are not changed.'}
                </p>
                {approval.error && <p className="mutation-error">{approval.error}</p>}
                {approval.status === 'approved' && approval.result && (
                  <p className="mutation-success">
                    {approval.result.name} was{' '}
                    {approval.result.operation === 'create' ? 'created' : 'updated'} and is{' '}
                    {approval.result.state}.
                  </p>
                )}
                {editable && (
                  <div className="mutation-actions">
                    <button
                      type="button"
                      className="mutation-reject"
                      onClick={() => rejectFlowChange(change.id)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="mutation-approve"
                      onClick={() => void approveFlowChange(change)}
                    >
                      Approve {change.operation}
                    </button>
                  </div>
                )}
                {approval.status === 'approving' && (
                  <p className="mutation-applying">Applying approved cloud-flow change…</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

export function ListMembershipCards({ item, approvals }: Props) {
  const {
    listMembershipApprovals,
    toggleListMembershipMember,
    rejectListMembership,
    approveListMembership
  } = approvals;
  return (
    <>
      {item.pendingListMemberships && item.pendingListMemberships.length > 0 && (
        <div className="mutation-list">
          {item.pendingListMemberships.map((membership) => {
            const approval = listMembershipApprovals[membership.id] || {
              selectedMemberIds: membership.members.map((member) => member.recordId),
              status: 'pending' as const
            };
            const editable = !approvals.blocked && canEditApproval(approval, item.historical);
            return (
              <section key={membership.id} className={`mutation-card ${approval.status}`}>
                <div className="mutation-heading">
                  <div>
                    <strong>Add members to {membership.listName}</strong>
                    <small>
                      {membership.memberTableDisplayName || membership.memberTableLogicalName}
                    </small>
                  </div>
                  <span>{approvalStatusLabel(approval, item.historical)}</span>
                </div>

                <div className="membership-members">
                  {membership.members.map((member) => {
                    const selected = approval.selectedMemberIds.includes(member.recordId);
                    return (
                      <label key={member.recordId} className={!selected ? 'excluded' : undefined}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!editable}
                          onChange={() =>
                            toggleListMembershipMember(membership.id, member.recordId)
                          }
                        />
                        <span>
                          <strong>{member.recordName || member.recordId}</strong>
                          <small>
                            {member.tableLogicalName} · {member.recordId}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <p className="mutation-note">
                  {item.historical
                    ? 'This historical membership preview cannot be applied. Prepare a fresh preview to continue.'
                    : 'All selected members will be submitted in one Dataverse AddListMembersList action.'}
                </p>
                {membership.alreadyMembers.length > 0 && (
                  <p className="mutation-note">
                    {membership.alreadyMembers.length} existing member
                    {membership.alreadyMembers.length === 1 ? '' : 's'} excluded:{' '}
                    {membership.alreadyMembers
                      .map((member) => member.recordName || member.recordId)
                      .join(', ')}
                    .
                  </p>
                )}
                {approval.error && <p className="mutation-error">{approval.error}</p>}
                {approval.status === 'approved' && approval.result && (
                  <p className="mutation-success">
                    Added {approval.result.addedMemberIds.length} member
                    {approval.result.addedMemberIds.length === 1 ? '' : 's'} to{' '}
                    {approval.result.listName}.
                  </p>
                )}
                {editable && (
                  <div className="mutation-actions">
                    <button
                      type="button"
                      className="mutation-reject"
                      onClick={() => rejectListMembership(membership.id)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="mutation-approve"
                      disabled={approval.selectedMemberIds.length === 0}
                      onClick={() => void approveListMembership(membership)}
                    >
                      Approve {approval.selectedMemberIds.length} member
                      {approval.selectedMemberIds.length === 1 ? '' : 's'}
                    </button>
                  </div>
                )}
                {approval.status === 'approving' && (
                  <p className="mutation-applying">Adding approved members in one bulk action…</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

export function SkillChangeCards({ item, approvals }: Props) {
  const { skillChangeApprovals, rejectSkillChange, approveSkillChange } = approvals;
  return (
    <>
      {item.pendingSkillChanges && item.pendingSkillChanges.length > 0 && (
        <div className="skill-change-list">
          {item.pendingSkillChanges.map((change) => {
            const approval = skillChangeApprovals[change.id] || { status: 'pending' as const };
            const editable = !approvals.blocked && canEditApproval(approval, item.historical);
            const preview = change.after || change.before;
            return (
              <section key={change.id} className={`skill-change-card ${approval.status}`}>
                <div className="skill-change-heading">
                  <div>
                    <strong>
                      {change.operation === 'create'
                        ? 'Create'
                        : change.operation === 'update'
                          ? 'Update'
                          : 'Delete'}{' '}
                      custom skill
                    </strong>
                    <small>{preview?.name || change.skillId}</small>
                  </div>
                  <span>{approvalStatusLabel(approval, item.historical)}</span>
                </div>
                <div className="skill-change-details">
                  <div>
                    <span>Skill ID</span>
                    <code>{change.skillId}</code>
                  </div>
                  <div>
                    <span>Name</span>
                    <strong>
                      {change.before?.name || 'New'} → {change.after?.name || 'Deleted'}
                    </strong>
                  </div>
                  <div>
                    <span>Version</span>
                    <strong>
                      {change.before?.version || 'New'} → {change.after?.version || 'Deleted'}
                    </strong>
                  </div>
                  <div>
                    <span>Inputs</span>
                    <strong>
                      {change.before?.inputs.length ?? 0} → {change.after?.inputs.length ?? 0}
                    </strong>
                  </div>
                  <div>
                    <span>Steps</span>
                    <strong>
                      {change.before?.steps.length ?? 0} → {change.after?.steps.length ?? 0}
                    </strong>
                  </div>
                  <div className="skill-change-tools">
                    <span>Allowed tools before change</span>
                    <small>{change.before?.allowedTools.join(', ') || 'None'}</small>
                  </div>
                  <div className="skill-change-tools">
                    <span>Allowed tools after change</span>
                    <small>
                      {change.after?.allowedTools.join(', ') || 'None — skill will be deleted'}
                    </small>
                  </div>
                  {change.after && (
                    <>
                      <div className="skill-change-tools">
                        <span>Proposed description</span>
                        <small>{change.after.description}</small>
                      </div>
                      <div className="skill-change-tools">
                        <span>Proposed instructions</span>
                        <small>{change.after.instructions}</small>
                      </div>
                    </>
                  )}
                  {change.after && (
                    <div className="skill-change-workflow">
                      <span>Proposed workflow</span>
                      <ol>
                        {change.after.steps.map((step) => (
                          <li key={step.id}>{step.instruction}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
                <p className="mutation-note">
                  {item.historical
                    ? 'This historical skill preview cannot be applied. Prepare a fresh preview to continue.'
                    : 'Only this custom skill will change. Bundled skills and extension settings are not accessible.'}
                </p>
                {approval.error && <p className="mutation-error">{approval.error}</p>}
                {approval.status === 'approved' && approval.result && (
                  <p className="mutation-success">
                    {approval.result.skillName} was{' '}
                    {approval.result.operation === 'create'
                      ? 'created'
                      : approval.result.operation === 'update'
                        ? 'updated'
                        : 'deleted'}
                    .
                  </p>
                )}
                {editable && (
                  <div className="mutation-actions">
                    <button
                      type="button"
                      className="mutation-reject"
                      onClick={() => rejectSkillChange(change.id)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className={
                        change.operation === 'delete' ? 'skill-delete-approve' : 'mutation-approve'
                      }
                      onClick={() => void approveSkillChange(change)}
                    >
                      Approve {change.operation}
                    </button>
                  </div>
                )}
                {approval.status === 'approving' && (
                  <p className="mutation-applying">Applying approved skill change…</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
