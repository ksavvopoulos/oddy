// @vitest-environment happy-dom
import { StrictMode, createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../entrypoints/sidepanel/App';
import { sendExtensionMessage } from '../lib/messages';
import { DEFAULT_SETTINGS, getSettings } from '../lib/storage';
import { getAvailableSkills } from '../lib/skills';
import { saveConversation } from '../lib/conversations';
import { contextFromUrl } from '../lib/dataverse-context';
import type { DataverseContext, ExtensionMessage, LlmResponse, MessageResult } from '../lib/types';
import { recordProposal } from './fixtures/proposals';

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
vi.mock('../lib/conversations', async (original) => ({
  ...(await original<typeof import('../lib/conversations')>()),
  saveConversation: vi.fn()
}));

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: T) => {
      listeners.delete(listener);
    }),
    fire: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
    listeners
  };
}
const source: DataverseContext = {
  isDataverse: true,
  source: 'url',
  origin: recordProposal.environmentOrigin,
  environmentName: 'contoso',
  tableLogicalName: 'contact',
  recordName: 'Contact record',
  fields: [{ logicalName: 'fullname', label: 'Name', value: 'PRIVATE_RECORD_VALUE' }],
  capturedAt: 'now'
};
const powerAutomate = contextFromUrl(
  'https://make.powerautomate.com/environments/environment/flows/workflow'
);
let activated: ReturnType<typeof event<(info: chrome.tabs.OnActivatedInfo) => void>>;
let updated: ReturnType<
  typeof event<(tabId: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>
>;
let focused: ReturnType<typeof event<(windowId: number) => void>>;
let current: DataverseContext;
let chat: () => Promise<MessageResult<LlmResponse>>;
let readContext: () => Promise<MessageResult<DataverseContext>>;

beforeEach(() => {
  vi.resetAllMocks();
  activated = event();
  updated = event();
  focused = event();
  vi.stubGlobal('chrome', {
    runtime: { onMessage: event() },
    storage: { onChanged: event() },
    tabs: { onActivated: activated, onUpdated: updated },
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 7 }), onFocusChanged: focused }
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
  vi.mocked(saveConversation).mockResolvedValue(undefined);
  current = source;
  readContext = async () => ({ ok: true, data: current });
  chat = async () => ({ ok: true, data: { content: 'The approved flow draft was saved.' } });
  vi.mocked(sendExtensionMessage).mockImplementation(async (message) => {
    if (message.type === 'GET_ACTIVE_CONTEXT') return readContext();
    if (message.type === 'LLM_CHAT') return chat();
    throw new Error(`Unexpected message: ${message.type}`);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const start = async () => {
  render(createElement(StrictMode, null, createElement(App)));
  await screen.findByRole('heading', { name: 'Contact record' });
};
const submit = (text: string) => {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
};
const chats = () =>
  vi
    .mocked(sendExtensionMessage)
    .mock.calls.map(([message]) => message)
    .filter(
      (message): message is Extract<ExtensionMessage, { type: 'LLM_CHAT' }> =>
        message.type === 'LLM_CHAT'
    );

const activatePowerAutomate = async () => {
  current = powerAutomate;
  act(() => activated.fire({ tabId: 2, windowId: 7 }));
  await screen.findByRole('heading', { name: 'Power Automate' });
};

describe('shared side-panel navigation', () => {
  it('keeps an in-flight conversation and its final answer when Power Automate becomes active', async () => {
    let finish!: (value: MessageResult<LlmResponse>) => void;
    chat = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await start();
    submit('Fix the flow and open Power Automate');
    await waitFor(() => expect(chats()).toHaveLength(1));
    expect(chats()[0]?.payload.expectedOrigin).toBe(source.origin);
    await activatePowerAutomate();
    expect(screen.getByText('Fix the flow and open Power Automate')).toBeTruthy();
    await act(async () =>
      finish({ ok: true, data: { content: 'Draft saved and Power Automate opened.' } })
    );
    expect(await screen.findByText('Draft saved and Power Automate opened.')).toBeTruthy();
    expect(screen.getByText(/Return to the Dataverse tab to use data and flow tools/)).toBeTruthy();
    expect(screen.queryByText('No active browser tab is available.')).toBeNull();
    expect(
      screen.getByLabelText('Include record context and allow Dataverse tools')
    ).toHaveProperty('disabled', true);
    // A follow-up can discuss the conversation, but cannot reuse the previous tab's context/tools.
    chat = async () => ({ ok: true, data: { content: 'Only the draft definition changed.' } });
    submit('What changed?');
    await screen.findByText('Only the draft definition changed.');
    expect(chats()[1]?.payload.allowDataverseTools).toBe(false);
    expect(chats()[1]?.payload.expectedOrigin).toBeUndefined();
    expect(JSON.stringify(chats()[1]?.payload.messages)).not.toContain('PRIVATE_RECORD_VALUE');
    current = source;
    act(() => activated.fire({ tabId: 1, windowId: 7 }));
    await screen.findByRole('heading', { name: 'Contact record' });
    expect(screen.getByText('Draft saved and Power Automate opened.')).toBeTruthy();
    expect(
      screen.getByLabelText('Include record context and allow Dataverse tools')
    ).toHaveProperty('disabled', false);
  });

  it('does not offer pending data approvals while on Power Automate, then restores them on return', async () => {
    chat = async () => ({
      ok: true,
      data: { content: 'Review the proposed update.', pendingMutations: [recordProposal] }
    });
    await start();
    submit('Prepare an update');
    await screen.findByRole('button', { name: 'Approve 1 field' });
    await activatePowerAutomate();
    expect(screen.getByText('Review the proposed update.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve 1 field' })).toBeNull();
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.some(([message]) => message.type === 'EXECUTE_DATAVERSE_MUTATION')
    ).toBe(false);
    current = source;
    act(() => activated.fire({ tabId: 1, windowId: 7 }));
    await screen.findByRole('button', { name: 'Approve 1 field' });
  });

  it('ignores stale context replies and events from other browser windows', async () => {
    await start();
    let finishOld!: (value: MessageResult<DataverseContext>) => void;
    readContext = () =>
      new Promise((resolve) => {
        finishOld = resolve;
      });
    act(() => activated.fire({ tabId: 1, windowId: 7 }));
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    readContext = async () => ({ ok: true, data: powerAutomate });
    act(() => activated.fire({ tabId: 2, windowId: 7 }));
    await screen.findByRole('heading', { name: 'Power Automate' });
    await act(async () => finishOld({ ok: true, data: source }));
    expect(screen.queryByRole('heading', { name: 'Contact record' })).toBeNull();
    const count = vi.mocked(sendExtensionMessage).mock.calls.length;
    act(() => {
      activated.fire({ tabId: 5, windowId: 99 });
      focused.fire(99);
    });
    expect(sendExtensionMessage).toHaveBeenCalledTimes(count);
    expect(
      vi
        .mocked(sendExtensionMessage)
        .mock.calls.filter(([message]) => message.type === 'GET_ACTIVE_CONTEXT')
        .every(
          ([message]) => message.type === 'GET_ACTIVE_CONTEXT' && message.payload?.windowId === 7
        )
    ).toBe(true);
  });

  it('refreshes active URL changes without content scripts and cleans up tab listeners', async () => {
    await start();
    current = powerAutomate;
    act(() =>
      updated.fire(1, { url: powerAutomate.url }, {
        id: 1,
        active: true,
        windowId: 7
      } as chrome.tabs.Tab)
    );
    await screen.findByRole('heading', { name: 'Power Automate' });
    expect(activated.listeners.size).toBe(1);
    cleanup();
    expect(activated.listeners.size).toBe(0);
    expect(updated.listeners.size).toBe(0);
    expect(focused.listeners.size).toBe(0);
  });

  it('keeps saved history associated with the Dataverse request, not the opened designer', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...(await getSettings()),
      conversationHistory: { ...DEFAULT_SETTINGS.conversationHistory, enabled: true }
    });
    await start();
    submit('Fix my flow');
    await screen.findByText('The approved flow draft was saved.');
    await activatePowerAutomate();
    await waitFor(() => expect(saveConversation).toHaveBeenCalled(), { timeout: 1500 });
    expect(vi.mocked(saveConversation).mock.calls.at(-1)?.[0]).toMatchObject({
      environmentOrigin: source.origin,
      environmentName: source.environmentName,
      tableLogicalName: source.tableLogicalName
    });
  });
});
