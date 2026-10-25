import { describe, expect, it, vi } from 'vitest';
import {
  approvalStatusLabel,
  canEditApproval,
  createApprovalExecutor,
  toggleSelection
} from '../lib/approvals';
import type { ApprovalState, ApprovalStatus } from '../lib/conversation-model';

describe('shared approval lifecycle', () => {
  it.each<ApprovalStatus>(['pending', 'approving', 'approved', 'rejected', 'error'])(
    'only pending live approvals are editable (%s)',
    (status) => {
      expect(canEditApproval({ status })).toBe(status === 'pending');
      expect(canEditApproval({ status }, true)).toBe(false);
    }
  );

  it('does not invent missing approval state and toggles a selection immutably', () => {
    expect(canEditApproval(undefined)).toBe(false);
    const selection = ['firstname'];
    expect(toggleSelection(selection, 'lastname')).toEqual(['firstname', 'lastname']);
    expect(toggleSelection(selection, 'firstname')).toEqual([]);
    expect(selection).toEqual(['firstname']);
  });

  it('labels historical pending approvals as expired without obscuring outcomes', () => {
    expect(approvalStatusLabel({ status: 'pending' }, true)).toBe('Expired preview');
    expect(approvalStatusLabel({ status: 'approved' }, true)).toBe('Applied');
    expect(approvalStatusLabel({ status: 'error' }, true)).toBe('Failed');
  });

  it('locks before yielding, preventing duplicate execution even before React updates', async () => {
    const execute = createApprovalExecutor();
    let resolveRequest!: (value: string) => void;
    const request = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const success = vi.fn();
    const options = {
      id: 'proposal',
      historical: false,
      getState: () => ({ status: 'pending' as const }),
      start: vi.fn(),
      request,
      success,
      failure: vi.fn()
    };
    const first = execute(options);
    await execute(options);
    expect(request).toHaveBeenCalledTimes(1);
    resolveRequest('saved');
    await first;
    expect(success).toHaveBeenCalledWith('saved');
  });

  it('records the failure once and requires a fresh proposal instead of a retry', async () => {
    const execute = createApprovalExecutor();
    let state: ApprovalState<string> = { status: 'pending' };
    const error = new Error('412: record changed');
    const failure = vi.fn(() => {
      state = { status: 'error', error: error.message };
    });
    const options = {
      id: 'proposal',
      historical: false,
      getState: () => state,
      start: () => {
        state = { status: 'approving' };
      },
      request: vi.fn(async () => {
        throw error;
      }),
      success: vi.fn(),
      failure
    };
    await execute(options);
    await execute(options);
    expect(options.request).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledExactlyOnceWith(error);
    expect(options.success).not.toHaveBeenCalled();
  });

  it.each<ApprovalStatus>(['approving', 'approved', 'rejected', 'error'])(
    'does not execute a %s proposal',
    async (status) => {
      const request = vi.fn();
      await createApprovalExecutor()({
        id: 'p',
        historical: false,
        getState: () => ({ status }),
        start: vi.fn(),
        request,
        success: vi.fn(),
        failure: vi.fn()
      });
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('never executes historical proposals', async () => {
    const request = vi.fn();
    await createApprovalExecutor()({
      id: 'p',
      historical: true,
      getState: () => ({ status: 'pending' }),
      start: vi.fn(),
      request,
      success: vi.fn(),
      failure: vi.fn()
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not misreport a successful write when UI follow-up fails', async () => {
    const failure = vi.fn();
    await expect(
      createApprovalExecutor()({
        id: 'p',
        historical: false,
        getState: () => ({ status: 'pending' }),
        start: vi.fn(),
        request: async () => 'saved',
        success: () => {
          throw new Error('UI failure');
        },
        failure
      })
    ).rejects.toThrow('UI failure');
    expect(failure).not.toHaveBeenCalled();
  });
});
