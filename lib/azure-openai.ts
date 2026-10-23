import type { AzureOpenAISettings, ChatMessage, LlmResponse } from './types';

const AZURE_OPENAI_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.services.ai.azure.com',
  '.cognitiveservices.azure.com'
];

export interface AzureToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AzureToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AzureChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: AzureToolCall[];
}

export interface AzureChatCompletion {
  assistantMessage: AzureChatMessage;
  content?: string;
  toolCalls: AzureToolCall[];
}

interface AzureCompletionPayload {
  choices?: Array<{
    message?: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: AzureToolCall[];
    };
  }>;
  error?: { message?: string; code?: string };
}

export interface AzureResponseFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface AzureResponseFunctionOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface AzureResponsesCompletion {
  id: string;
  content?: string;
  toolCalls: AzureResponseFunctionCall[];
}

interface AzureResponsesPayload {
  id?: string;
  output_text?: string | null;
  output?: Array<
    | AzureResponseFunctionCall
    | {
        type: 'message';
        role?: 'assistant';
        content?: Array<{ type?: string; text?: string }>;
      }
    | { type: string; [key: string]: unknown }
  >;
  error?: { message?: string; code?: string };
}

function getAzureEndpointOrigin(endpointValue: string): string {
  const endpoint = endpointValue.trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('Azure OpenAI endpoint is required.');

  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:') {
    throw new Error('Azure OpenAI endpoint must use HTTPS.');
  }

  const allowed = AZURE_OPENAI_HOST_SUFFIXES.some(
    (suffix) => parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix)
  );
  if (!allowed) {
    throw new Error('Use an Azure OpenAI or Azure AI Services endpoint.');
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Enter the base endpoint only, without an API path.');
  }

  return parsed.origin;
}

export function buildAzureOpenAIUrl(settings: AzureOpenAISettings): string {
  const deployment = settings.deployment.trim();
  const apiVersion = settings.apiVersion.trim();
  if (!deployment || !apiVersion) {
    throw new Error('Deployment and API version are required.');
  }

  const origin = getAzureEndpointOrigin(settings.endpoint);
  return `${origin}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

export function buildAzureOpenAIResponsesUrl(settings: AzureOpenAISettings): string {
  if (!settings.deployment.trim()) throw new Error('Deployment name is required.');
  return `${getAzureEndpointOrigin(settings.endpoint)}/openai/v1/responses`;
}

export async function callAzureOpenAICompletion(
  settings: AzureOpenAISettings,
  messages: AzureChatMessage[],
  tools?: AzureToolDefinition[],
  signal?: AbortSignal
): Promise<AzureChatCompletion> {
  if (!settings.apiKey.trim()) {
    throw new Error('Azure OpenAI API key is required.');
  }
  if (messages.length === 0) {
    throw new Error('At least one message is required.');
  }

  const body: Record<string, unknown> = {
    messages,
    temperature: settings.temperature
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    // Azure reasoning models default to a reasoning effort that is incompatible
    // with function tools on chat-completions. Disabling it enables tool calls.
    body.reasoning_effort = 'none';
  }

  const sendRequest = async (): Promise<{
    response: Response;
    payload: AzureCompletionPayload | undefined;
  }> => {
    const response = await fetch(buildAzureOpenAIUrl(settings), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': settings.apiKey.trim()
      },
      body: JSON.stringify(body)
    });
    const payload = (await response.json().catch(() => undefined)) as
      | AzureCompletionPayload
      | undefined;
    return { response, payload };
  };

  let { response, payload } = await sendRequest();
  const errorDetail = payload?.error?.message || '';
  const modelRejectsReasoningParameter =
    /unsupported parameter.*reasoning_effort/i.test(errorDetail) ||
    /unrecognized request argument.*reasoning_effort/i.test(errorDetail) ||
    /unknown parameter.*reasoning_effort/i.test(errorDetail);

  if (!response.ok && tools?.length && modelRejectsReasoningParameter) {
    delete body.reasoning_effort;
    ({ response, payload } = await sendRequest());
  }

  if (!response.ok) {
    const detail = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Azure OpenAI request failed: ${detail}`);
  }

  const message = payload?.choices?.[0]?.message;
  if (!message) {
    throw new Error('Azure OpenAI returned an empty response.');
  }

  const toolCalls = message.tool_calls || [];
  const assistantMessage: AzureChatMessage = {
    role: 'assistant',
    content: message.content ?? null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };

  return {
    assistantMessage,
    content: message.content || undefined,
    toolCalls
  };
}

export async function callAzureOpenAIResponses(
  settings: AzureOpenAISettings,
  options: {
    messages?: AzureChatMessage[];
    input?: AzureResponseFunctionOutput[];
    previousResponseId?: string;
    tools?: AzureToolDefinition[];
  },
  signal?: AbortSignal
): Promise<AzureResponsesCompletion> {
  if (!settings.apiKey.trim()) {
    throw new Error('Azure OpenAI API key is required.');
  }

  const body: Record<string, unknown> = {
    model: settings.deployment.trim()
  };

  if (options.messages) {
    const instructions = options.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .filter((content): content is string => Boolean(content))
      .join('\n\n');
    const input = options.messages
      .filter((message) => message.role !== 'system' && message.role !== 'tool')
      .map((message) => ({
        type: 'message',
        role: message.role,
        content: message.content || ''
      }));
    if (instructions) body.instructions = instructions;
    body.input = input;
  } else if (options.input) {
    body.input = options.input;
  } else {
    throw new Error('Responses API input is required.');
  }

  if (options.previousResponseId) {
    body.previous_response_id = options.previousResponseId;
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }));
    body.parallel_tool_calls = false;
  }

  const response = await fetch(buildAzureOpenAIResponsesUrl(settings), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'api-key': settings.apiKey.trim()
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => undefined)) as
    | AzureResponsesPayload
    | undefined;

  if (!response.ok) {
    const detail = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Azure OpenAI Responses request failed: ${detail}`);
  }
  if (!payload?.id) {
    throw new Error('Azure OpenAI Responses API returned an invalid response.');
  }

  const output = payload.output || [];
  const toolCalls = output.filter(
    (item): item is AzureResponseFunctionCall =>
      item.type === 'function_call' &&
      typeof (item as AzureResponseFunctionCall).call_id === 'string' &&
      typeof (item as AzureResponseFunctionCall).name === 'string' &&
      typeof (item as AzureResponseFunctionCall).arguments === 'string'
  );
  const content =
    payload.output_text ||
    output
      .filter((item) => item.type === 'message')
      .flatMap((item) =>
        'content' in item && Array.isArray(item.content)
          ? item.content
              .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
              .map((part) => part.text as string)
          : []
      )
      .join('\n') ||
    undefined;

  return { id: payload.id, content, toolCalls };
}

export async function callAzureOpenAI(
  settings: AzureOpenAISettings,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<LlmResponse> {
  const completion = await callAzureOpenAICompletion(
    settings,
    messages.map((message) => ({ ...message, content: message.content })),
    undefined,
    signal
  );
  if (!completion.content) {
    throw new Error('Azure OpenAI returned an empty response.');
  }
  return { content: completion.content };
}
