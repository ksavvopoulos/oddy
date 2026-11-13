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
import { definitionProposal } from './fixtures/flow-definitions';
import type { PreparedDataverseFlowChange } from '../lib/flows/contracts';
import { BulkJobCards } from '../entrypoints/sidepanel/BulkJobCards';
import { restoreConversation } from '../lib/conversation-model';
import { bulkSummary } from './fixtures/bulk';

function approvalActions(): ApprovalActions {
  const conversation = conversationFixture();
  return {
    bulkJobApprovals: {},
    schemaChangeApprovals: {},
    setSchemaChangeApprovals: vi.fn(),
    approveSchemaChange: vi.fn(),
    rejectSchemaChange: vi.fn(),
    formChangeApprovals: {},
    setFormChangeApprovals: vi.fn(),
    approveFormChange: vi.fn(),
    rejectFormChange: vi.fn(),
    setBulkJobApprovals: vi.fn(),
    approveBulkJob: vi.fn(),
    rejectBulkJob: vi.fn(),
    stopBulkJob: vi.fn(),
    toggleBulkReadableScope: vi.fn(),
    toggleBulkExecutionOption: vi.fn(),
    bulkProgress: {},
    allowBulkWrites: true,
    allowDataverseWrites: true,
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

describe('Bulk automation approval controls', () => {
  it('restores bypass choices as read-only history without making a saved approval executable', () => {
    const stored = conversationFixture();
    const job = bulkSummary();
    stored.transcript[1] = { ...stored.transcript[1]!, pendingBulkJobs: [job] };
    stored.bulkJobApprovals = {
      [job.id]: {
        status: 'approving',
        executionOptions: { bypassCustomLogic: true, bypassPowerAutomate: true }
      }
    };
    const restored = restoreConversation(stored);
    const approvals = approvalActions();
    approvals.bulkJobApprovals = restored.bulkJobApprovals!;
    const html = renderToStaticMarkup(
      createElement(BulkJobCards, {
        item: restored.transcript[1]!,
        approvals
      })
    );
    expect(html).toContain('Historical preview: read-only');
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('mutation-approve');
    expect(approvals.approveBulkJob).not.toHaveBeenCalled();
  });

  it('does not offer automation bypass for membership actions', () => {
    const item = {
      ...conversationFixture().transcript[1]!,
      pendingBulkJobs: [bulkSummary({ operation: 'membership' })]
    };
    const html = renderToStaticMarkup(
      createElement(BulkJobCards, { item, approvals: approvalActions() })
    );
    expect(html).not.toContain('Automation for this bulk job');
    expect(html).not.toContain('Bypass custom plug-ins');
    expect(html).not.toContain('Suppress Power Automate triggers');
    expect(html).toContain('mutation-approve');
  });
});

describe('Cloud-flow draft save disclosure', () => {
  it('shows the full native definition for creation without typed trigger/action views', () => {
    const item = { ...conversationFixture().transcript[1]!, pendingFlowChanges: [flowProposal] };
    const html = renderToStaticMarkup(
      createElement(FlowChangeCards, { item, approvals: approvalActions() })
    );
    expect(html).toContain('New flow definition');
    expect(html).toContain('Complete definition after');
    expect(html).toContain('Compose');
    expect(html).toContain('created Off');
    expect(html).toContain('Approve create');
    expect(html).not.toContain('Sequential actions');
  });

  it('keeps legacy typed previews readable but never offers approval', () => {
    const legacy = {
      ...flowProposal,
      mode: undefined,
      after: { name: 'Legacy flow', trigger: { kind: 'manual' }, actions: [] }
    } as unknown as PreparedDataverseFlowChange;
    const item = { ...conversationFixture().transcript[1]!, pendingFlowChanges: [legacy] };
    const html = renderToStaticMarkup(
      createElement(FlowChangeCards, { item, approvals: approvalActions() })
    );
    expect(html).toContain('Legacy flow');
    expect(html).toContain('legacy flow preview cannot be applied');
    expect(html).not.toContain('<button');
  });

  it('shows all definition changes and complete documents for a general flow edit', () => {
    const item = {
      ...conversationFixture().transcript[1]!,
      pendingFlowChanges: [definitionProposal]
    };
    const approvals = approvalActions();
    const pending = renderToStaticMarkup(createElement(FlowChangeCards, { item, approvals }));
    expect(pending).toContain('Definition changes');
    expect(pending).toContain('entityName');
    expect(pending).toContain('contact');
    expect(pending).toContain('contacts');
    expect(pending).toContain('Repeat_audit');
    expect(pending).toContain('Foreach');
    expect(pending).toContain('Complete definition before');
    expect(pending).toContain('Complete definition after');
    expect(pending).toContain('designerMetadata');
    expect(pending).toContain('connectionReferences');
    expect(pending).toContain('Approve draft save');
    expect(pending).not.toContain('Sequential actions');
    const historical = renderToStaticMarkup(
      createElement(FlowChangeCards, {
        item: { ...item, historical: true },
        approvals
      })
    );
    expect(historical).toContain('Expired preview');
    expect(historical).not.toContain('<button');
    expect(approvals.approveFlowChange).not.toHaveBeenCalled();
  });

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
