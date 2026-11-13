import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAssistantTool } from '../lib/assistant/execute-tool';
import { executePrimitiveInActiveTab } from '../lib/browser/primitives';
import { executeFlowPrimitiveInActiveTab } from '../lib/browser/flows';
import { executeSchemaPrimitiveInActiveTab } from '../lib/browser/schema';
import { executeFormPrimitiveInActiveTab } from '../lib/browser/forms';
import { createSchemaTablePlan } from './fixtures/schema';
import { openDataverseFlowDesigner } from '../lib/browser/flow-navigation';
import {
  queryFromArguments,
  mutationValueArray,
  skillFromToolArguments
} from '../lib/assistant/arguments';
import { SKILL_TOOL_OPTIONS } from '../lib/assistant/tool-catalog';
import { recordProposal } from './fixtures/proposals';

vi.mock('../lib/browser/primitives', () => ({ executePrimitiveInActiveTab: vi.fn() }));
vi.mock('../lib/browser/flows', () => ({ executeFlowPrimitiveInActiveTab: vi.fn() }));
vi.mock('../lib/browser/schema', () => ({ executeSchemaPrimitiveInActiveTab: vi.fn() }));
vi.mock('../lib/browser/forms', () => ({ executeFormPrimitiveInActiveTab: vi.fn() }));
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
  it('routes read-only form tools with strict arguments', async () => {
    await executeAssistantTool(
      context,
      'list_dataverse_forms',
      JSON.stringify({ tableLogicalName: 'contact' })
    );
    expect(executeFormPrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'list_forms',
      origin: context.origin,
      tableLogicalName: 'contact'
    });
    await executeAssistantTool(
      context,
      'get_dataverse_form_definition',
      JSON.stringify({ tableLogicalName: 'contact', formId: 'abc', languageCode: null })
    );
    expect(executeFormPrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'get_form_definition',
      origin: context.origin,
      tableLogicalName: 'contact',
      formId: 'abc'
    });
    await executeAssistantTool(
      context,
      'get_dataverse_form_definition',
      JSON.stringify({ tableLogicalName: 'contact', formId: 'abc', languageCode: 1032 })
    );
    expect(executeFormPrimitiveInActiveTab).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({ languageCode: 1032 })
    );
    vi.mocked(executeFormPrimitiveInActiveTab).mockClear();
    for (const [tool, args] of [
      ['list_dataverse_forms', { tableLogicalName: 'contact', formxml: '<form/>' }],
      [
        'get_dataverse_form_definition',
        { tableLogicalName: 'contact', formId: 'abc', languageCode: 1.5 }
      ],
      ['update_dataverse_form', { formId: 'abc' }]
    ] as const)
      expect((await executeAssistantTool(context, tool, JSON.stringify(args))).ok).toBe(false);
    expect(executeFormPrimitiveInActiveTab).not.toHaveBeenCalled();
  });

  it('routes schema discovery and preparation but never exposes execution', async () => {
    await executeAssistantTool(
      context,
      'prepare_dataverse_schema_change',
      JSON.stringify({ plan: createSchemaTablePlan })
    );
    expect(executeSchemaPrimitiveInActiveTab).toHaveBeenCalledWith(context, {
      action: 'prepare_schema_change',
      origin: context.origin,
      plan: createSchemaTablePlan
    });
    await executeAssistantTool(
      context,
      'list_dataverse_solutions',
      JSON.stringify({ afterUniqueName: null })
    );
    expect(executeSchemaPrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'list_schema_solutions',
      origin: context.origin,
      afterUniqueName: null
    });
    await executeAssistantTool(
      context,
      'get_dataverse_table_definition',
      JSON.stringify({ tableLogicalName: 'new_example' })
    );
    expect(executeSchemaPrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'get_table_definition',
      origin: context.origin,
      tableLogicalName: 'new_example'
    });
    vi.mocked(executeSchemaPrimitiveInActiveTab).mockClear();
    for (const tool of [
      'execute_dataverse_schema_change',
      'publish_all',
      'execute_schema_change'
    ]) {
      expect((await executeAssistantTool(context, tool, '{}')).ok).toBe(false);
    }
    expect(
      (
        await executeAssistantTool(
          context,
          'prepare_dataverse_schema_change',
          JSON.stringify({ plan: createSchemaTablePlan, url: '/anything' })
        )
      ).ok
    ).toBe(false);
    expect(executeSchemaPrimitiveInActiveTab).not.toHaveBeenCalled();
  });

  it.each(['{bad', 'null', '[]', '42', '"text"'])(
    'rejects non-object tool arguments (%s)',
    async (args) => {
      const result = await executeAssistantTool(context, 'query_dataverse_records', args);
      expect(result.ok).toBe(false);
      expect(executePrimitiveInActiveTab).not.toHaveBeenCalled();
    }
  );

  it('forwards full native XML and continuation arguments without structured normalization', async () => {
    const fetchXml =
      '<fetch><entity name="product"><filter type="or"><condition attribute="name" operator="eq" value="A &amp; B"/></filter></entity></fetch>';
    await executeAssistantTool(
      context,
      'query_dataverse_records',
      JSON.stringify({ fetchXml, pageSize: 100, cursor: null })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'query_records',
      origin: context.origin,
      fetchXml,
      pageSize: 100,
      cursor: undefined
    });
    await executeAssistantTool(
      context,
      'query_dataverse_records',
      JSON.stringify({ fetchXml: null, pageSize: null, cursor: 'cursor' })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'query_records',
      origin: context.origin,
      fetchXml: undefined,
      pageSize: undefined,
      cursor: 'cursor'
    });
    const layoutXml = '<grid><row id="productid"/></grid>';
    await executeAssistantTool(
      context,
      'manage_dataverse_view',
      JSON.stringify({ action: 'upsert', table: 'product', fetchXml, layoutXml, etag: 'W/"12"' })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'upsert_view',
      origin: context.origin,
      table: 'product',
      fetchXml,
      layoutXml,
      etag: 'W/"12"'
    });
    await executeAssistantTool(
      context,
      'execute_dataverse_view',
      JSON.stringify({ table: null, pageSize: null, cursor: 'view-cursor' })
    );
    expect(executePrimitiveInActiveTab).toHaveBeenLastCalledWith(context, {
      action: 'execute_view',
      origin: context.origin,
      table: undefined,
      pageSize: undefined,
      cursor: 'view-cursor'
    });
  });

  it.each([
    ['query_dataverse_records', { table: 'product', filters: [] }],
    ['query_dataverse_records', { fetchXml: '<fetch/>', cursor: 123 }],
    ['query_dataverse_records', { fetchXml: '<fetch/>', pageSize: '100' }],
    ['manage_dataverse_view', { action: 'delete', table: 'product' }],
    ['manage_dataverse_view', { action: 'get', table: 'product', fetchXml: '<fetch/>' }],
    ['execute_dataverse_view', { table: 'product', top: 10 }]
  ])(
    'rejects unsupported native arguments without silently dropping them (%s)',
    async (tool, args) => {
      const result = await executeAssistantTool(context, tool, JSON.stringify(args));
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

  it('forwards flow-list filters, trigger matching, sorting, and cursor without the old 50-flow clamp', async () => {
    vi.mocked(executeFlowPrimitiveInActiveTab).mockResolvedValue({
      ok: true,
      action: 'list_flows',
      flows: []
    });
    const options = {
      pageSize: 100,
      filters: { state: 'activated', isManaged: false },
      orderBy: { field: 'name', direction: 'asc' },
      definitionScope: 'published',
      trigger: { table: 'cr_voucher', event: 'create' },
      cursor: null
    };
    await executeAssistantTool(context, 'list_dataverse_flows', JSON.stringify(options));
    expect(executeFlowPrimitiveInActiveTab).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        action: 'list_flows',
        origin: context.origin,
        ...options
      })
    );
    await executeAssistantTool(
      context,
      'list_dataverse_flows',
      JSON.stringify({
        pageSize: null,
        filters: null,
        orderBy: null,
        definitionScope: null,
        trigger: null,
        cursor: 'opaque-cursor'
      })
    );
    expect(executeFlowPrimitiveInActiveTab).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        action: 'list_flows',
        cursor: 'opaque-cursor',
        pageSize: null,
        filters: null,
        definitionScope: null
      })
    );
  });

  it.each(['create', 'update'])(
    'routes the same definition format for %s and tolerates unused null fields',
    async (operation) => {
      vi.mocked(executeFlowPrimitiveInActiveTab).mockResolvedValue({
        ok: false,
        action: 'prepare_flow_change',
        error: 'test'
      });
      const definition = { name: 'Flow', description: null, clientData: '{"properties":{}}' };
      await executeAssistantTool(
        context,
        'prepare_dataverse_flow_change',
        JSON.stringify({
          operation,
          workflowId: operation === 'update' ? 'flow-id' : null,
          etag: operation === 'update' ? 'W/"1"' : null,
          definition,
          spec: null
        })
      );
      expect(executeFlowPrimitiveInActiveTab).toHaveBeenCalledWith(context, {
        action: 'prepare_flow_change',
        origin: context.origin,
        operation,
        workflowId: operation === 'update' ? 'flow-id' : undefined,
        etag: operation === 'update' ? 'W/"1"' : undefined,
        definition: { name: 'Flow', clientData: definition.clientData }
      });
      vi.mocked(executeFlowPrimitiveInActiveTab).mockClear();
      expect((await executeAssistantTool(context, 'execute_flow_change', '{}')).ok).toBe(false);
      expect(executeFlowPrimitiveInActiveTab).not.toHaveBeenCalled();
    }
  );

  it('rejects retired typed specs and missing definitions with an actionable error', async () => {
    for (const invalid of [
      { operation: 'create', spec: {} },
      { operation: 'update', definition: {}, spec: {} },
      { operation: 'update', definition: [] },
      { operation: 'create', definition: null }
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
