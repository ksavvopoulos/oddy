import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFlowPrimitive } from '../lib/dataverse-flow-primitives';
import type { DataverseFlowDefinition, PreparedDataverseFlowChange } from '../lib/flows/contracts';
import {
  beforeDefinition,
  afterDefinition,
  existingFlow,
  existingWorkflowId,
  contactAttributes,
  flowConnections,
  flowMetadataPayload,
  flowOrigin as origin
} from './fixtures/flow-definitions';

const response = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status, headers });
const modify = (edit: (data: any) => void): DataverseFlowDefinition => {
  const data = JSON.parse(afterDefinition.clientData);
  edit(data);
  return { name: 'New contact flow', clientData: JSON.stringify(data) };
};
const prepare = (definition: DataverseFlowDefinition) =>
  executeDataverseFlowPrimitive({
    action: 'prepare_flow_change',
    origin,
    operation: 'create',
    definition
  });
const writes = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([, options]) => options?.method);

beforeEach(() => vi.stubGlobal('window', { location: { origin } }));
afterEach(() => vi.unstubAllGlobals());

describe('native cloud-flow creation and validation', () => {
  it('lists modern flows as summaries without clientdata or ownership flags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ value: [existingFlow, { ...existingFlow, ismanaged: true }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeDataverseFlowPrimitive({ action: 'list_flows', origin });
    expect(result.flows).toEqual([
      expect.objectContaining({ oddyEditable: true }),
      expect.objectContaining({ oddyEditable: false })
    ]);
    expect(JSON.stringify(result)).not.toContain('clientData');
    expect(JSON.stringify(result)).not.toContain('typedEditable');
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('MSCRM.IncludeUnpublished')).toBe(
      'true'
    );
  });

  it('resolves the Power Platform environment even for an unreadable flow definition', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ...existingFlow, clientdata: '{}' }))
      .mockResolvedValueOnce(
        response({ Detail: { EnvironmentId: 'Default-00000000-0000-0000-0000-000000000001' } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeDataverseFlowPrimitive({
      action: 'get_flow_designer_target',
      origin,
      workflowId: existingWorkflowId
    });
    expect(result.flowDesignerTarget).toMatchObject({
      workflowId: existingWorkflowId,
      environmentId: 'Default-00000000-0000-0000-0000-000000000001'
    });
    expect(fetchMock.mock.calls[1]![0]).toContain('RetrieveCurrentOrganization');
  });

  it('uses the same full definition for creation, validates again on approval, and creates Off', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      const metadata = flowMetadataPayload(url);
      if (metadata !== undefined) return response(metadata);
      if (options?.method === 'POST')
        return response(undefined, 204, {
          'OData-EntityId': `${origin}/api/data/v9.2/workflows(${existingWorkflowId})`
        });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepare(afterDefinition);
    expect(prepared.ok).toBe(true);
    expect(prepared.flowChange).toMatchObject({
      mode: 'definition',
      operation: 'create',
      after: afterDefinition
    });
    expect(prepared.flowChange?.warnings.join(' ')).toContain('remain Off');
    expect(writes(fetchMock)).toHaveLength(0);
    const metadataBeforeApproval = fetchMock.mock.calls.length;
    const result = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change: prepared.flowChange!
    });
    expect(result.flowChangeResult).toEqual({
      operation: 'create',
      workflowId: existingWorkflowId,
      name: afterDefinition.name,
      state: 'draft'
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(metadataBeforeApproval + 1);
    expect(writes(fetchMock)).toHaveLength(1);
    const body = JSON.parse(String(writes(fetchMock)[0]![1]?.body));
    expect(body).toEqual({
      category: 5,
      type: 1,
      primaryentity: 'none',
      statecode: 0,
      name: afterDefinition.name,
      description: afterDefinition.description,
      clientdata: afterDefinition.clientData
    });
    expect(body.clientdata).not.toContain('"oddy"');
    expect(fetchMock.mock.calls.some(([url]) => /Publish|Activate/.test(url))).toBe(false);
  });

  it('lists and validates non-Dataverse connection references without filtering them out', async () => {
    const outlook = {
      connectionreferencelogicalname: 'cr_outlook',
      connectorid: '/providers/Microsoft.PowerApps/apis/shared_office365'
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/connectionreferences'))
        return response({ value: [...flowConnections.value, outlook] });
      const metadata = flowMetadataPayload(url);
      if (metadata !== undefined) return response(metadata);
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetchMock);
    const listed = await executeDataverseFlowPrimitive({
      action: 'list_flow_connection_references',
      origin
    });
    expect(listed.connectionReferences?.map((item) => item.logicalName)).toContain('cr_outlook');
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.has('$filter')).toBe(false);
    const definition = modify((data) => {
      data.properties.connectionReferences.outlook = {
        connection: { connectionReferenceLogicalName: 'cr_outlook' },
        api: { name: 'shared_office365' }
      };
      data.properties.definition.actions.Mail = {
        type: 'OpenApiConnection',
        runAfter: { Repeat_audit: ['Succeeded'] },
        inputs: {
          host: { connectionReferenceName: 'outlook', operationId: 'SendEmailV2' },
          parameters: { 'emailMessage/To': 'test@example.com' }
        }
      };
    });
    expect((await prepare(definition)).ok).toBe(true);
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it.each([
    [
      'wrong action table',
      (data: any) => {
        data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.parameters.entityName =
          'contact';
      },
      'Use contacts, not contact'
    ],
    [
      'wrong trigger table',
      (data: any) => {
        data.properties.definition.triggers.On_contact_changed.inputs.parameters[
          'subscriptionRequest/entityname'
        ] = 'contacts';
      },
      'Use contact, not contacts'
    ],
    [
      'unknown write column',
      (data: any) => {
        data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.parameters[
          'item/not_a_column'
        ] = 'x';
      },
      'Could not resolve contact.not_a_column'
    ],
    [
      'read-only write column',
      (data: any) => {
        data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.parameters[
          'item/contactid'
        ] = 'x';
      },
      'cannot be used for update'
    ],
    [
      'wrong literal type',
      (data: any) => {
        data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.parameters[
          'item/address1_country'
        ] = 123;
      },
      'requires a text literal'
    ],
    [
      'missing connection',
      (data: any) => {
        data.properties.connectionReferences.dataverse.connection.connectionReferenceLogicalName =
          'invented';
      },
      'was not found'
    ],
    [
      'wrong connector',
      (data: any) => {
        data.properties.connectionReferences.dataverse.api.name = 'shared_office365';
      },
      'does not match'
    ],
    [
      'no binding',
      (data: any) => {
        delete data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.host
          .connectionName;
      },
      'must specify an existing connection reference'
    ],
    [
      'missing alias',
      (data: any) => {
        data.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.host.connectionName =
          'not_defined';
      },
      'missing from clientdata'
    ],
    [
      'invalid nested action',
      (data: any) => {
        delete data.properties.definition.actions.Repeat_audit.actions.Compose_item.type;
      },
      'must have a name and type'
    ],
    [
      'invalid dependency',
      (data: any) => {
        data.properties.definition.actions.Audit.runAfter = { Missing: ['Succeeded'] };
      },
      'invalid runAfter'
    ],
    [
      'dependency cycle',
      (data: any) => {
        data.properties.definition.actions.Audit.runAfter = { Repeat_audit: ['Succeeded'] };
      },
      'circular runAfter'
    ]
  ])('refuses %s before any write', async (_label, change, expected) => {
    const fetchMock = vi.fn(async (url: string) => response(flowMetadataPayload(url)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await prepare(modify(change));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(expected);
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('rejects deleting a binding still used by otherwise unchanged actions', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const metadata = flowMetadataPayload(url);
      return response(metadata === undefined ? existingFlow : metadata);
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = JSON.parse(beforeDefinition.clientData);
    delete data.properties.connectionReferences.dataverse;
    const result = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'update',
      workflowId: existingWorkflowId,
      etag: existingFlow['@odata.etag'],
      definition: { ...beforeDefinition, clientData: JSON.stringify(data) }
    });
    expect(result.error).toContain('missing from clientdata');
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('validates selected and sorted columns and checks changed metadata again before creation', async () => {
    let readable = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/Attributes'))
        return response({
          value: contactAttributes.value.map((item) => ({ ...item, IsValidForRead: readable }))
        });
      return response(flowMetadataPayload(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const definition = modify((data) => {
      data.properties.definition.actions = {
        List: {
          type: 'OpenApiConnection',
          runAfter: {},
          inputs: {
            host: { connectionName: 'dataverse', operationId: 'ListRecords' },
            parameters: {
              entityName: 'contacts',
              $select: 'address1_city',
              $orderby: 'address1_country asc'
            }
          }
        }
      };
    });
    const prepared = await prepare(definition);
    expect(prepared.ok).toBe(true);
    readable = false;
    const result = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change: prepared.flowChange!
    });
    expect(result.error).toContain('cannot be used for read');
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it('validates nested switch/default actions and supports expressions without a typed value wrapper', async () => {
    const fetchMock = vi.fn(async (url: string) => response(flowMetadataPayload(url)));
    vi.stubGlobal('fetch', fetchMock);
    const definition = modify((data) => {
      const update = data.properties.definition.actions.If_Patras.actions.Set_Country_Greece;
      update.inputs.parameters['item/address1_country'] =
        "@coalesce(triggerBody()?['address1_country'], 'Greece')";
      data.properties.definition.actions = {
        Choose: {
          type: 'Switch',
          expression: '@triggerBody()',
          runAfter: {},
          cases: { Patras: { case: 'Patras', actions: { Update: update } } },
          default: { actions: {} }
        }
      };
    });
    expect((await prepare(definition)).ok).toBe(true);
    const invalid = JSON.parse(definition.clientData);
    delete invalid.properties.definition.actions.Choose.cases.Patras.actions.Update.type;
    expect((await prepare({ ...definition, clientData: JSON.stringify(invalid) })).ok).toBe(false);
  });

  it('rejects legacy typed previews without writing and does not recreate an existing flow', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const legacy = {
      operation: 'create',
      environmentOrigin: origin,
      after: { name: 'Old', trigger: { kind: 'manual' }, actions: [] }
    } as unknown as PreparedDataverseFlowChange;
    const result = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change: legacy
    });
    expect(result.error).toContain('legacy flow preview');
    expect(fetchMock).not.toHaveBeenCalled();
    const rejected = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      operation: 'create',
      origin,
      workflowId: existingWorkflowId,
      definition: beforeDefinition
    });
    expect(rejected.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
