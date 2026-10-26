import { useState } from 'react';
import type { BulkDatasetSummary, BulkJobSummary } from '../../lib/bulk/contracts';
import { parseDatasetFile } from '../../lib/bulk/datasets';
import { errorMessage, sendExtensionMessage } from '../../lib/messages';

export function BulkWorkspace({
  busy,
  enabled,
  onPreview
}: {
  busy: boolean;
  enabled: boolean;
  onPreview: (job: BulkJobSummary) => void;
}) {
  const [datasets, setDatasets] = useState<BulkDatasetSummary[]>([]);
  const [jobs, setJobs] = useState<BulkJobSummary[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = async () => {
    setError(undefined);
    try {
      const data = await sendExtensionMessage<BulkDatasetSummary[]>({ type: 'LIST_BULK_DATASETS' });
      if (!data.ok) throw new Error(data.error);
      setDatasets(data.data || []);
      if (enabled) {
        const result = await sendExtensionMessage<BulkJobSummary[]>({ type: 'LIST_BULK_JOBS' });
        if (!result.ok) throw new Error(result.error);
        setJobs(result.data || []);
      } else setJobs([]);
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const stage = async (file: File) => {
    setWorking(true);
    setError(undefined);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('Dataset file exceeds 25 MiB.');
      const records = parseDatasetFile(file.name, await file.text());
      const result = await sendExtensionMessage<BulkDatasetSummary>({
        type: 'STAGE_BULK_DATASET',
        payload: { name: file.name, records }
      });
      if (!result.ok || !result.data) throw new Error(result.error || 'Dataset staging failed.');
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  };
  const remaining = async (id: string) => {
    setWorking(true);
    setError(undefined);
    try {
      const result = await sendExtensionMessage<BulkJobSummary>({
        type: 'PREPARE_BULK_JOB_REMAINDER',
        payload: { id }
      });
      if (!result.ok || !result.data) throw new Error(result.error || 'Reconciliation failed.');
      onPreview(result.data);
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  };
  const remove = async (type: 'DELETE_BULK_JOB' | 'DELETE_BULK_DATASET', id: string) => {
    if (
      !globalThis.confirm(
        type === 'DELETE_BULK_JOB'
          ? 'Delete this job checkpoint and its frozen rows? This stops further execution, does not undo Dataverse changes, and removes recovery evidence for uncertain writes.'
          : 'Delete this uploaded dataset? Already prepared jobs keep their own frozen rows.'
      )
    )
      return;
    setWorking(true);
    setError(undefined);
    try {
      const result = await sendExtensionMessage({ type, payload: { id } });
      if (!result.ok) throw new Error(result.error || 'Local bulk deletion failed.');
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <details
      className="bulk-workspace"
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary>Bulk workspace · datasets and recovery</summary>
      <p>
        Full rows and uploaded files use a 24-hour cleanup policy when the workspace is used, even
        when chat history is off. Only compact job metadata, counts, and bounded diagnostics go to
        the model; row previews stay local and saved previews follow history retention. No jobs
        restart automatically.
      </p>
      <label>
        Upload a CSV or JSON dataset for bulk creates
        <input
          type="file"
          accept=".csv,.json"
          disabled={busy || working}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void stage(file);
          }}
        />
      </label>
      {datasets.map((dataset) => (
        <div key={dataset.id} className="bulk-workspace-item">
          <strong>{dataset.name}</strong>
          <span>
            {dataset.rowCount.toLocaleString()} rows · {dataset.columns.join(', ')}
          </span>
          <code>{dataset.id}</code>
          <button
            type="button"
            disabled={busy || working}
            onClick={() => void remove('DELETE_BULK_DATASET', dataset.id)}
          >
            Delete dataset
          </button>
        </div>
      ))}
      <button type="button" disabled={busy || working} onClick={() => void refresh()}>
        Refresh bulk workspace
      </button>
      {jobs.map((job) => (
        <div key={job.id} className="bulk-workspace-item">
          <strong>
            {job.operation} · {job.table} · {job.status}
          </strong>
          <span>
            {job.succeeded} succeeded; {job.conflicts} conflicts; {job.uncertain} uncertain;{' '}
            {job.remaining} unprocessed
          </span>
          <code>{job.id}</code>
          <button
            type="button"
            disabled={busy || working || !enabled}
            onClick={() => void remove('DELETE_BULK_JOB', job.id)}
          >
            Delete job checkpoint
          </button>
          {job.status !== 'completed' && job.total > 0 && (
            <button
              type="button"
              disabled={busy || working || !enabled}
              onClick={() => void remaining(job.id)}
            >
              Prepare remaining-work preview
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={busy || working}
        onClick={() => {
          if (
            !globalThis.confirm(
              'Delete all local bulk datasets and job checkpoints? This does not undo Dataverse changes and removes recovery evidence.'
            )
          )
            return;
          setWorking(true);
          void sendExtensionMessage({ type: 'CLEAR_BULK_WORKSPACE' })
            .then((result) => {
              if (!result.ok) throw new Error(result.error);
              setDatasets([]);
              setJobs([]);
            })
            .catch((error) => setError(errorMessage(error)))
            .finally(() => setWorking(false));
        }}
      >
        Clear local bulk data
      </button>
      {working && <p role="status">Processing local bulk data…</p>}
      {error && <p className="mutation-error">{error}</p>}
    </details>
  );
}
