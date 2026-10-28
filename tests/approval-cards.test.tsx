import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  RecordChangeCards,
  FlowChangeCards,
  ListMembershipCards,
  SkillChangeCards
} from '../entrypoints/sidepanel/ApprovalCards';
import type { ApprovalActions } from '../entrypoints/sidepanel/useApprovals';
import { conversationFixture, flowProposal } from './fixtures/proposals';

function approvalActions(): ApprovalActions {
  const conversation = conversationFixture();
  return {
    bulkJobApprovals: {},
    setBulkJobApprovals: vi.fn(),
    approveBulkJob: vi.fn(),
    rejectBulkJob: vi.fn(),
    stopBulkJob: vi.fn(),
    toggleBulkReadableScope: vi.fn(),
    bulkProgress: {},
    allowBulkWrites: true,
    mutationApprovals: conversation.mutationApprovals,
    flowChangeApprovals: { [flowProposal.id]: { status: 'pending' } },
    listMembershipApprovals: conversation.listMembershipApprovals,
    skillChangeApprovals: conversation.skillChangeApprovals,
    setMutationApprovals: vi.fn(),
    setFlowChangeApprovals: vi.fn(),
    setListMembershipApprovals: vi.fn(),
    setSkillChangeApprovals: vi.fn(),
    registerResponse: vi.fn(),
    approving: false,
    blocked: false,
    approveMutation: vi.fn(),
    rejectMutation: vi.fn(),
    approveFlowChange: vi.fn(),
    rejectFlowChange: vi.fn(),
    toggleMutationField: vi.fn(),
    approveListMembership: vi.fn(),
    rejectListMembership: vi.fn(),
    toggleListMembershipMember: vi.fn(),
    approveSkillChange: vi.fn(),
    rejectSkillChange: vi.fn()
  };
}

describe('Cloud-flow draft save disclosure', () => {
  it('distinguishes saving a draft from publishing an active flow', () => {
    const item = {
      ...conversationFixture().transcript[1]!,
      pendingFlowChanges: [
        { ...flowProposal, operation: 'update' as const, saveMode: 'draft' as const }
      ]
    };
    const approvals = approvalActions();
    const pending = renderToStaticMarkup(createElement(FlowChangeCards, { item, approvals }));
    expect(pending).toContain('Save cloud-flow draft');
    expect(pending).toContain('Approve draft save');
    expect(pending).toContain('Only an unpublished draft will be saved');
    approvals.flowChangeApprovals[flowProposal.id] = {
      status: 'approved',
      result: {
        operation: 'update',
        workflowId: 'id',
        name: flowProposal.after.name,
        state: 'activated',
        savedAs: 'unpublished-draft'
      }
    };
    const saved = renderToStaticMarkup(createElement(FlowChangeCards, { item, approvals }));
    expect(saved).toContain('unpublished draft saved. Not published or activated');
    expect(saved).toContain('runtime state remains activated');
  });
});

for (const Component of [
  RecordChangeCards,
  FlowChangeCards,
  ListMembershipCards,
  SkillChangeCards
]) {
  describe(Component.name, () => {
    it('renders a pending live preview with approval controls', () => {
      const base = conversationFixture().transcript[1]!;
      const item =
        Component === FlowChangeCards ? { ...base, pendingFlowChanges: [flowProposal] } : base;
      const html = renderToStaticMarkup(
        createElement(Component, { item, approvals: approvalActions() })
      );
      expect(html).toContain('Approval required');
      expect(html).toContain('<button');
      expect(html).toContain('Approve');
    });

    it('renders restored previews as read-only', () => {
      const base = conversationFixture().transcript[1]!;
      const item = {
        ...base,
        ...(Component === FlowChangeCards ? { pendingFlowChanges: [flowProposal] } : {}),
        historical: true
      };
      const html = renderToStaticMarkup(
        createElement(Component, { item, approvals: approvalActions() })
      );
      expect(html).toContain('Expired preview');
      expect(html).not.toContain('<button');
    });

    it('does not offer retry controls on a failed preview', () => {
      const base = conversationFixture().transcript[1]!;
      const item =
        Component === FlowChangeCards ? { ...base, pendingFlowChanges: [flowProposal] } : base;
      const approvals = approvalActions();
      for (const states of [
        approvals.mutationApprovals,
        approvals.flowChangeApprovals,
        approvals.listMembershipApprovals,
        approvals.skillChangeApprovals
      ]) {
        for (const state of Object.values(states)) {
          state.status = 'error';
          state.error = '403 denied';
        }
      }
      const html = renderToStaticMarkup(createElement(Component, { item, approvals }));
      expect(html).toContain('Failed');
      expect(html).toContain('403 denied');
      expect(html).not.toContain('<button');
    });
  });
}
