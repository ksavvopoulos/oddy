import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAzureOpenAIResponsesUrl,
  buildAzureOpenAIUrl,
  callAzureOpenAICompletion,
  callAzureOpenAIResponses
} from '../lib/azure-openai';
import type { AzureOpenAISettings } from '../lib/types';

const settings: AzureOpenAISettings = {
  endpoint: 'https://example.openai.azure.com/',
  deployment: 'gpt-4o dev',
  apiVersion: '2024-10-21',
  apiKey: 'secret',
  temperature: 0.2,
  systemPrompt: 'test'
};

afterEach(() => vi.unstubAllGlobals());

describe('buildAzureOpenAIUrl', () => {
  it('builds a deployment chat completions URL', () => {
    expect(buildAzureOpenAIUrl(settings)).toBe(
      'https://example.openai.azure.com/openai/deployments/gpt-4o%20dev/chat/completions?api-version=2024-10-21'
    );
  });

  it('rejects non-Azure hosts', () => {
    expect(() =>
      buildAzureOpenAIUrl({ ...settings, endpoint: 'https://example.com' })
    ).toThrow(/Azure OpenAI/);
  });

  it('builds the v1 Responses API URL', () => {
    expect(buildAzureOpenAIResponsesUrl(settings)).toBe(
      'https://example.openai.azure.com/openai/v1/responses'
    );
  });

  it('returns model tool calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'find_related_records',
                      arguments: '{"relatedTable":"invoice"}'
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const completion = await callAzureOpenAICompletion(
      settings,
      [{ role: 'user', content: 'Does this contact have invoices?' }],
      [
        {
          type: 'function',
          function: {
            name: 'find_related_records',
            description: 'Find related records',
            parameters: { type: 'object' }
          }
        }
      ]
    );

    expect(completion.toolCalls[0]?.function.name).toBe('find_related_records');
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.tool_choice).toBe('auto');
    expect(request.reasoning_effort).toBe('none');
  });

  it('uses the Responses API for reasoning-model tool calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp-1',
          output: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'find_related_records',
              arguments: '{"relatedTable":"invoice"}'
            }
          ]
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await callAzureOpenAIResponses(settings, {
      messages: [
        { role: 'system', content: 'Use tools.' },
        { role: 'user', content: 'Does this contact have invoices?' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'find_related_records',
            description: 'Find related records',
            parameters: { type: 'object' }
          }
        }
      ]
    });

    expect(response.toolCalls[0]?.name).toBe('find_related_records');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://example.openai.azure.com/openai/v1/responses'
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe('gpt-4o dev');
    expect(request.reasoning_effort).toBeUndefined();
    expect(request.tools[0].name).toBe('find_related_records');
  });
});
