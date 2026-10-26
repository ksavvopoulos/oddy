import { createBulkEngine } from '../bulk/engine';
import { executeBulkTransport } from '../bulk/transport';
import type { BulkTransportRequest, BulkChunkResult } from '../bulk/contracts';
import type { DataverseContext } from '../types';
import { errorMessage } from '../messages';
import { executePrimitiveInActiveTab } from './primitives';

async function transportInActiveTab(
  context: DataverseContext,
  request: BulkTransportRequest
): Promise<BulkChunkResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const fail = (error: string, uncertain: boolean): BulkChunkResult => ({
    error,
    outcomes: request.rows.map((row) => ({
      recordId: row.recordId,
      status: uncertain ? 'uncertain' : 'failed',
      error
    }))
  });
  if (!tab?.id || !tab.url || new URL(tab.url).origin !== context.origin)
    return fail('The active Dataverse environment changed.', false);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: executeBulkTransport,
      args: [request]
    });
    return (
      (results[0]?.result as BulkChunkResult) ||
      fail('No bulk transport result was returned. Reconcile before retrying.', true)
    );
  } catch (error) {
    return fail(
      `Bulk communication failed; outcomes may be uncertain: ${errorMessage(error)}`,
      true
    );
  }
}
export function activeBulkEngine(context: DataverseContext) {
  if (!context.isDataverse || !context.origin)
    throw new Error('Open the intended Dataverse environment first.');
  return createBulkEngine({
    origin: context.origin,
    primitive: (request) => executePrimitiveInActiveTab(context, request),
    transport: (request) => transportInActiveTab(context, request)
  });
}
