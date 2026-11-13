import type { SchemaPlan, PreparedSchemaChange, SchemaSolution } from '../../lib/schema/contracts';

export const schemaOrigin = 'https://contoso.crm.dynamics.com';
export const schemaSolution: SchemaSolution = {
  id: '00000000-0000-0000-0000-000000000001',
  uniqueName: 'ExampleSolution',
  displayName: 'Example solution',
  publisherId: '00000000-0000-0000-0000-000000000002',
  prefix: 'new',
  optionValuePrefix: 10000
};
export const schemaSolutionRow = {
  solutionid: schemaSolution.id,
  uniquename: schemaSolution.uniqueName,
  friendlyname: schemaSolution.displayName,
  ismanaged: false,
  publisherid: {
    publisherid: schemaSolution.publisherId,
    customizationprefix: 'new',
    customizationoptionvalueprefix: 10000
  }
};
const yes = { Value: true, CanBeChanged: true };
export const consentOutboxPlan: SchemaPlan = {
  operation: 'create_table',
  solutionUniqueName: schemaSolution.uniqueName,
  languageCode: 1033,
  schemaName: 'new_ConsentOutbox',
  displayName: 'Consent Outbox',
  pluralName: 'Consent Outbox Events',
  ownership: 'OrganizationOwned',
  primaryName: { schemaName: 'new_Name', displayName: 'Name', maxLength: 100 },
  columns: [
    {
      type: 'lookup',
      schemaName: 'new_Contact',
      displayName: 'Contact',
      targetTable: 'contact',
      relationshipSchemaName: 'new_contact_consentoutbox',
      deleteBehavior: 'Restrict'
    },
    {
      type: 'datetime',
      schemaName: 'new_OccurredOn',
      displayName: 'Occurred on',
      dateTimeBehavior: 'UserLocal'
    },
    ...['OldEmailConsent', 'NewEmailConsent', 'OldMobileConsent', 'NewMobileConsent'].map(
      (field) => ({
        type: 'boolean' as const,
        schemaName: `new_${field}`,
        displayName: field,
        falseLabel: 'No',
        trueLabel: 'Yes'
      })
    ),
    {
      type: 'choice',
      schemaName: 'new_ProcessingStatus',
      displayName: 'Processing status',
      choices: ['Pending', 'Failed', 'Success'],
      defaultChoice: 'Pending'
    },
    { type: 'multiline', schemaName: 'new_Error', displayName: 'Error', maxLength: 10000 }
  ]
};
export const schemaTable = {
  '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
  MetadataId: '00000000-0000-0000-0000-000000000003',
  LogicalName: 'new_example',
  SchemaName: 'new_Example',
  OwnershipType: 'UserOwned',
  IsCustomEntity: true,
  IsManaged: false,
  IsCustomizable: yes,
  IsRenameable: yes,
  IsActivity: false,
  IsIntersect: false,
  DataProviderId: null,
  CanCreateAttributes: yes,
  DisplayName: {
    LocalizedLabels: [
      { Label: 'Example', LanguageCode: 1033 },
      { Label: 'Παράδειγμα', LanguageCode: 1032 }
    ]
  },
  Description: { LocalizedLabels: [{ Label: 'Original description', LanguageCode: 1033 }] },
  IsAuditEnabled: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'audit' },
  Attributes: [
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
      MetadataId: '00000000-0000-0000-0000-000000000004',
      LogicalName: 'new_name',
      SchemaName: 'new_Name',
      AttributeType: 'String',
      IsCustomAttribute: true,
      IsManaged: false,
      IsCustomizable: yes,
      IsRenameable: yes,
      IsPrimaryId: false,
      IsPrimaryName: true,
      AttributeOf: null,
      SourceType: 0,
      RequiredLevel: { Value: 'None', CanBeChanged: true },
      CanModifyAdditionalSettings: yes,
      MaxLength: 100,
      FormatName: { Value: 'Text' },
      DisplayName: {
        LocalizedLabels: [
          { Label: 'Name', LanguageCode: 1033 },
          { Label: 'Όνομα', LanguageCode: 1032 }
        ]
      },
      Description: { LocalizedLabels: [{ Label: 'Name of example', LanguageCode: 1033 }] },
      UnrelatedSetting: 'preserve-me'
    }
  ],
  OneToManyRelationships: [],
  ManyToOneRelationships: [],
  ManyToManyRelationships: [],
  Privileges: []
};
export const createSchemaTablePlan: SchemaPlan = {
  operation: 'create_table',
  solutionUniqueName: schemaSolution.uniqueName,
  languageCode: 1033,
  schemaName: 'new_Order',
  displayName: 'Order',
  pluralName: 'Orders',
  ownership: 'UserOwned',
  primaryName: { schemaName: 'new_Name', displayName: 'Order name', maxLength: 100 }
};
export const schemaProposal: PreparedSchemaChange = {
  mode: 'schema-v2',
  id: 'schema-proposal',
  environmentOrigin: schemaOrigin,
  plan: createSchemaTablePlan,
  solution: schemaSolution,
  tableLogicalName: 'new_order',
  after: { SchemaName: 'new_Order', OwnershipType: 'UserOwned' },
  steps: [
    {
      kind: 'table',
      components: ['new_order', 'new_order.new_name'],
      method: 'POST',
      path: 'EntityDefinitions',
      body: { SchemaName: 'new_Order', OwnershipType: 'UserOwned' }
    }
  ],
  referenceRevisions: {},
  warnings: ['No publish request is included.']
};
