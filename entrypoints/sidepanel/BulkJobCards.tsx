import { useState } from 'react';
import type { BulkJobSummary, BulkRow } from '../../lib/bulk/contracts';
import { approvalStatusLabel, canEditApproval } from '../../lib/approvals';
import type { StoredTranscriptItem } from '../../lib/conversation-model';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';
import type { ApprovalActions } from './useApprovals';
import { formatPreviewValue } from './formatting';

function BulkCard({
  job,
  item,
  approvals
}: {
  job: BulkJobSummary;
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}) {
  const approval = approvals.bulkJobApprovals[job.id] || { status: 'pending' as const };
  const progress = approvals.bulkProgress[job.id] || approval.result || job;
  const editable =
    !approvals.blocked && approvals.allowBulkWrites && canEditApproval(approval, item.historical);
  const [rows, setRows] = useState<BulkRow[]>();
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const inspect = async (start: number) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await sendExtensionMessage<BulkRow[]>({
        type: 'GET_BULK_JOB_ROWS',
        payload: { id: job.id, offset: start }
      });
      if (!result.ok || !result.data)
        throw new Error(result.error || 'Local job rows are unavailable.');
      setRows(result.data);
      setOffset(start);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className={`mutation-card bulk-job-card ${approval.status}`}>
      <div className="mutation-heading">
        <div>
          <strong>
            Bulk {job.operation.replace('_', ' ')} · {job.table}
          </strong>
          <small>{job.total.toLocaleString()} frozen rows</small>
        </div>
        <span>{approvalStatusLabel(approval, item.historical)}</span>
      </div>
      <p>
        {job.matched.toLocaleString()} matched; {job.unchanged.toLocaleString()} already match or
        exist.
      </p>
      <details>
        <summary>Exact selection and operation</summary>
        <pre>{job.description}</pre>
        <small>
          Environment: {job.environmentOrigin}
          <br />
          Preview expires: {new Date(job.expiresAt).toLocaleString()}
        </small>
      </details>
      <details>
        <summary>Before/after sample (up to five rows)</summary>
        {job.sample.map((row) => (
          <div className="bulk-workspace-item" key={row.recordId}>
            <strong>{row.recordName || row.recordId}</strong>
            <span>
              {formatPreviewValue(row.before)} → {formatPreviewValue(row.after)}
            </span>
          </div>
        ))}
      </details>
      <button type="button" disabled={loading} onClick={() => void inspect(0)}>
        Inspect full selection locally
      </button>
      {rows && (
        <div className="bulk-row-inspection">
          <p>
            Rows {offset + 1}–{offset + rows.length} of {job.total}. Not sent to the model.
          </p>
          {rows.map((row) => (
            <div className="bulk-workspace-item" key={row.recordId}>
              <strong>
                {row.recordName || row.recordId} · {row.status}
              </strong>
              {row.fields.map((field) => (
                <span key={field.logicalName}>
                  {field.displayName || field.logicalName}: {formatPreviewValue(field.currentValue)}{' '}
                  → {field.proposedFormattedValue || formatPreviewValue(field.proposedValue)}
                </span>
              ))}
              {row.error && <small>{row.error}</small>}
            </div>
          ))}
          <button
            type="button"
            disabled={loading || offset === 0}
            onClick={() => void inspect(Math.max(0, offset - 25))}
          >
            Previous 25
          </button>
          <button
            type="button"
            disabled={loading || offset + rows.length >= job.total}
            onClick={() => void inspect(offset + 25)}
          >
            Next 25
          </button>
        </div>
      )}
      {error && <p className="mutation-error">{error}</p>}
      <p className="mutation-note">
        One approval covers only this frozen selection. Execution uses multiple requests, not one
        transaction. Existing memberships may be skipped; changed records stop with conflicts.
        Counts include only readable data. Related counts are a one-off calculation. Local rows use
        a 24-hour cleanup policy; saved compact chat previews follow history retention.
      </p>
      <details>
        <summary>Scope and storage warnings</summary>
        {job.warnings.map((warning, index) => (
          <p key={index}>{warning}</p>
        ))}
      </details>
      {item.historical && (
        <p className="mutation-note">
          Historical preview: read-only. Prepare a fresh remaining-work preview from Bulk workspace.
        </p>
      )}
      {approval.error && <p className="mutation-error">{approval.error}</p>}
      {(approval.status === 'approving' || approval.result || approvals.bulkProgress[job.id]) && (
        <p role="status">
          {progress.succeeded} succeeded · {progress.skipped} skipped · {progress.conflicts}{' '}
          conflicts · {progress.failed} failed · {progress.uncertain} uncertain ·{' '}
          {progress.remaining} unprocessed
        </p>
      )}
      {job.operation === 'count_related' && (
        <label>
          <input
            type="checkbox"
            checked={approval.acknowledgeReadableScope === true}
            disabled={!editable}
            onChange={() => approvals.toggleBulkReadableScope(job.id)}
          />{' '}
          I understand these counts include only source records my current user can read; hidden
          cases may make totals incomplete.
        </label>
      )}
      {editable && (
        <div className="mutation-actions">
          <button
            type="button"
            className="mutation-reject"
            onClick={() => approvals.rejectBulkJob(job.id)}
          >
            Reject
          </button>
          <button
            type="button"
            className="mutation-approve"
            disabled={job.operation === 'count_related' && !approval.acknowledgeReadableScope}
            onClick={() => void approvals.approveBulkJob(job)}
          >
            Approve {job.total.toLocaleString()} rows
          </button>
        </div>
      )}
      {approval.status === 'approving' && (
        <button type="button" onClick={() => approvals.stopBulkJob(job.id)}>
          Stop after current chunk
        </button>
      )}
    </section>
  );
}
export function BulkJobCards({
  item,
  approvals
}: {
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}) {
  if (!item.pendingBulkJobs?.length) return null;
  return (
    <div className="mutation-list">
      {item.pendingBulkJobs.map((job) => (
        <BulkCard key={job.id} job={job} item={item} approvals={approvals} />
      ))}
    </div>
  );
}
