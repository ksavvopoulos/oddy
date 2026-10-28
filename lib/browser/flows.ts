import {
  executeDataverseFlowPrimitive,
  type DataverseFlowPrimitiveRequest,
  type DataverseFlowPrimitiveResult
} from '../dataverse-flow-primitives';
import { errorMessage } from '../messages';
import type { DataverseContext } from '../types';

export async function executeFlowPrimitiveInActiveTab(
  context: DataverseContext,
  request: DataverseFlowPrimitiveRequest
): Promise<DataverseFlowPrimitiveResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !context.origin || new URL(tab.url).origin !== context.origin) {
    return { ok: false, action: request.action, error: 'The active browser tab changed.' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: executeDataverseFlowPrimitive,
      args: [request]
    });
    return (
      (results[0]?.result as DataverseFlowPrimitiveResult | undefined) || {
        ok: false,
        action: request.action,
        error: 'The Dataverse flow primitive returned no result.'
      }
    );
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: `Dataverse flow primitive failed: ${errorMessage(error)}`
    };
  }
}
