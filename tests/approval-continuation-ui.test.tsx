// @vitest-environment happy-dom
import { StrictMode, createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../entrypoints/sidepanel/App';
import { sendExtensionMessage } from '../lib/messages';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { getAvailableSkills } from '../lib/skills';
import type { ExtensionMessage, PreparedDataverseMutation } from '../lib/types';
import { membershipProposal, recordProposal } from './fixtures/proposals';

vi.mock('../lib/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messages')>()),
  sendExtensionMessage: vi.fn()
}));
vi.mock('../lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/storage')>()),
  getSettings: vi.fn()
}));
vi.mock('../lib/skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skills')>()),
  getAvailableSkills: vi.fn()
}));

const prompt = 'Create a new static marketing list and add contacts created the last 30 days';
const listProposal: PreparedDataverseMutation = {
  ...recordProposal,
  tableLogicalName: 'list',
  recordName: 'Recent contacts',
  fields: [
    { requestedName: 'listname', logicalName: 'listname', proposedValue: 'Recent contacts' },
    { requestedName: 'type', logicalName: 'type', proposedValue: false },
    { requestedName: 'createdfromcode', logicalName: 'createdfromcode', proposedValue: 2 }
  ]
};
const context = {
  isDataverse: true,
  source: 'url',
  origin: recordProposal.environmentOrigin,
  fields: [],
  capturedAt: 'now'
};
const result = {
  operation: 'create',
  tableLogicalName: 'list',
  recordId: membershipProposal.listId,
  recordName: 'Recent contacts',
  changedColumns: ['listname', 'type', 'createdfromcode']
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
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

async function submitRequest() {
  render(createElement(StrictMode, null, createElement(App)));
  await screen.findByText('URL context');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: prompt } });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveProperty('disabled', true)
  );
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: 'Approve 3 fields' });
}

function chatCalls() {
  return vi
    .mocked(sendExtensionMessage)
    .mock.calls.map(([message]) => message)
    .filter(
      (message): message is Extract<ExtensionMessage, { type: 'LLM_CHAT' }> =>
        message.type === 'LLM_CHAT'
    );
}

describe('approval continuation in the real side panel', () => {
  it('automatically prepares membership after creating the list, but still waits for fresh approval', async () => {
    let chats = 0;
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT') return { ok: true, data: context };
      if (message.type === 'LLM_CHAT') {
        chats += 1;
        if (chats === 1)
          return {
            ok: true,
            data: { content: 'Approve creating the list.', pendingMutations: [listProposal] }
          };
        if (chats === 2)
          return {
            ok: true,
            data: {
              content: 'Approve adding the matching contacts.',
              pendingListMemberships: [membershipProposal]
            }
          };
        return {
          ok: true,
          data: { content: 'The requested list and membership changes are complete.' }
        };
      }
      if (message.type === 'EXECUTE_DATAVERSE_MUTATION') return { ok: true, data: result };
      if (message.type === 'EXECUTE_MARKETING_LIST_MEMBERSHIP')
        return {
          ok: true,
          data: {
            listId: membershipProposal.listId,
            listName: membershipProposal.listName,
            memberTableLogicalName: 'contact',
            addedMemberIds: [membershipProposal.members[0]!.recordId],
            addedMemberNames: ['Ada Lovelace']
          }
        };
      throw new Error(`Unexpected message: ${message.type}`);
    });
    await submitRequest();
    fireEvent.click(screen.getByRole('button', { name: 'Approve 3 fields' }));
    await screen.findByRole('button', { name: 'Approve 1 member' });
    expect(chatCalls()).toHaveLength(2);
    expect(chatCalls()[1]?.payload.messages.at(-1)?.content).toContain(membershipProposal.listId);
    expect(chatCalls()[1]?.payload.messages.at(-1)?.content).toContain(prompt);
    expect(
      chatCalls()[1]
        ?.payload.messages.map((message) => message.content)
        .join('\n')
    ).toContain('Applied approved record change');
    expect(chatCalls()[1]?.payload.expectedOrigin).toBe(context.origin);
    expect(chatCalls()[1]?.payload.allowSkillTools).toBe(false);
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.filter(([message]) => message.type === 'EXECUTE_MARKETING_LIST_MEMBERSHIP')
    ).toHaveLength(0);
    // StrictMode replays effects; a successful approval must still resume just once.
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.filter(([message]) => message.type === 'EXECUTE_DATAVERSE_MUTATION')
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1 member' }));
    await screen.findByText('The requested list and membership changes are complete.');
    expect(chatCalls()).toHaveLength(3);
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.filter(([message]) => message.type === 'EXECUTE_MARKETING_LIST_MEMBERSHIP')
    ).toHaveLength(1);
    // Internal continuation instructions do not masquerade as new user messages.
    expect(screen.getAllByText(prompt)).toHaveLength(1);
  });

  it('does not automatically retry or continue when creation fails', async () => {
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT') return { ok: true, data: context };
      if (message.type === 'LLM_CHAT')
        return {
          ok: true,
          data: { content: 'Approve creating the list.', pendingMutations: [listProposal] }
        };
      if (message.type === 'EXECUTE_DATAVERSE_MUTATION') return { ok: false, error: '403 denied' };
      throw new Error(`Unexpected message: ${message.type}`);
    });
    await submitRequest();
    fireEvent.click(screen.getByRole('button', { name: 'Approve 3 fields' }));
    await screen.findAllByText('403 denied');
    expect(chatCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Approve 3 fields' })).toBeNull();
  });

  it('keeps the saved list applied when only the follow-up model call fails', async () => {
    let chats = 0;
    vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
      if (message.type === 'GET_ACTIVE_CONTEXT') return { ok: true, data: context };
      if (message.type === 'LLM_CHAT')
        return ++chats === 1
          ? {
              ok: true,
              data: { content: 'Approve creating the list.', pendingMutations: [listProposal] }
            }
          : { ok: false, error: 'Provider unavailable' };
      if (message.type === 'EXECUTE_DATAVERSE_MUTATION') return { ok: true, data: result };
      throw new Error(`Unexpected message: ${message.type}`);
    });
    await submitRequest();
    fireEvent.click(screen.getByRole('button', { name: 'Approve 3 fields' }));
    await screen.findByText(/The approved change succeeded, but Oddy could not continue/);
    expect(screen.getByText('Applied')).toBeDefined();
    expect(chatCalls()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Approve 3 fields' })).toBeNull();
  });
});
