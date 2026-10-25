import {
  collectDataverseWebApiContext,
  collectXrmPageContext,
  contextFromUrl,
  isDataverseUrl,
  mergePageContext,
  pickBestPageContext,
  type PageContextSnapshot,
  type WebApiContextRequest
} from '../dataverse-context';
import { errorMessage } from '../messages';
import type { DataverseContext } from '../types';

export async function getActiveDataverseContext(): Promise<DataverseContext> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) throw new Error('No active browser tab is available.');

  const base = contextFromUrl(tab.url, tab.title);
  if (!base.isDataverse || !tab.id || !isDataverseUrl(tab.url)) return base;

  let context = base;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: collectXrmPageContext
    });
    const snapshot = pickBestPageContext(
      results.map((result) => result.result as PageContextSnapshot | undefined)
    );
    context = mergePageContext(base, snapshot);
  } catch (error) {
    context = { ...base, warning: `Form context could not be read: ${errorMessage(error)}` };
  }

  if (context.fields.length > 0) return context;

  if (context.origin && context.tableLogicalName && context.recordId) {
    const request: WebApiContextRequest = {
      origin: context.origin,
      tableLogicalName: context.tableLogicalName,
      recordId: context.recordId
    };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: 'MAIN',
        func: collectDataverseWebApiContext,
        args: [request]
      });
      return mergePageContext(context, results[0]?.result as PageContextSnapshot | undefined);
    } catch (error) {
      return {
        ...context,
        warning: `Dataverse Web API fallback could not run: ${errorMessage(error)}`
      };
    }
  }

  return {
    ...context,
    warning:
      context.warning ||
      'No active Dataverse record is selected; list-level tools remain available.'
  };
}
