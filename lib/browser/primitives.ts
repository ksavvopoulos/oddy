import {
  executeDataversePrimitive,
  type DataversePrimitiveRequest,
  type DataversePrimitiveResult
} from '../dataverse-primitives';
import { errorMessage } from '../messages';
import type { DataverseContext } from '../types';
import type { DataversePreparationMetadata } from '../dataverse/contracts';

export async function executePrimitiveInActiveTab(
  context: DataverseContext,
  request: DataversePrimitiveRequest,
  metadata?: DataversePreparationMetadata
): Promise<DataversePrimitiveResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab?.id ||
    !tab.url ||
    !context.origin ||
    request.origin !== context.origin ||
    tab.pendingUrl ||
    new URL(tab.url).origin !== context.origin
  ) {
    return { ok: false, action: request.action, error: 'The active browser tab changed.' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: executeDataversePrimitive,
      args: metadata ? [request, metadata] : [request]
    });
    return (
      (results[0]?.result as DataversePrimitiveResult | undefined) || {
        ok: false,
        action: request.action,
        error: 'The Dataverse primitive returned no result.'
      }
    );
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: `Dataverse primitive failed: ${errorMessage(error)}`
    };
  }
}
