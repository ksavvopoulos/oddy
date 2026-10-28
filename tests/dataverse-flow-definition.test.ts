import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFlowPrimitive } from '../lib/dataverse-flow-primitives';
import { flowDefinitionDifferences } from '../lib/flows/definition-diff';
import {
  afterDefinition,
  beforeDefinition,
  definitionProposal,
  existingFlow,
  existingWorkflowId,
  flowOrigin as origin,
  flowMetadataPayload
} from './fixtures/flow-definitions';

const response = (value: unknown, status = 200) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status });
function stubFetch(handler: (url: string, options?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    const metadata = flowMetadataPayload(String(url));
    return metadata === undefined ? handler(url, options) : response(metadata);
  });
}
const prepareRequest = {
  action: 'prepare_flow_change' as const,
  origin,
  operation: 'update' as const,
  workflowId: existingWorkflowId,
  etag: existingFlow['@odata.etag'],
  definition: afterDefinition
};

beforeEach(() => vi.stubGlobal('window', { location: { origin } }));
afterEach(() => vi.unstubAllGlobals());

describe('approval-gated general cloud-flow definition edits', () => {
  it('reads a non-Oddy flow with its full definition and exact row version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(existingFlow));
    stubFetch(fetchMock);
    const result = await executeDataverseFlowPrimitive({
      action: 'get_flow',
      origin,
      workflowId: existingWorkflowId
    });
    expect(result.flow).toMatchObject({
      oddyEditable: true,
      definition: beforeDefinition,
      etag: existingFlow['@odata.etag']
    });
    expect(result.flow).not.toHaveProperty('spec');
    expect(result.flow).not.toHaveProperty('typedEditable');
    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(options.headers).get('MSCRM.IncludeUnpublished')).toBe('true');
  });

  it('prepares general edits without writing and saves only after approval execution', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(existingFlow))
      .mockResolvedValueOnce(response(existingFlow))
      .mockResolvedValueOnce(response(undefined, 204));
    stubFetch(fetchMock);
    const prepared = await executeDataverseFlowPrimitive(prepareRequest);
    expect(prepared.ok).toBe(true);
    expect(prepared.flowChange).toMatchObject({
      mode: 'definition',
      before: { definition: beforeDefinition },
      after: afterDefinition,
      saveMode: 'draft'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined();
    // Also verifies this new path remains self-contained when injected in MAIN world.
    const injected = new Function(
      `return (${executeDataverseFlowPrimitive.toString()});`
    )() as typeof executeDataverseFlowPrimitive;
    const result = await injected({
      action: 'execute_flow_change',
      origin,
      change: prepared.flowChange!
    });
    expect(result.flowChangeResult).toMatchObject({
      operation: 'update',
      state: 'activated',
      savedAs: 'unpublished-draft'
    });
    const patch = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(patch.method).toBe('PATCH');
    expect(new Headers(patch.headers).get('If-Match')).toBe(existingFlow['@odata.etag']);
    expect(new Headers(patch.headers).get('MSCRM.AsUnpublished')).toBe('true');
    expect(new Headers(patch.headers).has('MSCRM.SkipComponentVersioning')).toBe(false);
    expect(JSON.parse(String(patch.body))).toEqual({
      name: afterDefinition.name,
      description: afterDefinition.description,
      clientdata: afterDefinition.clientData
    });
    const before = JSON.parse(beforeDefinition.clientData);
    const after = JSON.parse(JSON.parse(String(patch.body)).clientdata);
    expect(after.properties.designerMetadata).toEqual(before.properties.designerMetadata);
    expect(after.properties.connectionReferences).toEqual(before.properties.connectionReferences);
    expect(after.properties.definition.actions.Audit).toEqual(
      before.properties.definition.actions.Audit
    );
    expect(
      after.properties.definition.actions.If_Patras.actions.Set_Country_Greece.metadata
    ).toEqual(before.properties.definition.actions.If_Patras.actions.Set_Country_Greece.metadata);
    expect(after.properties.definition.actions.Repeat_audit.type).toBe('Foreach');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([url]) => /Publish|Activate/.test(String(url)))).toBe(false);
  });

  it('allows a general edit when an embedded Oddy specification is outdated', async () => {
    const clientData = JSON.parse(beforeDefinition.clientData);
    clientData.properties.definition.triggers.On_contact_changed.metadata.oddy = {
      schemaVersion: 1,
      spec: {
        name: beforeDefinition.name,
        connectionReferenceLogicalName: 'cr_dataverse',
        trigger: { kind: 'manual' },
        actions: []
      }
    };
    stubFetch(
      vi.fn().mockResolvedValue(
        response({
          ...existingFlow,
          clientdata: JSON.stringify(clientData)
        })
      )
    );
    const prepared = await executeDataverseFlowPrimitive(prepareRequest);
    expect(prepared.ok).toBe(true);
    expect(prepared.flowChange?.before).toMatchObject({
      oddyEditable: true
    });
    expect(prepared.flowChange?.mode).toBe('definition');
  });

  it('preserves an omitted description rather than clearing it implicitly', async () => {
    stubFetch(vi.fn().mockResolvedValue(response(existingFlow)));
    const prepared = await executeDataverseFlowPrimitive({
      ...prepareRequest,
      definition: { name: afterDefinition.name, clientData: afterDefinition.clientData }
    });
    expect(prepared.flowChange?.after.description).toBe(beforeDefinition.description);
  });

  it('allows clearing the description when the proposal explicitly requests it', async () => {
    stubFetch(vi.fn().mockResolvedValue(response(existingFlow)));
    const prepared = await executeDataverseFlowPrimitive({
      ...prepareRequest,
      definition: { ...afterDefinition, description: '' }
    });
    expect(prepared.flowChange?.after.description).toBe('');
  });

  it.each([
    ['managed', { ...existingFlow, ismanaged: true }, existingFlow['@odata.etag']],
    [
      'missing saved ETag',
      { ...existingFlow, '@odata.etag': undefined },
      existingFlow['@odata.etag']
    ],
    ['missing read ETag', existingFlow, ''],
    ['wildcard', existingFlow, '*'],
    [
      'changed since read',
      { ...existingFlow, '@odata.etag': 'W/"2"' },
      existingFlow['@odata.etag']
    ],
    [
      'malformed current definition',
      { ...existingFlow, clientdata: '{}' },
      existingFlow['@odata.etag']
    ]
  ])('refuses preparation for %s', async (_label, flow, etag) => {
    const fetchMock = vi.fn().mockResolvedValue(response(flow));
    stubFetch(fetchMock);
    const result = await executeDataverseFlowPrimitive({ ...prepareRequest, etag });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined();
  });

  it.each([
    'not json',
    '{}',
    '[]',
    JSON.stringify({ properties: { definition: { triggers: {}, actions: {} } } }),
    JSON.stringify({
      properties: { definition: { triggers: { manual: { type: 'Request' } }, actions: [] } }
    }),
    JSON.stringify({ properties: { definition: { triggers: { manual: {} }, actions: {} } } }),
    'x'.repeat(1_000_001)
  ])('rejects malformed or oversized proposed clientdata (%#)', async (clientData) => {
    const fetchMock = vi.fn().mockResolvedValue(response(existingFlow));
    stubFetch(fetchMock);
    const result = await executeDataverseFlowPrimitive({
      ...prepareRequest,
      definition: { ...afterDefinition, clientData }
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'environment',
    'consent',
    'payload',
    'managed',
    'etag',
    'component',
    'snapshot',
    'name'
  ])('refuses approved execution after a change to %s', async (scenario) => {
    const change = structuredClone(definitionProposal);
    const current = { ...existingFlow };
    if (scenario === 'environment') change.environmentOrigin = 'https://other.crm.dynamics.com';
    if (scenario === 'consent') delete change.saveMode;
    if (scenario === 'payload') change.generatedClientData = '{}';
    if (scenario === 'managed') current.ismanaged = true;
    if (scenario === 'etag') current['@odata.etag'] = 'W/"new"';
    if (scenario === 'component') current.componentstate = 0;
    if (scenario === 'snapshot') current.clientdata = afterDefinition.clientData;
    if (scenario === 'name') current.name = 'Changed externally';
    const fetchMock = vi.fn().mockResolvedValue(response(current));
    stubFetch(fetchMock);
    const result = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change
    });
    expect(result.ok).toBe(false);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method)).toBe(false);
    if (['environment', 'consent', 'payload'].includes(scenario))
      expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 412])(
    'does not retry or publish after a server draft-save error (%s)',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(existingFlow))
        .mockResolvedValueOnce(response({ error: 'Draft save rejected' }, status));
      stubFetch(fetchMock);
      const result = await executeDataverseFlowPrimitive({
        action: 'execute_flow_change',
        origin,
        change: definitionProposal
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(String(status));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]![1]?.method).toBe('PATCH');
    }
  );
});

describe('complete flow definition diff', () => {
  it('includes broad logic changes, not only entity-name repairs', () => {
    const diff = flowDefinitionDifferences(beforeDefinition, afterDefinition);
    expect(diff.map((item) => item.path)).toEqual([
      '/name',
      '/clientData/properties/definition/actions/If_Patras/actions/Set_Country_Greece/inputs/parameters/entityName',
      '/clientData/properties/definition/actions/Repeat_audit'
    ]);
    expect(diff[1]).toMatchObject({ before: 'contact', after: 'contacts' });
    expect(diff[2]?.after).toMatchObject({ type: 'Foreach' });
  });

  it('shows removals, connection changes, arrays, and escaped JSON paths', () => {
    const wrap = (value: unknown) => ({ name: 'Test', clientData: JSON.stringify(value) });
    const diff = flowDefinitionDifferences(
      wrap({ 'a/b': { '~key': [1, 2] }, removed: true, connectionReferences: { a: 'old' } }),
      wrap({ 'a/b': { '~key': [2, 1] }, connectionReferences: { a: 'new' } })
    );
    expect(diff.map((item) => item.path)).toEqual([
      '/clientData/a~1b/~0key',
      '/clientData/removed',
      '/clientData/connectionReferences/a'
    ]);
    expect(diff[1]?.after).toBeUndefined();
  });
});
