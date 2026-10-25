import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  RecordChangeCards,
  ListMembershipCards,
  SkillChangeCards
} from '../entrypoints/sidepanel/ApprovalCards';
import type { ApprovalActions } from '../entrypoints/sidepanel/useApprovals';
import { conversationFixture } from './fixtures/proposals';

function approvalActions(): ApprovalActions {
  const conversation = conversationFixture();
  return {
    mutationApprovals: conversation.mutationApprovals,
    listMembershipApprovals: conversation.listMembershipApprovals,
    skillChangeApprovals: conversation.skillChangeApprovals,
    setMutationApprovals: vi.fn(),
    setListMembershipApprovals: vi.fn(),
    setSkillChangeApprovals: vi.fn(),
    registerResponse: vi.fn(),
    approving: false,
    approveMutation: vi.fn(),
    rejectMutation: vi.fn(),
    toggleMutationField: vi.fn(),
    approveListMembership: vi.fn(),
    rejectListMembership: vi.fn(),
    toggleListMembershipMember: vi.fn(),
    approveSkillChange: vi.fn(),
    rejectSkillChange: vi.fn()
  };
}

for (const Component of [RecordChangeCards, ListMembershipCards, SkillChangeCards]) {
  describe(Component.name, () => {
    it('renders a pending live preview with approval controls', () => {
      const item = conversationFixture().transcript[1]!;
      const html = renderToStaticMarkup(
        createElement(Component, { item, approvals: approvalActions() })
      );
      expect(html).toContain('Approval required');
      expect(html).toContain('<button');
      expect(html).toContain('Approve');
    });

    it('renders restored previews as read-only', () => {
      const item = { ...conversationFixture().transcript[1]!, historical: true };
      const html = renderToStaticMarkup(
        createElement(Component, { item, approvals: approvalActions() })
      );
      expect(html).toContain('Expired preview');
      expect(html).not.toContain('<button');
    });

    it('does not offer retry controls on a failed preview', () => {
      const item = conversationFixture().transcript[1]!;
      const approvals = approvalActions();
      for (const states of [
        approvals.mutationApprovals,
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
