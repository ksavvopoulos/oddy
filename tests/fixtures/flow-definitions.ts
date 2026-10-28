import type { PreparedDataverseFlowDefinitionChange } from '../../lib/flows/contracts';

export const flowOrigin = 'https://contoso.crm.dynamics.com';
export const existingWorkflowId = '919da3e3-a5d2-f111-a05c-6045bd86f519';
const clientData = {
  schemaVersion: '1.0.0.0',
  properties: {
    designerMetadata: { preserved: true },
    connectionReferences: {
      dataverse: {
        runtimeSource: 'embedded',
        connection: { connectionReferenceLogicalName: 'cr_dataverse' },
        api: { name: 'shared_commondataserviceforapps' }
      }
    },
    definition: {
      parameters: { $authentication: { type: 'SecureObject' } },
      triggers: {
        On_contact_changed: {
          type: 'OpenApiConnectionWebhook',
          inputs: {
            host: { connectionName: 'dataverse', operationId: 'SubscribeWebhookTrigger' },
            parameters: { 'subscriptionRequest/entityname': 'contact' }
          },
          metadata: { operationMetadataId: 'designer-trigger-id' }
        }
      },
      actions: {
        If_Patras: {
          type: 'If',
          expression: { equals: ["@triggerOutputs()?['body/address1_city']", 'Patras'] },
          runAfter: {},
          actions: {
            Set_Country_Greece: {
              type: 'OpenApiConnection',
              inputs: {
                host: { connectionName: 'dataverse', operationId: 'UpdateOnlyRecord' },
                parameters: {
                  entityName: 'contact',
                  recordId: "@triggerOutputs()?['body/contactid']",
                  'item/address1_country': 'Greece'
                }
              },
              metadata: { operationMetadataId: 'designer-action-id' },
              runAfter: {}
            }
          },
          else: { actions: {} }
        },
        Audit: {
          type: 'Compose',
          inputs: 'Preserve this unrelated action',
          runAfter: { If_Patras: ['Succeeded'] }
        }
      },
      outputs: { preserved: { type: 'String', value: 'original' } }
    }
  }
};

export const beforeDefinition = {
  name: 'Contact - Set country to Greece for Patras',
  description: 'Existing flow created outside Oddy',
  clientData: JSON.stringify(clientData)
};
const revised = JSON.parse(beforeDefinition.clientData);
revised.properties.definition.actions.If_Patras.actions.Set_Country_Greece.inputs.parameters.entityName =
  'contacts';
// A general edit is not restricted to fixing entityName: add logic and expressions too.
revised.properties.definition.actions.Repeat_audit = {
  type: 'Foreach',
  foreach: '@createArray(1, 2)',
  runAfter: { Audit: ['Succeeded'] },
  actions: { Compose_item: { type: 'Compose', inputs: '@item()', runAfter: {} } }
};
export const afterDefinition = {
  ...beforeDefinition,
  name: 'Contact country and audit',
  clientData: JSON.stringify(revised)
};
export const existingFlow = {
  workflowid: existingWorkflowId,
  name: beforeDefinition.name,
  description: beforeDefinition.description,
  category: 5,
  type: 1,
  statecode: 1,
  componentstate: 1,
  ismanaged: false,
  clientdata: beforeDefinition.clientData,
  '@odata.etag': 'W/"existing-1"'
};

export const definitionProposal: PreparedDataverseFlowDefinitionChange = {
  mode: 'definition',
  id: 'definition-proposal',
  operation: 'update',
  environmentOrigin: flowOrigin,
  workflowId: existingWorkflowId,
  etag: existingFlow['@odata.etag'],
  before: {
    workflowId: existingWorkflowId,
    name: beforeDefinition.name,
    description: beforeDefinition.description,
    state: 'activated',
    isManaged: false,
    oddyEditable: true,
    componentState: 1,
    etag: existingFlow['@odata.etag'],
    definition: beforeDefinition
  },
  after: afterDefinition,
  generatedClientData: afterDefinition.clientData,
  saveMode: 'draft',
  warnings: ['Save an unpublished draft only; not published or activated.']
};
