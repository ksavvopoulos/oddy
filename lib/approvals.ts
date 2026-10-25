import type { ApprovalState } from './conversation-model';

export function canEditApproval(
  approval: Pick<ApprovalState<unknown>, 'status'> | undefined,
  historical = false
): boolean {
  return !historical && approval?.status === 'pending';
}

export function approvalStatusLabel(
  approval: Pick<ApprovalState<unknown>, 'status'>,
  historical = false
): string {
  switch (approval.status) {
    case 'approved':
      return 'Applied';
    case 'rejected':
      return 'Rejected';
    case 'error':
      return 'Failed';
    case 'approving':
      return 'Applying…';
    case 'pending':
      return historical ? 'Expired preview' : 'Approval required';
  }
}

export function toggleSelection(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** Lock synchronously, before React can render or an async request can yield. */
export function createApprovalExecutor() {
  const inFlight = new Set<string>();
  return async function execute<Result>(options: {
    id: string;
    getState: () => ApprovalState<Result> | undefined;
    historical: boolean;
    start: () => void;
    request: () => Promise<Result>;
    success: (result: Result) => void;
    failure: (error: unknown) => void;
  }): Promise<void> {
    if (inFlight.has(options.id) || !canEditApproval(options.getState(), options.historical))
      return;
    inFlight.add(options.id);
    let result: Result;
    try {
      options.start();
      result = await options.request();
    } catch (error) {
      options.failure(error);
      return;
    } finally {
      inFlight.delete(options.id);
    }
    // UI/refresh failures must never relabel a successful Dataverse write as failed.
    options.success(result);
  };
}
