import { executeDataverseSchemaPrimitive } from '../dataverse-schema-primitives';
import type { SchemaPrimitiveRequest, SchemaPrimitiveResult } from '../schema/contracts';
import type { DataverseContext } from '../types';
import { errorMessage } from '../messages';

export async function executeSchemaPrimitiveInActiveTab(
  context: DataverseContext,
  request: SchemaPrimitiveRequest
): Promise<SchemaPrimitiveResult> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (
      !context.isDataverse ||
      !context.origin ||
      request.origin !== context.origin ||
      !tab?.id ||
      !tab.url ||
      tab.pendingUrl ||
      new URL(tab.url).origin !== context.origin
    ) {
      return { ok: false, action: request.action, error: 'The active Dataverse tab changed.' };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: executeDataverseSchemaPrimitive,
      args: [request]
    });
    return (
      (results[0]?.result as SchemaPrimitiveResult | undefined) || {
        ok: false,
        action: request.action,
        error: 'The Dataverse schema primitive returned no result.'
      }
    );
  } catch (error) {
    return { ok: false, action: request.action, error: errorMessage(error) };
  }
}
