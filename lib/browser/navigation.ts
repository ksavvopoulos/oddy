import { errorMessage } from '../messages';
import type { DataverseContext, ExtensionMessage, NavigationProgress } from '../types';

export interface NavigationArguments {
  target: 'list' | 'view' | 'record';
  tableLogicalName: string;
  recordId?: string;
  viewId?: string;
  viewType?: 'userquery' | 'savedquery';
}

export interface NavigationResult {
  ok: boolean;
  navigationState?: 'started' | 'loaded';
  navigationMethod?: 'xrm' | 'url';
  target?: NavigationArguments['target'];
  tableLogicalName?: string;
  recordId?: string;
  viewId?: string;
  url?: string;
  error?: string;
}

interface XrmNavigationRequest {
  target: NavigationArguments['target'];
  tableLogicalName: string;
  recordId?: string;
  viewId?: string;
  viewType?: 'userquery' | 'savedquery';
}

interface XrmNavigationResult {
  ok: boolean;
  error?: string;
}

export async function navigateDataverse(
  context: DataverseContext,
  args: NavigationArguments,
  requestId?: string
): Promise<NavigationResult> {
  const tableLogicalName = args.tableLogicalName.trim();
  if (!context.origin || !/^[a-z0-9_]+$/i.test(tableLogicalName)) {
    return { ok: false, error: 'A valid table logical name is required for navigation.' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || new URL(tab.url).origin !== context.origin) {
    return { ok: false, error: 'The active browser tab changed before navigation.' };
  }

  let recordId: string | undefined;
  let viewId: string | undefined;
  const url = new URL('/main.aspx', context.origin);
  if (args.target !== 'view' && context.appId) url.searchParams.set('appid', context.appId);
  url.searchParams.set('pagetype', args.target === 'record' ? 'entityrecord' : 'entitylist');
  url.searchParams.set('etn', tableLogicalName);

  if (args.target === 'record') {
    recordId = args.recordId?.replace(/[{}]/g, '').trim() || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
      return { ok: false, error: 'A valid record GUID is required.' };
    }
    url.searchParams.set('id', recordId);
  }

  if (args.target === 'view') {
    viewId = args.viewId?.replace(/[{}]/g, '').trim() || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewId)) {
      return { ok: false, error: 'A valid view GUID is required.' };
    }
    url.searchParams.set('viewid', `{${viewId}}`);
    url.searchParams.set('viewtype', args.viewType === 'savedquery' ? '1039' : '4230');
  }

  const navigationLabel =
    args.target === 'view'
      ? `AI Result (${tableLogicalName})`
      : args.target === 'record'
        ? `${tableLogicalName} record`
        : `${tableLogicalName} list`;
  const expectedUrl = url.toString();
  const sameDestination = navigationUrlsMatch(tab.url, expectedUrl);

  notifyNavigationProgress(requestId, {
    stage: 'opening',
    label: `Opening ${navigationLabel}`,
    detail: sameDestination
      ? 'Refreshing the current Dataverse destination.'
      : 'Using Dataverse native navigation.'
  });

  if (!sameDestination) {
    const nativeResult = await executeXrmNavigation(tab.id, {
      target: args.target,
      tableLogicalName,
      recordId,
      viewId,
      viewType: args.viewType
    });

    if (nativeResult.ok) {
      const navigatedTab = await waitForExpectedTabUrl(tab.id, expectedUrl, 3_000);
      if (navigatedTab?.url) {
        notifyNavigationProgress(requestId, {
          stage: 'loaded',
          label: `${navigationLabel} loaded`,
          detail: 'Dataverse completed the native navigation.'
        });
        return {
          ok: true,
          navigationState: 'loaded',
          navigationMethod: 'xrm',
          target: args.target,
          tableLogicalName,
          recordId,
          viewId,
          url: navigatedTab.url
        };
      }
    }

    notifyNavigationProgress(requestId, {
      stage: 'opening',
      label: `Opening ${navigationLabel}`,
      detail:
        'Native navigation was unavailable or did not reach the requested destination; using the browser fallback.'
    });
  }

  try {
    if (sameDestination) {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
    } else {
      await chrome.tabs.update(tab.id, { url: expectedUrl });
    }

    const loaded = await waitForTabNavigation(tab.id, expectedUrl, 30_000);
    notifyNavigationProgress(
      requestId,
      loaded
        ? {
            stage: 'loaded',
            label: `${navigationLabel} loaded`,
            detail: 'The destination page finished loading through the browser fallback.'
          }
        : {
            stage: 'delayed',
            label: `${navigationLabel} is still loading`,
            detail: 'Navigation started, but Dataverse did not report completion within 30 seconds.'
          }
    );

    return {
      ok: true,
      navigationState: loaded ? 'loaded' : 'started',
      navigationMethod: 'url',
      target: args.target,
      tableLogicalName,
      recordId,
      viewId,
      url: expectedUrl
    };
  } catch (error) {
    return { ok: false, error: `Navigation failed: ${errorMessage(error)}` };
  }
}

async function executeXrmNavigation(
  tabId: number,
  request: XrmNavigationRequest
): Promise<XrmNavigationResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: navigateWithXrm,
      args: [request]
    });
    return (
      (results[0]?.result as XrmNavigationResult | undefined) || {
        ok: false,
        error: 'Dataverse native navigation returned no result.'
      }
    );
  } catch (error) {
    return { ok: false, error: `Dataverse native navigation failed: ${errorMessage(error)}` };
  }
}

/** Runs in the Dataverse page MAIN world. */
async function navigateWithXrm(request: XrmNavigationRequest): Promise<XrmNavigationResult> {
  type PageInput = Record<string, string>;
  type XrmWindow = typeof window & {
    Xrm?: {
      Navigation?: {
        navigateTo?: (pageInput: PageInput) => Promise<unknown>;
      };
    };
  };

  try {
    const navigation = (window as XrmWindow).Xrm?.Navigation;
    if (!navigation?.navigateTo) {
      return { ok: false, error: 'Xrm.Navigation.navigateTo is unavailable.' };
    }

    const pageInput: PageInput =
      request.target === 'record'
        ? {
            pageType: 'entityrecord',
            entityName: request.tableLogicalName,
            entityId: request.recordId || ''
          }
        : {
            pageType: 'entitylist',
            entityName: request.tableLogicalName,
            ...(request.target === 'view' && request.viewId
              ? {
                  viewId: request.viewId,
                  viewType: request.viewType === 'savedquery' ? 'savedquery' : 'userquery'
                }
              : {})
          };

    await navigation.navigateTo(pageInput);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function notifyNavigationProgress(
  requestId: string | undefined,
  progress: Omit<NavigationProgress, 'requestId'>
): void {
  if (!requestId) return;
  void chrome.runtime
    .sendMessage({
      type: 'NAVIGATION_STATUS',
      payload: { requestId, ...progress }
    } satisfies ExtensionMessage)
    .catch(() => undefined);
}

async function waitForExpectedTabUrl(
  tabId: number,
  expectedUrl: string,
  timeoutMs: number
): Promise<chrome.tabs.Tab | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return undefined;
    if (tab.url && navigationUrlsMatch(tab.url, expectedUrl)) return tab;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return undefined;
}

export async function waitForTabNavigation(
  tabId: number,
  expectedUrl: string,
  timeoutMs: number
): Promise<boolean> {
  const isExpectedAndComplete = (tab?: chrome.tabs.Tab): boolean =>
    Boolean(tab?.status === 'complete' && tab.url && navigationUrlsMatch(tab.url, expectedUrl));

  try {
    if (isExpectedAndComplete(await chrome.tabs.get(tabId))) return true;
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeout);
      resolve(loaded);
    };
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
      updatedTab: chrome.tabs.Tab
    ) => {
      if (updatedTabId !== tabId) return;
      if (
        (changeInfo.status === 'complete' || updatedTab.status === 'complete') &&
        navigationUrlsMatch(updatedTab.url || '', expectedUrl)
      ) {
        finish(true);
      }
    };
    const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export function navigationUrlsMatch(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;

    return ['pagetype', 'etn', 'id', 'viewid'].every((key) => {
      const expectedValue = getSearchParam(expected, key);
      if (expectedValue == null) return true;
      return (
        (getSearchParam(actual, key) || '').replace(/[{}]/g, '').toLowerCase() ===
        expectedValue.replace(/[{}]/g, '').toLowerCase()
      );
    });
  } catch {
    return false;
  }
}

export function getSearchParam(url: URL, name: string): string | null {
  const match = [...url.searchParams.entries()].find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match?.[1] ?? null;
}
