import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseSchemaPrimitive as execute } from '../lib/dataverse-schema-primitives';
import type {
  PreparedSchemaChange,
  SchemaColumnDefinition,
  SchemaPlan
} from '../lib/schema/contracts';
import {
  createSchemaTablePlan,
  schemaOrigin as origin,
  schemaSolutionRow,
  schemaTable
} from './fixtures/schema';

let table: Record<string, unknown>;
let solution: Record<string, unknown>;
let exists: boolean;
let writes: Array<{ path: string; init: RequestInit; body: Record<string, unknown> }>;
let fetchMock: ReturnType<typeof vi.fn>;
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
beforeEach(() => {
  table = structuredClone(schemaTable);
  solution = structuredClone(schemaSolutionRow);
  exists = false;
  writes = [];
  vi.stubGlobal('window', { location: { origin } });
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const path = decodeURIComponent(url.split('/api/data/v9.2/')[1]!);
    if (init.method !== 'GET') {
      writes.push({ path, init, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }
    // Dataverse metadata endpoints reject $top (0x80060888).
    if (/^\w+Definitions\?/.test(path) && path.includes('$top'))
      return new Response(
        JSON.stringify({
          error: { code: '0x80060888', message: 'The query parameter $top is not supported' }
        }),
        { status: 400 }
      );
    if (path.startsWith('solutions?')) return response({ value: [solution] });
    if (path.startsWith('RetrieveEntity(')) return response({ EntityMetadata: table });
    if (path.startsWith('EntityDefinitions?'))
      return response({ value: exists ? [{ LogicalName: 'new_order' }] : [] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function readRevision() {
  const result = await execute({
    action: 'get_table_definition',
    origin,
    tableLogicalName: 'new_example'
  });
  expect(result.ok, result.error).toBe(true);
  return result.tableDefinition!.revision;
}
async function planFor(
  operation: 'update_table' | 'update_column' | 'publish_table' | 'create_column'
): Promise<SchemaPlan> {
  const common = {
    solutionUniqueName: 'ExampleSolution',
    languageCode: 1033,
    tableLogicalName: 'new_example',
    baseRevision: await readRevision()
  };
  if (operation === 'update_table')
    return { ...common, operation, changes: { displayName: 'Updated example' } };
  if (operation === 'update_column')
    return {
      ...common,
      operation,
      columnLogicalName: 'new_name',
      changes: { displayName: 'Updated name', maxLength: 200 }
    };
  if (operation === 'create_column')
    return {
      ...common,
      operation,
      column: { type: 'text', schemaName: 'new_Extra', displayName: 'Extra', maxLength: 500 }
    };
  return { ...common, operation };
}
async function prepare(plan: SchemaPlan): Promise<PreparedSchemaChange> {
  const result = await execute({ action: 'prepare_schema_change', origin, plan });
  expect(result.ok, result.error).toBe(true);
  return result.schemaChange!;
}
const apply = (change: PreparedSchemaChange) =>
  execute({ action: 'execute_schema_change', origin, change });

describe('approval-gated schema primitives', () => {
  it('survives MAIN-world function serialization without module closures', async () => {
    const injected = new Function(`return (${execute.toString()});`)() as typeof execute;
    const prepared = await injected({
      action: 'prepare_schema_change',
      origin,
      plan: createSchemaTablePlan
    });
    expect(prepared.ok, prepared.error).toBe(true);
    const result = await injected({
      action: 'execute_schema_change',
      origin,
      change: prepared.schemaChange!
    });
    expect(result.ok, result.error).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('refuses partial latest metadata and avoids sending table child keys on PUT', async () => {
    table.Keys = [{ SchemaName: 'new_AlternateKey' }];
    const change = await prepare(await planFor('update_table'));
    expect(change.before).not.toHaveProperty('Keys');
    expect(change.after).not.toHaveProperty('Keys');
    expect((await apply(change)).ok).toBe(true);
    table['Attributes@odata.nextLink'] = 'https://untrusted.example/partial';
    const result = await execute({
      action: 'get_table_definition',
      origin,
      tableLogicalName: 'new_example'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Partial metadata');
  });

  it('reads explicit latest/as-if-published metadata and exposes a stable revision', async () => {
    const first = await readRevision();
    expect(fetchMock.mock.calls[0]![0]).toContain('RetrieveAsIfPublished=true');
    expect(fetchMock.mock.calls[0]![0]).toContain("EntityFilters'All'");
    table.HasChanged = true;
    (table.DisplayName as Record<string, unknown>).UserLocalizedLabel = { Label: 'User language' };
    expect(await readRevision()).toBe(first);
    expect(writes).toEqual([]);
  });

  it('prepares a table without writes and creates it in the selected solution only after approval', async () => {
    const change = await prepare(createSchemaTablePlan);
    expect(writes).toHaveLength(0);
    expect(change.after).toMatchObject({
      SchemaName: 'new_Order',
      OwnershipType: 'UserOwned',
      Attributes: [{ IsPrimaryName: true, SchemaName: 'new_Name', MaxLength: 100 }]
    });
    const result = await apply(change);
    expect(result.ok, result.error).toBe(true);
    expect(result.schemaChangeResult).toMatchObject({
      operation: 'create_table',
      tableLogicalName: 'new_order',
      status: 'saved'
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: 'EntityDefinitions',
      init: {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: { 'MSCRM.SolutionUniqueName': 'ExampleSolution' }
      }
    });
    expect(writes.some((w) => w.path.includes('Publish'))).toBe(false);
  });

  it.each([
    { type: 'text', maxLength: 200 },
    { type: 'multiline', maxLength: 10000 },
    { type: 'integer', minValue: 0, maxValue: 1000 },
    { type: 'decimal', minValue: -100, maxValue: 100, precision: 2 },
    { type: 'date' },
    { type: 'boolean', falseLabel: 'No', trueLabel: 'Yes' },
    { type: 'choice', choices: ['First', 'Second'] }
  ] as Array<Partial<SchemaColumnDefinition>>)(
    'creates a supported $type column without publishing',
    async (spec) => {
      const plan = await planFor('create_column');
      if (plan.operation !== 'create_column') throw new Error('wrong plan');
      plan.column = {
        schemaName: 'new_Extra',
        displayName: 'Extra',
        ...spec
      } as SchemaColumnDefinition;
      const change = await prepare(plan);
      expect(writes).toHaveLength(0);
      const result = await apply(change);
      expect(result.ok, result.error).toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.path).toBe("EntityDefinitions(LogicalName='new_example')/Attributes");
      expect(writes[0]!.init.method).toBe('POST');
      if (spec.type === 'choice')
        expect(change.after.OptionSet).toMatchObject({
          IsGlobal: false,
          Options: [{ Value: 100000000 }, { Value: 100000001 }]
        });
      if (spec.type === 'date')
        expect(change.after).toMatchObject({
          DateTimeBehavior: { Value: 'DateOnly' },
          Format: 'DateOnly'
        });
    }
  );

  it.each(['update_table', 'update_column'] as const)(
    'uses PUT for %s and preserves translations and unrelated settings',
    async (operation) => {
      const change = await prepare(await planFor(operation));
      expect(writes).toHaveLength(0);
      const result = await apply(change);
      expect(result.ok, result.error).toBe(true);
      const write = writes[0]!;
      expect(write.init).toMatchObject({
        method: 'PUT',
        headers: { 'MSCRM.MergeLabels': 'true', 'MSCRM.SolutionUniqueName': 'ExampleSolution' }
      });
      expect(write.body.DisplayName).toMatchObject({
        LocalizedLabels: expect.arrayContaining([expect.objectContaining({ LanguageCode: 1032 })])
      });
      if (operation === 'update_table') {
        expect(write.body.IsAuditEnabled).toEqual(schemaTable.IsAuditEnabled);
        expect(write.body).not.toHaveProperty('Attributes');
        expect(change.before).not.toHaveProperty('Attributes');
      } else {
        expect(write.body.UnrelatedSetting).toBe('preserve-me');
        expect(write.body.MaxLength).toBe(200);
        expect(write.body['@odata.type']).toBe('Microsoft.Dynamics.CRM.StringAttributeMetadata');
      }
    }
  );

  it('publishes only the exact table in a separately approved PublishXml request', async () => {
    const change = await prepare(await planFor('publish_table'));
    expect(writes).toHaveLength(0);
    expect(change.warnings.join(' ')).toContain('ALL pending customizations');
    expect(change.warnings.join(' ')).toContain('other people');
    expect(change.before).toHaveProperty('Attributes');
    const result = await apply(change);
    expect(result.ok, result.error).toBe(true);
    expect(result.schemaChangeResult?.status).toBe('published');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: 'PublishXml',
      init: { method: 'POST' },
      body: {
        ParameterXml:
          '<importexportxml><entities><entity>new_example</entity></entities></importexportxml>'
      }
    });
  });

  it.each(['create_column', 'update_table', 'update_column', 'publish_table'] as const)(
    'rejects stale %s approvals',
    async (operation) => {
      const change = await prepare(await planFor(operation));
      table.IsAuditEnabled = { Value: false, CanBeChanged: true };
      const result = await apply(change);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metadata changed');
      expect(writes).toHaveLength(0);
    }
  );

  it('refuses missing revisions at preparation', async () => {
    const plan = await planFor('update_table');
    if (plan.operation === 'update_table') plan.baseRevision = '';
    const result = await execute({ action: 'prepare_schema_change', origin, plan });
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it.each(['solution', 'after', 'before'] as const)(
    'rebuilds and rejects modified approval %s',
    async (field) => {
      const change = await prepare(await planFor('update_table'));
      (change[field] as unknown as Record<string, unknown>).unexpected = 'tampered';
      const result = await apply(change);
      expect(result.ok).toBe(false);
      expect(writes).toHaveLength(0);
    }
  );

  it('rejects publisher drift, managed solutions, and table-name collisions before creation', async () => {
    const change = await prepare(createSchemaTablePlan);
    solution.publisherid = {
      ...schemaSolutionRow.publisherid,
      customizationoptionvalueprefix: 10001
    };
    expect((await apply(change)).ok).toBe(false);
    solution = { ...schemaSolutionRow, ismanaged: true };
    expect(
      (await execute({ action: 'prepare_schema_change', origin, plan: createSchemaTablePlan })).ok
    ).toBe(false);
    solution = structuredClone(schemaSolutionRow);
    exists = true;
    expect((await apply(change)).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it.each([
    { IsManaged: true },
    { IsCustomEntity: false },
    { IsCustomizable: { Value: false } },
    { IsActivity: true },
    { IsIntersect: true },
    { DataProviderId: 'provider' }
  ])('rejects unsupported or locked table metadata %j', async (overrides) => {
    Object.assign(table, overrides);
    const plan = await planFor('update_table');
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it.each([
    { IsManaged: true },
    { IsCustomAttribute: false },
    { IsCustomizable: { Value: false } },
    { SourceType: 1 },
    { AttributeOf: 'other_column' },
    { IsRenameable: { Value: false } }
  ])('rejects unsupported or locked column metadata %j', async (overrides) => {
    Object.assign((table.Attributes as Record<string, unknown>[])[0]!, overrides);
    const plan = await planFor('update_column');
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it.each([
    { maxLength: 50 },
    { type: 'Integer' },
    { schemaName: 'new_Other' },
    { requiredLevel: 'SystemRequired' },
    { minValue: 0 }
  ])('refuses destructive or unsupported edits %j', async (changes) => {
    const plan = await planFor('update_column');
    if (plan.operation === 'update_column') plan.changes = changes as never;
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('allows a permitted requirement edit, clears only explicit empty descriptions, and treats null as unchanged', async () => {
    const plan = await planFor('update_column');
    if (plan.operation !== 'update_column') throw new Error('wrong plan');
    plan.changes = {
      requiredLevel: 'ApplicationRequired',
      description: '',
      displayName: null
    } as never;
    const change = await prepare(plan);
    expect(change.after.RequiredLevel).toMatchObject({
      Value: 'ApplicationRequired',
      CanBeChanged: true
    });
    expect(change.after.DisplayName).toEqual(schemaTable.Attributes[0]!.DisplayName);
    expect(change.after.Description).toMatchObject({
      LocalizedLabels: [{ Label: '', LanguageCode: 1033 }]
    });
    expect((await apply(change)).ok).toBe(true);
  });

  it('rejects unknown actions, deletion, malicious names, wrong prefixes, irrelevant options, and empty edits', async () => {
    const plans = [
      { ...createSchemaTablePlan, operation: 'delete_table' },
      { ...createSchemaTablePlan, schemaName: 'other_Order' },
      { ...createSchemaTablePlan, schemaName: "new_order')/anything" },
      { ...createSchemaTablePlan, url: '/arbitrary' },
      { ...(await planFor('update_table')), changes: {} },
      {
        ...(await planFor('create_column')),
        column: {
          type: 'text',
          schemaName: 'new_X',
          displayName: 'X',
          maxLength: 100,
          choices: ['Not applicable']
        }
      }
    ];
    for (const plan of plans)
      expect(
        (await execute({ action: 'prepare_schema_change', origin, plan: plan as SchemaPlan })).ok
      ).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('rejects a column collision and an uneditable requirement level', async () => {
    const plan = await planFor('create_column');
    if (plan.operation === 'create_column') plan.column.schemaName = 'new_Name';
    expect((await execute({ action: 'prepare_schema_change', origin, plan })).ok).toBe(false);
    (table.Attributes as Record<string, unknown>[])[0]!.RequiredLevel = {
      Value: 'None',
      CanBeChanged: false
    };
    const edit = await planFor('update_column');
    if (edit.operation === 'update_column') edit.changes = { requiredLevel: 'ApplicationRequired' };
    expect((await execute({ action: 'prepare_schema_change', origin, plan: edit })).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('does not claim publication was absent after an uncertain publish response', async () => {
    const change = await prepare(await planFor('publish_table'));
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      init: RequestInit
    ) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      init.method === 'GET'
        ? original(url, init)
        : new Response('Connection failed', { status: 503 })
    );
    const result = await apply(change);
    expect(result.ok).toBe(false);
    expect(result.schemaChangeResult?.outcomes?.[0]?.status).toBe('unknown');
    expect(result.error).toContain('publish request outcome must be inspected');
    expect(result.error).not.toContain('No publish request was sent');
    expect(result.error).not.toContain('publish was performed');
  });

  it('never retries or publishes after a rejected metadata write', async () => {
    const change = await prepare(createSchemaTablePlan);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === 'GET'
        ? response({ value: _url.includes('solutions?') ? [solution] : [] })
        : new Response('Permission denied', { status: 403 })
    );
    const result = await apply(change);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('403') });
    const writeCalls = fetchMock.mock.calls.filter(([, options]) => options.method !== 'GET');
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]![0]).not.toContain('Publish');
  });

  it('checks the live origin before reads or writes', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://other.crm.dynamics.com' } });
    expect(
      (await execute({ action: 'prepare_schema_change', origin, plan: createSchemaTablePlan })).ok
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds responses and rejects malformed metadata instead of preparing a partial preview', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { headers: { 'Content-Length': '5000000' } }));
    expect(
      (await execute({ action: 'get_table_definition', origin, tableLogicalName: 'new_example' }))
        .error
    ).toContain('4 MiB');
    fetchMock.mockResolvedValue(response({ EntityMetadata: { ...schemaTable, Attributes: null } }));
    expect(
      (await execute({ action: 'get_table_definition', origin, tableLogicalName: 'new_example' }))
        .ok
    ).toBe(false);
  });
});

describe('solution discovery', () => {
  it('pages unmanaged solutions by exact unique name without exposing a fetchable cursor', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      ...schemaSolutionRow,
      uniquename: `Solution${String(i).padStart(3, '0')}`
    }));
    fetchMock.mockResolvedValue(response({ value: rows }));
    const first = await execute({ action: 'list_schema_solutions', origin });
    expect(first.ok, first.error).toBe(true);
    expect(first.solutions).toHaveLength(50);
    expect(first.nextAfterUniqueName).toBe('Solution049');
    fetchMock.mockResolvedValue(response({ value: [rows[50]] }));
    const last = await execute({
      action: 'list_schema_solutions',
      origin,
      afterUniqueName: first.nextAfterUniqueName
    });
    expect(last.nextAfterUniqueName).toBeUndefined();
    expect(decodeURIComponent(fetchMock.mock.calls.at(-1)![0])).toContain(
      "uniquename gt 'Solution049'"
    );
    expect(writes).toHaveLength(0);
  });
});
