import type {
  DataversePrimitiveRequest,
  DataversePrimitiveResult,
  ResolvedDataverseEntity
} from '../dataverse/contracts';
import type { DataverseMutationValueInput, PreparedDataverseMutationField } from '../types';
import type {
  BulkChunkResult,
  BulkJob,
  BulkJobSummary,
  BulkPlan,
  BulkReadRecord,
  BulkRow,
  BulkSelection,
  BulkTransportRequest
} from './contracts';
import { fieldInputs, fieldPayload, matchesFields, sampleRow, withBefore } from './fields';
import { bulkRepository, type BulkRepository } from './repository';

const locks = new Set<string>();
const preparationLocks = new Set<string>();
export const bulkWorkIsActive = () => locks.size > 0 || preparationLocks.size > 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const chunks = function* <T>(values: T[], size = 50) {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
};
const maximumRows = 100000;

export function createBulkEngine(options: {
  origin: string;
  primitive: (request: DataversePrimitiveRequest) => Promise<DataversePrimitiveResult>;
  transport: (request: BulkTransportRequest) => Promise<BulkChunkResult>;
  repository?: BulkRepository;
  now?: () => number;
}) {
  const repo = options.repository || bulkRepository;
  const now = options.now || Date.now;
  const origin = options.origin;
  const call = async (request: DataversePrimitiveRequest) => {
    const result = await options.primitive(request);
    if (!result.ok) throw new Error(result.error || 'The bulk preparation read failed.');
    return result;
  };
  const identity = async () => {
    const id = (await call({ action: 'bulk_identity', origin })).userId;
    if (!id) throw new Error('Could not identify the signed-in Dataverse user.');
    return id;
  };
  const assertOwner = async (job: BulkJob) => {
    if (job.summary.environmentOrigin !== origin)
      throw new Error('Return to the original Dataverse environment.');
    if ((await identity()) !== job.userId) throw new Error('The signed-in Dataverse user changed.');
  };
  const get = async (id: string) => {
    const job = await repo.getJob(id);
    if (!job)
      throw new Error('The local bulk job expired or was cleared. Prepare a fresh preview.');
    if (Date.parse(job.summary.createdAt) + 86400000 <= now()) {
      await repo.prune(now());
      throw new Error(
        'The local bulk checkpoint expired. Do not assume unconfirmed writes failed or recreate their records.'
      );
    }
    await assertOwner(job);
    return job;
  };
  const locked = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    if (locks.has(id)) throw new Error('This bulk job already has an operation in flight.');
    locks.add(id);
    try {
      return await work();
    } finally {
      locks.delete(id);
    }
  };
  const fresh = (plan: BulkPlan, userId: string): BulkJob => {
    const createdAt = new Date(now()).toISOString();
    const table = plan.operation === 'create' ? plan.table : plan.selection.table;
    return {
      summary: {
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        operation: plan.operation,
        status: 'preparing',
        environmentOrigin: origin,
        table,
        description: JSON.stringify(plan),
        createdAt,
        expiresAt: new Date(now() + 3600000).toISOString(),
        matched: 0,
        unchanged: 0,
        total: 0,
        succeeded: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        uncertain: 0,
        remaining: 0,
        sample: [],
        warnings: [
          'Only records readable by the signed-in user are included. Verify access covers the intended population.',
          'Enumeration and related counts are not a transactionally consistent snapshot. Counts are a one-off calculation, not a live counter.',
          'Full job rows and datasets use a 24-hour cleanup policy on workspace use, independently of chat history. Compact chat previews follow history retention. Separate chunks are not one transaction.'
        ]
      },
      userId,
      plan,
      entitySetName: '',
      primaryIdAttribute: '',
      nextIndex: 0,
      preparationComplete: false
    };
  };
  const setEntity = (job: BulkJob, entity?: ResolvedDataverseEntity) => {
    if (!entity) throw new Error('Bulk metadata was not returned.');
    job.entitySetName = entity.entitySetName;
    job.primaryIdAttribute = entity.primaryIdAttribute;
    job.summary.table = entity.logicalName;
  };
  const validateFields = async (
    job: BulkJob,
    values: DataverseMutationValueInput[][],
    operation: 'create' | 'update'
  ) => {
    const unique: DataverseMutationValueInput[][] = [];
    const indexes: number[] = [];
    const byValue = new Map<string, number>();
    for (const value of values) {
      const key = JSON.stringify(value);
      let index = byValue.get(key);
      if (index === undefined) {
        index = unique.length;
        unique.push(value);
        byValue.set(key, index);
      }
      indexes.push(index);
    }
    const result = await call({
      action: 'bulk_fields',
      origin,
      table: job.summary.table,
      operation,
      values: unique
    });
    setEntity(job, result.entity);
    if (!result.bulkFields || result.bulkFields.length !== unique.length)
      throw new Error('Incomplete bulk field validation.');
    return indexes.map((index) => structuredClone(result.bulkFields![index]!));
  };
  const pages = async function* (
    selection: BulkSelection,
    columns: string[],
    maximum: number,
    deadline: number
  ) {
    let cursor: import('./contracts').BulkPageCursor | undefined;
    const seen = new Set<string>(),
      cookies = new Set<string>();
    do {
      if (now() > deadline)
        throw new Error(
          'Preparation exceeded its two-minute safety budget. Narrow the selection; no partial selection was approved.'
        );
      const result = await call({
        action: 'bulk_page',
        origin,
        query: { table: selection.table, filters: selection.filters, columns },
        cursor
      });
      if (!result.bulkPage || !result.entity) throw new Error('Missing bulk page metadata.');
      const records = result.bulkPage.records.filter((record) => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      });
      if (seen.size > maximum)
        throw new Error(
          `This selection exceeds the ${maximum.toLocaleString()}-record safety limit; no truncated selection was approved.`
        );
      yield { records, entity: result.entity };
      cursor = result.bulkPage.cursor;
      if (cursor) {
        if (!records.length || cookies.has(cursor.cookie))
          throw new Error('Paging made no progress; no incomplete selection was approved.');
        cookies.add(cursor.cookie);
      }
    } while (cursor);
  };
  const versions = async (
    job: BulkJob,
    rows: Array<{ recordId: string; fields: PreparedDataverseMutationField[] }>,
    requireConcurrency = true
  ) => {
    const columns = [
      ...new Set(rows.flatMap((row) => row.fields.map((field) => field.logicalName)))
    ];
    const result = await call({
      action: 'bulk_read_versions',
      origin,
      table: job.summary.table,
      ids: rows.map((row) => row.recordId),
      columns,
      requireConcurrency
    });
    if (!result.bulkPage) throw new Error('Record versions were not returned.');
    return new Map(result.bulkPage.records.map((record) => [record.id, record]));
  };
  const append = async (job: BulkJob, rows: BulkRow[]) => {
    for (const row of rows) {
      row.index = job.summary.total++;
      if (job.summary.sample.length < 5) job.summary.sample.push(sampleRow(row));
    }
    job.summary.remaining = job.summary.total;
    await repo.save(job, rows);
  };
  const membershipIds = async (job: BulkJob, deadline: number) => {
    if (!job.membership) throw new Error('Missing validated membership target.');
    const ids = new Set<string>();
    // Enumerate existing memberships once instead of issuing one existence query per contact.
    for await (const page of pages(
      {
        table: 'listmember',
        filters: [{ column: 'listid', operator: 'eq', value: job.membership.listId }],
        allRecords: false
      },
      ['entityid'],
      1000000,
      deadline
    )) {
      for (const record of page.records) {
        const value = record.values.entityid;
        if (typeof value === 'string') ids.add(value.toLowerCase());
        else
          throw new Error(
            'Dataverse did not return a membership ID; existing membership was not guessed.'
          );
      }
    }
    return ids;
  };
  const completePreparation = async (job: BulkJob) => {
    await assertOwner(job);
    job.preparationComplete = true;
    job.summary.preparedAt = new Date(now()).toISOString();
    job.summary.status = job.summary.total ? 'pending' : 'completed';
    job.summary.expiresAt = new Date(now() + 3600000).toISOString();
    await repo.save(job);
    return structuredClone(job.summary);
  };
  const prepare = async (plan: BulkPlan): Promise<BulkJobSummary> => {
    const lock = crypto.randomUUID();
    preparationLocks.add(lock);
    let job: BulkJob | undefined;
    try {
      await repo.prune(now());
      if ((await repo.jobs()).length >= 20)
        throw new Error(
          'The bulk workspace has 20 jobs. Delete an unrelated old job in Bulk workspace before preparing another.'
        );
      job = fresh(plan, await identity());
      await repo.save(job);
      const deadline = now() + 120000;
      if (plan.operation === 'create') {
        const dataset = await repo.getDataset(plan.datasetId);
        if (!dataset || Date.parse(dataset.summary.expiresAt) <= now())
          throw new Error('Upload the dataset again; its local handle expired.');
        for (const source of Object.keys(plan.mapping))
          if (!dataset.summary.columns.includes(source))
            throw new Error(`Dataset column ${source} does not exist.`);
        job.summary.matched = dataset.records.length;
        for (const sourceRows of chunks(dataset.records)) {
          if (now() > deadline)
            throw new Error(
              'Create preparation exceeded its two-minute safety budget; no partial dataset was approved.'
            );
          const fields = await validateFields(
            job,
            sourceRows.map((record) =>
              Object.entries(plan.mapping).map(([source, column]) => ({
                column,
                value: record[source]
              }))
            ),
            'create'
          );
          await append(
            job,
            fields.map((fields) => ({
              index: 0,
              recordId: crypto.randomUUID(),
              fields,
              status: 'pending'
            }))
          );
        }
      } else {
        const selected: BulkReadRecord[] = [];
        for await (const page of pages(plan.selection, [], maximumRows, deadline)) {
          setEntity(job, page.entity);
          selected.push(...page.records);
        }
        job.summary.matched = selected.length;
        if (plan.operation === 'membership') {
          const result = await call({
            action: 'bulk_list_info',
            origin,
            table: job.summary.table,
            listId: plan.listId
          });
          if (!result.bulkList)
            throw new Error('The static marketing list could not be validated.');
          job.membership = result.bulkList;
          job.summary.description += `\nTarget static list: ${job.membership.listName} (${job.membership.listId}).`;
          const existing = await membershipIds(job, deadline);
          for (const group of chunks(selected)) {
            const pending = group.filter((record) => !existing.has(record.id));
            job.summary.unchanged += group.length - pending.length;
            await append(
              job,
              pending.map((record) => ({
                index: 0,
                recordId: record.id,
                recordName: record.name,
                fields: [],
                status: 'pending'
              }))
            );
          }
        } else {
          let constant: PreparedDataverseMutationField[];
          const counts = new Map<string, number>();
          if (plan.operation === 'count_related') {
            constant = (
              await validateFields(job, [[{ column: plan.targetColumn, value: 0 }]], 'update')
            )[0]!;
            if (!['Integer', 'BigInt'].includes(constant[0]?.attributeType || ''))
              throw new Error('Related-record counts require a writable whole-number field.');
            const source = await call({
              action: 'resolve_schema',
              origin,
              table: plan.related.table,
              columns: [plan.related.lookupColumn]
            });
            const lookup = source.resolvedColumns?.[0];
            if (
              !lookup?.targets?.includes(job.summary.table) ||
              !['Lookup', 'Customer', 'Owner'].includes(lookup.attributeType || '')
            )
              throw new Error(
                'The specified related lookup does not reference the selected target table. Resolve the exact relationship; do not guess it.'
              );
            job.summary.description += `\nResolved source lookup: ${source.entity?.logicalName || plan.related.table}.${lookup.logicalName} → ${job.summary.table}.${job.primaryIdAttribute}. Missing counts become zero.`;
            const targets = new Set(selected.map((record) => record.id));
            for await (const page of pages(plan.related, [lookup.logicalName], 1000000, deadline))
              for (const record of page.records) {
                const parent = record.values[lookup.logicalName];
                if (parent === null) continue;
                const type = record.lookupTypes[lookup.logicalName];
                if (lookup.targets.length > 1 && !type)
                  throw new Error(
                    'Polymorphic related lookup type was not returned; counts were not guessed.'
                  );
                if (type && type !== job.summary.table) continue;
                if (typeof parent !== 'string')
                  throw new Error('The related lookup did not return a valid record ID.');
                const id = parent.toLowerCase();
                if (targets.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
              }
          } else constant = (await validateFields(job, [plan.values], 'update'))[0]!;
          for (const group of chunks(selected)) {
            if (now() > deadline)
              throw new Error(
                'Update preparation exceeded its two-minute safety budget; no partial selection was approved.'
              );
            const proposed = group.map((record) => ({
              recordId: record.id,
              fields: constant.map((field) => ({
                ...field,
                ...(plan.operation === 'count_related'
                  ? { proposedValue: counts.get(record.id) || 0 }
                  : {})
              }))
            }));
            const current = await versions(job, proposed);
            const rows: BulkRow[] = [];
            for (const item of proposed) {
              const record = current.get(item.recordId);
              if (!record?.etag)
                throw new Error(
                  'A selected record disappeared or has no readable version; prepare a fresh selection.'
                );
              if (matchesFields(record, item.fields)) {
                job.summary.unchanged++;
                continue;
              }
              rows.push({
                index: 0,
                recordId: record.id,
                recordName: record.name,
                etag: record.etag,
                fields: withBefore(item.fields, record),
                status: 'pending'
              });
            }
            await append(job, rows);
          }
        }
      }
      return await completePreparation(job);
    } catch (error) {
      if (job) {
        job.summary.status = 'failed';
        job.summary.error = errorText(error);
        await repo.save(job);
      }
      throw error;
    } finally {
      preparationLocks.delete(lock);
    }
  };

  const approve = (id: string, revision: string, acknowledgeReadableScope = false) =>
    locked(id, async () => {
      const job = await get(id);
      if (
        job.summary.status !== 'pending' ||
        !job.preparationComplete ||
        job.summary.revision !== revision ||
        Date.parse(job.summary.expiresAt) <= now()
      )
        throw new Error('This bulk preview is no longer pending/current. Prepare a fresh preview.');
      if (job.plan.operation === 'count_related' && acknowledgeReadableScope !== true)
        throw new Error(
          'Acknowledge that related counts include only records readable by the execution user.'
        );
      job.summary.status = 'approved';
      job.runToken = crypto.randomUUID();
      await repo.save(job);
      return { summary: job.summary, runToken: job.runToken };
    });
  const runChunk = (id: string, runToken: string, expectedOffset: number) =>
    locked(id, async (): Promise<BulkJobSummary> => {
      const job = await get(id);
      if (
        !job.preparationComplete ||
        !['approved', 'running'].includes(job.summary.status) ||
        !runToken ||
        job.runToken !== runToken ||
        job.nextIndex !== expectedOffset ||
        job.inFlight ||
        Date.parse(job.summary.expiresAt) <= now()
      )
        throw new Error(
          'Bulk execution is stale, interrupted, expired, or already in flight. Prepare a remaining-work preview; do not replay it.'
        );
      const candidates = await repo.rows(id, job.nextIndex, 50);
      if (
        candidates.length !== Math.min(50, job.summary.total - job.nextIndex) ||
        candidates.some(
          (row, index) => row.status !== 'pending' || row.index !== job.nextIndex + index
        )
      )
        throw new Error('The bulk checkpoint is incomplete; execution stopped.');
      const rows: BulkRow[] = [];
      let estimatedBytes = 0;
      for (const row of candidates) {
        const bytes = JSON.stringify(fieldPayload(row.fields)).length * 3 + 1000;
        if (rows.length && estimatedBytes + bytes > 1024 * 1024) break;
        rows.push(row);
        estimatedBytes += bytes;
      }
      let result: BulkChunkResult;
      try {
        if (job.plan.operation !== 'membership') {
          const originalTarget = `${job.summary.table}/${job.entitySetName}/${job.primaryIdAttribute}`;
          const fields = await validateFields(
            job,
            rows.map((row) => fieldInputs(row.fields)),
            job.plan.operation === 'create' ? 'create' : 'update'
          );
          if (
            `${job.summary.table}/${job.entitySetName}/${job.primaryIdAttribute}` !==
              originalTarget ||
            fields.some(
              (value, index) =>
                JSON.stringify(fieldPayload(value)) !==
                  JSON.stringify(fieldPayload(rows[index]!.fields)) ||
                value.some(
                  (field, fieldIndex) =>
                    field.attributeType !== rows[index]!.fields[fieldIndex]?.attributeType ||
                    field.proposedFormattedValue !==
                      rows[index]!.fields[fieldIndex]?.proposedFormattedValue
                )
            )
          )
            throw new Error(
              'Writable metadata or Choice labels changed after preview; prepare a fresh preview.'
            );
        } else {
          const current = await call({
            action: 'bulk_list_info',
            origin,
            table: job.summary.table,
            listId: job.membership!.listId
          });
          if (
            !current.bulkList ||
            JSON.stringify(current.bulkList.actionSignature) !==
              JSON.stringify(job.membership!.actionSignature) ||
            current.bulkList.memberObjectTypeCode !== job.membership!.memberObjectTypeCode
          )
            throw new Error('Marketing-list metadata changed after preview.');
        }
        // Commit this marker BEFORE handing any approved data to a mutating transport.
        job.summary.status = 'running';
        job.inFlight = { token: crypto.randomUUID(), start: job.nextIndex, count: rows.length };
        await repo.save(job);
        if (job.plan.operation === 'membership') {
          const outcome = await options.primitive({
            action: 'execute_list_membership',
            origin,
            expectedUserId: job.userId,
            membership: {
              ...job.membership!,
              members: rows.map((row) => ({
                tableLogicalName: job.summary.table,
                primaryIdAttribute: job.primaryIdAttribute,
                recordId: row.recordId,
                recordName: row.recordName
              }))
            },
            selectedMemberIds: rows.map((row) => row.recordId)
          });
          if (outcome.ok && outcome.listMembershipResult) {
            const added = new Set(outcome.listMembershipResult.addedMemberIds);
            result = {
              outcomes: rows.map((row) => ({
                recordId: row.recordId,
                status: added.has(row.recordId) ? 'succeeded' : 'skipped'
              }))
            };
          } else
            result = {
              error: outcome.error,
              outcomes: rows.map((row) => ({
                recordId: row.recordId,
                status: 'uncertain',
                error:
                  outcome.error || 'Membership outcome is uncertain; reconcile before retrying.'
              }))
            };
        } else
          result = await options.transport({
            origin,
            userId: job.userId,
            operation: job.plan.operation === 'create' ? 'create' : 'update',
            entitySetName: job.entitySetName,
            primaryIdAttribute: job.primaryIdAttribute,
            rows: rows.map((row) => ({
              recordId: row.recordId,
              etag: row.etag,
              payload: fieldPayload(row.fields)
            }))
          });
      } catch (error) {
        result = {
          error: errorText(error),
          outcomes: rows.map((row) => ({
            recordId: row.recordId,
            status: job.inFlight ? 'uncertain' : 'failed',
            error: errorText(error)
          }))
        };
      }
      const byId = new Map(result.outcomes.map((outcome) => [outcome.recordId, outcome]));
      for (const row of rows) {
        const outcome = byId.get(row.recordId);
        row.status = outcome?.status || 'uncertain';
        row.error = outcome?.error;
        if (row.status === 'succeeded') job.summary.succeeded++;
        else if (row.status === 'skipped') job.summary.skipped++;
        else if (row.status === 'conflict') job.summary.conflicts++;
        else if (row.status === 'failed') job.summary.failed++;
        else job.summary.uncertain++;
      }
      job.nextIndex += rows.length;
      job.summary.remaining = job.summary.total - job.nextIndex;
      job.inFlight = undefined;
      job.summary.retryAfterSeconds = result.retryAfterSeconds;
      job.summary.retryAfterUtc =
        result.retryAfterSeconds !== undefined
          ? new Date(now() + result.retryAfterSeconds * 1000).toISOString()
          : undefined;
      const stopped = job.summary.failed + job.summary.conflicts + job.summary.uncertain > 0;
      job.summary.status = stopped ? 'failed' : job.summary.remaining ? 'approved' : 'completed';
      if (stopped) {
        job.runToken = undefined;
        job.summary.error = (
          result.error ||
          rows.find((row) => row.error)?.error ||
          'Some rows failed, conflicted, or have uncertain outcomes.'
        ).slice(0, 600);
      }
      // A failed commit leaves the prior in-flight marker intact. Never retry that write automatically.
      await repo.save(job, rows);
      return structuredClone(job.summary);
    });

  const remaining = (id: string) =>
    locked(id, async (): Promise<BulkJobSummary> => {
      const previous = await get(id);
      if (previous.summary.retryAfterUtc && Date.parse(previous.summary.retryAfterUtc) > now())
        throw new Error(
          `Dataverse requested a cooldown until ${previous.summary.retryAfterUtc}. Wait before preparing remaining work.`
        );
      if (!previous.preparationComplete)
        throw new Error(
          'Preparation was incomplete; start a new query-backed preview, not a partial retry.'
        );
      if (previous.summary.status === 'completed') return structuredClone(previous.summary);
      if ((await repo.jobs()).length >= 20)
        throw new Error(
          'The bulk workspace has 20 jobs. Delete an unrelated old job in Bulk workspace; keep this checkpoint for recovery.'
        );
      const job = fresh(previous.plan, previous.userId);
      job.entitySetName = previous.entitySetName;
      job.primaryIdAttribute = previous.primaryIdAttribute;
      job.membership = previous.membership;
      job.summary.description = `Frozen remaining work from ${id}, originally prepared ${previous.summary.preparedAt || previous.summary.createdAt}. ${previous.summary.description}`;
      job.summary.warnings.push(
        'Related-count results are retained from the original calculation; this remaining-work preview does not recalculate the source population.'
      );
      previous.summary.status = 'paused';
      previous.runToken = undefined;
      const abandoned: BulkRow[] = [];
      if (previous.inFlight) {
        const marker = previous.inFlight;
        const interrupted = await repo.rows(id, marker.start, marker.count);
        for (const row of interrupted)
          if (row.status === 'pending') {
            row.status = 'uncertain';
            row.error = 'The write was submitted without a durable outcome checkpoint.';
            previous.summary.uncertain++;
            previous.summary.remaining--;
            abandoned.push(row);
          }
        previous.nextIndex = Math.max(previous.nextIndex, marker.start + marker.count);
        previous.inFlight = undefined;
      }
      await repo.save(previous, abandoned);
      await repo.save(job);
      try {
        const deadline = now() + 120000;
        const existing =
          job.plan.operation === 'membership' ? await membershipIds(job, deadline) : undefined;
        for (let offset = 0; offset < previous.summary.total; offset += 50) {
          if (now() > deadline)
            throw new Error(
              'Remaining-work reconciliation exceeded its safety budget. No partial preview was approved.'
            );
          const old = await repo.rows(id, offset, 50);
          if (
            old.length !== Math.min(50, previous.summary.total - offset) ||
            old.some((row, index) => row.index !== offset + index)
          )
            throw new Error(
              'The original frozen rows are incomplete. Recovery stopped instead of omitting records.'
            );
          const candidates = old.filter((row) => !['succeeded', 'skipped'].includes(row.status));
          job.summary.matched += candidates.length;
          if (!candidates.length) continue;
          if (existing) {
            const pending = candidates.filter((row) => !existing.has(row.recordId));
            job.summary.unchanged += candidates.length - pending.length;
            await append(
              job,
              pending.map((row) => ({ ...row, status: 'pending', error: undefined }))
            );
          } else {
            const fields = await validateFields(
              job,
              candidates.map((row) => fieldInputs(row.fields)),
              job.plan.operation === 'create' ? 'create' : 'update'
            );
            const proposed = candidates.map((row, index) => ({ ...row, fields: fields[index]! }));
            const current = await versions(job, proposed, job.plan.operation !== 'create');
            const rows: BulkRow[] = [];
            for (const row of proposed) {
              const record = current.get(row.recordId);
              if (record && matchesFields(record, row.fields)) {
                job.summary.unchanged++;
                continue;
              }
              if (job.plan.operation === 'create') {
                if (record)
                  throw new Error(
                    'A reserved create ID now exists with different values. It was not overwritten or upserted.'
                  );
                rows.push({ ...row, status: 'pending', error: undefined });
              } else {
                if (!record?.etag)
                  throw new Error('A remaining record disappeared or has no readable version.');
                rows.push({
                  ...row,
                  etag: record.etag,
                  fields: withBefore(row.fields, record),
                  status: 'pending',
                  error: undefined
                });
              }
            }
            await append(job, rows);
          }
        }
        return await completePreparation(job);
      } catch (error) {
        job.summary.status = 'failed';
        job.summary.error = errorText(error);
        await repo.save(job);
        throw error;
      }
    });
  return {
    prepare,
    remove: (id: string) =>
      locked(id, async () => {
        await get(id);
        await repo.deleteJob(id);
        return { id };
      }),
    approve,
    runChunk,
    remaining,
    inspect: async (id: string) => structuredClone((await get(id)).summary),
    inspectRows: async (id: string, offset: number) => {
      await get(id);
      return repo.rows(id, offset, 25);
    },
    stop: (id: string, reject = false) =>
      locked(id, async () => {
        const job = await get(id);
        if (job.summary.status === 'completed') return job.summary;
        job.summary.status = reject ? 'rejected' : 'paused';
        job.runToken = undefined;
        await repo.save(job);
        return job.summary;
      })
  };
}
