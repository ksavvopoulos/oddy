import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseSchemaPrimitive as execute } from '../lib/dataverse-schema-primitives';
import type {
  PreparedSchemaChange,
  SchemaColumnDefinition,
  SchemaPlan
} from '../lib/schema/contracts';
import {
  consentOutboxPlan,
  schemaOrigin as origin,
  schemaSolutionRow,
  schemaTable,
  createSchemaTablePlan
} from './fixtures/schema';

type Obj = Record<string, unknown>;
const response = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
let source: Obj | undefined;
let reference: Obj;
let solutions: Obj[];
let writes: Array<{ path: string; body: Obj; options: RequestInit }>;
let rejectRelationship: number | undefined;
let uncertainTable: boolean;
let afterTable: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  source = undefined;
  solutions = [structuredClone(schemaSolutionRow)];
  writes = [];
  rejectRelationship = undefined;
  uncertainTable = false;
  afterTable = undefined;
  reference = {
    ...structuredClone(schemaTable),
    LogicalName: 'contact',
    SchemaName: 'Contact',
    MetadataId: '00000000-0000-0000-0000-000000000099',
    PrimaryIdAttribute: 'contactid',
    IsManaged: true,
    IsCustomEntity: false,
    CanBePrimaryEntityInRelationship: { Value: true }
  };
  vi.stubGlobal('window', { location: { origin } });
  fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    const path = decodeURIComponent(url.split('/api/data/v9.2/')[1]!);
    if (options.method === 'GET') {
      if (path.startsWith('solutions?')) {
        const exact = path.match(/uniquename eq '([^']+)'/);
        return response({
          value: exact ? solutions.filter((v) => v.uniquename === exact[1]) : solutions
        });
      }
      if (path.startsWith('EntityDefinitions?'))
        return response({ value: source ? [{ LogicalName: source.LogicalName }] : [] });
      if (path.startsWith('RelationshipDefinitions?')) return response({ value: [] });
      if (path.startsWith('RetrieveEntity(')) {
        const logicalName = path.match(/LogicalName='([^']+)'/)?.[1];
        if (logicalName === 'contact') return response({ EntityMetadata: reference });
        return source
          ? response({ EntityMetadata: source })
          : new Response('not found', { status: 404 });
      }
    } else {
      const body: Obj = JSON.parse(options.body as string);
      writes.push({ path, body, options });
      if (path === 'EntityDefinitions') {
        source = {
          ...structuredClone(schemaTable),
          ...body,
          LogicalName: String(body.SchemaName).toLowerCase(),
          CanBeRelatedEntityInRelationship: { Value: true },
          Attributes: (body.Attributes as Obj[]).map((v) => ({
            ...v,
            LogicalName: String(v.SchemaName).toLowerCase()
          }))
        };
        afterTable?.();
        if (uncertainTable) throw new TypeError('Connection lost after submission');
      } else if (path === 'RelationshipDefinitions') {
        if (rejectRelationship)
          return new Response('Relationship rejected', { status: rejectRelationship });
        (source!.Attributes as Obj[]).push({
          ...(body.Lookup as Obj),
          LogicalName: String((body.Lookup as Obj).SchemaName).toLowerCase()
        });
        (source!.ManyToOneRelationships as Obj[]).push(body);
      } else throw new Error(`Unexpected write ${path}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
async function prepare(plan: SchemaPlan = consentOutboxPlan) {
  const result = await execute({ action: 'prepare_schema_change', origin, plan });
  expect(result.ok, result.error).toBe(true);
  return result.schemaChange!;
}
const apply = (change: PreparedSchemaChange) =>
  execute({ action: 'execute_schema_change', origin, change });

describe('complete table proposals', () => {
  it('preflights the entire ConsentOutbox with a real Contact lookup, UTC-instant datetime, and Pending form default', async () => {
    const change = await prepare();
    expect(writes).toHaveLength(0);
    expect(change.mode).toBe('schema-v2');
    expect(change.steps).toHaveLength(2);
    expect(change.steps![0]).toMatchObject({
      path: 'EntityDefinitions',
      body: { OwnershipType: 'OrganizationOwned' }
    });
    const attributes = change.after.Attributes as Obj[];
    expect(attributes).toHaveLength(8); // primary name plus seven scalar columns
    expect(attributes.find((v) => v.SchemaName === 'new_OccurredOn')).toMatchObject({
      Format: 'DateAndTime',
      DateTimeBehavior: { Value: 'UserLocal' }
    });
    expect(attributes.find((v) => v.SchemaName === 'new_ProcessingStatus')).toMatchObject({
      DefaultFormValue: 100000000,
      OptionSet: { Options: [{ Value: 100000000 }, { Value: 100000001 }, { Value: 100000002 }] }
    });
    expect(attributes.some((v) => v.SchemaName === 'new_Contact')).toBe(false);
    expect(change.steps![1]).toMatchObject({
      path: 'RelationshipDefinitions',
      body: {
        ReferencedEntity: 'contact',
        ReferencedAttribute: 'contactid',
        ReferencingEntity: 'new_consentoutbox',
        Lookup: {
          '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
          SchemaName: 'new_Contact'
        },
        CascadeConfiguration: {
          Delete: 'Restrict',
          Assign: 'NoCascade',
          Reparent: 'NoCascade',
          Share: 'NoCascade',
          Unshare: 'NoCascade',
          Merge: 'NoCascade'
        }
      }
    });
    expect(change.referenceRevisions?.contact).toMatch(/^[a-f0-9]{64}$/);
    expect(change.warnings.join(' ')).toContain('form defaults');
    expect(change.warnings.join(' ')).toContain('NOT a global transaction');
    const result = await apply(change);
    expect(result.ok, result.error).toBe(true);
    expect(result.schemaChangeResult?.status).toBe('saved');
    expect(result.schemaChangeResult?.outcomes?.map((v) => v.status)).toEqual([
      'succeeded',
      'succeeded'
    ]);
    expect(writes.map((v) => v.path)).toEqual(['EntityDefinitions', 'RelationshipDefinitions']);
    for (const write of writes)
      expect(write.options.headers).toMatchObject({
        'MSCRM.SolutionUniqueName': 'ExampleSolution'
      });
  });

  it('works as a serialized, module-independent MAIN-world executor', async () => {
    const injected = new Function(`return (${execute.toString()});`)() as typeof execute;
    const preview = await injected({
      action: 'prepare_schema_change',
      origin,
      plan: consentOutboxPlan
    });
    expect(preview.ok, preview.error).toBe(true);
    const result = await injected({
      action: 'execute_schema_change',
      origin,
      change: preview.schemaChange!
    });
    expect(result.ok, result.error).toBe(true);
  });

  it('stops after a relationship rejection, reports partial completion, and leaves later requests unattempted', async () => {
    const plan = structuredClone(consentOutboxPlan);
    if (plan.operation !== 'create_table') throw new Error('wrong plan');
    plan.columns!.push({
      ...plan.columns![0]!,
      schemaName: 'new_SecondContact',
      relationshipSchemaName: 'new_second_contact_consentoutbox'
    });
    const change = await prepare(plan);
    rejectRelationship = 400;
    const result = await apply(change);
    expect(result.ok).toBe(false);
    expect(result.schemaChangeResult?.status).toBe('partial');
    expect(result.schemaChangeResult?.outcomes?.map((v) => v.status)).toEqual([
      'succeeded',
      'failed',
      'not-attempted'
    ]);
    expect(result.error).toContain('prior successful steps remain');
    expect(writes).toHaveLength(2);
    expect(writes.some((v) => /Publish|DELETE/i.test(v.path))).toBe(false);
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false); // never recreate
  });

  it.each([500, 503])(
    'treats relationship HTTP %s as an uncertain outcome, never a retry',
    async (status) => {
      const change = await prepare();
      rejectRelationship = status;
      const result = await apply(change);
      expect(result.schemaChangeResult?.outcomes?.map((v) => v.status)).toEqual([
        'succeeded',
        'unknown'
      ]);
      expect(result.error).toContain('uncertain outcome');
      expect(writes).toHaveLength(2);
    }
  );

  it('reports a lost table-create response as unknown and does not submit relationships', async () => {
    const change = await prepare();
    uncertainTable = true;
    const result = await apply(change);
    expect(result.schemaChangeResult?.status).toBe('failed');
    expect(result.schemaChangeResult?.outcomes?.map((v) => v.status)).toEqual([
      'unknown',
      'not-attempted'
    ]);
    expect(writes).toHaveLength(1);
  });

  it('detects referenced-table drift before any write and rechecks it between steps', async () => {
    const change = await prepare();
    reference.PrimaryIdAttribute = 'differentid';
    expect((await apply(change)).ok).toBe(false);
    expect(writes).toHaveLength(0);
    reference.PrimaryIdAttribute = 'contactid';
    afterTable = () => {
      reference.CanBePrimaryEntityInRelationship = { Value: false };
    };
    const result = await apply(change);
    expect(result.schemaChangeResult?.status).toBe('partial');
    expect(result.schemaChangeResult?.outcomes?.[1]?.status).toBe('not-attempted');
    expect(writes).toHaveLength(1);
  });

  it('revalidates solution/publisher after table creation before submitting relationships', async () => {
    const change = await prepare();
    afterTable = () => {
      solutions[0]!.publisherid = {
        ...schemaSolutionRow.publisherid,
        customizationoptionvalueprefix: 10001
      };
    };
    const result = await apply(change);
    expect(result.schemaChangeResult?.status).toBe('partial');
    expect(result.error).toContain('publisher changed');
    expect(writes).toHaveLength(1);
  });

  it.each(['steps', 'referenceRevisions'] as const)(
    'rejects a modified approved %s before any write',
    async (key) => {
      const change = await prepare();
      if (key === 'steps') change.steps![1]!.body.ReferencedEntity = 'account';
      else change.referenceRevisions!.contact = 'tampered';
      expect((await apply(change)).ok).toBe(false);
      expect(writes).toHaveLength(0);
    }
  );

  it('expires old v1 previews without touching the tenant', async () => {
    const change = await prepare();
    fetchMock.mockClear();
    change.mode = 'schema-v1';
    expect((await apply(change)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can add a real lookup to an existing unmanaged table using its exact revision', async () => {
    source = { ...structuredClone(schemaTable), CanBeRelatedEntityInRelationship: { Value: true } };
    const read = await execute({
      action: 'get_table_definition',
      origin,
      tableLogicalName: 'new_example'
    });
    const change = await prepare({
      operation: 'create_column',
      solutionUniqueName: 'ExampleSolution',
      languageCode: 1033,
      tableLogicalName: 'new_example',
      baseRevision: read.tableDefinition!.revision,
      column: {
        type: 'lookup',
        schemaName: 'new_Contact',
        displayName: 'Contact',
        targetTable: 'contact',
        relationshipSchemaName: 'new_contact_example',
        deleteBehavior: 'RemoveLink'
      }
    });
    expect(change.steps).toHaveLength(1);
    expect(change.steps![0]!.body.CascadeConfiguration).toMatchObject({ Delete: 'RemoveLink' });
    expect((await apply(change)).ok).toBe(true);
    expect(writes.map((v) => v.path)).toEqual(['RelationshipDefinitions']);
  });

  it.each([
    { dateTimeBehavior: undefined },
    { dateTimeBehavior: 'UTC' },
    { dateTimeBehavior: 'DateOnly' }
  ])('rejects unspecified or invalid timestamp semantics %j', async (spec) => {
    const plan = {
      ...createSchemaTablePlan,
      columns: [{ type: 'datetime', schemaName: 'new_When', displayName: 'When', ...spec }]
    };
    expect(
      (await execute({ action: 'prepare_schema_change', origin, plan: plan as SchemaPlan })).ok
    ).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('supports explicit wall-time behavior and boolean true defaults', async () => {
    const change = await prepare({
      ...createSchemaTablePlan,
      columns: [
        {
          type: 'datetime',
          schemaName: 'new_WallTime',
          displayName: 'Wall time',
          dateTimeBehavior: 'TimeZoneIndependent'
        },
        {
          type: 'boolean',
          schemaName: 'new_Flag',
          displayName: 'Flag',
          falseLabel: 'No',
          trueLabel: 'Yes',
          defaultBoolean: true
        }
      ]
    } as SchemaPlan);
    expect(change.after.Attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ DateTimeBehavior: { Value: 'TimeZoneIndependent' } }),
        expect.objectContaining({ DefaultValue: true })
      ])
    );
  });

  it.each([
    { defaultChoice: 'Missing' },
    { choices: ['Pending', 'pending'] },
    { defaultBoolean: 'false' },
    { relationshipSchemaName: 'other_relation' },
    { deleteBehavior: 'Cascade' },
    { targetTable: "contact')/anything" }
  ])('rejects bad defaults/lookup definitions before writes %j', async (spec) => {
    const plan = structuredClone(consentOutboxPlan);
    if (plan.operation !== 'create_table') throw new Error('wrong plan');
    const type =
      'defaultChoice' in spec || 'choices' in spec
        ? 'choice'
        : 'defaultBoolean' in spec
          ? 'boolean'
          : 'lookup';
    Object.assign(
      plan.columns!.find((v) => v.type === type)!,
      spec
    );
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('rejects ineligible references, duplicate columns/relationships, and existing relationship names', async () => {
    reference.CanBePrimaryEntityInRelationship = { Value: false };
    expect(
      (await execute({ action: 'prepare_schema_change', origin, plan: consentOutboxPlan })).ok
    ).toBe(false);
    reference.CanBePrimaryEntityInRelationship = { Value: true };
    for (const extra of [
      { type: 'text', schemaName: 'NEW_NAME', displayName: 'Duplicate', maxLength: 100 },
      {
        type: 'lookup',
        schemaName: 'new_AnotherContact',
        displayName: 'Contact',
        targetTable: 'contact',
        relationshipSchemaName: 'NEW_CONTACT_CONSENTOUTBOX',
        deleteBehavior: 'Restrict'
      }
    ] as SchemaColumnDefinition[]) {
      const plan = structuredClone(consentOutboxPlan);
      if (plan.operation === 'create_table') plan.columns!.push(extra);
      expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    }
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      init: RequestInit
    ) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url.includes('RelationshipDefinitions?')
        ? response({ value: [{ SchemaName: 'new_contact_consentoutbox' }] })
        : original(url, init)
    );
    expect(
      (await execute({ action: 'prepare_schema_change', origin, plan: consentOutboxPlan })).ok
    ).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('resilient, searchable solution discovery', () => {
  it('returns valid matches even when another publisher prefix is missing or unsupported', async () => {
    solutions.unshift({
      ...schemaSolutionRow,
      uniquename: 'BadPublisher',
      publisherid: { ...schemaSolutionRow.publisherid, customizationprefix: '' }
    });
    solutions.push({
      ...schemaSolutionRow,
      uniquename: 'TooLong',
      publisherid: { ...schemaSolutionRow.publisherid, customizationprefix: 'toolongprefix' }
    });
    const result = await execute({ action: 'list_schema_solutions', origin, search: 'test table' });
    expect(result.ok, result.error).toBe(true);
    expect(result.solutions?.map((v) => v.uniqueName)).toEqual(['ExampleSolution']);
    expect(result.solutionIssues).toHaveLength(2);
    expect(result.solutionIssues![0]).toMatchObject({
      uniqueName: 'BadPublisher',
      reason: 'Invalid publisher prefix.'
    });
    expect(decodeURIComponent(fetchMock.mock.calls[0]![0])).toContain(
      "contains(friendlyname,'test table')"
    );
    expect((await prepare(createSchemaTablePlan)).solution.uniqueName).toBe('ExampleSolution');
  });

  it('does not relax publisher checks on a selected invalid solution', async () => {
    solutions[0]!.publisherid = { ...schemaSolutionRow.publisherid, customizationprefix: '' };
    const result = await execute({
      action: 'prepare_schema_change',
      origin,
      plan: createSchemaTablePlan
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid publisher prefix');
    expect(writes).toHaveLength(0);
  });

  it('preserves ambiguous display-name matches and OData-escapes the search literal', async () => {
    solutions.push({
      ...schemaSolutionRow,
      solutionid: '00000000-0000-0000-0000-000000000077',
      uniquename: 'OtherSolution'
    });
    const result = await execute({
      action: 'list_schema_solutions',
      origin,
      search: "team's test table"
    });
    expect(result.solutions).toHaveLength(2);
    expect(result.solutions?.map((v) => v.id)).toEqual([
      schemaSolutionRow.solutionid,
      '00000000-0000-0000-0000-000000000077'
    ]);
    expect(decodeURIComponent(fetchMock.mock.calls[0]![0])).toContain(
      "contains(friendlyname,'team''s test table')"
    );
  });

  it('uses the last candidate for continuation even when every page entry is unselectable', async () => {
    solutions = Array.from({ length: 51 }, (_, i) => ({
      ...schemaSolutionRow,
      uniquename: `Solution${String(i).padStart(3, '0')}`,
      publisherid: null
    }));
    const result = await execute({ action: 'list_schema_solutions', origin, search: 'test table' });
    expect(result.ok).toBe(true);
    expect(result.solutions).toEqual([]);
    expect(result.solutionIssues).toHaveLength(50);
    expect(result.nextAfterUniqueName).toBe('Solution049');
    expect(result.scannedSolutions).toBe(50);
    solutions = [schemaSolutionRow];
    await execute({
      action: 'list_schema_solutions',
      origin,
      search: 'test table',
      afterUniqueName: result.nextAfterUniqueName
    });
    const url = decodeURIComponent(fetchMock.mock.calls.at(-1)![0]);
    expect(url).toContain("uniquename gt 'Solution049'");
    expect(url).toContain("contains(friendlyname,'test table')");
  });
});
