import type {
  PreparedSchemaChange,
  PreparedSchemaStep,
  SchemaColumnDefinition,
  SchemaStepOutcome,
  SchemaPlan,
  SchemaPrimitiveRequest,
  SchemaPrimitiveResult,
  SchemaSolution
} from './schema/contracts';

/** Injected into the signed-in Dataverse page. All runtime helpers must stay inside this function. */
export async function executeDataverseSchemaPrimitive(
  request: SchemaPrimitiveRequest
): Promise<SchemaPrimitiveResult> {
  type Obj = Record<string, unknown>;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'OData-Version': '4.0',
    'OData-MaxVersion': '4.0'
  };
  const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown, name: string, max = 100, empty = false): string => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max)
      throw new Error(`Invalid ${name}.`);
    return v;
  };
  const name = (v: unknown): string => {
    const result = text(v, 'logical/schema name');
    if (!/^[a-z][a-z0-9_]*$/i.test(result)) throw new Error('Invalid logical/schema name.');
    return result;
  };
  const guid = (v: unknown): string => {
    const result = text(v, 'metadata/publisher ID', 36);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result))
      throw new Error('Invalid metadata/publisher ID.');
    return result;
  };
  const integer = (v: unknown, label: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`Invalid ${label}.`);
    return v;
  };
  const keys = (v: Obj, allowed: string[]) => {
    if (Object.keys(v).some((key) => !allowed.includes(key)))
      throw new Error(
        'Unsupported schema property. Only advertised, non-destructive settings may be changed.'
      );
  };
  // Provider schemas use null for unused options. Normalize it to omission, never a clear operation.
  const compact = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(compact)
      : object(v)
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, item]) => item != null)
              .map(([k, item]) => [k, compact(item)])
          )
        : v;
  const clean = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(clean)
      : object(v)
        ? Object.fromEntries(
            Object.entries(v)
              .filter(
                ([k]) =>
                  !['HasChanged', 'UserLocalizedLabel'].includes(k) &&
                  (!k.startsWith('@odata.') || k === '@odata.type')
              )
              .map(([k, item]) => [k, clean(item)])
          )
        : v;
  const canonical = (v: unknown, key = ''): string => {
    if (Array.isArray(v)) {
      const values = v.map((item) => canonical(item));
      if (
        [
          'Attributes',
          'OneToManyRelationships',
          'ManyToOneRelationships',
          'ManyToManyRelationships',
          'Privileges',
          'LocalizedLabels'
        ].includes(key)
      )
        values.sort();
      return `[${values.join(',')}]`;
    }
    if (object(v))
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(v[k], k)}`)
        .join(',')}}`;
    return JSON.stringify(v);
  };
  const revision = async (metadata: Obj): Promise<string> => {
    const bytes = new TextEncoder().encode(canonical(clean(metadata)));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
  };
  const api = async (
    path: string,
    method = 'GET',
    body?: Obj,
    extra: Record<string, string> = {}
  ): Promise<Obj> => {
    // Metadata writes (table creation with columns, publish) routinely exceed 30s server-side.
    const timeoutMs = method === 'GET' ? 30_000 : 300_000;
    let response: Response;
    try {
      response = await fetch(`${request.origin}/api/data/v9.2/${path}`, {
        method,
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...headers, ...extra },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new Error(
          `Dataverse did not respond within ${timeoutMs / 1000} seconds; the request may still complete on the server.`
        );
      throw error;
    }
    const maximum = 4 * 1024 * 1024;
    if (Number(response.headers.get('Content-Length')) > maximum)
      throw new Error('Schema response exceeds the 4 MiB safety limit.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw new Error('Schema response exceeds the 4 MiB safety limit.');
        }
        chunks.push(part.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const content = new TextDecoder().decode(bytes);
    if (!response.ok)
      throw Object.assign(
        new Error(`Dataverse schema request failed (${response.status}): ${content.slice(0, 700)}`),
        {
          definitiveRejection:
            response.status >= 400 && response.status < 500 && response.status !== 408
        }
      );
    if (!content) return {};
    const result: unknown = JSON.parse(content);
    if (!object(result)) throw new Error('Invalid Dataverse schema response.');
    return result;
  };
  const solutionFrom = (row: Obj): SchemaSolution => {
    if (row.ismanaged !== false || !object(row.publisherid))
      throw new Error('Select an unmanaged solution with a readable publisher.');
    const publisher = row.publisherid;
    const prefix = text(publisher.customizationprefix, 'publisher prefix', 8);
    if (!/^[a-z][a-z0-9]{1,7}$/i.test(prefix) || prefix.toLowerCase() === 'mscrm')
      throw new Error('Unsupported publisher prefix.');
    return {
      id: guid(row.solutionid),
      uniqueName: name(row.uniquename),
      displayName: text(row.friendlyname, 'solution display name', 256),
      publisherId: guid(publisher.publisherid),
      prefix,
      optionValuePrefix: integer(
        publisher.customizationoptionvalueprefix,
        'publisher option value prefix',
        10000,
        99999
      )
    };
  };
  const solutionQuery =
    'solutions?$select=solutionid,uniquename,friendlyname,ismanaged&$expand=publisherid($select=publisherid,customizationprefix,customizationoptionvalueprefix)';
  const getSolution = async (uniqueName: string): Promise<SchemaSolution> => {
    name(uniqueName);
    const result = await api(
      `${solutionQuery}&$filter=${encodeURIComponent(`uniquename eq '${uniqueName}'`)}&$top=2`
    );
    if (!Array.isArray(result.value) || result.value.length !== 1 || !object(result.value[0]))
      throw new Error('The exact solution was not found.');
    return solutionFrom(result.value[0]);
  };
  const readTable = async (logicalName: string, entityOnly = false): Promise<Obj> => {
    name(logicalName);
    // Unlike ordinary data reads this is explicitly latest/as-if-published metadata.
    const result = await api(
      `RetrieveEntity(EntityFilters=Microsoft.Dynamics.CRM.EntityFilters'${entityOnly ? 'Entity' : 'All'}',LogicalName='${logicalName}',MetadataId=00000000-0000-0000-0000-000000000000,RetrieveAsIfPublished=true)`
    );
    if (
      !object(result.EntityMetadata) ||
      result.EntityMetadata.LogicalName !== logicalName ||
      (!entityOnly &&
        ![
          'Attributes',
          'OneToManyRelationships',
          'ManyToOneRelationships',
          'ManyToManyRelationships',
          'Privileges'
        ].every((key) => Array.isArray((result.EntityMetadata as Obj)[key])))
    )
      throw new Error('The latest complete table metadata could not be read.');
    const partial = (value: unknown): boolean =>
      Array.isArray(value)
        ? value.some(partial)
        : object(value) &&
          Object.entries(value).some(
            ([key, item]) => key.endsWith('@odata.nextLink') || partial(item)
          );
    if (partial(result)) throw new Error('Partial metadata cannot be used for schema changes.');
    guid(result.EntityMetadata.MetadataId);
    return result.EntityMetadata;
  };
  const flag = (v: unknown) => object(v) && v.Value === true;
  const editableTable = (table: Obj) => {
    if (
      table.IsCustomEntity !== true ||
      table.IsManaged !== false ||
      !flag(table.IsCustomizable) ||
      table.IsActivity !== false ||
      table.IsIntersect !== false ||
      (table.TableType != null && table.TableType !== 'Standard') ||
      table.DataProviderId != null
    )
      throw new Error(
        'Only customizable, unmanaged, standard custom tables are writable in this version.'
      );
  };
  const label = (value: string, languageCode: number) => ({
    LocalizedLabels: [{ Label: value, LanguageCode: languageCode }]
  });
  const setLabel = (body: Obj, key: string, value: string, languageCode: number) => {
    const previous = object(body[key]) ? body[key] : {};
    const labels = Array.isArray(previous.LocalizedLabels) ? previous.LocalizedLabels : [];
    body[key] = {
      ...previous,
      LocalizedLabels: [
        ...labels.filter((item) => object(item) && item.LanguageCode !== languageCode),
        { Label: value, LanguageCode: languageCode }
      ]
    };
  };
  const schemaName = (value: unknown, solution: SchemaSolution) => {
    const result = name(value);
    if (
      !result.toLowerCase().startsWith(`${solution.prefix.toLowerCase()}_`) ||
      result.length <= solution.prefix.length + 1
    )
      throw new Error(`Schema names must use the selected publisher prefix ${solution.prefix}_.`);
    return result;
  };
  const requiredLevel = (v: unknown): string => {
    if (!['None', 'Recommended', 'ApplicationRequired'].includes(String(v)))
      throw new Error('Invalid requirement level.');
    return String(v);
  };
  const types: Record<string, string> = {
    text: 'String',
    multiline: 'Memo',
    integer: 'Integer',
    decimal: 'Decimal',
    date: 'DateTime',
    datetime: 'DateTime',
    boolean: 'Boolean',
    choice: 'Picklist',
    lookup: 'Lookup'
  };
  const columnBody = (input: unknown, solution: SchemaSolution, languageCode: number): Obj => {
    if (!object(input)) throw new Error('A column definition is required.');
    keys(input, [
      'schemaName',
      'displayName',
      'description',
      'type',
      'requiredLevel',
      'maxLength',
      'minValue',
      'maxValue',
      'precision',
      'choices',
      'falseLabel',
      'trueLabel',
      'defaultBoolean',
      'defaultChoice',
      'dateTimeBehavior',
      'targetTable',
      'relationshipSchemaName',
      'deleteBehavior'
    ]);
    const type = text(input.type, 'column type');
    if (!Object.hasOwn(types, type)) throw new Error('Unsupported column type.');
    const applicable: Record<string, string[]> = {
      text: ['maxLength'],
      multiline: ['maxLength'],
      integer: ['minValue', 'maxValue'],
      decimal: ['minValue', 'maxValue', 'precision'],
      date: [],
      datetime: ['dateTimeBehavior'],
      boolean: ['falseLabel', 'trueLabel', 'defaultBoolean'],
      choice: ['choices', 'defaultChoice'],
      lookup: ['targetTable', 'relationshipSchemaName', 'deleteBehavior']
    };
    for (const property of [
      'maxLength',
      'minValue',
      'maxValue',
      'precision',
      'choices',
      'falseLabel',
      'trueLabel',
      'defaultBoolean',
      'defaultChoice',
      'dateTimeBehavior',
      'targetTable',
      'relationshipSchemaName',
      'deleteBehavior'
    ])
      if (input[property] !== undefined && !applicable[type]!.includes(property))
        throw new Error(`${property} is not applicable to ${type}.`);
    const body: Obj = {
      '@odata.type': `Microsoft.Dynamics.CRM.${types[type]}AttributeMetadata`,
      SchemaName: schemaName(input.schemaName, solution),
      DisplayName: label(text(input.displayName, 'column display name'), languageCode),
      Description: label(text(input.description ?? '', 'description', 2000, true), languageCode),
      RequiredLevel: { Value: requiredLevel(input.requiredLevel ?? 'None') }
    };
    if (type === 'text' || type === 'multiline') {
      body.MaxLength = integer(
        input.maxLength,
        'text maximum length',
        1,
        type === 'text' ? 4000 : 1048576
      );
      if (type === 'text') body.FormatName = { Value: 'Text' };
      else body.Format = 'Text';
    }
    if (type === 'integer' || type === 'decimal') {
      const limit = type === 'integer' ? 2147483647 : 100000000000;
      const min = input.minValue;
      const max = input.maxValue;
      if (
        typeof min !== 'number' ||
        typeof max !== 'number' ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        min < -limit ||
        max > limit ||
        min >= max ||
        (type === 'integer' && (!Number.isInteger(min) || !Number.isInteger(max)))
      )
        throw new Error('Valid explicit numeric bounds are required.');
      body.MinValue = min;
      body.MaxValue = max;
      if (type === 'integer') body.Format = 'None';
      else body.Precision = integer(input.precision, 'decimal precision', 0, 10);
    }
    if (type === 'date') {
      body.Format = 'DateOnly';
      body.DateTimeBehavior = { Value: 'DateOnly' };
    }
    if (type === 'datetime') {
      if (!['UserLocal', 'TimeZoneIndependent'].includes(String(input.dateTimeBehavior)))
        throw new Error(
          'Date-time columns require explicit UserLocal or TimeZoneIndependent behavior.'
        );
      body.Format = 'DateAndTime';
      body.DateTimeBehavior = { Value: input.dateTimeBehavior };
    }
    if (type === 'boolean') {
      if (input.defaultBoolean !== undefined && typeof input.defaultBoolean !== 'boolean')
        throw new Error('Boolean defaults must be true or false.');
      body.DefaultValue = input.defaultBoolean ?? false;
      body.OptionSet = {
        '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
        TrueOption: { Value: 1, Label: label(text(input.trueLabel, 'true label'), languageCode) },
        FalseOption: { Value: 0, Label: label(text(input.falseLabel, 'false label'), languageCode) }
      };
    }
    if (type === 'choice') {
      if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 100)
        throw new Error('Provide 1–100 local Choice labels.');
      const options = input.choices.map((v) => text(v, 'Choice label'));
      if (new Set(options.map((v) => v.trim().toLowerCase())).size !== options.length)
        throw new Error('Choice labels must be unique.');
      if (input.defaultChoice !== undefined) {
        const index = options.indexOf(text(input.defaultChoice, 'default Choice label'));
        if (index < 0)
          throw new Error('Default Choice must exactly match one of the proposed labels.');
        body.DefaultFormValue = solution.optionValuePrefix * 10000 + index;
      }
      body.OptionSet = {
        '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
        IsGlobal: false,
        OptionSetType: 'Picklist',
        Options: options.map((v, i) => ({
          Value: solution.optionValuePrefix * 10000 + i,
          Label: label(v, languageCode)
        }))
      };
    }
    return body;
  };
  const relationshipBody = async (
    column: SchemaColumnDefinition,
    sourceName: string,
    solution: SchemaSolution,
    languageCode: number,
    referenceRevisions: Record<string, string>,
    source?: Obj
  ): Promise<Obj> => {
    const lookup = columnBody(column, solution, languageCode);
    const targetName = name(column.targetTable);
    if (targetName === sourceName)
      throw new Error('Self-referencing lookups are not supported in this version.');
    const relationName = schemaName(column.relationshipSchemaName, solution);
    if (!['Restrict', 'RemoveLink'].includes(String(column.deleteBehavior)))
      throw new Error(
        'Lookup deletion behavior must explicitly be Restrict or RemoveLink; cascading deletion is not supported.'
      );
    if (source && !flag(source.CanBeRelatedEntityInRelationship))
      throw new Error('The source table cannot be the referencing table.');
    const target = await readTable(targetName, true);
    if (
      !flag(target.CanBePrimaryEntityInRelationship) ||
      target.IsIntersect !== false ||
      target.IsActivity !== false ||
      target.DataProviderId != null ||
      (target.TableType != null && target.TableType !== 'Standard')
    )
      throw new Error('The referenced table is not eligible for this lookup relationship.');
    referenceRevisions[targetName] = await revision(target);
    const existing = await api(
      `RelationshipDefinitions?$select=SchemaName&$filter=${encodeURIComponent(`SchemaName eq '${relationName}'`)}`
    );
    if (!Array.isArray(existing.value) || existing.value.length)
      throw new Error(
        `Relationship ${relationName} already exists or name availability could not be verified.`
      );
    return {
      '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      SchemaName: relationName,
      ReferencedEntity: targetName,
      ReferencedAttribute: name(target.PrimaryIdAttribute),
      ReferencingEntity: sourceName,
      Lookup: lookup,
      AssociatedMenuConfiguration: { Behavior: 'DoNotDisplay', Group: 'Details', Order: 10000 },
      CascadeConfiguration: {
        Assign: 'NoCascade',
        Delete: column.deleteBehavior,
        Merge: 'NoCascade',
        Reparent: 'NoCascade',
        Share: 'NoCascade',
        Unshare: 'NoCascade'
      }
    };
  };
  const prepare = async (raw: SchemaPlan): Promise<PreparedSchemaChange> => {
    if (JSON.stringify(raw ?? null).length > 128_000)
      throw new Error('The schema plan exceeds the safety limit.');
    const plan = compact(raw) as SchemaPlan;
    if (!object(plan)) throw new Error('A schema plan is required.');
    const common = ['operation', 'solutionUniqueName', 'languageCode'];
    const allowed: Record<string, string[]> = {
      create_table: [
        'schemaName',
        'displayName',
        'pluralName',
        'description',
        'ownership',
        'primaryName',
        'columns'
      ],
      create_column: ['tableLogicalName', 'baseRevision', 'column'],
      update_table: ['tableLogicalName', 'baseRevision', 'changes'],
      update_column: ['tableLogicalName', 'columnLogicalName', 'baseRevision', 'changes'],
      publish_table: ['tableLogicalName', 'baseRevision']
    };
    if (!Object.hasOwn(allowed, plan.operation)) throw new Error('Unsupported schema operation.');
    keys(plan as unknown as Obj, [...common, ...allowed[plan.operation]!]);
    const languageCode = integer(plan.languageCode, 'language LCID', 1, 65535);
    const solution = await getSolution(plan.solutionUniqueName);
    let tableLogicalName: string;
    let columnLogicalName: string | undefined;
    let before: Obj | undefined;
    let after: Obj;
    let baseRevision: string | undefined;
    const referenceRevisions: Record<string, string> = {};
    const relationships: PreparedSchemaStep[] = [];
    const warnings = [
      'Dataverse enforces customization and solution permissions. Schema changes can affect apps, integrations, and automation.',
      'Requests are not retried automatically. If the outcome is uncertain, inspect the schema before preparing another preview.'
    ];
    if (plan.operation === 'create_table') {
      const schema = schemaName(plan.schemaName, solution);
      tableLogicalName = schema.toLowerCase();
      const existing = await api(
        `EntityDefinitions?$select=LogicalName&$filter=${encodeURIComponent(`LogicalName eq '${tableLogicalName}'`)}`
      );
      if (!Array.isArray(existing.value) || existing.value.length)
        throw new Error('The table already exists or name availability could not be verified.');
      if (!['UserOwned', 'OrganizationOwned'].includes(plan.ownership))
        throw new Error('Invalid ownership type.');
      if (!object(plan.primaryName)) throw new Error('A primary-name column is required.');
      keys(plan.primaryName, ['schemaName', 'displayName', 'maxLength']);
      const primary = columnBody({ ...plan.primaryName, type: 'text' }, solution, languageCode);
      integer(primary.MaxLength, 'primary-name maximum length', 1, 850);
      after = {
        '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
        SchemaName: schema,
        DisplayName: label(text(plan.displayName, 'table display name'), languageCode),
        DisplayCollectionName: label(text(plan.pluralName, 'plural display name'), languageCode),
        Description: label(text(plan.description ?? '', 'description', 2000, true), languageCode),
        OwnershipType: plan.ownership,
        IsActivity: false,
        HasActivities: false,
        HasNotes: false,
        Attributes: [{ ...primary, IsPrimaryName: true }]
      };
      if (plan.columns !== undefined && (!Array.isArray(plan.columns) || plan.columns.length > 20))
        throw new Error('A complete table plan supports up to 20 additional columns.');
      if (String(primary.SchemaName).toLowerCase() === `${tableLogicalName}id`)
        throw new Error(
          'The primary-name column cannot use the automatically generated primary-ID name.'
        );
      const columnNames = new Set([
        String(primary.SchemaName).toLowerCase(),
        `${tableLogicalName}id`
      ]);
      const relationshipNames = new Set<string>();
      for (const column of plan.columns ?? []) {
        const body = columnBody(column, solution, languageCode);
        const logicalName = String(body.SchemaName).toLowerCase();
        if (columnNames.has(logicalName))
          throw new Error(
            'Column schema names must be unique and not collide with the primary name/ID.'
          );
        columnNames.add(logicalName);
        if (column.type === 'lookup') {
          const relationship = await relationshipBody(
            column,
            tableLogicalName,
            solution,
            languageCode,
            referenceRevisions
          );
          const relationshipName = String(relationship.SchemaName).toLowerCase();
          if (relationshipNames.has(relationshipName))
            throw new Error('Relationship schema names must be unique.');
          relationshipNames.add(relationshipName);
          relationships.push({
            kind: 'relationship',
            components: [`${tableLogicalName}.${logicalName}`, String(relationship.SchemaName)],
            method: 'POST',
            path: 'RelationshipDefinitions',
            body: relationship
          });
        } else (after.Attributes as Obj[]).push(body);
      }
      warnings.push(
        'Schema names and ownership cannot be changed later. Table creation does not add it to an app or grant record access. New metadata may be immediately available; this operation does not call PublishXml.'
      );
    } else {
      tableLogicalName = name(plan.tableLogicalName);
      const table = await readTable(tableLogicalName);
      editableTable(table);
      baseRevision = await revision(table);
      if (plan.baseRevision !== baseRevision)
        throw new Error(
          'The table metadata changed or its revision is missing. Read the table definition again and prepare a fresh preview.'
        );
      if (plan.operation === 'create_column') {
        if (!flag(table.CanCreateAttributes))
          throw new Error('This table does not allow new columns.');
        after = columnBody(plan.column, solution, languageCode);
        columnLogicalName = String(after.SchemaName).toLowerCase();
        if (
          (table.Attributes as Obj[]).some(
            (attribute) => attribute.LogicalName === columnLogicalName
          )
        )
          throw new Error('That column already exists.');
        if (plan.column.type === 'lookup') {
          after = await relationshipBody(
            plan.column,
            tableLogicalName,
            solution,
            languageCode,
            referenceRevisions,
            table
          );
          relationships.push({
            kind: 'relationship',
            components: [`${tableLogicalName}.${columnLogicalName}`, String(after.SchemaName)],
            method: 'POST',
            path: 'RelationshipDefinitions',
            body: after
          });
        }
        warnings.push(
          'Adding a column does not add it to forms or views. Metadata may be immediately available; no PublishXml call is included.'
        );
      } else if (plan.operation === 'publish_table') {
        before = clean(table) as Obj;
        after = {
          ParameterXml: `<importexportxml><entities><entity>${tableLogicalName}</entity></entities></importexportxml>`
        };
        warnings.push(
          'Publishes ALL pending customizations for this table, including changes made by other people and table-related forms/views. This is not limited to Oddy edits. The metadata snapshot below covers table, columns, and relationships, not an exhaustive forms/views diff. Proceed only if all pending table customizations are ready.'
        );
      } else {
        let target = table;
        if (plan.operation === 'update_column') {
          columnLogicalName = name(plan.columnLogicalName);
          const attribute = (table.Attributes as Obj[]).find(
            (v) => v.LogicalName === columnLogicalName
          );
          if (
            !attribute ||
            attribute.IsCustomAttribute !== true ||
            attribute.IsManaged !== false ||
            !flag(attribute.IsCustomizable) ||
            attribute.IsPrimaryId === true ||
            attribute.AttributeOf != null ||
            attribute.SourceType !== 0
          )
            throw new Error(
              'Only customizable, unmanaged, non-derived custom columns can be edited.'
            );
          if (
            !Object.values(types)
              .filter((type) => type !== 'Lookup')
              .includes(String(attribute.AttributeType))
          )
            throw new Error('This column type is inspection-only.');
          target = attribute;
        }
        before = clean(target) as Obj;
        if (plan.operation === 'update_table') {
          for (const k of [
            'Attributes',
            'OneToManyRelationships',
            'ManyToOneRelationships',
            'ManyToManyRelationships',
            'Keys',
            'Privileges'
          ])
            delete before[k];
        } else {
          before['@odata.type'] = `Microsoft.Dynamics.CRM.${target.AttributeType}AttributeMetadata`;
        }
        after = JSON.parse(JSON.stringify(before)) as Obj;
        const changes = plan.changes;
        if (!object(changes) || !Object.keys(changes).length)
          throw new Error('At least one explicit setting is required.');
        keys(
          changes,
          plan.operation === 'update_table'
            ? ['displayName', 'pluralName', 'description']
            : ['displayName', 'description', 'requiredLevel', 'maxLength']
        );
        if (
          (changes.displayName != null || changes.pluralName != null) &&
          !flag(target.IsRenameable)
        )
          throw new Error('The target does not allow renaming its display labels.');
        for (const [key, property] of [
          ['displayName', 'DisplayName'],
          ['pluralName', 'DisplayCollectionName'],
          ['description', 'Description']
        ] as const) {
          const value = changes[key as keyof typeof changes];
          if (value !== undefined)
            setLabel(
              after,
              property,
              text(value, key, key === 'description' ? 2000 : 100, key === 'description'),
              languageCode
            );
        }
        if (changes.requiredLevel !== undefined) {
          if (
            !object(target.RequiredLevel) ||
            target.RequiredLevel.CanBeChanged !== true ||
            target.RequiredLevel.Value === 'SystemRequired'
          )
            throw new Error('Requirement level cannot be changed.');
          after.RequiredLevel = {
            ...(clean(target.RequiredLevel) as Obj),
            Value: requiredLevel(changes.requiredLevel)
          };
        }
        if (changes.maxLength !== undefined) {
          if (
            !['String', 'Memo'].includes(String(target.AttributeType)) ||
            !flag(target.CanModifyAdditionalSettings) ||
            typeof target.MaxLength !== 'number'
          )
            throw new Error('Maximum length cannot be changed for this column.');
          const maxLength = integer(
            changes.maxLength,
            'text maximum length',
            target.MaxLength,
            target.IsPrimaryName === true ? 850 : target.AttributeType === 'String' ? 4000 : 1048576
          );
          after.MaxLength = maxLength;
        }
        if (canonical(before) === canonical(after))
          throw new Error('The requested settings are unchanged.');
        warnings.push(
          'Saves metadata without publishing. Review and approve table publishing separately.'
        );
      }
      warnings.push(
        'The latest metadata is re-read before execution. Snapshot comparison is not an atomic concurrency guarantee: another maker could change metadata between the check and request.'
      );
    }
    const steps: PreparedSchemaStep[] = [];
    const entityPath = `EntityDefinitions(LogicalName='${tableLogicalName}')`;
    if (plan.operation === 'create_table')
      steps.push({
        kind: 'table',
        components: [
          tableLogicalName,
          ...(after.Attributes as Obj[]).map(
            (v) => `${tableLogicalName}.${String(v.SchemaName).toLowerCase()}`
          )
        ],
        method: 'POST',
        path: 'EntityDefinitions',
        body: after
      });
    else if (plan.operation === 'create_column' && plan.column.type !== 'lookup')
      steps.push({
        kind: 'column',
        components: [`${tableLogicalName}.${columnLogicalName}`],
        method: 'POST',
        path: `${entityPath}/Attributes`,
        body: after
      });
    else if (plan.operation === 'update_table')
      steps.push({
        kind: 'table',
        components: [tableLogicalName],
        method: 'PUT',
        path: entityPath,
        body: after
      });
    else if (plan.operation === 'update_column')
      steps.push({
        kind: 'column',
        components: [`${tableLogicalName}.${columnLogicalName}`],
        method: 'PUT',
        path: `${entityPath}/Attributes(LogicalName='${columnLogicalName}')`,
        body: after
      });
    else if (plan.operation === 'publish_table')
      steps.push({
        kind: 'publish',
        components: [tableLogicalName],
        method: 'POST',
        path: 'PublishXml',
        body: after
      });
    steps.push(...relationships);
    if (steps.length > 1)
      warnings.push(
        'One approval covers the entire ordered plan, NOT a global transaction. Scalar columns are created with the table; lookup relationships follow separately. A failure stops remaining steps without rollback or automatic retries. Inspect actual metadata before a new preview.'
      );
    const columns =
      plan.operation === 'create_table'
        ? (plan.columns ?? [])
        : plan.operation === 'create_column'
          ? [plan.column]
          : [];
    if (columns.some((v) => v.type === 'choice' && v.defaultChoice !== undefined))
      warnings.push(
        'Choice defaults are form defaults (DefaultFormValue). API/automation producers must explicitly write the intended processing status; omission is not a server-side Pending guarantee.'
      );
    if (columns.some((v) => v.type === 'datetime'))
      warnings.push(
        'UserLocal timestamps represent UTC instants displayed in the viewer’s time zone; TimeZoneIndependent values are wall times without conversion. Timestamp precision must be validated in the target tenant.'
      );
    return {
      mode: 'schema-v2',
      id: crypto.randomUUID(),
      environmentOrigin: request.origin,
      plan,
      solution,
      tableLogicalName,
      columnLogicalName,
      baseRevision,
      before,
      after,
      warnings,
      steps,
      referenceRevisions
    };
  };

  try {
    if (
      window.location.origin !== request.origin ||
      new URL(request.origin).origin !== request.origin ||
      !request.origin.startsWith('https://')
    )
      throw new Error('The active Dataverse environment changed.');
    if (request.action === 'list_schema_solutions') {
      const after = request.afterUniqueName ? name(request.afterUniqueName) : undefined;
      const search =
        request.search != null ? text(request.search, 'solution search', 256).trim() : undefined;
      const literal = search?.replace(/'/g, "''");
      const filter = `ismanaged eq false and uniquename ne 'Active'${after ? ` and uniquename gt '${after}'` : ''}${literal ? ` and (contains(friendlyname,'${literal}') or contains(uniquename,'${literal}'))` : ''}`;
      const result = await api(
        `${solutionQuery}&$filter=${encodeURIComponent(filter)}&$orderby=uniquename asc&$top=51`
      );
      if (!Array.isArray(result.value) || result['@odata.nextLink'])
        throw new Error('Could not read a complete bounded solution page.');
      const candidates = result.value.slice(0, 50);
      const solutions: SchemaSolution[] = [];
      const solutionIssues: NonNullable<SchemaPrimitiveResult['solutionIssues']> = [];
      for (const row of candidates) {
        try {
          if (!object(row)) throw new Error('Invalid solution row.');
          solutions.push(solutionFrom(row));
        } catch (error) {
          solutionIssues.push({
            ...(object(row)
              ? {
                  id: typeof row.solutionid === 'string' ? row.solutionid : undefined,
                  uniqueName: typeof row.uniquename === 'string' ? row.uniquename : undefined,
                  displayName: typeof row.friendlyname === 'string' ? row.friendlyname : undefined
                }
              : {}),
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const last = candidates.at(-1);
      return {
        ok: true,
        action: request.action,
        solutions,
        solutionIssues,
        scannedSolutions: candidates.length,
        ...(result.value.length > 50
          ? { nextAfterUniqueName: name(object(last) ? last.uniquename : undefined) }
          : {})
      };
    }
    if (request.action === 'get_table_definition') {
      const table = await readTable(name(request.tableLogicalName));
      // The full snapshot is only needed locally; give the model a bounded discovery projection.
      const select = (row: Obj, fields: string[]) =>
        Object.fromEntries(
          fields.filter((k) => row[k] !== undefined).map((k) => [k, clean(row[k])])
        );
      const metadata = select(table, [
        'SchemaName',
        'DisplayName',
        'DisplayCollectionName',
        'Description',
        'OwnershipType',
        'IsManaged',
        'IsCustomEntity',
        'IsCustomizable',
        'IsRenameable',
        'CanCreateAttributes',
        'PrimaryIdAttribute',
        'TableType',
        'DataProviderId',
        'CanBeRelatedEntityInRelationship',
        'CanBePrimaryEntityInRelationship'
      ]);
      metadata.Attributes = (table.Attributes as Obj[]).map((v) =>
        select(v, [
          'LogicalName',
          'SchemaName',
          'AttributeType',
          'DisplayName',
          'Description',
          'IsManaged',
          'IsCustomAttribute',
          'IsCustomizable',
          'IsRenameable',
          'RequiredLevel',
          'MaxLength',
          'SourceType',
          'IsPrimaryName',
          'Targets',
          'DateTimeBehavior',
          'Format',
          'DefaultValue',
          'DefaultFormValue',
          'OptionSet',
          'MinValue',
          'MaxValue',
          'Precision'
        ])
      );
      metadata.ManyToOneRelationships = (table.ManyToOneRelationships as Obj[]).map((v) =>
        select(v, [
          'MetadataId',
          'SchemaName',
          'ReferencedEntity',
          'ReferencedAttribute',
          'ReferencingEntity',
          'ReferencingAttribute',
          'CascadeConfiguration'
        ])
      );
      return {
        ok: true,
        action: request.action,
        tableDefinition: {
          logicalName: String(table.LogicalName),
          metadataId: guid(table.MetadataId),
          revision: await revision(table),
          metadata
        }
      };
    }
    if (request.action === 'prepare_schema_change')
      return { ok: true, action: request.action, schemaChange: await prepare(request.plan) };
    if (request.action !== 'execute_schema_change') throw new Error('Unsupported schema action.');
    const change = request.change;
    if (
      change.mode !== 'schema-v2' ||
      !change.steps?.length ||
      change.environmentOrigin !== request.origin
    )
      throw new Error('This schema preview is invalid or belongs to another environment.');
    const fresh = await prepare(change.plan);
    for (const key of [
      'solution',
      'tableLogicalName',
      'columnLogicalName',
      'baseRevision',
      'before',
      'after',
      'steps',
      'referenceRevisions'
    ] as const) {
      if (canonical(fresh[key] ?? null) !== canonical(change[key] ?? null))
        throw new Error(
          'The approved schema payload or metadata changed. Prepare a fresh preview.'
        );
    }
    const outcomes: SchemaStepOutcome[] = fresh.steps!.map((step) => ({
      components: step.components,
      status: 'not-attempted'
    }));
    let createdSourceId: string | undefined;
    for (let i = 0; i < fresh.steps!.length; i++) {
      const step = fresh.steps![i]!;
      let submitted = false;
      try {
        if (window.location.origin !== request.origin)
          throw new Error('The active Dataverse environment changed.');
        if (canonical(await getSolution(fresh.solution.uniqueName)) !== canonical(fresh.solution))
          throw new Error('The selected solution or publisher changed. Prepare a fresh preview.');
        if (step.kind === 'relationship') {
          const targetName = name(step.body.ReferencedEntity);
          if (
            (await revision(await readTable(targetName, true))) !==
            fresh.referenceRevisions?.[targetName]
          )
            throw new Error(
              'Referenced table metadata changed. Inspect the schema and prepare a fresh preview.'
            );
          const source = await readTable(fresh.tableLogicalName);
          editableTable(source);
          if (!flag(source.CanBeRelatedEntityInRelationship))
            throw new Error('Source table no longer permits lookup relationships.');
          if (fresh.plan.operation === 'create_table') {
            if (
              String(source.SchemaName).toLowerCase() !== fresh.tableLogicalName ||
              source.OwnershipType !== fresh.plan.ownership
            )
              throw new Error('The created source table no longer matches the approved plan.');
            const sourceId = guid(source.MetadataId);
            if (createdSourceId && createdSourceId !== sourceId)
              throw new Error('The source table identity changed.');
            createdSourceId = sourceId;
          } else if ((await revision(source)) !== fresh.baseRevision) {
            throw new Error('Source table metadata changed. Prepare a fresh preview.');
          }
          const lookup = step.body.Lookup as Obj;
          if (
            (source.Attributes as Obj[]).some(
              (v) => String(v.LogicalName).toLowerCase() === String(lookup.SchemaName).toLowerCase()
            )
          )
            throw new Error(
              'The approved lookup column already exists. Inspect it before a fresh preview.'
            );
        }
        submitted = true;
        await api(step.path, step.method, step.body, {
          'MSCRM.SolutionUniqueName': fresh.solution.uniqueName,
          'MSCRM.MergeLabels': 'true'
        });
        outcomes[i] = { components: step.components, status: 'succeeded' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const definite =
          error instanceof Error &&
          'definitiveRejection' in error &&
          error.definitiveRejection === true;
        outcomes[i] = {
          components: step.components,
          status: !submitted ? 'not-attempted' : definite ? 'failed' : 'unknown',
          message: detail
        };
        const partial = outcomes.some((v) => v.status === 'succeeded');
        const message = `${partial ? 'Schema plan partially completed; prior successful steps remain.' : 'Schema plan did not complete.'} ${submitted && !definite ? 'The last submitted request has an uncertain outcome.' : ''} ${detail} Remaining steps were not attempted. No rollback or automatic retry was performed. ${fresh.plan.operation === 'publish_table' ? 'The publish request outcome must be inspected before any new approval.' : 'No publish request was sent.'} Inspect actual table/column/relationship metadata before preparing a NEW approval; do not recreate the table blindly.`;
        return {
          ok: false,
          action: request.action,
          error: message,
          schemaChangeResult: {
            operation: fresh.plan.operation,
            tableLogicalName: fresh.tableLogicalName,
            columnLogicalName: fresh.columnLogicalName,
            solutionUniqueName: fresh.solution.uniqueName,
            status: partial ? 'partial' : 'failed',
            message,
            outcomes
          }
        };
      }
    }
    const published = fresh.plan.operation === 'publish_table';
    return {
      ok: true,
      action: request.action,
      schemaChangeResult: {
        operation: fresh.plan.operation,
        tableLogicalName: fresh.tableLogicalName,
        columnLogicalName: fresh.columnLogicalName,
        solutionUniqueName: fresh.solution.uniqueName,
        status: published ? 'published' : 'saved',
        message: published
          ? 'Published all pending customizations for this table.'
          : 'Complete approved schema plan saved. No publish request was sent; new metadata may already be available. Forms, views, app membership, record access, event capture, delivery, and retries were not configured.',
        outcomes
      }
    };
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
