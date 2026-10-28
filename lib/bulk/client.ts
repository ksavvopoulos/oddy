import type { ExtensionMessage, MessageResult } from '../types';
import type { BulkExecutionOptions, BulkJobSummary } from './contracts';

export function bulkAudit(summary: BulkJobSummary) {
  return {
    jobId: summary.id,
    operation: summary.operation,
    table: summary.table,
    status: summary.status,
    executionOptions: {
      bypassCustomLogic: summary.executionOptions?.bypassCustomLogic === true,
      bypassPowerAutomate: summary.executionOptions?.bypassPowerAutomate === true
    },
    matched: summary.matched,
    unchanged: summary.unchanged,
    total: summary.total,
    succeeded: summary.succeeded,
    skipped: summary.skipped,
    conflicts: summary.conflicts,
    failed: summary.failed,
    uncertain: summary.uncertain,
    remaining: summary.remaining
  };
}
/** Live UI-owned loop, never an effect/history replay. Each background message processes one checkpointed chunk. */
export async function executeApprovedBulkJob(
  preview: BulkJobSummary,
  client: {
    send: <T>(message: ExtensionMessage) => Promise<MessageResult<T>>;
    allowed: () => boolean;
    stopRequested: () => boolean;
    progress: (summary: BulkJobSummary) => void;
    acknowledgeReadableScope?: boolean;
    executionOptions?: BulkExecutionOptions;
  }
): Promise<BulkJobSummary> {
  if (!client.allowed()) throw new Error('Dataverse consent is required to approve this bulk job.');
  let summary = preview;
  try {
    const approval = await client.send<{ summary: BulkJobSummary; runToken: string }>({
      type: 'APPROVE_BULK_JOB',
      payload: {
        id: preview.id,
        revision: preview.revision,
        acknowledgeReadableScope: client.acknowledgeReadableScope === true,
        executionOptions: client.executionOptions
      }
    });
    if (!approval.ok || !approval.data?.runToken)
      throw new Error(approval.error || 'Bulk approval returned no execution token.');
    summary = approval.data.summary;
    client.progress(summary);
    let chunks = 0;
    while (summary.status === 'approved') {
      if (!client.allowed() || client.stopRequested()) {
        const stopped = await client.send<BulkJobSummary>({
          type: 'STOP_BULK_JOB',
          payload: { id: preview.id }
        });
        if (!stopped.ok || !stopped.data)
          throw new Error(stopped.error || 'Could not checkpoint the stopped job.');
        summary = stopped.data;
        client.progress(summary);
        break;
      }
      if (++chunks > 100000) throw new Error('Bulk chunk safety budget exceeded.');
      const result = await client.send<BulkJobSummary>({
        type: 'EXECUTE_BULK_JOB_CHUNK',
        payload: {
          id: preview.id,
          runToken: approval.data.runToken,
          expectedOffset: summary.total - summary.remaining
        }
      });
      if (!result.ok || !result.data)
        throw new Error(result.error || 'No chunk checkpoint was returned.');
      summary = result.data;
      client.progress(summary);
    }
    if (summary.status !== 'completed')
      throw new Error(
        `${summary.error || 'The job stopped before completion.'}${summary.retryAfterSeconds !== undefined ? ` Retry-After: ${summary.retryAfterSeconds} seconds; no automatic retry was made.` : ''}`
      );
    return summary;
  } catch (error) {
    throw new Error(
      `Bulk job ${preview.id} stopped. Last confirmed checkpoint: ${JSON.stringify(bulkAudit(summary))}. ${error instanceof Error ? error.message : String(error)} A submitted chunk may have applied even if its response/checkpoint was lost. Prepare a fresh remaining-work preview to reconcile; never replay the original job.`
    );
  }
}
