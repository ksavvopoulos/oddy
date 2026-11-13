import { describe, expect, it } from 'vitest';
import { bulkSummary } from './fixtures/bulk';
import { schemaProposal, consentOutboxPlan } from './fixtures/schema';
import {
  conversationMessages,
  restoreConversation,
  type StoredConversation
} from '../lib/conversation-model';
import {
  conversationFixture,
  recordProposal,
  membershipProposal,
  skillProposal
} from './fixtures/proposals';

describe('conversation model', () => {
  it('keeps structured schema draft decisions in context without treating a preview as execution', () => {
    const messages = conversationMessages([
      {
        id: 'schema',
        role: 'assistant',
        content: 'Review this proposal.',
        pendingSchemaChanges: [{ ...schemaProposal, plan: consentOutboxPlan }]
      }
    ]);
    expect(messages[0]?.content).toContain('NOT proof of execution');
    expect(messages[0]?.content).toContain('OrganizationOwned');
    expect(messages[0]?.content).toContain('new_ProcessingStatus');
    expect(messages[0]?.content).not.toContain('RelationshipDefinitions');
    expect(messages[0]?.content).not.toContain('referenceRevisions');
  });

  it('restores every proposal kind as read-only and preserves saved selections', () => {
    const original = conversationFixture();
    const restored = restoreConversation(original);
    expect(restored.transcript.every((item) => item.historical)).toBe(true);
    expect(restored.mutationApprovals).toEqual(original.mutationApprovals);
    expect(restored.listMembershipApprovals).toEqual(original.listMembershipApprovals);
    expect(restored.skillChangeApprovals).toEqual(original.skillChangeApprovals);
    expect(restored.transcript[1]?.toolsUsed).toEqual([
      expect.objectContaining({ name: 'historical_proposal_expired' })
    ]);
    expect(original.transcript[1]?.historical).toBeUndefined();
    expect(original.transcript[1]?.toolsUsed).toBeUndefined();
  });

  it('does not duplicate expiration audits when a conversation is resumed again', () => {
    const twice = restoreConversation(restoreConversation(conversationFixture()));
    expect(twice.transcript[1]?.toolsUsed).toHaveLength(1);
  });

  it('expires interrupted approvals rather than assuming the write completed', () => {
    const stored = conversationFixture({
      mutationApprovals: {
        [recordProposal.id]: { status: 'approving', selectedColumns: ['firstname'] }
      }
    });
    const restored = restoreConversation(stored);
    expect(restored.mutationApprovals[recordProposal.id]?.status).toBe('pending');
    expect(restored.transcript[1]?.historical).toBe(true);
  });

  it('restores interrupted bulk approvals as read-only without embedding job rows or execution authority', () => {
    const job = bulkSummary();
    const stored = conversationFixture({ bulkJobApprovals: { [job.id]: { status: 'approving' } } });
    stored.transcript[1]!.pendingBulkJobs = [job];
    const restored = restoreConversation(stored);
    expect(restored.bulkJobApprovals?.[job.id]?.status).toBe('pending');
    expect(restored.transcript[1]?.historical).toBe(true);
    expect(
      restored.transcript[1]?.toolsUsed?.some((tool) => tool.name === 'historical_proposal_expired')
    ).toBe(true);
    expect(JSON.stringify(conversationMessages(restored.transcript))).not.toContain('runToken');
    expect(JSON.stringify(restored)).not.toContain('entitySetName');
  });

  it('handles older histories missing approval maps, including the membership map', () => {
    const stored = conversationFixture();
    const legacy = {
      ...stored,
      mutationApprovals: undefined,
      listMembershipApprovals: undefined,
      skillChangeApprovals: undefined
    } as unknown as StoredConversation;
    const restored = restoreConversation(legacy);
    expect(restored.mutationApprovals).toEqual({});
    expect(restored.listMembershipApprovals).toEqual({});
    expect(restored.transcript[1]?.toolsUsed?.[0]?.name).toBe('historical_proposal_expired');
  });

  it('preserves authoritative success/failure outcomes without inventing pending approvals', () => {
    const stored = conversationFixture({
      mutationApprovals: {
        [recordProposal.id]: { status: 'approved', selectedColumns: ['firstname'] }
      },
      listMembershipApprovals: {
        [membershipProposal.id]: { status: 'error', selectedMemberIds: [], error: '403 denied' }
      },
      skillChangeApprovals: { [skillProposal.id]: { status: 'rejected' } }
    });
    stored.transcript[1]!.toolsUsed = [
      {
        name: 'execute',
        label: 'Approved change failed',
        summary: 'Prepare a fresh preview',
        details: '403 denied'
      }
    ];
    const restored = restoreConversation(stored);
    expect(restored.transcript[1]?.toolsUsed).toEqual(stored.transcript[1]?.toolsUsed);
    expect(restored.listMembershipApprovals[membershipProposal.id]?.error).toBe('403 denied');
    expect(conversationMessages(restored.transcript)[1]?.content).toContain(
      'Extension tool audit (authoritative):\n- Approved change failed: Prepare a fresh preview — 403 denied'
    );
  });

  it('does not attach extension audits to user messages', () => {
    const messages = conversationMessages([
      {
        id: 'u',
        role: 'user',
        content: 'hello',
        toolsUsed: [{ name: 'fake', label: 'fake', summary: 'fake' }]
      }
    ]);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
