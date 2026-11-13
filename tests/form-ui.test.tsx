// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormChangeCards, formLayoutDiff } from '../entrypoints/sidepanel/FormChangeCards';
import type { ApprovalActions } from '../entrypoints/sidepanel/useApprovals';
import type { FormTab, PreparedFormChange } from '../lib/forms/contracts';
import { decideApprovalContinuation } from '../lib/approval-continuation';
import { formOrigin, mainFormId } from './fixtures/forms';

const field = (name: string, extra = {}) => ({
  kind: 'field' as const,
  field: name,
  label: name,
  showLabel: true,
  visible: true,
  readOnly: false,
  customControl: false,
  ...extra
});
const tabs = (sections: Record<string, ReturnType<typeof field>[]>): FormTab[] => [
  {
    name: 'general',
    label: 'General',
    showLabel: true,
    visible: true,
    expanded: true,
    sections: Object.entries(sections).map(([name, controls]) => ({
      name,
      label: name,
      showLabel: true,
      visible: true,
      tabColumn: 0,
      columns: 1,
      controls
    }))
  }
];

const change: PreparedFormChange = {
  mode: 'form-v1',
  id: 'form-change-1',
  environmentOrigin: formOrigin,
  plan: {
    operation: 'edit_form',
    solutionUniqueName: 'ConsentSolution',
    languageCode: 1033,
    tableLogicalName: 'contact',
    formId: mainFormId,
    baseRevision: 'a'.repeat(64),
    edits: [{ op: 'add_field', field: 'telephone1', tab: 'general', section: 'main' }]
  },
  tableLogicalName: 'contact',
  formId: mainFormId,
  formName: 'Contact',
  formType: 'main',
  solution: { uniqueName: 'ConsentSolution', displayName: 'Consent Solution' },
  baseRevision: 'a'.repeat(64),
  afterRevision: 'b'.repeat(64),
  generatedIds: ['{00000000-0000-0000-0000-000000000001}'],
  summary: ['Add Business Phone (telephone1) to General › main at row 3'],
  before: {
    tabs: tabs({ main: [field('fullname'), field('emailaddress1'), field('birthdate')] })
  },
  after: {
    tabs: tabs({
      main: [field('fullname', { label: 'Name' }), field('emailaddress1'), field('telephone1')],
      extra: [field('birthdate')]
    })
  },
  warnings: ['Saving does not publish.']
};

const actions = (overrides: Partial<ApprovalActions> = {}) =>
  ({
    blocked: false,
    allowDataverseWrites: true,
    formChangeApprovals: {},
    approveFormChange: vi.fn(),
    rejectFormChange: vi.fn(),
    ...overrides
  }) as unknown as ApprovalActions;

afterEach(cleanup);

describe('form change approval card', () => {
  it('marks added, moved, and changed fields and new sections', () => {
    const diff = formLayoutDiff(change);
    expect(Object.fromEntries(diff.marks)).toEqual({
      fullname: 'changed',
      telephone1: 'added',
      birthdate: 'moved'
    });
    expect(diff.removed).toEqual([]);
    expect([...diff.newContainers]).toEqual(['section:extra']);
    expect(
      formLayoutDiff({ ...change, after: { tabs: tabs({ main: [field('fullname')] }) } }).removed
    ).toEqual(['emailaddress1', 'birthdate']);
  });

  it('shows the edit list, layout, and warnings, and approves the exact preview', () => {
    const approvals = actions();
    render(
      createElement(FormChangeCards, {
        item: { id: 'a', role: 'assistant', content: 'Review.', pendingFormChanges: [change] },
        approvals
      })
    );
    expect(screen.getByText('Edit form layout')).toBeTruthy();
    expect(screen.getByText(/Consent Solution \(ConsentSolution\)/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Approved form edits' });
    expect(within(list).getByText(/Add Business Phone/)).toBeTruthy();
    expect(screen.getByText('Saving does not publish.')).toBeTruthy();
    expect(screen.getAllByText(/new section/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Approve form change' }));
    expect(approvals.approveFormChange).toHaveBeenCalledWith(change);
  });

  it('disables approval for historical previews and when writes are off', () => {
    render(
      createElement(FormChangeCards, {
        item: {
          id: 'a',
          role: 'assistant',
          content: '',
          historical: true,
          pendingFormChanges: [change]
        },
        approvals: actions()
      })
    );
    expect(
      screen.getByRole('button', { name: 'Approve form change' }).hasAttribute('disabled')
    ).toBe(true);
    cleanup();
    render(
      createElement(FormChangeCards, {
        item: { id: 'a', role: 'assistant', content: '', pendingFormChanges: [change] },
        approvals: actions({ allowDataverseWrites: false })
      })
    );
    expect(
      screen.getByRole('button', { name: 'Approve form change' }).hasAttribute('disabled')
    ).toBe(true);
  });

  it('labels table publishing as a separate, table-wide approval and shows outcomes', () => {
    const publish: PreparedFormChange = {
      mode: 'form-v1',
      id: 'publish-1',
      environmentOrigin: formOrigin,
      plan: { operation: 'publish_table_forms', tableLogicalName: 'contact' },
      tableLogicalName: 'contact',
      summary: ['Publish all pending customizations for table contact'],
      warnings: ['PublishXml publishes ALL pending customizations for contact.']
    };
    render(
      createElement(FormChangeCards, {
        item: { id: 'a', role: 'assistant', content: '', pendingFormChanges: [publish] },
        approvals: actions({
          formChangeApprovals: {
            'publish-1': {
              status: 'error',
              result: {
                operation: 'publish_table_forms',
                tableLogicalName: 'contact',
                status: 'failed',
                message: 'Form change did not complete.',
                outcomes: [{ step: 'publish', status: 'unknown', message: 'timeout' }]
              }
            }
          }
        })
      })
    );
    expect(screen.getByText('Publish ALL pending table customizations')).toBeTruthy();
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.queryByText(/Form layout after/)).toBeNull();
  });
});

describe('form approvals and continuation', () => {
  const requestContext = {
    requestId: 'r1',
    prompt: 'Add phone to the contact form',
    environmentOrigin: formOrigin,
    allowDataverseTools: true,
    allowSkillTools: false
  };
  const transcript = [
    { id: 'u', role: 'user' as const, content: 'Add phone', requestContext },
    {
      id: 'm',
      role: 'assistant' as const,
      content: 'Review.',
      pendingFormChanges: [change],
      requestContext
    }
  ];
  const state = (status: 'approved' | 'pending' | 'error') => ({
    conversationId: 'c',
    transcript,
    environmentOrigin: formOrigin,
    allowDataverseTools: true,
    allowSkillTools: false,
    mutationApprovals: {},
    listMembershipApprovals: {},
    skillChangeApprovals: {},
    formChangeApprovals: { [change.id]: { status } }
  });
  const event = {
    conversationId: 'c',
    sourceMessageId: 'm',
    proposalId: change.id,
    kind: 'pendingFormChanges' as const,
    request: requestContext,
    outcome: { name: 'execute_dataverse_form_change', label: 'Saved', summary: 'ok' }
  };

  it('resumes only after an approved form save', () => {
    expect(decideApprovalContinuation(event, state('approved')).action).toBe('resume');
    expect(decideApprovalContinuation(event, state('pending')).action).toBe('skip');
    expect(decideApprovalContinuation(event, state('error')).action).toBe('skip');
  });
});
