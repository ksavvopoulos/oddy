import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage, MessageResult } from '../lib/types';

afterEach(() => vi.unstubAllGlobals());

describe('shared side-panel background configuration', () => {
  it('uses only global panel options and scopes context reads to the requesting window', async () => {
    let installed!: () => void;
    let messageListener!: (
      message: ExtensionMessage,
      sender: unknown,
      reply: (value: MessageResult<unknown>) => void
    ) => boolean;
    const setOptions = vi.fn().mockResolvedValue(undefined);
    const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue([
      {
        id: 2,
        url: 'https://make.powerautomate.com/environments/env/flows/flow',
        title: 'Power Automate'
      }
    ]);
    const executeScript = vi.fn();
    vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: {
          addListener: (listener: () => void) => {
            installed = listener;
          }
        },
        onMessage: {
          addListener: (listener: typeof messageListener) => {
            messageListener = listener;
          }
        }
      },
      sidePanel: { setOptions, setPanelBehavior },
      tabs: { query },
      scripting: { executeScript }
    });
    const background = (await import('../entrypoints/background')).default as unknown as {
      main: () => void;
    };
    background.main();
    await vi.waitFor(() => expect(setPanelBehavior).toHaveBeenCalledTimes(1));
    installed();
    await vi.waitFor(() => expect(setPanelBehavior).toHaveBeenCalledTimes(2));
    expect(setOptions.mock.calls.map(([options]) => options)).toEqual([
      { path: 'sidepanel.html', enabled: true },
      { path: 'sidepanel.html', enabled: true }
    ]);
    expect(query).not.toHaveBeenCalled();
    const result = await new Promise<MessageResult<unknown>>((resolve) => {
      expect(
        messageListener({ type: 'GET_ACTIVE_CONTEXT', payload: { windowId: 7 } }, {}, resolve)
      ).toBe(true);
    });
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 7 });
    expect(result).toMatchObject({
      ok: true,
      data: { isDataverse: false, pageType: 'power-automate' }
    });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
