import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAssistantTool } from '../lib/assistant/execute-tool';
import { executePrimitiveInActiveTab } from '../lib/browser/primitives';
import { executeFlowPrimitiveInActiveTab } from '../lib/browser/flows';
import { openDataverseFlowDesigner } from '../lib/browser/flow-navigation';
import {
  queryFromArguments,
  mutationValueArray,
  skillFromToolArguments,
  flowSpecFromArguments
} from '../lib/assistant/arguments';
import { SKILL_TOOL_OPTIONS } from '../lib/assistant/tool-catalog';
import { recordProposal } from './fixtures/proposals';

vi.mock('../lib/browser/primitives', () => ({ executePrimitiveInActiveTab: vi.fn() }));
vi.mock('../lib/browser/flows', () => ({ executeFlowPrimitiveInActiveTab: vi.fn() }));
vi.mock('../lib/browser/flow-navigation', () => ({ openDataverseFlowDesigner: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
});
const context = {
  isDataverse: true,
  source: 'url' as const,
  origin: recordProposal.environmentOrigin,
  fields: [],
  capturedAt: 'now'
};

describe('assistant tool dispatch', () => {
  it.each(['{bad', 'null', '[]', '42', '"text"'])(
    'rejects non-object tool arguments (%s)',
    async (args) => {
      const result = await executeAssistantTool(context, 'query_dataverse_records', args);
      expect(result.ok).toBe(false);
      expect(executePrimitiveInActiveTab).not.toHaveBeenCalled();
    }
  );

  it('routes mutation preparation but never execution from model calls', async () => {
    vi.mocked(executePrimitiveInActiveTab).mockResolvedValue({
      ok: true,
      action: 'prepare_mutation',
      mutation: recordProposal
    });
    await executeAssistantTool(
      context,
      'prepare_dataverse_record_change',
      JSON.stringify({
        operation: 'create',
        table: 'contact',
        values: [{ column: 'firstname', value: 'Ada' }]
      })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ action: 'prepare_mutation' })
    );
    vi.mocked(executePrimitiveInActiveTab).mockClear();
    expect((await executeAssistantTool(context, 'execute_mutation', '{}')).ok).toBe(false);
    expect(executePrimitiveInActiveTab).not.toHaveBeenCalled();
  });

  it('opens an exact cloud flow in Power Automate through a navigation-only tool', async () => {
    vi.mocked(openDataverseFlowDesigner).mockResolvedValue({
      ok: true,
      navigationState: 'started',
      navigationMethod: 'power-automate-url',
      workflowId: '00000000-0000-0000-0000-000000000010'
    });
    await executeAssistantTool(
      context,
      'open_dataverse_flow_designer',
      JSON.stringify({ workflowId: '00000000-0000-0000-0000-000000000010' })
    );
    expect(openDataverseFlowDesigner).toHaveBeenCalledWith(
      context,
      '00000000-0000-0000-0000-000000000010'
    );
  });

  it('routes typed flow preparation but never flow execution from model calls', async () => {
    vi.mocked(executeFlowPrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'prepare_flow_change',
      error: 'test'
    });
    const spec = {
      name: 'Oddy flow',
      connectionReferenceLogicalName: 'cr_dataverse',
      trigger: { kind: 'manual' },
      actions: []
    };
    await executeAssistantTool(
      context,
      'prepare_dataverse_flow_change',
      JSON.stringify({ operation: 'create', spec })
    );
    expect(executeFlowPrimitiveInActiveTab).toHaveBeenCalledWith(context, {
      action: 'prepare_flow_change',
      origin: context.origin,
      operation: 'create',
      spec
    });
    vi.mocked(executeFlowPrimitiveInActiveTab).mockClear();
    expect((await executeAssistantTool(context, 'execute_flow_change', '{}')).ok).toBe(false);
    expect(executeFlowPrimitiveInActiveTab).not.toHaveBeenCalled();
  });

  it('routes complete definition proposals without exposing execution to the model', async () => {
    vi.mocked(executeFlowPrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'prepare_flow_change',
      error: 'test'
    });
    const definition = { name: 'Existing flow', clientData: '{"properties":{}}' };
    await executeAssistantTool(
      context,
      'prepare_dataverse_flow_change',
      JSON.stringify({
        operation: 'update',
        workflowId: 'flow-id',
        etag: 'W/"1"',
        definition
      })
    );
    expect(executeFlowPrimitiveInActiveTab).toHaveBeenCalledWith(context, {
      action: 'prepare_flow_change',
      origin: context.origin,
      operation: 'update',
      workflowId: 'flow-id',
      etag: 'W/"1"',
      definition
    });
    vi.mocked(executeFlowPrimitiveInActiveTab).mockClear();
    for (const invalid of [
      { operation: 'create', definition },
      { operation: 'update', definition, spec: {} },
      { operation: 'update', definition: [] }
    ]) {
      expect(
        (
          await executeAssistantTool(
            context,
            'prepare_dataverse_flow_change',
            JSON.stringify(invalid)
          )
        ).ok
      ).toBe(false);
    }
    expect(executeFlowPrimitiveInActiveTab).not.toHaveBeenCalled();
  });

  it('routes bulk membership preparation as one primitive', async () => {
    vi.mocked(executePrimitiveInActiveTab).mockResolvedValue({
      ok: false,
      action: 'prepare_list_membership',
      error: 'test'
    });
    const members = [
      { table: 'contact', recordId: 'one' },
      { table: 'contact', recordId: 'two' }
    ];
    await executeAssistantTool(
      context,
      'prepare_marketing_list_membership',
      JSON.stringify({ listId: 'list-id', members })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenCalledExactlyOnceWith(context, {
      action: 'prepare_list_membership',
      origin: context.origin,
      listId: 'list-id',
      members
    });
  });

  it('keeps structured-query limits, filters, and lookup proposals intact', () => {
    expect(
      queryFromArguments({
        table: 'contact',
        top: 100,
        filters: [{ column: 'emailaddress1', operator: 'eq', value: 'test@example.com' }]
      })
    ).toMatchObject({
      top: 50,
      filters: [{ column: 'emailaddress1', operator: 'eq', value: 'test@example.com' }]
    });
    expect(
      flowSpecFromArguments({
        name: 'Oddy flow',
        connectionReferenceLogicalName: 'cr_dataverse',
        trigger: { kind: 'manual' },
        actions: []
      })
    ).toMatchObject({ name: 'Oddy flow', trigger: { kind: 'manual' }, actions: [] });
    expect(
      mutationValueArray([
        { column: 'ownerid', lookup: { table: 'systemuser', recordId: 'guid' } },
        { column: 'nullable', value: null }
      ])
    ).toEqual([
      { column: 'ownerid', lookup: { table: 'systemuser', recordId: 'guid' } },
      { column: 'nullable', value: null }
    ]);
  });

  it('does not silently truncate a skill tool list when a new tool is added', () => {
    const names = SKILL_TOOL_OPTIONS.map((tool) => tool.name);
    expect(skillFromToolArguments({ allowedTools: names }).allowedTools).toEqual(names);
  });
});
