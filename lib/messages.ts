import type { ExtensionMessage, MessageResult } from './types';

export function sendExtensionMessage<T>(message: ExtensionMessage): Promise<MessageResult<T>> {
  return chrome.runtime.sendMessage(message) as Promise<MessageResult<T>>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
