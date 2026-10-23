import type {
  DataverseMutationExecutionResult,
  DataverseMutationInput,
  PreparedDataverseMutation,
  PreparedDataverseMutationField
} from './types';

export type DataverseFilterOperator =
  | 'not-null'
  | 'null'
  | 'eq'
  | 'ne'
  | 'contains'
  | 'begins-with'
  | 'ends-with'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'on'
  | 'on-or-after'
  | 'on-or-before';

export interface DataverseFilterSpec {
  column: string;
  operator: DataverseFilterOperator;
  value?: string;
  entityType?: string;
}

export interface DataverseOrderSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DataverseQuerySpec {
  table: string;
  columns?: string[];
  filters?: DataverseFilterSpec[];
  orderBy?: DataverseOrderSpec[];
  top?: number;
}

export type DataversePrimitiveRequest =
  | {
      action: 'resolve_schema';
      origin: string;
      table: string;
      columns?: string[];
    }
  | {
      action: 'query_records';
      origin: string;
      query: DataverseQuerySpec;
    }
  | {
      action: 'discover_relationships';
      origin: string;
      sourceTable: string;
      targetTable: string;
    }
  | {
      action: 'get_view';
      origin: string;
      table: string;
    }
  | {
      action: 'upsert_view';
      origin: string;
      query: DataverseQuerySpec;
      layoutColumns?: string[];
    }
  | {
      action: 'execute_view';
      origin: string;
      table: string;
      top?: number;
    }
  | {
      action: 'prepare_mutation';
      origin: string;
      mutation: DataverseMutationInput;
    }
  | {
      action: 'execute_mutation';
      origin: string;
      mutation: PreparedDataverseMutation;
      selectedColumns: string[];
    };

export interface ResolvedDataverseEntity {
  logicalName: string;
  entitySetName: string;
  primaryIdAttribute: string;
  primaryNameAttribute?: string;
  objectTypeCode?: number;
  displayName?: string;
  displayCollectionName?: string;
}

export interface ResolvedDataverseColumn {
  requestedName: string;
  logicalName: string;
  displayName?: string;
  attributeType?: string;
}

export interface DataverseRelationship {
  schemaName: string;
  sourceTable: string;
  targetTable: string;
  lookupColumn: string;
  direction: 'source-parent' | 'source-child';
  referencedNavigationPropertyName?: string;
  referencingNavigationPropertyName?: string;
}

export interface DataversePrimitiveResult {
  ok: boolean;
  action: DataversePrimitiveRequest['action'];
  entity?: ResolvedDataverseEntity;
  resolvedColumns?: ResolvedDataverseColumn[];
  unresolvedColumns?: string[];
  query?: DataverseQuerySpec;
  fetchXml?: string;
  layoutXml?: string;
  records?: Array<Record<string, unknown>>;
  totalCount?: number;
  relationships?: DataverseRelationship[];
  view?: {
    id: string;
    name: string;
    tableLogicalName: string;
    created?: boolean;
    query?: DataverseQuerySpec;
    layoutColumns?: string[];
  };
  mutation?: PreparedDataverseMutation;
  mutationResult?: DataverseMutationExecutionResult;
  warnings?: string[];
  error?: string;
}

/**
 * Runs inside the Dataverse page MAIN world. This is the single signed-session
 * executor behind the assistant's schema, query, relationship, and view primitives.
 */
export async function executeDataversePrimitive(
  request: DataversePrimitiveRequest
): Promise<DataversePrimitiveResult> {
  type EntityMetadata = {
    LogicalName?: string;
    EntitySetName?: string;
    PrimaryIdAttribute?: string;
    PrimaryNameAttribute?: string;
    ObjectTypeCode?: number;
    DisplayName?: { UserLocalizedLabel?: { Label?: string } };
    DisplayCollectionName?: { UserLocalizedLabel?: { Label?: string } };
  };
  type AttributeMetadata = {
    LogicalName?: string;
    AttributeType?: string;
    IsValidForRead?: boolean;
    IsValidForCreate?: boolean;
    IsValidForUpdate?: boolean;
    DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  };
  type RelationshipMetadata = {
    SchemaName?: string;
    ReferencedEntity?: string;
    ReferencingEntity?: string;
    ReferencingAttribute?: string;
    ReferencedEntityNavigationPropertyName?: string;
    ReferencingEntityNavigationPropertyName?: string;
  };

  const managedViewName = 'AI Result';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0'
  };
  const allowedOperators = new Set<DataverseFilterOperator>([
    'not-null',
    'null',
    'eq',
    'ne',
    'contains',
    'begins-with',
    'ends-with',
    'gt',
    'ge',
    'lt',
    'le',
    'on',
    'on-or-after',
    'on-or-before'
  ]);
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const xmlEscape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  const odataEscape = (value: string) => value.replace(/'/g, "''");
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.length > 2000 ? `${value.slice(0, 2000)}… [truncated]` : value;
    }
    if (depth > 2) return String(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !key.includes('@'))
          .slice(0, 30)
          .map(([key, item]) => [key, sanitize(item, depth + 1)])
      );
    }
    return String(value);
  };

  const getJson = async <T>(url: string, preferFormatted = false): Promise<T> => {
    const response = await fetch(url, {
      credentials: 'include',
      headers: preferFormatted
        ? {
            ...headers,
            Prefer:
              'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname"'
          }
        : headers
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  };

  const resolveEntity = async (tableName: string): Promise<ResolvedDataverseEntity> => {
    const raw = tableName.trim();
    if (!raw || raw.length > 100) throw new Error('A Dataverse table name is required.');
    const safe = raw.toLowerCase().replace(/\s+/g, '_');
    const candidates = [safe];
    if (safe.endsWith('ies')) candidates.push(`${safe.slice(0, -3)}y`);
    if (safe.endsWith('s')) candidates.push(safe.slice(0, -1));
    const select =
      'LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,ObjectTypeCode,DisplayName,DisplayCollectionName';

    let metadata: EntityMetadata | undefined;
    for (const candidate of [...new Set(candidates)]) {
      if (!/^[a-z0-9_]+$/i.test(candidate)) continue;
      const response = await fetch(
        `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${candidate}')?$select=${select}`,
        { credentials: 'include', headers }
      );
      if (response.ok) {
        metadata = (await response.json()) as EntityMetadata;
        break;
      }
      if (response.status !== 404) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`Could not resolve table metadata (${response.status}): ${detail}`);
      }
    }

    if (!metadata) {
      const entitySetUrl = new URL(`${request.origin}/api/data/v9.2/EntityDefinitions`);
      entitySetUrl.searchParams.set('$select', select);
      entitySetUrl.searchParams.set('$filter', `EntitySetName eq '${odataEscape(safe)}'`);
      const matches = await getJson<{ value?: EntityMetadata[] }>(entitySetUrl.toString());
      metadata = matches.value?.[0];
    }

    if (!metadata) {
      const catalogUrl = new URL(`${request.origin}/api/data/v9.2/EntityDefinitions`);
      catalogUrl.searchParams.set('$select', select);
      catalogUrl.searchParams.set('$filter', 'IsIntersect eq false');
      const catalog = await getJson<{ value?: EntityMetadata[] }>(catalogUrl.toString());
      const hints = new Set([raw, ...candidates].map(normalize));
      metadata = catalog.value?.find((entity) =>
        [
          entity.LogicalName,
          entity.EntitySetName,
          entity.DisplayName?.UserLocalizedLabel?.Label,
          entity.DisplayCollectionName?.UserLocalizedLabel?.Label
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => hints.has(normalize(value)))
      );
    }

    if (!metadata?.LogicalName || !metadata.EntitySetName || !metadata.PrimaryIdAttribute) {
      throw new Error(`Could not resolve the Dataverse table “${tableName}”.`);
    }
    return {
      logicalName: metadata.LogicalName,
      entitySetName: metadata.EntitySetName,
      primaryIdAttribute: metadata.PrimaryIdAttribute,
      primaryNameAttribute: metadata.PrimaryNameAttribute,
      objectTypeCode: metadata.ObjectTypeCode,
      displayName: metadata.DisplayName?.UserLocalizedLabel?.Label,
      displayCollectionName: metadata.DisplayCollectionName?.UserLocalizedLabel?.Label
    };
  };

  const getAttributes = async (entity: ResolvedDataverseEntity): Promise<AttributeMetadata[]> => {
    const url =
      `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes` +
      '?$select=LogicalName,AttributeType,IsValidForRead,IsValidForCreate,IsValidForUpdate,DisplayName';
    const payload = await getJson<{ value?: AttributeMetadata[] }>(url);
    return (payload.value || []).filter(
      (attribute) => attribute.LogicalName && attribute.IsValidForRead !== false
    );
  };

  const resolveColumn = (
    requestedName: string,
    attributes: AttributeMetadata[]
  ): ResolvedDataverseColumn | undefined => {
    const lower = requestedName.trim().toLowerCase();
    const normalized = normalize(requestedName);
    const attribute =
      attributes.find((item) => item.LogicalName?.toLowerCase() === lower) ||
      attributes.find(
        (item) => item.DisplayName?.UserLocalizedLabel?.Label?.toLowerCase() === lower
      ) ||
      attributes.find(
        (item) =>
          normalize(item.LogicalName || '') === normalized ||
          normalize(item.DisplayName?.UserLocalizedLabel?.Label || '') === normalized
      );
    if (!attribute?.LogicalName) return undefined;
    return {
      requestedName,
      logicalName: attribute.LogicalName,
      displayName: attribute.DisplayName?.UserLocalizedLabel?.Label,
      attributeType: attribute.AttributeType
    };
  };

  const resolveQuery = async (
    query: DataverseQuerySpec
  ): Promise<{
    entity: ResolvedDataverseEntity;
    query: DataverseQuerySpec;
    resolvedColumns: ResolvedDataverseColumn[];
    unresolvedColumns: string[];
  }> => {
    const entity = await resolveEntity(query.table);
    const attributes = await getAttributes(entity);
    const resolvedColumns: ResolvedDataverseColumn[] = [];
    const unresolvedColumns: string[] = [];
    const resolve = (name: string): string | undefined => {
      const column = resolveColumn(name, attributes);
      if (!column) {
        unresolvedColumns.push(name);
        return undefined;
      }
      if (!resolvedColumns.some((existing) => existing.logicalName === column.logicalName)) {
        resolvedColumns.push(column);
      }
      return column.logicalName;
    };

    const columns = (query.columns || []).map(resolve).filter((value): value is string => Boolean(value));
    const filters = (query.filters || []).slice(0, 20).map((filter) => {
      if (!allowedOperators.has(filter.operator)) {
        throw new Error(`Unsupported filter operator: ${filter.operator}`);
      }
      const column = resolve(filter.column);
      if (!column) return undefined;
      const needsValue = filter.operator !== 'not-null' && filter.operator !== 'null';
      if (needsValue && (filter.value == null || String(filter.value).trim() === '')) {
        throw new Error(`Filter ${filter.column} ${filter.operator} requires a value.`);
      }
      return {
        column,
        operator: filter.operator,
        ...(needsValue ? { value: String(filter.value) } : {}),
        ...(filter.entityType ? { entityType: filter.entityType } : {})
      } satisfies DataverseFilterSpec;
    }).filter((value): value is DataverseFilterSpec => Boolean(value));
    const orderBy = (query.orderBy || []).slice(0, 5).map((order) => {
      const column = resolve(order.column);
      return column ? { column, direction: order.direction } : undefined;
    }).filter((value): value is DataverseOrderSpec => Boolean(value));

    return {
      entity,
      query: {
        table: entity.logicalName,
        columns: [...new Set(columns)],
        filters,
        orderBy,
        ...(query.top ? { top: Math.min(Math.max(query.top, 1), 50) } : {})
      },
      resolvedColumns,
      unresolvedColumns: [...new Set(unresolvedColumns)]
    };
  };

  const buildConditionsXml = (query: DataverseQuerySpec): string =>
    (query.filters || [])
      .map((filter) => {
        const value = filter.value == null ? '' : ` value="${xmlEscape(String(filter.value))}"`;
        const entityType = filter.entityType
          ? ` uitype="${xmlEscape(filter.entityType)}"`
          : '';
        return `<condition attribute="${xmlEscape(filter.column)}" operator="${filter.operator}"${value}${entityType} />`;
      })
      .join('');

  const buildFetchXml = (
    entity: ResolvedDataverseEntity,
    query: DataverseQuerySpec,
    options: { top?: number; pageSize?: number; includeTotalCount?: boolean } = {}
  ): { fetchXml: string; selectedColumns: string[] } => {
    const selectedColumns = [
      entity.primaryIdAttribute,
      entity.primaryNameAttribute,
      ...(query.columns || []),
      ...(query.filters || []).map((filter) => filter.column),
      ...(query.orderBy || []).map((order) => order.column)
    ]
      .filter((column): column is string => Boolean(column))
      .filter((column, index, values) => values.indexOf(column) === index)
      .slice(0, 20);
    const top = options.top ?? query.top;
    const fetchAttributes: string[] = [];
    if (top !== undefined) {
      fetchAttributes.push(`top="${Math.min(Math.max(top, 1), 50)}"`);
    } else {
      if (options.pageSize !== undefined) {
        fetchAttributes.push(`count="${Math.min(Math.max(options.pageSize, 1), 50)}"`);
        fetchAttributes.push('page="1"');
      }
      if (options.includeTotalCount) {
        fetchAttributes.push('returntotalrecordcount="true"');
      }
    }
    fetchAttributes.push('mapping="logical"', 'distinct="false"');
    const attributesXml = selectedColumns
      .map((column) => `<attribute name="${xmlEscape(column)}" />`)
      .join('');
    const orderXml = (query.orderBy || [])
      .map(
        (order) =>
          `<order attribute="${xmlEscape(order.column)}" descending="${order.direction === 'desc' ? 'true' : 'false'}" />`
      )
      .join('');
    const conditionsXml = buildConditionsXml(query);
    const filterXml = conditionsXml ? `<filter type="and">${conditionsXml}</filter>` : '';
    return {
      fetchXml:
        `<fetch ${fetchAttributes.join(' ')}><entity name="${xmlEscape(entity.logicalName)}">` +
        `${attributesXml}${orderXml}${filterXml}</entity></fetch>`,
      selectedColumns
    };
  };

  const buildCountFetchXml = (
    entity: ResolvedDataverseEntity,
    query: DataverseQuerySpec
  ): string => {
    const conditionsXml = buildConditionsXml(query);
    const filterXml = conditionsXml ? `<filter type="and">${conditionsXml}</filter>` : '';
    return (
      `<fetch aggregate="true" mapping="logical"><entity name="${xmlEscape(entity.logicalName)}">` +
      `<attribute name="${xmlEscape(entity.primaryIdAttribute)}" alias="recordcount" aggregate="count" />` +
      `${filterXml}</entity></fetch>`
    );
  };

  const mapRecords = (
    rawRecords: Array<Record<string, unknown>>,
    selectedColumns: string[]
  ): Array<Record<string, unknown>> =>
    rawRecords.map((record) => {
      const mapped: Record<string, unknown> = {};
      for (const column of selectedColumns) {
        if (!(column in record)) continue;
        const formatted = record[`${column}@OData.Community.Display.V1.FormattedValue`];
        mapped[column] =
          typeof formatted === 'string'
            ? { value: sanitize(record[column]), formattedValue: formatted }
            : sanitize(record[column]);
      }
      return mapped;
    });

  const getView = async (
    entity: ResolvedDataverseEntity
  ): Promise<{ id: string; name: string; fetchXml: string; layoutXml?: string } | undefined> => {
    const url = new URL(`${request.origin}/api/data/v9.2/userqueries`);
    url.searchParams.set(
      '$select',
      'userqueryid,name,fetchxml,layoutxml,returnedtypecode,createdon'
    );
    url.searchParams.set('$filter', `name eq '${odataEscape(managedViewName)}'`);
    url.searchParams.set('$orderby', 'createdon asc');
    url.searchParams.set('$top', '50');
    const payload = await getJson<{
      value?: Array<{
        userqueryid?: string;
        name?: string;
        fetchxml?: string;
        layoutxml?: string;
        returnedtypecode?: string | number;
      }>;
    }>(url.toString());
    const view = payload.value?.find((candidate) => {
      const returnedType = String(candidate.returnedtypecode ?? '').toLowerCase();
      return (
        returnedType === entity.logicalName.toLowerCase() ||
        (entity.objectTypeCode !== undefined &&
          returnedType === String(entity.objectTypeCode))
      );
    });
    if (!view?.userqueryid || !view.fetchxml) return undefined;
    return {
      id: view.userqueryid.replace(/[{}]/g, ''),
      name: managedViewName,
      fetchXml: view.fetchxml,
      layoutXml: view.layoutxml
    };
  };

  const parseView = (
    entity: ResolvedDataverseEntity,
    fetchXml: string,
    layoutXml?: string
  ): { query: DataverseQuerySpec; layoutColumns: string[] } => {
    const parser = new DOMParser();
    const fetchDocument = parser.parseFromString(fetchXml, 'application/xml');
    if (fetchDocument.querySelector('parsererror')) {
      throw new Error('The personal view contains invalid FetchXML.');
    }
    const entityElement = fetchDocument.getElementsByTagName('entity')[0];
    if (!entityElement) throw new Error('The personal view FetchXML has no entity element.');
    const columns = [...entityElement.getElementsByTagName('attribute')]
      .map((node) => node.getAttribute('name') || '')
      .filter(Boolean);
    const filters = [...entityElement.getElementsByTagName('condition')]
      .map((node) => {
        const column = node.getAttribute('attribute');
        const operator = node.getAttribute('operator') as DataverseFilterOperator | null;
        if (!column || !operator || !allowedOperators.has(operator)) return undefined;
        const value = node.getAttribute('value');
        const entityType = node.getAttribute('uitype');
        return {
          column,
          operator,
          ...(value != null ? { value } : {}),
          ...(entityType ? { entityType } : {})
        } satisfies DataverseFilterSpec;
      })
      .filter((value): value is DataverseFilterSpec => Boolean(value));
    const orderBy = [...entityElement.getElementsByTagName('order')]
      .map((node) => {
        const column = node.getAttribute('attribute');
        if (!column) return undefined;
        return {
          column,
          direction: node.getAttribute('descending') === 'true' ? 'desc' : 'asc'
        } satisfies DataverseOrderSpec;
      })
      .filter((value): value is DataverseOrderSpec => Boolean(value));
    let layoutColumns: string[] = [];
    if (layoutXml) {
      const layoutDocument = parser.parseFromString(layoutXml, 'application/xml');
      if (!layoutDocument.querySelector('parsererror')) {
        layoutColumns = [...layoutDocument.getElementsByTagName('cell')]
          .map((node) => node.getAttribute('name') || '')
          .filter(Boolean);
      }
    }
    return {
      query: { table: entity.logicalName, columns, filters, orderBy },
      layoutColumns
    };
  };

  const ensureMutationValue = (value: unknown, column: string): unknown => {
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      if (typeof value === 'string' && value.length > 10_000) {
        throw new Error(`The proposed value for ${column} is too long to preview safely.`);
      }
      return value;
    }
    throw new Error(
      `The proposed value for ${column} must be text, a number, true/false, or null. Lookup and complex values are not supported yet.`
    );
  };

  const prepareMutation = async (
    input: DataverseMutationInput
  ): Promise<PreparedDataverseMutation> => {
    if (input.operation !== 'create' && input.operation !== 'update') {
      throw new Error('The mutation operation must be create or update.');
    }
    if (!Array.isArray(input.values) || input.values.length === 0) {
      throw new Error('At least one field value is required.');
    }
    if (input.values.length > 20) {
      throw new Error('A maximum of 20 fields can be changed in one approval.');
    }

    const entity = await resolveEntity(input.table);
    const attributes = await getAttributes(entity);
    const seen = new Set<string>();
    const fields: PreparedDataverseMutationField[] = input.values.map((item) => {
      const column = resolveColumn(item.column, attributes);
      if (!column) throw new Error(`Could not resolve writable column “${item.column}”.`);
      if (seen.has(column.logicalName)) {
        throw new Error(`Column ${column.logicalName} was proposed more than once.`);
      }
      seen.add(column.logicalName);
      const metadata = attributes.find(
        (attribute) => attribute.LogicalName === column.logicalName
      );
      const writeAllowed = input.operation === 'create'
        ? metadata?.IsValidForCreate === true
        : metadata?.IsValidForUpdate === true;
      if (!writeAllowed || column.logicalName === entity.primaryIdAttribute) {
        throw new Error(
          `${column.displayName || column.logicalName} cannot be ${input.operation === 'create' ? 'set during creation' : 'updated'}.`
        );
      }
      if (['Lookup', 'Customer', 'Owner', 'PartyList', 'MultiSelectPicklist'].includes(column.attributeType || '')) {
        throw new Error(
          `${column.displayName || column.logicalName} uses ${column.attributeType}; lookup and complex field updates are not supported yet.`
        );
      }
      return {
        requestedName: item.column,
        logicalName: column.logicalName,
        displayName: column.displayName,
        attributeType: column.attributeType,
        proposedValue: ensureMutationValue(item.value, column.displayName || column.logicalName)
      };
    });

    let recordId: string | undefined;
    let recordName: string | undefined;
    let etag: string | undefined;
    if (input.operation === 'update') {
      recordId = input.recordId?.replace(/[{}]/g, '').trim() || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
        throw new Error('A valid record GUID is required for an update preview.');
      }
      const columns = [
        entity.primaryNameAttribute,
        ...fields.map((field) => field.logicalName)
      ].filter((column): column is string => Boolean(column));
      const currentUrl = new URL(
        `${request.origin}/api/data/v9.2/${entity.entitySetName}(${recordId})`
      );
      currentUrl.searchParams.set('$select', [...new Set(columns)].join(','));
      const current = await getJson<Record<string, unknown>>(currentUrl.toString(), true);
      etag = typeof current['@odata.etag'] === 'string' ? current['@odata.etag'] : undefined;
      recordName = entity.primaryNameAttribute
        ? String(current[entity.primaryNameAttribute] ?? '') || undefined
        : undefined;
      for (const field of fields) {
        field.currentValue = sanitize(current[field.logicalName]);
        const formatted = current[
          `${field.logicalName}@OData.Community.Display.V1.FormattedValue`
        ];
        if (typeof formatted === 'string') field.currentFormattedValue = formatted;
      }
    } else if (entity.primaryNameAttribute) {
      const nameField = fields.find(
        (field) => field.logicalName === entity.primaryNameAttribute
      );
      if (typeof nameField?.proposedValue === 'string') recordName = nameField.proposedValue;
    }

    return {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      operation: input.operation,
      environmentOrigin: request.origin,
      tableLogicalName: entity.logicalName,
      tableDisplayName: entity.displayName,
      recordId,
      recordName,
      etag,
      fields
    };
  };

  const executeMutation = async (
    mutation: PreparedDataverseMutation,
    selectedColumns: string[]
  ): Promise<DataverseMutationExecutionResult> => {
    if (mutation.environmentOrigin !== request.origin) {
      throw new Error('The approved change belongs to a different Dataverse environment.');
    }
    const entity = await resolveEntity(mutation.tableLogicalName);
    const attributes = await getAttributes(entity);
    const selected = new Set(selectedColumns.map((column) => column.toLowerCase()));
    const fields = mutation.fields.filter((field) => selected.has(field.logicalName.toLowerCase()));
    if (fields.length === 0) throw new Error('Select at least one field to apply.');

    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const column = resolveColumn(field.logicalName, attributes);
      if (!column || column.logicalName !== field.logicalName) {
        throw new Error(`Column ${field.logicalName} is no longer available.`);
      }
      const metadata = attributes.find(
        (attribute) => attribute.LogicalName === column.logicalName
      );
      const writeAllowed = mutation.operation === 'create'
        ? metadata?.IsValidForCreate === true
        : metadata?.IsValidForUpdate === true;
      if (!writeAllowed || column.logicalName === entity.primaryIdAttribute) {
        throw new Error(`${column.displayName || column.logicalName} is not writable.`);
      }
      if (['Lookup', 'Customer', 'Owner', 'PartyList', 'MultiSelectPicklist'].includes(column.attributeType || '')) {
        throw new Error(`${column.displayName || column.logicalName} uses an unsupported complex field type.`);
      }
      payload[column.logicalName] = ensureMutationValue(
        field.proposedValue,
        column.displayName || column.logicalName
      );
    }

    if (mutation.operation === 'update') {
      const recordId = mutation.recordId?.replace(/[{}]/g, '').trim() || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
        throw new Error('The approved update has an invalid record ID.');
      }
      const response = await fetch(
        `${request.origin}/api/data/v9.2/${entity.entitySetName}(${recordId})`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            ...headers,
            'If-Match': mutation.etag || '*'
          },
          body: JSON.stringify(payload)
        }
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        if (response.status === 412) {
          throw new Error('This record changed after the preview was prepared. Ask Oddy to prepare a fresh preview before approving it.');
        }
        throw new Error(`Could not update the record (${response.status}): ${detail || response.statusText}`);
      }
      return {
        operation: 'update',
        tableLogicalName: entity.logicalName,
        recordId,
        recordName: mutation.recordName,
        changedColumns: Object.keys(payload)
      };
    }

    const response = await fetch(`${request.origin}/api/data/v9.2/${entity.entitySetName}`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Could not create the record (${response.status}): ${detail || response.statusText}`);
    }
    const created = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const entityIdHeader = response.headers.get('OData-EntityId') || '';
    const createdId = String(created[entity.primaryIdAttribute] || '') ||
      entityIdHeader.match(/\(([^)]+)\)/)?.[1]?.replace(/[{}]/g, '') || '';
    if (!createdId) throw new Error('Dataverse created the record but did not return its ID.');
    return {
      operation: 'create',
      tableLogicalName: entity.logicalName,
      recordId: createdId,
      recordName: entity.primaryNameAttribute
        ? String(created[entity.primaryNameAttribute] ?? mutation.recordName ?? '') || undefined
        : mutation.recordName,
      changedColumns: Object.keys(payload)
    };
  };

  try {
    if (request.action === 'prepare_mutation') {
      const mutation = await prepareMutation(request.mutation);
      return {
        ok: true,
        action: request.action,
        mutation
      };
    }

    if (request.action === 'execute_mutation') {
      const mutationResult = await executeMutation(
        request.mutation,
        request.selectedColumns
      );
      return {
        ok: true,
        action: request.action,
        mutationResult
      };
    }

    if (request.action === 'resolve_schema') {
      const entity = await resolveEntity(request.table);
      const attributes = await getAttributes(entity);
      const requested = request.columns || [];
      const resolvedColumns = requested
        .map((column) => resolveColumn(column, attributes))
        .filter((column): column is ResolvedDataverseColumn => Boolean(column));
      const resolvedNames = new Set(resolvedColumns.map((column) => column.requestedName));
      return {
        ok: true,
        action: request.action,
        entity,
        resolvedColumns,
        unresolvedColumns: requested.filter((column) => !resolvedNames.has(column))
      };
    }

    if (request.action === 'query_records') {
      const resolved = await resolveQuery(request.query);
      const hasTop = resolved.query.top !== undefined;
      const compiled = buildFetchXml(
        resolved.entity,
        resolved.query,
        hasTop
          ? { top: resolved.query.top }
          : { pageSize: 10, includeTotalCount: true }
      );
      const url = new URL(`${request.origin}/api/data/v9.2/${resolved.entity.entitySetName}`);
      url.searchParams.set('fetchXml', compiled.fetchXml);
      const payload = await getJson<{
        value?: Array<Record<string, unknown>>;
        '@Microsoft.Dynamics.CRM.totalrecordcount'?: number;
      }>(url.toString(), true);
      let totalCount =
        payload['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? payload.value?.length ?? 0;
      const warnings: string[] = [];

      if (hasTop) {
        try {
          const countUrl = new URL(
            `${request.origin}/api/data/v9.2/${resolved.entity.entitySetName}`
          );
          countUrl.searchParams.set(
            'fetchXml',
            buildCountFetchXml(resolved.entity, resolved.query)
          );
          const countPayload = await getJson<{
            value?: Array<{ recordcount?: number | string }>;
          }>(countUrl.toString());
          const countValue = Number(countPayload.value?.[0]?.recordcount);
          if (Number.isFinite(countValue)) totalCount = countValue;
        } catch (countError) {
          warnings.push(
            `Total-count query failed: ${countError instanceof Error ? countError.message : String(countError)}`
          );
        }
      }

      return {
        ok: true,
        action: request.action,
        entity: resolved.entity,
        resolvedColumns: resolved.resolvedColumns,
        unresolvedColumns: resolved.unresolvedColumns,
        query: resolved.query,
        fetchXml: compiled.fetchXml,
        records: mapRecords(payload.value || [], compiled.selectedColumns),
        totalCount,
        warnings: warnings.length ? warnings : undefined
      };
    }

    if (request.action === 'discover_relationships') {
      const source = await resolveEntity(request.sourceTable);
      const target = await resolveEntity(request.targetTable);
      const select =
        'SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute,ReferencedEntityNavigationPropertyName,ReferencingEntityNavigationPropertyName';
      const url = new URL(
        `${request.origin}/api/data/v9.2/RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata`
      );
      url.searchParams.set('$select', select);
      url.searchParams.set(
        '$filter',
        `(ReferencedEntity eq '${odataEscape(source.logicalName)}' and ReferencingEntity eq '${odataEscape(target.logicalName)}') or ` +
          `(ReferencedEntity eq '${odataEscape(target.logicalName)}' and ReferencingEntity eq '${odataEscape(source.logicalName)}')`
      );
      const payload = await getJson<{ value?: RelationshipMetadata[] }>(url.toString());
      const relationships = (payload.value || [])
        .filter(
          (relationship) => relationship.SchemaName && relationship.ReferencingAttribute
        )
        .map((relationship) => {
          const sourceIsParent = relationship.ReferencedEntity === source.logicalName;
          return {
            schemaName: relationship.SchemaName as string,
            sourceTable: source.logicalName,
            targetTable: target.logicalName,
            lookupColumn: relationship.ReferencingAttribute as string,
            direction: sourceIsParent ? 'source-parent' : 'source-child',
            referencedNavigationPropertyName:
              relationship.ReferencedEntityNavigationPropertyName,
            referencingNavigationPropertyName:
              relationship.ReferencingEntityNavigationPropertyName
          } satisfies DataverseRelationship;
        });
      return {
        ok: true,
        action: request.action,
        entity: target,
        relationships
      };
    }

    if (request.action === 'get_view') {
      const entity = await resolveEntity(request.table);
      const view = await getView(entity);
      if (!view) {
        throw new Error(`The ${managedViewName} personal view does not exist for ${entity.logicalName}.`);
      }
      const parsed = parseView(entity, view.fetchXml, view.layoutXml);
      return {
        ok: true,
        action: request.action,
        entity,
        query: parsed.query,
        fetchXml: view.fetchXml,
        layoutXml: view.layoutXml,
        view: {
          id: view.id,
          name: view.name,
          tableLogicalName: entity.logicalName,
          query: parsed.query,
          layoutColumns: parsed.layoutColumns
        }
      };
    }

    if (request.action === 'upsert_view') {
      const resolved = await resolveQuery(request.query);
      if (typeof resolved.entity.objectTypeCode !== 'number') {
        throw new Error('The target table object type code is unavailable.');
      }
      const layoutRequested = request.layoutColumns?.length
        ? request.layoutColumns
        : resolved.query.columns || [];
      const attributes = await getAttributes(resolved.entity);
      const layoutResolved = layoutRequested
        .map((column) => resolveColumn(column, attributes)?.logicalName)
        .filter((column): column is string => Boolean(column));
      const queryWithLayout: DataverseQuerySpec = {
        ...resolved.query,
        columns: [...new Set([...(resolved.query.columns || []), ...layoutResolved])]
      };
      const compiled = buildFetchXml(resolved.entity, queryWithLayout);
      const layoutColumns = [
        resolved.entity.primaryNameAttribute,
        ...layoutResolved,
        ...(queryWithLayout.columns || [])
      ]
        .filter((column): column is string => Boolean(column))
        .filter((column, index, values) =>
          column !== resolved.entity.primaryIdAttribute && values.indexOf(column) === index
        )
        .slice(0, 12);
      const cells = layoutColumns
        .map((column, index) => `<cell name="${xmlEscape(column)}" width="${index === 0 ? 300 : 140}" />`)
        .join('');
      const layoutXml =
        `<grid name="resultset" object="${resolved.entity.objectTypeCode}" jump="${xmlEscape(resolved.entity.primaryNameAttribute || resolved.entity.primaryIdAttribute)}" ` +
        `select="1" icon="1" preview="1"><row name="result" id="${xmlEscape(resolved.entity.primaryIdAttribute)}">` +
        `${cells}</row></grid>`;
      const existing = await getView(resolved.entity);
      const payload = {
        name: managedViewName,
        description:
          'Managed by Oddy using structured Dataverse query primitives.',
        querytype: 0,
        returnedtypecode: resolved.entity.logicalName,
        fetchxml: compiled.fetchXml,
        layoutxml: layoutXml
      };
      let viewId = existing?.id;
      let created = false;
      if (viewId) {
        const response = await fetch(
          `${request.origin}/api/data/v9.2/userqueries(${viewId})`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers,
            body: JSON.stringify(payload)
          }
        );
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`Could not update ${managedViewName} (${response.status}): ${detail}`);
        }
      } else {
        const response = await fetch(`${request.origin}/api/data/v9.2/userqueries`, {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`Could not create ${managedViewName} (${response.status}): ${detail}`);
        }
        const createdPayload = (await response.json().catch(() => ({}))) as {
          userqueryid?: string;
        };
        viewId = createdPayload.userqueryid?.replace(/[{}]/g, '');
        if (!viewId) {
          const entityId = response.headers.get('OData-EntityId') || '';
          viewId = entityId.match(/userqueries\(([^)]+)\)/i)?.[1]?.replace(/[{}]/g, '');
        }
        created = true;
      }
      if (!viewId) {
        throw new Error(`Dataverse did not return the ${managedViewName} view ID.`);
      }
      return {
        ok: true,
        action: request.action,
        entity: resolved.entity,
        resolvedColumns: resolved.resolvedColumns,
        unresolvedColumns: resolved.unresolvedColumns,
        query: queryWithLayout,
        fetchXml: compiled.fetchXml,
        layoutXml,
        view: {
          id: viewId,
          name: managedViewName,
          tableLogicalName: resolved.entity.logicalName,
          created,
          query: queryWithLayout,
          layoutColumns
        }
      };
    }

    const entity = await resolveEntity(request.table);
    const view = await getView(entity);
    if (!view) {
      throw new Error(`The ${managedViewName} personal view does not exist for ${entity.logicalName}.`);
    }
    let fetchXml = view.fetchXml;
    const top = Math.min(Math.max(request.top || 10, 1), 50);
    fetchXml = fetchXml.replace(
      /\s+(?:returntotalrecordcount|page|count|paging-cookie)=["'][^"']*["']/gi,
      ''
    );
    if (/\btop=["'][^"']+["']/i.test(fetchXml)) {
      fetchXml = fetchXml.replace(/\btop=["'][^"']+["']/i, `top="${top}"`);
    } else {
      fetchXml = fetchXml.replace(/<fetch\b/i, `<fetch top="${top}"`);
    }
    const parsed = parseView(entity, view.fetchXml, view.layoutXml);
    const selectedColumns = [
      entity.primaryIdAttribute,
      entity.primaryNameAttribute,
      ...(parsed.query.columns || [])
    ]
      .filter((column): column is string => Boolean(column))
      .filter((column, index, values) => values.indexOf(column) === index);
    const url = new URL(`${request.origin}/api/data/v9.2/${entity.entitySetName}`);
    url.searchParams.set('fetchXml', fetchXml);
    const payload = await getJson<{ value?: Array<Record<string, unknown>> }>(
      url.toString(),
      true
    );
    return {
      ok: true,
      action: request.action,
      entity,
      query: parsed.query,
      fetchXml,
      layoutXml: view.layoutXml,
      records: mapRecords(payload.value || [], selectedColumns),
      totalCount: payload.value?.length || 0,
      view: {
        id: view.id,
        name: view.name,
        tableLogicalName: entity.logicalName,
        query: parsed.query,
        layoutColumns: parsed.layoutColumns
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
