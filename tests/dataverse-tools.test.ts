import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataversePrimitive } from '../lib/dataverse-primitives';

afterEach(() => vi.unstubAllGlobals());

describe('Dataverse structured primitives', () => {
  it('resolves table and column display names', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'contact',
            EntitySetName: 'contacts',
            PrimaryIdAttribute: 'contactid',
            PrimaryNameAttribute: 'fullname',
            ObjectTypeCode: 2
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                LogicalName: 'fullname',
                AttributeType: 'String',
                IsValidForRead: true,
                DisplayName: { UserLocalizedLabel: { Label: 'Full Name' } }
              },
              {
                LogicalName: 'new_registrationstoreid',
                AttributeType: 'Lookup',
                IsValidForRead: true,
                DisplayName: { UserLocalizedLabel: { Label: 'Registration Store' } }
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              { LogicalName: 'new_registrationstoreid', Targets: ['account'] }
            ]
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'resolve_schema',
      origin: 'https://contoso.crm.dynamics.com',
      table: 'contacts',
      columns: ['Full Name', 'Registration Store']
    });

    expect(result.ok).toBe(true);
    expect(result.entity?.logicalName).toBe('contact');
    expect(result.resolvedColumns?.map((column) => column.logicalName)).toEqual([
      'fullname',
      'new_registrationstoreid'
    ]);
    expect(result.resolvedColumns?.[1]?.targets).toEqual(['account']);
  });

  it('compiles and executes a filtered, sorted record query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'contact',
            EntitySetName: 'contacts',
            PrimaryIdAttribute: 'contactid',
            PrimaryNameAttribute: 'fullname',
            ObjectTypeCode: 2
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                LogicalName: 'fullname',
                IsValidForRead: true,
                DisplayName: { UserLocalizedLabel: { Label: 'Full Name' } }
              },
              {
                LogicalName: 'new_registrationstoreid',
                IsValidForRead: true,
                DisplayName: { UserLocalizedLabel: { Label: 'Registration Store' } }
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                contactid: '00000000-0000-0000-0000-000000000001',
                fullname: 'Linda Cook',
                new_registrationstoreid: 'store-1'
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ recordcount: 1 }] }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'query_records',
      origin: 'https://contoso.crm.dynamics.com',
      query: {
        table: 'contacts',
        columns: ['Full Name', 'Registration Store'],
        filters: [{ column: 'Registration Store', operator: 'not-null' }],
        orderBy: [{ column: 'Full Name', direction: 'asc' }],
        top: 5
      }
    });

    expect(result.ok).toBe(true);
    expect(result.totalCount).toBe(1);
    expect(result.query).toEqual({
      table: 'contact',
      columns: ['fullname', 'new_registrationstoreid'],
      filters: [{ column: 'new_registrationstoreid', operator: 'not-null' }],
      orderBy: [{ column: 'fullname', direction: 'asc' }],
      top: 5
    });
    expect(result.fetchXml).toContain(
      '<condition attribute="new_registrationstoreid" operator="not-null" />'
    );
    expect(result.fetchXml).toContain('<order attribute="fullname" descending="false" />');
    expect(result.fetchXml).toContain('<fetch top="5"');
    expect(result.fetchXml).not.toContain('returntotalrecordcount');
    expect(result.fetchXml).not.toContain(' page=');
    expect(result.fetchXml).not.toContain(' count=');
    expect(result.fetchXml).not.toContain('paging-cookie');
  });

  it('uses top without paging or total-count attributes for the newest scenario', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'sieben_scenarios',
            EntitySetName: 'sieben_scenarioses',
            PrimaryIdAttribute: 'sieben_scenariosid',
            PrimaryNameAttribute: 'sieben_name',
            ObjectTypeCode: 10001
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              { LogicalName: 'sieben_scenariosid', IsValidForRead: true },
              { LogicalName: 'sieben_name', IsValidForRead: true },
              { LogicalName: 'createdon', IsValidForRead: true }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                sieben_scenariosid: '00000000-0000-0000-0000-000000000001',
                sieben_name: 'Latest scenario',
                createdon: '2026-10-22T10:00:00Z'
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ recordcount: 7 }] }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'query_records',
      origin: 'https://contoso.crm.dynamics.com',
      query: {
        table: 'sieben_scenarios',
        columns: ['sieben_name', 'createdon'],
        orderBy: [{ column: 'createdon', direction: 'desc' }],
        top: 1
      }
    });

    expect(result.ok).toBe(true);
    expect(result.records?.length).toBeLessThanOrEqual(1);
    expect(result.totalCount).toBe(7);
    expect(result.fetchXml).toContain('<fetch top="1"');
    expect(result.fetchXml).toContain('<order attribute="createdon" descending="true" />');
    expect(result.fetchXml).not.toContain('returntotalrecordcount');
    expect(result.fetchXml).not.toMatch(/\spage=/i);
    expect(result.fetchXml).not.toMatch(/\scount=/i);
    expect(result.fetchXml).not.toContain('paging-cookie');
  });

  it('discovers a direct relationship in either direction', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'contact',
            EntitySetName: 'contacts',
            PrimaryIdAttribute: 'contactid'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            LogicalName: 'invoice',
            EntitySetName: 'invoices',
            PrimaryIdAttribute: 'invoiceid'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                SchemaName: 'contact_invoices',
                ReferencedEntity: 'contact',
                ReferencingEntity: 'invoice',
                ReferencingAttribute: 'customerid',
                ReferencedEntityNavigationPropertyName: 'contact_invoices',
                ReferencingEntityNavigationPropertyName: 'customerid_contact'
              }
            ]
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'discover_relationships',
      origin: 'https://contoso.crm.dynamics.com',
      sourceTable: 'contact',
      targetTable: 'invoice'
    });

    expect(result.ok).toBe(true);
    expect(result.relationships).toEqual([
      expect.objectContaining({
        schemaName: 'contact_invoices',
        lookupColumn: 'customerid',
        direction: 'source-parent'
      })
    ]);
  });

  it('creates AI Result from a complete structured query', async () => {
    const entityMetadata = {
      LogicalName: 'contact',
      EntitySetName: 'contacts',
      PrimaryIdAttribute: 'contactid',
      PrimaryNameAttribute: 'fullname',
      ObjectTypeCode: 2
    };
    const attributes = {
      value: [
        { LogicalName: 'contactid', IsValidForRead: true },
        {
          LogicalName: 'fullname',
          IsValidForRead: true,
          DisplayName: { UserLocalizedLabel: { Label: 'Full Name' } }
        },
        {
          LogicalName: 'new_registrationstoreid',
          IsValidForRead: true,
          DisplayName: { UserLocalizedLabel: { Label: 'Registration Store' } }
        }
      ]
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(entityMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ userqueryid: '00000000-0000-0000-0000-000000000099' }), {
          status: 201
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin: 'https://contoso.crm.dynamics.com',
      query: {
        table: 'contacts',
        columns: ['Full Name', 'Registration Store'],
        filters: [{ column: 'Registration Store', operator: 'not-null' }],
        orderBy: [{ column: 'Full Name', direction: 'asc' }]
      },
      layoutColumns: ['Full Name', 'Registration Store']
    });

    expect(result.ok).toBe(true);
    expect(result.view).toEqual(
      expect.objectContaining({
        id: '00000000-0000-0000-0000-000000000099',
        name: 'AI Result',
        tableLogicalName: 'contact',
        created: true
      })
    );
    const createBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
    expect(createBody.fetchxml).toContain('attribute="new_registrationstoreid"');
    expect(createBody.layoutxml).toContain('name="new_registrationstoreid"');
  });

  it('reuses the oldest AI Result personal view for the same entity', async () => {
    const entityMetadata = {
      LogicalName: 'contact',
      EntitySetName: 'contacts',
      PrimaryIdAttribute: 'contactid',
      PrimaryNameAttribute: 'fullname',
      ObjectTypeCode: 2
    };
    const attributes = {
      value: [
        { LogicalName: 'contactid', IsValidForRead: true },
        { LogicalName: 'fullname', IsValidForRead: true }
      ]
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(entityMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                userqueryid: 'invoice-view',
                name: 'AI Result',
                returnedtypecode: 'invoice',
                fetchxml: '<fetch><entity name="invoice" /></fetch>'
              },
              {
                userqueryid: 'contact-view',
                name: 'AI Result',
                returnedtypecode: 'contact',
                fetchxml: '<fetch><entity name="contact" /></fetch>',
                layoutxml: '<grid><row /></grid>'
              }
            ]
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'upsert_view',
      origin: 'https://contoso.crm.dynamics.com',
      query: {
        table: 'contact',
        columns: ['fullname'],
        orderBy: [{ column: 'fullname', direction: 'asc' }]
      },
      layoutColumns: ['fullname']
    });

    expect(result.ok).toBe(true);
    expect(result.view).toEqual(
      expect.objectContaining({
        id: 'contact-view',
        name: 'AI Result',
        tableLogicalName: 'contact',
        created: false
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[4]?.[1]?.method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain('userqueries(contact-view)');
  });

  it('prepares an update preview without writing business data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          LogicalName: 'contact',
          EntitySetName: 'contacts',
          PrimaryIdAttribute: 'contactid',
          PrimaryNameAttribute: 'fullname',
          DisplayName: { UserLocalizedLabel: { Label: 'Contact' } }
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [
          { LogicalName: 'fullname', AttributeType: 'String', IsValidForRead: true, IsValidForUpdate: true },
          { LogicalName: 'address1_line1', AttributeType: 'String', IsValidForRead: true, IsValidForUpdate: true, DisplayName: { UserLocalizedLabel: { Label: 'Street 1' } } },
          { LogicalName: 'address1_city', AttributeType: 'String', IsValidForRead: true, IsValidForUpdate: true, DisplayName: { UserLocalizedLabel: { Label: 'City' } } }
        ] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          '@odata.etag': 'W/"42"',
          fullname: 'Linda Cook',
          address1_line1: 'Old Street',
          address1_city: 'Athens'
        }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'prepare_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: {
        operation: 'update',
        table: 'contact',
        recordId: '00000000-0000-0000-0000-000000000001',
        values: [
          { column: 'Street 1', value: 'Papaflessa 13' },
          { column: 'City', value: 'Patra' }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.mutation).toEqual(expect.objectContaining({
      operation: 'update',
      environmentOrigin: 'https://contoso.crm.dynamics.com',
      tableLogicalName: 'contact',
      recordName: 'Linda Cook',
      etag: 'W/"42"'
    }));
    expect(result.mutation?.fields).toEqual([
      expect.objectContaining({ logicalName: 'address1_line1', currentValue: 'Old Street', proposedValue: 'Papaflessa 13' }),
      expect.objectContaining({ logicalName: 'address1_city', currentValue: 'Athens', proposedValue: 'Patra' })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((call) => !['PATCH', 'POST'].includes(String(call[1]?.method)))).toBe(true);
  });

  it('applies only approved update fields with optimistic concurrency', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          LogicalName: 'contact',
          EntitySetName: 'contacts',
          PrimaryIdAttribute: 'contactid',
          PrimaryNameAttribute: 'fullname'
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [
          { LogicalName: 'address1_line1', AttributeType: 'String', IsValidForRead: true, IsValidForUpdate: true },
          { LogicalName: 'address1_city', AttributeType: 'String', IsValidForRead: true, IsValidForUpdate: true }
        ] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'execute_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: {
        id: 'proposal-1',
        operation: 'update',
        environmentOrigin: 'https://contoso.crm.dynamics.com',
        tableLogicalName: 'contact',
        recordId: '00000000-0000-0000-0000-000000000001',
        recordName: 'Linda Cook',
        etag: 'W/"42"',
        fields: [
          { requestedName: 'Street 1', logicalName: 'address1_line1', proposedValue: 'Papaflessa 13' },
          { requestedName: 'City', logicalName: 'address1_city', proposedValue: 'Patra' }
        ]
      },
      selectedColumns: ['address1_city']
    });

    expect(result.ok).toBe(true);
    expect(result.mutationResult?.changedColumns).toEqual(['address1_city']);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual(expect.objectContaining({ 'If-Match': 'W/"42"' }));
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ address1_city: 'Patra' });
  });

  it('resolves a Choice label to its numeric Dataverse option value', async () => {
    const entityMetadata = {
      LogicalName: 'sieben_scenarios',
      EntitySetName: 'sieben_scenarioses',
      PrimaryIdAttribute: 'sieben_scenariosid',
      PrimaryNameAttribute: 'sieben_name'
    };
    const attributes = {
      value: [
        { LogicalName: 'sieben_name', AttributeType: 'String', IsValidForRead: true, IsValidForCreate: true },
        { LogicalName: 'sieben_sendmethod', AttributeType: 'Picklist', IsValidForRead: true, IsValidForCreate: true, DisplayName: { UserLocalizedLabel: { Label: 'Send Method' } } }
      ]
    };
    const optionMetadata = {
      OptionSet: {
        Options: [
          { Value: 100000000, Label: { UserLocalizedLabel: { Label: 'Email' } } },
          { Value: 100000001, Label: { UserLocalizedLabel: { Label: 'SMS' } } }
        ]
      }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(entityMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(optionMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(entityMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(optionMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sieben_scenariosid: '00000000-0000-0000-0000-000000000030',
        sieben_name: 'oddy3'
      }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const preview = await executeDataversePrimitive({
      action: 'prepare_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: {
        operation: 'create',
        table: 'sieben_scenarios',
        values: [
          { column: 'sieben_name', value: 'oddy3' },
          { column: 'Send Method', value: 'Email' }
        ]
      }
    });

    expect(preview.ok).toBe(true);
    expect(preview.mutation?.fields[1]).toEqual(expect.objectContaining({
      logicalName: 'sieben_sendmethod',
      proposedValue: 100000000,
      proposedFormattedValue: 'Email'
    }));

    const applied = await executeDataversePrimitive({
      action: 'execute_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: preview.mutation!,
      selectedColumns: ['sieben_name', 'sieben_sendmethod']
    });

    expect(applied.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toEqual({
      sieben_name: 'oddy3',
      sieben_sendmethod: 100000000
    });
  });

  it('previews and applies multiple marketing-list members with one AddListMembersList action', async () => {
    const listMetadata = {
      LogicalName: 'list',
      EntitySetName: 'lists',
      PrimaryIdAttribute: 'listid',
      PrimaryNameAttribute: 'listname',
      ObjectTypeCode: 4300
    };
    const listAttributes = {
      value: [
        { LogicalName: 'listid', AttributeType: 'Uniqueidentifier', IsValidForRead: true },
        { LogicalName: 'listname', AttributeType: 'String', IsValidForRead: true },
        { LogicalName: 'type', AttributeType: 'Boolean', IsValidForRead: true },
        { LogicalName: 'createdfromcode', AttributeType: 'Picklist', IsValidForRead: true }
      ]
    };
    const listRecord = {
      listid: '07c003e9-58d0-f111-a05c-000d3a285a7f',
      listname: 'oddy test',
      type: false,
      createdfromcode: 2,
      'createdfromcode@OData.Community.Display.V1.FormattedValue': 'Contact'
    };
    const contactMetadata = {
      LogicalName: 'contact',
      EntitySetName: 'contacts',
      PrimaryIdAttribute: 'contactid',
      PrimaryNameAttribute: 'fullname',
      ObjectTypeCode: 2,
      DisplayCollectionName: { UserLocalizedLabel: { Label: 'Contacts' } }
    };
    const contacts = {
      value: [
        { contactid: '00000000-0000-0000-0000-000000000101', fullname: 'Ada Lovelace' },
        { contactid: '00000000-0000-0000-0000-000000000102', fullname: 'Grace Hopper' }
      ]
    };
    const listMemberMetadata = {
      LogicalName: 'listmember',
      EntitySetName: 'listmembers',
      PrimaryIdAttribute: 'listmemberid',
      PrimaryNameAttribute: 'name'
    };
    const listMemberAttributes = {
      value: [
        { LogicalName: 'listid', AttributeType: 'Lookup', IsValidForRead: true },
        { LogicalName: 'entityid', AttributeType: 'Lookup', IsValidForRead: true }
      ]
    };
    const metadataXml = `<?xml version="1.0"?>
      <Schema Namespace="Microsoft.Dynamics.CRM">
        <Action Name="AddListMembersList" IsBound="false">
          <Parameter Name="List" Type="mscrm.list" />
          <Parameter Name="Members" Type="Collection(mscrm.crmbaseentity)" />
        </Action>
      </Schema>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(listMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listRecord), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(contactMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(contacts), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listMemberMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listMemberAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(metadataXml, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listRecord), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(contactMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(contacts), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listMemberMetadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listMemberAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(metadataXml, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const preview = await executeDataversePrimitive({
      action: 'prepare_list_membership',
      origin: 'https://contoso.crm.dynamics.com',
      listId: listRecord.listid,
      members: [
        { table: 'contact', recordId: contacts.value[0]!.contactid },
        { table: 'contact', recordId: contacts.value[1]!.contactid }
      ]
    });

    expect(preview.ok).toBe(true);
    expect(preview.listMembership).toEqual(expect.objectContaining({
      listName: 'oddy test',
      memberTableLogicalName: 'contact'
    }));
    expect(preview.listMembership?.members.map((member) => member.recordName)).toEqual([
      'Ada Lovelace',
      'Grace Hopper'
    ]);

    const applied = await executeDataversePrimitive({
      action: 'execute_list_membership',
      origin: 'https://contoso.crm.dynamics.com',
      membership: preview.listMembership!,
      selectedMemberIds: preview.listMembership!.members.map((member) => member.recordId)
    });

    expect(applied.ok).toBe(true);
    expect(applied.listMembershipResult?.addedMemberIds).toHaveLength(2);
    // Both preparation and approval-time revalidation must negotiate XML.
    const metadataCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/$metadata'));
    expect(metadataCalls).toHaveLength(2);
    for (const [, options] of metadataCalls) {
      const requestHeaders = new Headers(options?.headers);
      expect(requestHeaders.get('Accept')).toBe('application/xml');
      expect(requestHeaders.has('Content-Type')).toBe(false);
      expect(requestHeaders.get('OData-Version')).toBe('4.0');
      expect(options?.credentials).toBe('include');
    }
    expect(new Headers(fetchMock.mock.calls[18]?.[1]?.headers).get('Accept')).toBe('application/json');
    expect(fetchMock.mock.calls[18]?.[0]).toBe(
      'https://contoso.crm.dynamics.com/api/data/v9.2/AddListMembersList'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[18]?.[1]?.body))).toEqual({
      List: {
        listid: listRecord.listid,
        '@odata.type': 'Microsoft.Dynamics.CRM.list'
      },
      Members: [
        {
          contactid: contacts.value[0]!.contactid,
          '@odata.type': 'Microsoft.Dynamics.CRM.contact'
        },
        {
          contactid: contacts.value[1]!.contactid,
          '@odata.type': 'Microsoft.Dynamics.CRM.contact'
        }
      ]
    });
  });

  it('rejects manual membership preparation for a dynamic marketing list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        LogicalName: 'list',
        EntitySetName: 'lists',
        PrimaryIdAttribute: 'listid',
        PrimaryNameAttribute: 'listname'
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [
          { LogicalName: 'listname', AttributeType: 'String', IsValidForRead: true },
          { LogicalName: 'type', AttributeType: 'Boolean', IsValidForRead: true },
          { LogicalName: 'createdfromcode', AttributeType: 'Picklist', IsValidForRead: true }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        listid: '07c003e9-58d0-f111-a05c-000d3a285a7f',
        listname: 'Dynamic list',
        type: true,
        createdfromcode: 2
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'prepare_list_membership',
      origin: 'https://contoso.crm.dynamics.com',
      listId: '07c003e9-58d0-f111-a05c-000d3a285a7f',
      members: [{ table: 'contact', recordId: '00000000-0000-0000-0000-000000000101' }]
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('static marketing list');
  });

  it('previews and applies a single-record lookup using its navigation property', async () => {
    const sourceEntity = {
      LogicalName: 'sieben_scenarios',
      EntitySetName: 'sieben_scenarioses',
      PrimaryIdAttribute: 'sieben_scenariosid',
      PrimaryNameAttribute: 'sieben_name'
    };
    const sourceAttributes = {
      value: [
        { LogicalName: 'sieben_name', AttributeType: 'String', IsValidForRead: true, IsValidForCreate: true },
        { LogicalName: 'sieben_sender', AttributeType: 'Lookup', IsValidForRead: true, IsValidForCreate: true, DisplayName: { UserLocalizedLabel: { Label: 'Sender' } } }
      ]
    };
    const targetEntity = {
      LogicalName: 'sieben_senderaccount',
      EntitySetName: 'sieben_senderaccounts',
      PrimaryIdAttribute: 'sieben_senderaccountid',
      PrimaryNameAttribute: 'sieben_name'
    };
    const lookupTargets = {
      value: [{ LogicalName: 'sieben_sender', Targets: ['sieben_senderaccount'] }]
    };
    const relationship = {
      value: [{
        SchemaName: 'sieben_senderaccount_scenarios',
        ReferencedEntity: 'sieben_senderaccount',
        ReferencingEntity: 'sieben_scenarios',
        ReferencingAttribute: 'sieben_sender',
        ReferencingEntityNavigationPropertyName: 'sieben_Sender'
      }]
    };
    const senderId = '00000000-0000-0000-0000-000000000020';
    const scenarioId = '00000000-0000-0000-0000-000000000021';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sourceEntity), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sourceAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(targetEntity), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(lookupTargets), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(relationship), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sieben_senderaccountid: senderId, sieben_name: 'testEmail' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sourceEntity), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sourceAttributes), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(targetEntity), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(lookupTargets), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(relationship), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sieben_senderaccountid: senderId, sieben_name: 'testEmail' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sieben_scenariosid: scenarioId, sieben_name: 'oddy3' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const preview = await executeDataversePrimitive({
      action: 'prepare_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: {
        operation: 'create',
        table: 'sieben_scenarios',
        values: [
          { column: 'sieben_name', value: 'oddy3' },
          {
            column: 'Sender',
            lookup: {
              table: 'sieben_senderaccount',
              recordId: senderId,
              recordName: 'testEmail'
            }
          }
        ]
      }
    });

    expect(preview.ok).toBe(true);
    expect(preview.mutation?.fields[1]).toEqual(expect.objectContaining({
      logicalName: 'sieben_sender',
      proposedValue: expect.objectContaining({ recordId: senderId, recordName: 'testEmail' }),
      lookup: expect.objectContaining({
        tableLogicalName: 'sieben_senderaccount',
        navigationPropertyName: 'sieben_Sender'
      })
    }));

    const applied = await executeDataversePrimitive({
      action: 'execute_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: preview.mutation!,
      selectedColumns: ['sieben_name', 'sieben_sender']
    });

    expect(applied.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[12]?.[1]?.body))).toEqual({
      sieben_name: 'oddy3',
      'sieben_Sender@odata.bind': `/sieben_senderaccounts(${senderId})`
    });
  });

  it('creates a record only after the approved proposal is executed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          LogicalName: 'contact',
          EntitySetName: 'contacts',
          PrimaryIdAttribute: 'contactid',
          PrimaryNameAttribute: 'fullname'
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [
          { LogicalName: 'firstname', AttributeType: 'String', IsValidForRead: true, IsValidForCreate: true },
          { LogicalName: 'lastname', AttributeType: 'String', IsValidForRead: true, IsValidForCreate: true }
        ] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          contactid: '00000000-0000-0000-0000-000000000002',
          fullname: 'Ada Lovelace'
        }), { status: 201 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDataversePrimitive({
      action: 'execute_mutation',
      origin: 'https://contoso.crm.dynamics.com',
      mutation: {
        id: 'proposal-2',
        operation: 'create',
        environmentOrigin: 'https://contoso.crm.dynamics.com',
        tableLogicalName: 'contact',
        recordName: 'Ada Lovelace',
        fields: [
          { requestedName: 'First Name', logicalName: 'firstname', proposedValue: 'Ada' },
          { requestedName: 'Last Name', logicalName: 'lastname', proposedValue: 'Lovelace' }
        ]
      },
      selectedColumns: ['firstname', 'lastname']
    });

    expect(result.ok).toBe(true);
    expect(result.mutationResult).toEqual(expect.objectContaining({
      operation: 'create',
      recordId: '00000000-0000-0000-0000-000000000002',
      recordName: 'Ada Lovelace'
    }));
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      firstname: 'Ada',
      lastname: 'Lovelace'
    });
  });
});
