import { vi } from 'vitest';
import { createBulkEngine } from '../../lib/bulk/engine';
import { bulkRepository, type BulkRepository } from '../../lib/bulk/repository';
import type {
  DataversePrimitiveRequest,
  DataversePrimitiveResult
} from '../../lib/dataverse/contracts';
import type {
  BulkReadRecord,
  BulkTransportRequest,
  BulkChunkResult,
  BulkJobSummary
} from '../../lib/bulk/contracts';

export const bulkOrigin = 'https://contoso.crm.dynamics.com';
export const guid = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
export const contactEntity = {
  logicalName: 'contact',
  entitySetName: 'contacts',
  primaryIdAttribute: 'contactid',
  primaryNameAttribute: 'fullname',
  optimisticConcurrencyEnabled: true
};
export function bulkHarness(size = 1200, repository: BulkRepository = bulkRepository) {
  const records = new Map<string, BulkReadRecord>(
    Array.from({ length: size }, (_, index) => [
      guid(index + 1),
      {
        id: guid(index + 1),
        name: `Contact ${index + 1}`,
        etag: 'W/"1"',
        values: { firstname: 'Old', new_casecount: null },
        lookupTypes: {}
      }
    ])
  );
  const cases: BulkReadRecord[] = [];
  const memberships = new Set<string>();
  let userId = guid(999999),
    time = Date.parse('2026-01-01T12:00:00Z');
  let nextWrite: ((request: BulkTransportRequest) => Promise<BulkChunkResult>) | undefined;
  const primitive = vi.fn(
    async (request: DataversePrimitiveRequest): Promise<DataversePrimitiveResult> => {
      const base = { ok: true, action: request.action };
      if (request.action === 'bulk_identity') return { ...base, userId };
      if (request.action === 'bulk_fields')
        return {
          ...base,
          entity: contactEntity,
          bulkFields: request.values.map((values) =>
            values.map((value) => ({
              requestedName: value.column,
              logicalName: value.column,
              attributeType: value.column === 'new_casecount' ? 'Integer' : 'String',
              proposedValue: value.value
            }))
          )
        };
      if (request.action === 'bulk_page') {
        const source =
          request.query.table === 'incident'
            ? cases
            : request.query.table === 'listmember'
              ? [...memberships].map((id, index) => ({
                  id: guid(800000 + index),
                  values: { entityid: id },
                  lookupTypes: {}
                }))
              : [...records.values()];
        const start = ((request.cursor?.page || 1) - 1) * 500;
        const more = start + 500 < source.length;
        return {
          ...base,
          entity:
            request.query.table === 'contact'
              ? contactEntity
              : {
                  logicalName: request.query.table,
                  entitySetName: `${request.query.table}s`,
                  primaryIdAttribute: `${request.query.table}id`
                },
          bulkPage: {
            records: structuredClone(source.slice(start, start + 500)),
            cursor: more
              ? { page: (request.cursor?.page || 1) + 1, cookie: `cookie-${start + 500}` }
              : undefined
          }
        };
      }
      if (request.action === 'bulk_read_versions')
        return {
          ...base,
          entity: contactEntity,
          bulkPage: {
            records: request.ids.flatMap((id) =>
              records.has(id) ? [structuredClone(records.get(id)!)] : []
            )
          }
        };
      if (request.action === 'resolve_schema')
        return {
          ...base,
          resolvedColumns: [
            {
              requestedName: 'customerid',
              logicalName: 'customerid',
              attributeType: 'Customer',
              targets: ['contact', 'account']
            }
          ]
        };
      if (request.action === 'bulk_list_info')
        return {
          ...base,
          entity: contactEntity,
          bulkList: {
            id: guid(700001),
            environmentOrigin: bulkOrigin,
            listId: guid(700000),
            listName: 'Existing list',
            listEntitySetName: 'lists',
            memberTableLogicalName: 'contact',
            memberObjectTypeCode: 2,
            members: [],
            alreadyMembers: [],
            actionSignature: {
              name: 'AddListMembersList',
              isBound: false,
              parameters: [
                { name: 'List', type: 'mscrm.list' },
                { name: 'Members', type: 'Collection(mscrm.crmbaseentity)' }
              ]
            }
          }
        };
      if (request.action === 'execute_list_membership') {
        const addedMemberIds = request.selectedMemberIds.filter((id) => !memberships.has(id));
        for (const id of addedMemberIds) memberships.add(id);
        return {
          ...base,
          listMembershipResult: {
            listId: guid(700000),
            listName: 'Existing list',
            memberTableLogicalName: 'contact',
            addedMemberIds,
            addedMemberNames: []
          }
        };
      }
      throw new Error(`Unexpected fixture primitive: ${request.action}`);
    }
  );
  const apply = async (request: BulkTransportRequest): Promise<BulkChunkResult> => ({
    outcomes: request.rows.map((row) => {
      const existing = records.get(row.recordId);
      if (request.operation === 'update' && row.etag !== existing?.etag)
        return { recordId: row.recordId, status: 'conflict' };
      if (request.operation === 'create' && existing)
        return { recordId: row.recordId, status: 'failed', error: 'ID already exists' };
      records.set(row.recordId, {
        id: row.recordId,
        name: existing?.name,
        etag: 'W/"2"',
        values: { ...existing?.values, ...row.payload },
        lookupTypes: {}
      });
      return { recordId: row.recordId, status: 'succeeded' };
    })
  });
  const transport = vi.fn(async (request: BulkTransportRequest) =>
    nextWrite ? nextWrite(request) : apply(request)
  );
  const engine = createBulkEngine({
    origin: bulkOrigin,
    repository,
    primitive,
    transport,
    now: () => time
  });
  return {
    engine,
    primitive,
    transport,
    records,
    cases,
    memberships,
    apply,
    setUser: (id: string) => {
      userId = id;
    },
    advance: (ms: number) => {
      time += ms;
    },
    setWrite: (write?: typeof nextWrite) => {
      nextWrite = write;
    }
  };
}
export const updatePlan = {
  operation: 'update' as const,
  selection: { table: 'contact', filters: [], allRecords: true },
  values: [{ column: 'firstname', value: 'New' }]
};
export const bulkSummary = (overrides: Partial<BulkJobSummary> = {}): BulkJobSummary => ({
  id: guid(900000),
  revision: 'revision',
  operation: 'update',
  status: 'pending',
  environmentOrigin: bulkOrigin,
  table: 'contact',
  description: 'All contacts: firstname → New',
  createdAt: '2026-01-01T12:00:00Z',
  expiresAt: '2026-01-01T13:00:00Z',
  matched: 1200,
  unchanged: 0,
  total: 1200,
  succeeded: 0,
  skipped: 0,
  conflicts: 0,
  failed: 0,
  uncertain: 0,
  remaining: 1200,
  sample: [],
  warnings: [],
  ...overrides
});
