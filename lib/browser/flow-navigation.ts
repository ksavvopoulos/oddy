import type { DataverseContext } from '../types';
import { executeFlowPrimitiveInActiveTab } from './flows';

export interface FlowDesignerNavigationResult {
  ok: boolean;
  navigationState?: 'started';
  navigationMethod?: 'power-automate-url';
  workflowId?: string;
  flowName?: string;
  url?: string;
  error?: string;
}

export async function openDataverseFlowDesigner(
  context: DataverseContext,
  workflowId: string
): Promise<FlowDesignerNavigationResult> {
  if (!context.origin) return { ok: false, error: 'The Dataverse origin is unavailable.' };
  const id = workflowId.replace(/[{}]/g, '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: 'A valid cloud-flow workflow ID is required.' };
  }

  const target = await executeFlowPrimitiveInActiveTab(context, {
    action: 'get_flow_designer_target',
    origin: context.origin,
    workflowId: id
  });
  if (!target.ok || !target.flowDesignerTarget) {
    return {
      ok: false,
      error: target.error || 'Dataverse did not return the cloud-flow designer target.'
    };
  }

  const url = new URL(
    `/environments/${encodeURIComponent(target.flowDesignerTarget.environmentId)}/flows/${encodeURIComponent(target.flowDesignerTarget.workflowId)}/edit`,
    'https://make.powerautomate.com'
  ).toString();
  await chrome.tabs.create({ url });
  return {
    ok: true,
    navigationState: 'started',
    navigationMethod: 'power-automate-url',
    workflowId: target.flowDesignerTarget.workflowId,
    flowName: target.flowDesignerTarget.flowName,
    url
  };
}
