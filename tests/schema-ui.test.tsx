// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../entrypoints/sidepanel/App';
import { SchemaChangeCards } from '../entrypoints/sidepanel/SchemaChangeCards';
import type { ApprovalActions } from '../entrypoints/sidepanel/useApprovals';
import { sendExtensionMessage } from '../lib/messages';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { getAvailableSkills } from '../lib/skills';
import { restoreConversation } from '../lib/conversation-model';
import { conversationFixture } from './fixtures/proposals';
import { schemaProposal, schemaOrigin, consentOutboxPlan } from './fixtures/schema';

vi.mock('../lib/messages', async (original) => ({
  ...(await original<typeof import('../lib/messages')>()),
  sendExtensionMessage: vi.fn()
}));
vi.mock('../lib/storage', async (original) => ({
  ...(await original<typeof import('../lib/storage')>()),
  getSettings: vi.fn()
}));
vi.mock('../lib/skills', async (original) => ({
  ...(await original<typeof import('../lib/skills')>()),
  getAvailableSkills: vi.fn()
}));

const result = {
  operation: 'create_table',
  tableLogicalName: 'new_order',
  solutionUniqueName: 'ExampleSolution',
  status: 'saved',
  message: 'Schema saved. No publish request was sent.'
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    tabs: {
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    windows: {
      getCurrent: vi.fn().mockResolvedValue({ id: 1 }),
      onFocusChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } }
  });
  vi.mocked(getSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    azureOpenAI: {
      ...DEFAULT_SETTINGS.azureOpenAI,
      endpoint: 'https://test.openai.azure.com',
      apiKey: 'test',
      deployment: 'test'
    }
  });
  vi.mocked(getAvailableSkills).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function submit() {
  render(createElement(App));
  await screen.findByText('URL context');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, {
    target: { value: 'Create an orders table in ExampleSolution, then publish it.' }
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveProperty('disabled', true)
  );
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: 'Approve schema change' });
}

describe('schema approval in the real panel', () => {
  it('shows all requested columns and explicit lookup/time/default semantics in one approval card', () => {
    const approve = vi.fn();
    render(
      createElement(SchemaChangeCards, {
        item: {
          id: 'complete',
          role: 'assistant',
          content: 'Review.',
          pendingSchemaChanges: [{ ...schemaProposal, plan: consentOutboxPlan }]
        },
        approvals: {
          blocked: false,
          allowDataverseWrites: true,
          schemaChangeApprovals: {},
          approveSchemaChange: approve,
          rejectSchemaChange: vi.fn()
        } as unknown as ApprovalActions
      })
    );
    expect(screen.getByRole('table', { name: 'Complete proposed columns' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(10);
    expect(screen.getByRole('cell', { name: 'lookup' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: /contact · delete: Restrict/ })).toBeTruthy();
    expect(screen.getByRole('cell', { name: /UTC instant, displayed locally/ })).toBeTruthy();
    expect(screen.getByRole('cell', { name: /FORM default: Pending/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Approve schema change' })).toHaveLength(1);
    expect(approve).not.toHaveBeenCalled();
  });

  it('preserves partial/unknown component outcomes and never automatically continues or retries', async () => {
    let chats = 0;
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT')
        return {
          ok: true,
          data: {
            isDataverse: true,
            source: 'url',
            origin: schemaOrigin,
            fields: [],
            capturedAt: 'now'
          }
        };
      if (message.type === 'LLM_CHAT') {
        chats++;
        return {
          ok: true,
          data: { content: 'Review the complete table.', pendingSchemaChanges: [schemaProposal] }
        };
      }
      if (message.type === 'EXECUTE_DATAVERSE_SCHEMA_CHANGE')
        return {
          ok: true,
          data: {
            ...result,
            status: 'partial',
            message:
              'Table saved; relationship outcome uncertain. Inspect metadata before a new approval.',
            outcomes: [
              { components: ['new_order', 'new_order.new_name'], status: 'succeeded' },
              {
                components: ['new_order.new_contact'],
                status: 'unknown',
                message: 'Connection lost'
              }
            ]
          }
        };
      return { ok: true };
    });
    await submit();
    fireEvent.click(screen.getByRole('button', { name: 'Approve schema change' }));
    await screen.findByText('Schema plan incomplete — inspect component outcomes');
    expect(screen.getByRole('button', { name: 'Approve schema change' })).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.getByText('Connection lost')).toBeTruthy();
    expect(chats).toBe(1);
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.filter(([m]) => m.type === 'EXECUTE_DATAVERSE_SCHEMA_CHANGE')
    ).toHaveLength(1);
  });

  it('disables legacy v1 previews even in a live conversation', () => {
    const approve = vi.fn();
    render(
      createElement(SchemaChangeCards, {
        item: {
          id: 'old',
          role: 'assistant',
          content: 'Old preview',
          pendingSchemaChanges: [{ ...schemaProposal, mode: 'schema-v1' }]
        },
        approvals: {
          blocked: false,
          allowDataverseWrites: true,
          schemaChangeApprovals: {},
          approveSchemaChange: approve,
          rejectSchemaChange: vi.fn()
        } as unknown as ApprovalActions
      })
    );
    expect(screen.getByRole('button', { name: 'Approve schema change' })).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByText(/Older schema preview/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
  });

  it('waits for approval, audits the save, then continues into a separately approved publish preview', async () => {
    let chats = 0;
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT')
        return {
          ok: true,
          data: {
            isDataverse: true,
            source: 'url',
            origin: schemaOrigin,
            fields: [],
            capturedAt: 'now'
          }
        };
      if (message.type === 'LLM_CHAT') {
        chats++;
        return {
          ok: true,
          data:
            chats === 1
              ? { content: 'Approve the schema.', pendingSchemaChanges: [schemaProposal] }
              : {
                  content: 'Approve publishing.',
                  pendingSchemaChanges: [
                    {
                      ...schemaProposal,
                      id: 'publish',
                      plan: {
                        operation: 'publish_table',
                        solutionUniqueName: 'ExampleSolution',
                        languageCode: 1033,
                        tableLogicalName: 'new_order',
                        baseRevision: 'revision'
                      },
                      warnings: [
                        'Publishes ALL pending customizations for this table, including other makers’ forms/views.'
                      ]
                    }
                  ]
                }
        };
      }
      if (message.type === 'EXECUTE_DATAVERSE_SCHEMA_CHANGE') return { ok: true, data: result };
      return { ok: true };
    });
    await submit();
    expect(sendExtensionMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EXECUTE_DATAVERSE_SCHEMA_CHANGE' })
    );
    expect(screen.getByText(/Environment:/).textContent).toContain(schemaOrigin);
    expect(screen.getByText(/Environment:/).textContent).toContain('ExampleSolution');
    fireEvent.click(screen.getByRole('button', { name: 'Approve schema change' }));
    await screen.findByRole('button', { name: 'Approve table publishing' });
    const writes = vi
      .mocked(sendExtensionMessage)
      .mock.calls.filter(([m]) => m.type === 'EXECUTE_DATAVERSE_SCHEMA_CHANGE');
    expect(writes).toHaveLength(1);
    expect(chats).toBe(2);
    const secondChat = vi
      .mocked(sendExtensionMessage)
      .mock.calls.filter(([m]) => m.type === 'LLM_CHAT')[1]![0];
    expect(JSON.stringify(secondChat)).toContain('new_order');
    expect(JSON.stringify(secondChat)).toContain('No publish request was sent');
  });

  it('does not continue or allow retries after a failed schema execution', async () => {
    let chats = 0;
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT')
        return {
          ok: true,
          data: {
            isDataverse: true,
            source: 'url',
            origin: schemaOrigin,
            fields: [],
            capturedAt: 'now'
          }
        };
      if (message.type === 'LLM_CHAT') {
        chats++;
        return { ok: true, data: { content: 'Approve.', pendingSchemaChanges: [schemaProposal] } };
      }
      if (message.type === 'EXECUTE_DATAVERSE_SCHEMA_CHANGE')
        return { ok: false, error: 'Metadata changed; prepare a fresh preview.' };
      return { ok: true };
    });
    await submit();
    fireEvent.click(screen.getByRole('button', { name: 'Approve schema change' }));
    await screen.findByText('Metadata changed; prepare a fresh preview.', { selector: 'p.error' });
    expect(screen.getByRole('button', { name: 'Approve schema change' })).toHaveProperty(
      'disabled',
      true
    );
    expect(chats).toBe(1);
  });

  it('restores pending schema previews as expired, display-only history', () => {
    const stored = conversationFixture();
    stored.transcript = [
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Approve.',
        pendingSchemaChanges: [schemaProposal]
      }
    ];
    stored.schemaChangeApprovals = { [schemaProposal.id]: { status: 'approving' } };
    const restored = restoreConversation(stored);
    expect(restored.schemaChangeApprovals?.[schemaProposal.id]?.status).toBe('pending');
    expect(restored.transcript[0]!.toolsUsed).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'historical_proposal_expired' })])
    );
    const approve = vi.fn();
    const actions = {
      blocked: false,
      allowDataverseWrites: true,
      schemaChangeApprovals: restored.schemaChangeApprovals,
      approveSchemaChange: approve,
      rejectSchemaChange: vi.fn()
    } as unknown as ApprovalActions;
    render(createElement(SchemaChangeCards, { item: restored.transcript[0]!, approvals: actions }));
    const button = screen.getByRole('button', { name: 'Approve schema change' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(approve).not.toHaveBeenCalled();
  });
});
