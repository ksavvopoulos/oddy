import { describe, expect, it } from 'vitest';
import { bulkSummary } from './fixtures/bulk';
import {
  approvalContinuationPrompt,
  createApprovalContinuation,
  createContinuationGuard,
  decideApprovalContinuation
} from '../lib/approval-continuation';
import type { ConversationRequestContext, StoredTranscriptItem } from '../lib/conversation-model';
import { conversationFixture, membershipProposal, recordProposal } from './fixtures/proposals';

const request: ConversationRequestContext = {
  requestId: 'original-request',
  prompt: 'Create a static list and add contacts created in the last 30 days',
  environmentOrigin: recordProposal.environmentOrigin,
  allowDataverseTools: true,
  allowSkillTools: false
};
const outcome = {
  name: 'execute_dataverse_mutation',
  label: 'Applied approved record change',
  summary: 'Created marketing list',
  details: JSON.stringify({
    operation: 'create',
    tableLogicalName: 'list',
    recordId: membershipProposal.listId
  })
};
function fixture() {
  const stored = conversationFixture();
  const transcript: StoredTranscriptItem[] = stored.transcript.map((item) => ({
    ...item,
    requestContext: request,
    pendingListMemberships: undefined,
    pendingSkillChanges: undefined
  }));
  const event = createApprovalContinuation(
    stored.id,
    transcript,
    'pendingMutations',
    recordProposal.id,
    outcome
  )!;
  const state = {
    ...stored,
    transcript,
    conversationId: stored.id,
    environmentOrigin: request.environmentOrigin,
    allowDataverseTools: true,
    allowSkillTools: true,
    mutationApprovals: {
      [recordProposal.id]: {
        ...stored.mutationApprovals[recordProposal.id]!,
        status: 'approved' as const
      }
    }
  };
  return { event, state };
}

describe('post-approval continuation', () => {
  it('resumes after a live successful approval with the original prompt and exact saved ID', () => {
    const { event, state } = fixture();
    const decision = decideApprovalContinuation(event, state);
    expect(decision.action).toBe('resume');
    const prompt = approvalContinuationPrompt(event);
    expect(prompt).toContain(request.prompt);
    expect(prompt).toContain(membershipProposal.listId);
    expect(prompt).toContain('do not repeat it or recreate its record');
    expect(prompt).toContain('NEW preview');
  });

  it('does not widen tool consent when the current settings are more permissive', () => {
    const { event, state } = fixture();
    expect(decideApprovalContinuation(event, state)).toMatchObject({
      action: 'resume',
      request: { allowSkillTools: false }
    });
    event.request = { ...request, allowSkillTools: true };
    state.allowSkillTools = false;
    expect(decideApprovalContinuation(event, state)).toMatchObject({
      action: 'resume',
      request: { allowSkillTools: false }
    });
  });

  it('retains the original skill run and original tool ceiling', () => {
    const { event, state } = fixture();
    event.request = {
      ...request,
      skillRun: { skillId: 'test', inputValues: {} },
      skillToolLimit: ['query_dataverse_records']
    };
    expect(decideApprovalContinuation(event, state)).toMatchObject({
      action: 'resume',
      request: {
        skillRun: event.request.skillRun,
        skillToolLimit: ['query_dataverse_records']
      }
    });
  });

  it.each(['pending', 'approving', 'error', 'rejected'] as const)(
    'does not resume a source proposal whose status is %s',
    (status) => {
      const { event, state } = fixture();
      const changed = {
        ...state,
        mutationApprovals: { [recordProposal.id]: { selectedColumns: ['firstname'], status } }
      };
      expect(decideApprovalContinuation(event, changed).action).toBe('skip');
    }
  );

  it('waits for bulk siblings and resumes only a confirmed completed bulk approval', () => {
    const { event, state } = fixture();
    const job = bulkSummary();
    state.transcript[1]!.pendingBulkJobs = [job];
    const pending = { ...state, bulkJobApprovals: { [job.id]: { status: 'pending' as const } } };
    expect(decideApprovalContinuation(event, pending).action).toBe('wait');
    const source = createApprovalContinuation(
      state.conversationId,
      state.transcript,
      'pendingBulkJobs',
      job.id,
      { name: 'execute_bulk_job', label: 'Completed approved bulk job', summary: '1200 succeeded' }
    )!;
    expect(decideApprovalContinuation(source, pending).action).toBe('skip');
    expect(
      decideApprovalContinuation(source, {
        ...pending,
        bulkJobApprovals: { [job.id]: { status: 'approved' } }
      }).action
    ).toBe('resume');
    expect(
      decideApprovalContinuation(event, {
        ...pending,
        bulkJobApprovals: { [job.id]: { status: 'error' } }
      }).action
    ).toBe('skip');
  });

  it('waits for sibling approvals rather than applying them implicitly', () => {
    const { event, state } = fixture();
    state.transcript[1]!.pendingListMemberships = [membershipProposal];
    expect(decideApprovalContinuation(event, state).action).toBe('wait');
    state.listMembershipApprovals[membershipProposal.id]!.status = 'approved';
    expect(decideApprovalContinuation(event, state).action).toBe('resume');
  });

  it.each(['rejected', 'error'] as const)('stops when a sibling is %s', (status) => {
    const { event, state } = fixture();
    state.transcript[1]!.pendingListMemberships = [membershipProposal];
    state.listMembershipApprovals[membershipProposal.id]!.status = status;
    expect(decideApprovalContinuation(event, state).action).toBe('skip');
  });

  it('does not resume after another user request or conversation switch', () => {
    const { event, state } = fixture();
    expect(decideApprovalContinuation(event, { ...state, conversationId: 'another' }).action).toBe(
      'skip'
    );
    state.transcript.push({
      id: 'new-user',
      role: 'user',
      content: 'Never mind',
      requestContext: { ...request, requestId: 'new' }
    });
    expect(decideApprovalContinuation(event, state).action).toBe('skip');
  });

  it('does not resume when consent is revoked or the environment changes', () => {
    const { event, state } = fixture();
    expect(decideApprovalContinuation(event, { ...state, allowDataverseTools: false }).action).toBe(
      'skip'
    );
    expect(
      decideApprovalContinuation(event, {
        ...state,
        environmentOrigin: 'https://other.crm.dynamics.com'
      }).action
    ).toBe('skip');
  });

  it('never automatically resumes restored or legacy proposals', () => {
    const { state } = fixture();
    state.transcript[1]!.historical = true;
    expect(
      createApprovalContinuation(
        state.id,
        state.transcript,
        'pendingMutations',
        recordProposal.id,
        outcome
      )
    ).toBeUndefined();
    delete state.transcript[1]!.requestContext;
    expect(
      createApprovalContinuation(
        state.id,
        state.transcript,
        'pendingMutations',
        recordProposal.id,
        outcome
      )
    ).toBeUndefined();
  });

  it('consumes each approval only once, including repeated React effects', () => {
    const { event } = fixture();
    const claim = createContinuationGuard();
    expect(claim(event)).toBe(true);
    expect(claim(event)).toBe(false);
    expect(claim({ ...event, proposalId: 'next-proposal' })).toBe(true);
  });
});
