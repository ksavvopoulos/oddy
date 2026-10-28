import { callAzureOpenAI } from '../lib/azure-openai';
import { isDataverseUrl } from '../lib/dataverse-context';
import { runDataverseAssistant } from '../lib/assistant/run';
import { getActiveDataverseContext } from '../lib/browser/context';
import { activeBulkEngine } from '../lib/browser/bulk';
import { bulkRepository } from '../lib/bulk/repository';
import { bulkWorkIsActive } from '../lib/bulk/engine';
import { createDataset } from '../lib/bulk/datasets';
import { executePrimitiveInActiveTab } from '../lib/browser/primitives';
import { executeFlowPrimitiveInActiveTab } from '../lib/browser/flows';
import { navigateDataverse } from '../lib/browser/navigation';
import { refreshAfterMutation } from '../lib/browser/refresh';
import { errorMessage } from '../lib/messages';
import { executeOddySkillChange, getSkillById } from '../lib/skills';
import { getSettings, isAzureOpenAIConfigured } from '../lib/storage';
import type { ExtensionMessage, MessageResult } from '../lib/types';

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    void configureAllSidePanels();
  });

  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void configureAllSidePanels();

  chrome.tabs.onCreated.addListener((tab) => {
    void configureSidePanelForTab(tab);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs
      .get(tabId)
      .then((tab) => configureSidePanelForTab(tab))
      .catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      void configureSidePanelForTab(tab);
    }
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void chrome.tabs
      .query({ active: true, windowId })
      .then(([tab]) => {
        if (tab) return configureSidePanelForTab(tab);
      })
      .catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      _sender,
      sendResponse: (response: MessageResult<unknown>) => void
    ) => {
      void handleMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
      return true;
    }
  );
});

async function configureAllSidePanels(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => configureSidePanelForTab(tab)));
}

async function configureSidePanelForTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  const enabled = Boolean(tab.url && isDataverseUrl(tab.url));
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled
  });
}

async function handleMessage(message: ExtensionMessage): Promise<MessageResult<unknown>> {
  switch (message.type) {
    case 'STAGE_BULK_DATASET': {
      await bulkRepository.prune();
      if ((await bulkRepository.datasets()).length >= 5)
        throw new Error(
          'The workspace already has five datasets. Delete an old dataset in Bulk workspace before uploading more.'
        );
      const dataset = createDataset(message.payload.name, message.payload.records);
      await bulkRepository.saveDataset(dataset);
      return { ok: true, data: dataset.summary };
    }
    case 'DELETE_BULK_DATASET':
      if (bulkWorkIsActive())
        throw new Error('Wait for the current bulk operation before deleting its dataset.');
      await bulkRepository.deleteDataset(message.payload.id);
      return { ok: true };
    case 'LIST_BULK_DATASETS':
      await bulkRepository.prune();
      return { ok: true, data: await bulkRepository.datasets() };
    case 'CLEAR_BULK_WORKSPACE':
      if (bulkWorkIsActive())
        throw new Error('Stop the current bulk operation before clearing its checkpoints.');
      await bulkRepository.clear();
      return { ok: true };
    case 'LIST_BULK_JOBS': {
      await bulkRepository.prune();
      const context = await getActiveDataverseContext({ includeUserSettings: false });
      if (!context.origin) throw new Error('Open the original Dataverse environment.');
      const identity = await executePrimitiveInActiveTab(context, {
        action: 'bulk_identity',
        origin: context.origin
      });
      if (!identity.ok || !identity.userId)
        throw new Error(identity.error || 'Could not identify the signed-in user.');
      const jobs = await bulkRepository.jobs();
      return {
        ok: true,
        data: jobs
          .filter(
            (job) =>
              job.userId === identity.userId && job.summary.environmentOrigin === context.origin
          )
          .map((job) => job.summary)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
      };
    }
    case 'DELETE_BULK_JOB':
    case 'GET_BULK_JOB':
    case 'GET_BULK_JOB_ROWS':
    case 'PREPARE_BULK_JOB_REMAINDER':
    case 'APPROVE_BULK_JOB':
    case 'EXECUTE_BULK_JOB_CHUNK':
    case 'STOP_BULK_JOB': {
      const engine = activeBulkEngine(
        await getActiveDataverseContext({ includeUserSettings: false })
      );
      const id = message.payload.id;
      if (message.type === 'DELETE_BULK_JOB') return { ok: true, data: await engine.remove(id) };
      if (message.type === 'GET_BULK_JOB') return { ok: true, data: await engine.inspect(id) };
      if (message.type === 'GET_BULK_JOB_ROWS')
        return { ok: true, data: await engine.inspectRows(id, message.payload.offset) };
      if (message.type === 'PREPARE_BULK_JOB_REMAINDER')
        return { ok: true, data: await engine.remaining(id) };
      if (message.type === 'APPROVE_BULK_JOB')
        return {
          ok: true,
          data: await engine.approve(
            id,
            message.payload.revision,
            message.payload.acknowledgeReadableScope
          )
        };
      if (message.type === 'EXECUTE_BULK_JOB_CHUNK')
        return {
          ok: true,
          data: await engine.runChunk(id, message.payload.runToken, message.payload.expectedOffset)
        };
      return { ok: true, data: await engine.stop(id, message.payload.reject) };
    }
    case 'GET_ACTIVE_CONTEXT':
      return { ok: true, data: await getActiveDataverseContext() };

    case 'LLM_CHAT': {
      const settings = await getSettings();
      if (!isAzureOpenAIConfigured(settings)) {
        throw new Error('Configure Azure OpenAI in extension settings first.');
      }
      const skillRun = message.payload.skillRun;
      const skill = skillRun ? await getSkillById(skillRun.skillId) : undefined;
      if (skillRun && !skill) {
        throw new Error('The selected Oddy skill is unavailable or disabled.');
      }
      if (skill && message.payload.allowDataverseTools !== true) {
        throw new Error('Oddy skills require Dataverse tools to be enabled for this request.');
      }
      const response = await runDataverseAssistant(
        settings.azureOpenAI,
        message.payload.messages,
        message.payload.allowDataverseTools === true,
        message.payload.allowSkillTools === true,
        message.payload.requestId,
        skill && skillRun ? { skill, run: skillRun } : undefined,
        {
          expectedOrigin: message.payload.expectedOrigin,
          skillToolLimit: message.payload.skillToolLimit
        }
      );
      return { ok: true, data: response };
    }

    case 'EXECUTE_ODDY_SKILL_CHANGE': {
      return { ok: true, data: await executeOddySkillChange(message.payload.change) };
    }

    case 'EXECUTE_MARKETING_LIST_MEMBERSHIP': {
      const context = await getActiveDataverseContext();
      if (!context.origin || context.origin !== message.payload.membership.environmentOrigin) {
        throw new Error(
          'Return to the Dataverse environment where this preview was prepared before approving it.'
        );
      }
      const result = await executePrimitiveInActiveTab(context, {
        action: 'execute_list_membership',
        origin: context.origin,
        membership: message.payload.membership,
        selectedMemberIds: message.payload.selectedMemberIds
      });
      if (!result.ok || !result.listMembershipResult) {
        throw new Error(
          result.error || 'Dataverse did not add the approved marketing-list members.'
        );
      }
      return { ok: true, data: result.listMembershipResult };
    }

    case 'EXECUTE_DATAVERSE_FLOW_CHANGE': {
      const context = await getActiveDataverseContext({ includeUserSettings: false });
      if (!context.origin || context.origin !== message.payload.change.environmentOrigin) {
        throw new Error(
          'Return to the Dataverse environment where this flow preview was prepared before approving it.'
        );
      }
      const result = await executeFlowPrimitiveInActiveTab(context, {
        action: 'execute_flow_change',
        origin: context.origin,
        change: message.payload.change
      });
      if (!result.ok || !result.flowChangeResult) {
        throw new Error(result.error || 'Dataverse did not apply the approved cloud-flow change.');
      }
      return { ok: true, data: result.flowChangeResult };
    }

    case 'EXECUTE_DATAVERSE_MUTATION': {
      const context = await getActiveDataverseContext();
      if (!context.origin || context.origin !== message.payload.mutation.environmentOrigin) {
        throw new Error(
          'Return to the Dataverse environment where this preview was prepared before approving it.'
        );
      }
      const result = await executePrimitiveInActiveTab(context, {
        action: 'execute_mutation',
        origin: context.origin,
        mutation: message.payload.mutation,
        selectedColumns: message.payload.selectedColumns
      });
      if (!result.ok || !result.mutationResult) {
        throw new Error(result.error || 'Dataverse did not apply the approved change.');
      }
      const refresh = await refreshAfterMutation(context, result.mutationResult);
      return {
        ok: true,
        data: { ...result.mutationResult, ...refresh }
      };
    }

    case 'TEST_LLM_CONNECTION': {
      const response = await callAzureOpenAI(message.payload, [
        { role: 'system', content: 'Reply with exactly: Connection successful' },
        { role: 'user', content: 'Test connection' }
      ]);
      return { ok: true, data: response };
    }

    case 'OPEN_DATAVERSE_RECORD': {
      const context = await getActiveDataverseContext();
      const result = await navigateDataverse(context, {
        target: 'record',
        tableLogicalName: message.payload.tableLogicalName,
        recordId: message.payload.recordId
      });
      return result.ok ? { ok: true, data: result } : { ok: false, error: result.error };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'CONTEXT_CHANGED':
    case 'NAVIGATION_STATUS':
      return { ok: true };

    default:
      throw new Error('Unsupported extension message.');
  }
}
