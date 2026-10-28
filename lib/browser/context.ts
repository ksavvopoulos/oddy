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
import { collectDataverseUserContext } from '../dataverse-user-context';
import type { DataverseContext, DataverseUserContext } from '../types';

export async function getActiveDataverseContext(
  options: { includeUserSettings?: boolean; windowId?: number } = {}
): Promise<DataverseContext> {
  const [tab] = await chrome.tabs.query({
    active: true,
    ...(options.windowId === undefined ? { currentWindow: true } : { windowId: options.windowId })
  });
  if (!tab?.url) {
    // Newly opened tabs can have only pendingUrl. Do not inject into an uncommitted page.
    const pending = tab?.pendingUrl ? contextFromUrl(tab.pendingUrl, tab.title) : undefined;
    return {
      ...pending,
      isDataverse: false,
      source: 'url',
      title: tab?.title,
      fields: [],
      capturedAt: new Date().toISOString(),
      warning:
        pending?.warning ||
        'The active page is loading or unavailable. Select a Dataverse tab to use data and flow tools.'
    };
  }

  const base = contextFromUrl(tab.url, tab.title);
  if (!base.isDataverse || !tab.id || !isDataverseUrl(tab.url)) return base;

  const observedAtUtc = new Date().toISOString();
  const currentUser =
    options.includeUserSettings === false
      ? undefined
      : chrome.scripting
          .executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            world: 'MAIN',
            func: collectDataverseUserContext,
            args: [{ origin: base.origin!, utcNow: observedAtUtc }]
          })
          .then(
            (results): DataverseUserContext =>
              (results[0]?.result as DataverseUserContext | undefined) || {
                source: 'unavailable',
                observedAtUtc,
                warning: 'The signed-in user settings returned no result.'
              }
          )
          .catch((error: unknown): DataverseUserContext => ({
            source: 'unavailable',
            observedAtUtc,
            warning: `Could not read signed-in user settings: ${errorMessage(error)}`
          }));

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

  if (currentUser) context.currentUser = await currentUser;
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
