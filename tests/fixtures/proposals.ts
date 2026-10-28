import type {
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange
} from '../../lib/types';
import type { PreparedDataverseFlowChange } from '../../lib/flows/contracts';
import type { StoredConversation } from '../../lib/conversation-model';

export const recordProposal: PreparedDataverseMutation = {
  id: 'record-proposal',
  operation: 'create',
  environmentOrigin: 'https://contoso.crm.dynamics.com',
  tableLogicalName: 'contact',
  recordName: 'Ada Lovelace',
  fields: [{ requestedName: 'firstname', logicalName: 'firstname', proposedValue: 'Ada' }]
};

export const membershipProposal: PreparedMarketingListMembership = {
  id: 'membership-proposal',
  environmentOrigin: recordProposal.environmentOrigin,
  listId: '00000000-0000-0000-0000-000000000100',
  listName: 'Test list',
  listEntitySetName: 'lists',
  memberTableLogicalName: 'contact',
  memberObjectTypeCode: 2,
  members: [
    {
      tableLogicalName: 'contact',
      primaryIdAttribute: 'contactid',
      recordId: '00000000-0000-0000-0000-000000000101',
      recordName: 'Ada Lovelace'
    }
  ],
  alreadyMembers: [],
  actionSignature: {
    name: 'AddListMembersList',
    isBound: false,
    parameters: [
      { name: 'List', type: 'mscrm.list' },
      { name: 'Members', type: 'Collection(mscrm.crmbaseentity)' }
    ]
  }
};

const flowClientData = JSON.stringify({
  schemaVersion: '1.0.0.0',
  properties: {
    connectionReferences: {},
    definition: {
      triggers: {
        manual: {
          type: 'Request',
          kind: 'Button',
          inputs: { schema: { type: 'object', properties: {} } }
        }
      },
      actions: { Compose: { type: 'Compose', inputs: 'Hello', runAfter: {} } }
    }
  }
});
export const flowProposal: PreparedDataverseFlowChange = {
  mode: 'definition',
  id: 'flow-proposal',
  operation: 'create',
  environmentOrigin: recordProposal.environmentOrigin,
  after: { name: 'Oddy test flow', clientData: flowClientData },
  generatedClientData: flowClientData,
  warnings: ['The new flow will remain Off until it is activated separately.']
};

export const skillProposal: PreparedOddySkillChange = {
  id: 'skill-proposal',
  skillId: 'test-skill',
  operation: 'delete'
};

export function conversationFixture(
  overrides: Partial<StoredConversation> = {}
): StoredConversation {
  return {
    id: 'conversation',
    title: 'Create a contact',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    transcript: [
      { id: 'user', role: 'user', content: 'Create a contact' },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Awaiting approval.',
        pendingMutations: [recordProposal],
        pendingListMemberships: [membershipProposal],
        pendingSkillChanges: [skillProposal]
      }
    ],
    mutationApprovals: {
      [recordProposal.id]: { status: 'pending', selectedColumns: ['firstname'] }
    },
    listMembershipApprovals: {
      [membershipProposal.id]: {
        status: 'pending',
        selectedMemberIds: [membershipProposal.members[0]!.recordId]
      }
    },
    skillChangeApprovals: { [skillProposal.id]: { status: 'pending' } },
    ...overrides
  };
}
