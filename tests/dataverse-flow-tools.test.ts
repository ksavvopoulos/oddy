import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFlowPrimitive } from '../lib/dataverse-flow-primitives';

const origin = 'https://contoso.crm.dynamics.com';
const connectionReferences = {
  value: [
    {
      connectionreferencelogicalname: 'cr_sharedcommondataserviceforapps',
      connectionreferencedisplayname: 'Dataverse connection',
      connectorid: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
      connectionid: 'shared-connection-id',
      ismanaged: false
    }
  ]
};
const accountEntity = {
  LogicalName: 'account',
  EntitySetName: 'accounts',
  PrimaryIdAttribute: 'accountid'
};
const accountAttributes = {
  value: [
    {
      LogicalName: 'name',
      AttributeType: 'String',
      IsValidForRead: true,
      IsValidForCreate: true,
      IsValidForUpdate: true
    },
    {
      LogicalName: 'accountid',
      AttributeType: 'Uniqueidentifier',
      IsValidForRead: true,
      IsValidForCreate: false,
      IsValidForUpdate: false
    }
  ]
};

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function manualClientData(spec: {
  name: string;
  connectionReferenceLogicalName: string;
  trigger: { kind: 'manual' };
  actions: unknown[];
}) {
  return JSON.stringify({
    properties: {
      connectionReferences: {
        shared_commondataserviceforapps: {
          runtimeSource: 'embedded',
          connection: {
            connectionReferenceLogicalName: spec.connectionReferenceLogicalName
          },
          api: { name: 'shared_commondataserviceforapps' }
        }
      },
      definition: {
        triggers: {
          manual: {
            metadata: { oddy: { schemaVersion: 1, spec } },
            type: 'Request',
            kind: 'Button',
            inputs: { schema: { type: 'object', properties: {}, required: [] } }
          }
        },
        actions: {}
      }
    }
  });
}

beforeEach(() => vi.stubGlobal('window', { location: { origin } }));
afterEach(() => vi.unstubAllGlobals());

describe('Dataverse cloud-flow primitives', () => {
  it('lists modern flows without exposing clientdata', async () => {
    const clientdata = manualClientData({
      name: 'Oddy flow',
      connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
      trigger: { kind: 'manual' },
      actions: []
    });
    const externallyChanged = JSON.parse(clientdata);
    externallyChanged.properties.definition.triggers.manual.kind = 'Http';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        response({
          value: [
            {
              workflowid: '00000000-0000-0000-0000-000000000010',
              name: 'Oddy flow',
              statecode: 0,
              ismanaged: false,
              clientdata,
              '@odata.etag': 'W/"10"'
            },
            {
              workflowid: '00000000-0000-0000-0000-000000000011',
              name: 'Existing flow',
              statecode: 1,
              ismanaged: false,
              clientdata: JSON.stringify(externallyChanged)
            }
          ]
        })
      )
    );

    const result = await executeDataverseFlowPrimitive({
      action: 'list_flows',
      origin,
      top: 20
    });

    expect(result.ok).toBe(true);
    expect(result.flows).toEqual([
      expect.objectContaining({ name: 'Oddy flow', state: 'draft', oddyEditable: true }),
      expect.objectContaining({ name: 'Existing flow', state: 'activated', oddyEditable: false })
    ]);
    expect(JSON.stringify(result)).not.toContain('clientdata');
  });

  it('resolves the current Power Platform environment for designer navigation', async () => {
    const workflowId = '00000000-0000-0000-0000-000000000014';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          workflowid: workflowId,
          name: 'Oddy flow',
          category: 5,
          type: 1,
          statecode: 0,
          ismanaged: false,
          clientdata: '{}'
        })
      )
      .mockResolvedValueOnce(
        response({
          Detail: { EnvironmentId: 'Default-00000000-0000-0000-0000-000000000001' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataverseFlowPrimitive({
      action: 'get_flow_designer_target',
      origin,
      workflowId
    });

    expect(result.flowDesignerTarget).toEqual({
      environmentId: 'Default-00000000-0000-0000-0000-000000000001',
      workflowId,
      flowName: 'Oddy flow'
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('RetrieveCurrentOrganization');
  });

  it('prepares and creates a typed Dataverse-only flow after approval', async () => {
    const workflowId = '00000000-0000-0000-0000-000000000012';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response(accountEntity))
      .mockResolvedValueOnce(response(accountAttributes))
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response(accountEntity))
      .mockResolvedValueOnce(response(accountAttributes))
      .mockResolvedValueOnce(
        response(undefined, 204, {
          'OData-EntityId': `${origin}/api/data/v9.2/workflows(${workflowId})`
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const prepared = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'create',
      spec: {
        name: 'List one account',
        description: 'Created by Oddy',
        connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
        trigger: {
          kind: 'dataverse-row',
          table: 'Accounts',
          change: 'update',
          scope: 'organization'
        },
        actions: [
          {
            id: 'List_accounts',
            kind: 'list-rows',
            table: 'Accounts',
            selectColumns: ['Name'],
            top: 1
          }
        ]
      }
    });

    expect(prepared.ok).toBe(true);
    expect(prepared.flowChange?.after.actions[0]).toEqual(
      expect.objectContaining({ table: 'accounts', selectColumns: ['name'] })
    );
    expect(prepared.flowChange?.warnings.join(' ')).toContain('remain Off');

    const applied = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change: prepared.flowChange!
    });

    expect(applied.flowChangeResult).toEqual({
      operation: 'create',
      workflowId,
      name: 'List one account',
      state: 'draft'
    });
    const createCall = fetchMock.mock.calls[6]!;
    expect(createCall[1]?.method).toBe('POST');
    const body = JSON.parse(String(createCall[1]?.body));
    expect(body).toMatchObject({ category: 5, type: 1, primaryentity: 'none' });
    const clientdata = JSON.parse(body.clientdata);
    expect(
      clientdata.properties.connectionReferences.shared_commondataserviceforapps.connection
        .connectionReferenceLogicalName
    ).toBe('cr_sharedcommondataserviceforapps');
    expect(
      clientdata.properties.definition.triggers.When_a_row_changes.inputs.parameters[
        'subscriptionRequest/entityname'
      ]
    ).toBe('account');
    expect(clientdata.properties.definition.actions.List_accounts.inputs.host.operationId).toBe(
      'ListRecords'
    );
    expect(clientdata.properties.definition.actions.List_accounts.inputs.parameters).toEqual({
      entityName: 'accounts',
      $select: 'name',
      $top: 1
    });
  });

  it('keeps trigger table names logical but uses entity-set names for update actions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(
        response({
          LogicalName: 'contact',
          EntitySetName: 'contacts',
          PrimaryIdAttribute: 'contactid'
        })
      )
      .mockResolvedValueOnce(
        response({
          value: [
            {
              LogicalName: 'contactid',
              AttributeType: 'Uniqueidentifier',
              IsValidForRead: true,
              IsValidForUpdate: false
            },
            {
              LogicalName: 'address1_country',
              AttributeType: 'String',
              IsValidForRead: true,
              IsValidForUpdate: true
            }
          ]
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'create',
      spec: {
        name: 'Update contact country',
        connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
        trigger: {
          kind: 'dataverse-row',
          table: 'contact',
          change: 'update',
          scope: 'organization'
        },
        actions: [
          {
            id: 'Set_country',
            kind: 'update-row',
            table: 'contact',
            rowId: { kind: 'trigger-column', column: 'contactid' },
            values: [
              {
                column: 'address1_country',
                value: { kind: 'literal', value: 'Greece' }
              }
            ]
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.flowChange?.after.trigger).toMatchObject({ table: 'contact' });
    expect(result.flowChange?.after.actions[0]).toMatchObject({ table: 'contacts' });
    const clientdata = JSON.parse(result.flowChange!.generatedClientData);
    expect(
      clientdata.properties.definition.triggers.When_a_row_changes.inputs.parameters[
        'subscriptionRequest/entityname'
      ]
    ).toBe('contact');
    expect(clientdata.properties.definition.actions.Set_country.inputs.parameters.entityName).toBe(
      'contacts'
    );
  });

  it('rejects unsupported lookup writes instead of emitting invalid connector payloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response(accountEntity))
      .mockResolvedValueOnce(
        response({
          value: [
            {
              LogicalName: 'primarycontactid',
              AttributeType: 'Lookup',
              IsValidForRead: true,
              IsValidForCreate: true,
              IsValidForUpdate: true
            }
          ]
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'create',
      spec: {
        name: 'Unsupported lookup flow',
        connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
        trigger: { kind: 'manual' },
        actions: [
          {
            id: 'Create_account',
            kind: 'add-row',
            table: 'account',
            values: [
              {
                column: 'primarycontactid',
                value: { kind: 'literal', value: '00000000-0000-0000-0000-000000000099' }
              }
            ]
          }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported flow-write type Lookup');
  });

  it.each([0, 1])(
    'saves only an unpublished draft with an exact ETag (runtime state %s)',
    async (runtimeState) => {
      const workflowId = '00000000-0000-0000-0000-000000000013';
      const spec = {
        name: 'Existing draft',
        connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
        trigger: { kind: 'manual' as const },
        actions: []
      };
      const flow = {
        workflowid: workflowId,
        name: spec.name,
        statecode: runtimeState,
        componentstate: 1,
        ismanaged: false,
        clientdata: manualClientData(spec),
        '@odata.etag': 'W/"draft-1"'
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(connectionReferences))
        .mockResolvedValueOnce(response(flow))
        .mockResolvedValueOnce(response(connectionReferences))
        .mockResolvedValueOnce(response(flow))
        .mockResolvedValueOnce(response(undefined, 204));
      vi.stubGlobal('fetch', fetchMock);
      const prepared = await executeDataverseFlowPrimitive({
        action: 'prepare_flow_change',
        origin,
        operation: 'update',
        workflowId,
        spec: { ...spec, name: 'Fixed draft' }
      });
      expect(prepared.ok).toBe(true);
      expect(prepared.flowChange?.saveMode).toBe('draft');
      expect(prepared.flowChange?.before?.componentState).toBe(1);
      expect(prepared.flowChange?.warnings.join(' ')).toContain('does not publish');
      const result = await executeDataverseFlowPrimitive({
        action: 'execute_flow_change',
        origin,
        change: prepared.flowChange!
      });
      expect(result.flowChangeResult).toMatchObject({
        savedAs: 'unpublished-draft',
        state: runtimeState === 1 ? 'activated' : 'draft'
      });
      for (const index of [1, 3]) {
        const options = fetchMock.mock.calls[index]![1] as RequestInit;
        expect(new Headers(options.headers).get('MSCRM.IncludeUnpublished')).toBe('true');
      }
      const patch = fetchMock.mock.calls[4]![1] as RequestInit;
      expect(patch.method).toBe('PATCH');
      expect(new Headers(patch.headers).get('MSCRM.AsUnpublished')).toBe('true');
      expect(new Headers(patch.headers).get('If-Match')).toBe('W/"draft-1"');
      expect(new Headers(patch.headers).has('MSCRM.SkipComponentVersioning')).toBe(false);
      const body = JSON.parse(String(patch.body));
      expect(Object.keys(body).sort()).toEqual(['clientdata', 'description', 'name']);
      expect(body.name).toBe('Fixed draft');
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(fetchMock.mock.calls.some(([url]) => /Publish|Activate/.test(String(url)))).toBe(
        false
      );
    }
  );

  it.each([
    ['missing draft consent', 'legacy'],
    ['managed draft', 'managed'],
    ['unrecognized draft', 'unsupported'],
    ['changed component state', 'component-change'],
    ['server version conflict', 'conflict'],
    ['server draft-save failure', 'draft-error']
  ])('does not publish or retry after %s', async (_label, scenario) => {
    const workflowId = '00000000-0000-0000-0000-000000000013';
    const spec = {
      name: 'Existing draft',
      connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
      trigger: { kind: 'manual' as const },
      actions: []
    };
    const flow = {
      workflowid: workflowId,
      name: spec.name,
      statecode: 0,
      componentstate: 1,
      ismanaged: false,
      clientdata: manualClientData(spec),
      '@odata.etag': 'W/"1"'
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response(flow));
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'update',
      workflowId,
      spec: { ...spec, name: 'Fixed draft' }
    });
    expect(prepared.ok).toBe(true);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(
        response({
          ...flow,
          ...(scenario === 'managed' ? { ismanaged: true } : {}),
          ...(scenario === 'unsupported' ? { clientdata: '{}' } : {}),
          ...(scenario === 'component-change' ? { componentstate: 0 } : {})
        })
      )
      .mockResolvedValueOnce(
        response(
          {
            error: {
              message:
                scenario === 'conflict' ? 'Precondition failed' : 'Unpublished context rejected'
            }
          },
          scenario === 'conflict' ? 412 : 400
        )
      );
    const change = { ...prepared.flowChange! };
    if (scenario === 'legacy') delete change.saveMode;
    const result = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change
    });
    expect(result.ok).toBe(false);
    const writes = fetchMock.mock.calls.filter(
      ([, options]) => (options as RequestInit)?.method === 'PATCH'
    );
    expect(writes).toHaveLength(['conflict', 'draft-error'].includes(scenario) ? 1 : 0);
    expect(fetchMock.mock.calls.some(([url]) => /Publish|Activate/.test(String(url)))).toBe(false);
    if (scenario === 'legacy') expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a stale Oddy-created flow update', async () => {
    const workflowId = '00000000-0000-0000-0000-000000000013';
    const spec = {
      name: 'Oddy flow',
      connectionReferenceLogicalName: 'cr_sharedcommondataserviceforapps',
      trigger: { kind: 'manual' as const },
      actions: []
    };
    const clientdata = manualClientData(spec);
    const flow = {
      workflowid: workflowId,
      name: spec.name,
      statecode: 1,
      ismanaged: false,
      clientdata,
      '@odata.etag': 'W/"1"'
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response(flow))
      .mockResolvedValueOnce(response(connectionReferences))
      .mockResolvedValueOnce(response({ ...flow, '@odata.etag': 'W/"2"' }));
    vi.stubGlobal('fetch', fetchMock);

    const prepared = await executeDataverseFlowPrimitive({
      action: 'prepare_flow_change',
      origin,
      operation: 'update',
      workflowId,
      spec: { ...spec, name: 'Renamed Oddy flow' }
    });
    const applied = await executeDataverseFlowPrimitive({
      action: 'execute_flow_change',
      origin,
      change: prepared.flowChange!
    });

    expect(applied.ok).toBe(false);
    expect(applied.error).toContain('changed after this preview');
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });
});
