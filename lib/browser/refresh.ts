import { errorMessage } from '../messages';
import type { DataverseContext, DataverseMutationExecutionResult } from '../types';
import { getSearchParam, waitForTabNavigation } from './navigation';

export async function refreshAfterMutation(
  context: DataverseContext,
  mutation: DataverseMutationExecutionResult
): Promise<Pick<DataverseMutationExecutionResult, 'refreshStatus' | 'refreshMessage'>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !context.origin || new URL(tab.url).origin !== context.origin) {
    return {
      refreshStatus: 'failed',
      refreshMessage: 'The active tab changed before Oddy could refresh it.'
    };
  }
  if (context.tableLogicalName?.toLowerCase() !== mutation.tableLogicalName.toLowerCase()) {
    return {
      refreshStatus: 'not-applicable',
      refreshMessage: 'The change was applied; the currently open page belongs to another table.'
    };
  }

  const activeRecordId = context.recordId?.replace(/[{}]/g, '').toLowerCase();
  const changedRecordId = mutation.recordId.replace(/[{}]/g, '').toLowerCase();
  if (activeRecordId) {
    if (mutation.operation !== 'update' || activeRecordId !== changedRecordId) {
      return {
        refreshStatus: 'not-applicable',
        refreshMessage: 'The change was applied; the currently open form is a different record.'
      };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: refreshMatchingDataverseForm,
        args: [mutation.tableLogicalName, mutation.recordId]
      });
      const outcome = results
        .map(
          (result) =>
            result.result as
              | { matched?: boolean; refreshed?: boolean; dirty?: boolean; error?: string }
              | undefined
        )
        .find((result) => result?.matched);
      if (outcome?.refreshed) {
        return {
          refreshStatus: 'form-refreshed',
          refreshMessage: 'The open Dataverse form was refreshed with the saved values.'
        };
      }
      if (outcome?.dirty) {
        return {
          refreshStatus: 'skipped-dirty',
          refreshMessage:
            'The record was updated, but the form was not refreshed because it has other unsaved changes.'
        };
      }
      return {
        refreshStatus: 'failed',
        refreshMessage:
          outcome?.error || 'The record was updated, but the form refresh API was unavailable.'
      };
    } catch (error) {
      return {
        refreshStatus: 'failed',
        refreshMessage: `The record was updated, but the form could not be refreshed: ${errorMessage(error)}`
      };
    }
  }

  const pageType = context.pageType || getSearchParam(new URL(tab.url), 'pagetype');
  if (pageType?.toLowerCase() !== 'entitylist') {
    return {
      refreshStatus: 'not-applicable',
      refreshMessage: 'The change was applied; no matching open form or list needed refreshing.'
    };
  }

  try {
    const currentUrl = tab.url;
    await chrome.tabs.reload(tab.id);
    const loaded = await waitForTabNavigation(tab.id, currentUrl, 30_000);
    return loaded
      ? {
          refreshStatus: 'page-refreshed',
          refreshMessage: 'The open Dataverse list was refreshed with the saved changes.'
        }
      : {
          refreshStatus: 'failed',
          refreshMessage:
            'The change was applied and the list reload started, but Dataverse is still loading.'
        };
  } catch (error) {
    return {
      refreshStatus: 'failed',
      refreshMessage: `The change was applied, but the list could not be refreshed: ${errorMessage(error)}`
    };
  }
}

/** Runs in every accessible Dataverse frame's MAIN world. */
async function refreshMatchingDataverseForm(
  tableLogicalName: string,
  recordId: string
): Promise<{ matched: boolean; refreshed?: boolean; dirty?: boolean; error?: string }> {
  type XrmPage = {
    data?: {
      refresh?: (save?: boolean) => Promise<unknown>;
      entity?: {
        getEntityName?: () => string;
        getId?: () => string;
        getIsDirty?: () => boolean;
      };
    };
  };
  try {
    const xrm = (window as typeof window & { Xrm?: { Page?: XrmPage } }).Xrm;
    const page = xrm?.Page;
    const entity = page?.data?.entity;
    const currentTable = entity?.getEntityName?.()?.toLowerCase();
    const currentId = entity?.getId?.()?.replace(/[{}]/g, '').toLowerCase();
    if (
      currentTable !== tableLogicalName.toLowerCase() ||
      currentId !== recordId.replace(/[{}]/g, '').toLowerCase()
    ) {
      return { matched: false };
    }
    if (entity?.getIsDirty?.()) return { matched: true, dirty: true };
    if (!page?.data?.refresh) {
      return { matched: true, error: 'Xrm.Page.data.refresh is unavailable.' };
    }
    await page.data.refresh(false);
    return { matched: true, refreshed: true };
  } catch (error) {
    return {
      matched: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
