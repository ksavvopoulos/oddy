import { approvalStatusLabel, canEditApproval } from '../../lib/approvals';
import type { StoredTranscriptItem } from '../../lib/conversation-model';
import type { FormControl, FormTab, PreparedFormChange } from '../../lib/forms/contracts';
import type { ApprovalActions } from './useApprovals';

type Mark = 'added' | 'moved' | 'changed';

function fieldIndex(tabs: FormTab[] = []) {
  const index = new Map<string, { place: string; control: FormControl }>();
  for (const tab of tabs)
    for (const section of tab.sections)
      for (const control of section.controls)
        if (control.field)
          index.set(control.field, { place: `${tab.name}/${section.name}`, control });
  return index;
}

/** Field/section/tab differences between the before and after layout trees. */
export function formLayoutDiff(change: Pick<PreparedFormChange, 'before' | 'after'>) {
  const before = fieldIndex(change.before?.tabs);
  const after = fieldIndex(change.after?.tabs);
  const marks = new Map<string, Mark>();
  for (const [field, { place, control }] of after) {
    const previous = before.get(field);
    if (!previous) marks.set(field, 'added');
    else if (previous.place !== place) marks.set(field, 'moved');
    else if (
      previous.control.label !== control.label ||
      previous.control.readOnly !== control.readOnly ||
      previous.control.visible !== control.visible ||
      previous.control.showLabel !== control.showLabel
    )
      marks.set(field, 'changed');
  }
  const removed = [...before.keys()].filter((field) => !after.has(field));
  const names = (tabs: FormTab[] = []) =>
    new Set(
      tabs.flatMap((tab) => [`tab:${tab.name}`, ...tab.sections.map((s) => `section:${s.name}`)])
    );
  const previousNames = names(change.before?.tabs);
  const newContainers = [...names(change.after?.tabs)].filter((key) => !previousNames.has(key));
  return { marks, removed, newContainers: new Set(newContainers) };
}

const markLabel: Record<Mark, string> = { added: 'new', moved: 'moved', changed: 'changed' };

function controlText(control: FormControl) {
  if (control.kind === 'spacer') return '(spacer)';
  const name = control.label || control.field || control.controlId || control.kind;
  const flags = [
    control.kind !== 'field' ? control.kind : undefined,
    control.readOnly ? 'read-only' : undefined,
    control.visible ? undefined : 'hidden'
  ].filter(Boolean);
  return `${name}${control.field && control.label ? ` (${control.field})` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`;
}

function LayoutTree({ tabs, diff }: { tabs: FormTab[]; diff?: ReturnType<typeof formLayoutDiff> }) {
  return (
    <ul className="form-layout">
      {tabs.map((tab, tabIndex) => (
        <li key={`${tab.name}-${tabIndex}`}>
          <strong>
            {tab.label || tab.name}
            {!tab.visible && ' · hidden'}
            {diff?.newContainers.has(`tab:${tab.name}`) && <mark> new tab</mark>}
          </strong>
          <ul>
            {tab.sections.map((section, sectionIndex) => (
              <li key={`${section.name}-${sectionIndex}`}>
                <em>
                  {section.label || section.name}
                  {!section.visible && ' · hidden'}
                  {diff?.newContainers.has(`section:${section.name}`) && <mark> new section</mark>}
                </em>
                <ul>
                  {section.controls.map((control, controlIndex) => {
                    const mark = control.field ? diff?.marks.get(control.field) : undefined;
                    return (
                      <li key={controlIndex} className={mark ? `form-${mark}` : undefined}>
                        {controlText(control)}
                        {mark && <mark> {markLabel[mark]}</mark>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function FormChangeCards({
  item,
  approvals
}: {
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}) {
  return (
    <div className="mutation-list">
      {item.pendingFormChanges?.map((change) => {
        const state = approvals.formChangeApprovals[change.id] || { status: 'pending' as const };
        const editable =
          !approvals.blocked &&
          approvals.allowDataverseWrites &&
          change.mode === 'form-v1' &&
          canEditApproval(state, item.historical);
        const publish = change.plan.operation === 'publish_table_forms';
        const diff = publish ? undefined : formLayoutDiff(change);
        return (
          <section key={change.id} className={`mutation-card ${state.status}`}>
            <div className="mutation-heading">
              <div>
                <strong>
                  {publish ? 'Publish ALL pending table customizations' : 'Edit form layout'}
                </strong>
                <small>
                  {publish
                    ? change.tableLogicalName
                    : `${change.formName} (${change.formType}) · ${change.tableLogicalName}`}
                </small>
              </div>
              <span>{approvalStatusLabel(state, item.historical)}</span>
            </div>
            <p className="mutation-note">
              Environment: {change.environmentOrigin}
              {change.solution && (
                <>
                  <br />
                  Solution: {change.solution.displayName} ({change.solution.uniqueName})
                </>
              )}
              {change.plan.operation === 'edit_form' && (
                <>
                  <br />
                  Label LCID: {change.plan.languageCode}
                </>
              )}
            </p>
            <ol aria-label="Approved form edits">
              {change.summary.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ol>
            {diff && diff.removed.length > 0 && (
              <p className="mutation-note">
                Removed from the form (column and data unchanged): {diff.removed.join(', ')}
              </p>
            )}
            {change.after && (
              <details className="data-preview" open>
                <summary>Form layout after this change</summary>
                <LayoutTree tabs={change.after.tabs} diff={diff} />
              </details>
            )}
            {change.before && (
              <details className="data-preview">
                <summary>Form layout before — latest saved version</summary>
                <LayoutTree tabs={change.before.tabs} />
              </details>
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
                  {state.result.outcomes.map((outcome) => (
                    <li key={outcome.step}>
                      <strong>{outcome.status}</strong>: {outcome.step.replace(/_/g, ' ')}
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
                onClick={() => approvals.rejectFormChange(change.id)}
              >
                Reject
              </button>
              <button
                type="button"
                disabled={!editable}
                className="mutation-approve"
                onClick={() => void approvals.approveFormChange(change)}
              >
                {publish ? 'Approve table publishing' : 'Approve form change'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
