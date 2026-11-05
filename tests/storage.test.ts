import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getSettings, SETTINGS_KEY } from '../lib/storage';

function stored(value?: unknown) {
  const get = vi.fn().mockResolvedValue(value === undefined ? {} : { [SETTINGS_KEY]: value });
  vi.stubGlobal('chrome', { storage: { local: { get } } });
  return get;
}

afterEach(() => vi.unstubAllGlobals());

describe('Azure OpenAI settings defaults', () => {
  it('uses gpt-6.1-sol and temperature 1.0 for new settings', async () => {
    const get = stored();
    expect(DEFAULT_SETTINGS.azureOpenAI).toMatchObject({
      deployment: 'gpt-6.1-sol',
      temperature: 1.0
    });
    expect((await getSettings()).azureOpenAI).toMatchObject({
      deployment: 'gpt-6.1-sol',
      temperature: 1.0
    });
    expect(get).toHaveBeenCalledWith(SETTINGS_KEY);
  });

  it('fills missing defaults without changing other saved Azure settings', async () => {
    stored({ azureOpenAI: { endpoint: 'https://example.openai.azure.com', apiKey: 'saved-key' } });
    expect((await getSettings()).azureOpenAI).toMatchObject({
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'saved-key',
      deployment: 'gpt-6.1-sol',
      temperature: 1.0
    });
  });

  it.each([0, 0.2, 1])(
    'preserves an explicitly saved deployment and temperature %s',
    async (temperature) => {
      stored({ azureOpenAI: { deployment: 'custom-deployment', temperature } });
      expect((await getSettings()).azureOpenAI).toMatchObject({
        deployment: 'custom-deployment',
        temperature
      });
    }
  );
});
