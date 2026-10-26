import type {
  DataverseActionSignature,
  DataverseMutationExecutionResult,
  DataverseMutationInput,
  MarketingListMemberInput,
  MarketingListMembershipExecutionResult,
  PreparedDataverseMutation,
  PreparedDataverseMutationField,
  PreparedMarketingListMembership,
  PreparedMarketingListMember
} from './types';

import type {
  DataverseFilterOperator,
  DataverseFilterSpec,
  DataverseOrderSpec,
  DataverseQuerySpec,
  DataversePrimitiveRequest,
  ResolvedDataverseEntity,
  ResolvedDataverseColumn,
  DataverseRelationship,
  DataversePrimitiveResult
} from './dataverse/contracts';
export type {
  DataverseFilterOperator,
  DataverseFilterSpec,
  DataverseOrderSpec,
  DataverseQuerySpec,
  DataversePrimitiveRequest,
  ResolvedDataverseEntity,
  ResolvedDataverseColumn,
  DataverseRelationship,
  DataversePrimitiveResult
} from './dataverse/contracts';

/**
 * Runs inside the Dataverse page MAIN world. This is the single signed-session
 * executor behind the assistant's schema, query, relationship, view, and write primitives.
 * Chrome serializes this function for executeScript: keep every runtime dependency
 * inside its body. Only type imports are safe here. See docs/architecture.md.
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
    IsOptimisticConcurrencyEnabled?: boolean;
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
  type LookupAttributeMetadata = {
    LogicalName?: string;
    Targets?: string[];
  };
  type ChoiceAttributeMetadata = {
    OptionSet?: {
      Options?: Array<{
        Value?: number;
        Label?: { UserLocalizedLabel?: { Label?: string } };
      }>;
    };
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

  // Per-injection caches amortize metadata over bulk rows without caching stale metadata across approvals.
  const entityCache = new Map<string, ResolvedDataverseEntity>();
  const attributeCache = new Map<string, AttributeMetadata[]>();
  const choiceCache = new Map<string, Array<{ value: number; label: string }>>();
  const lookupCache = new Map<string, Map<string, string[]>>();
  const resolveEntity = async (tableName: string): Promise<ResolvedDataverseEntity> => {
    const raw = tableName.trim();
    const cached = entityCache.get(raw.toLowerCase());
    if (cached) return cached;
    if (!raw || raw.length > 100) throw new Error('A Dataverse table name is required.');
    const safe = raw.toLowerCase().replace(/\s+/g, '_');
    const candidates = [safe];
    if (safe.endsWith('ies')) candidates.push(`${safe.slice(0, -3)}y`);
    if (safe.endsWith('s')) candidates.push(safe.slice(0, -1));
    const select =
      'LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,ObjectTypeCode,DisplayName,DisplayCollectionName,IsOptimisticConcurrencyEnabled';

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
    const resolved: ResolvedDataverseEntity = {
      logicalName: metadata.LogicalName,
      entitySetName: metadata.EntitySetName,
      primaryIdAttribute: metadata.PrimaryIdAttribute,
      primaryNameAttribute: metadata.PrimaryNameAttribute,
      objectTypeCode: metadata.ObjectTypeCode,
      displayName: metadata.DisplayName?.UserLocalizedLabel?.Label,
      displayCollectionName: metadata.DisplayCollectionName?.UserLocalizedLabel?.Label,
      optimisticConcurrencyEnabled: metadata.IsOptimisticConcurrencyEnabled
    };
    entityCache.set(raw.toLowerCase(), resolved);
    entityCache.set(resolved.logicalName, resolved);
    return resolved;
  };

  const getAttributes = async (entity: ResolvedDataverseEntity): Promise<AttributeMetadata[]> => {
    const cached = attributeCache.get(entity.logicalName);
    if (cached) return cached;
    const url =
      `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes` +
      '?$select=LogicalName,AttributeType,IsValidForRead,IsValidForCreate,IsValidForUpdate,DisplayName';
    const payload = await getJson<{ value?: AttributeMetadata[] }>(url);
    const attributes = (payload.value || []).filter(
      (attribute) => attribute.LogicalName && attribute.IsValidForRead !== false
    );
    attributeCache.set(entity.logicalName, attributes);
    return attributes;
  };

  const getLookupTargets = async (
    entity: ResolvedDataverseEntity
  ): Promise<Map<string, string[]>> => {
    const cached = lookupCache.get(entity.logicalName);
    if (cached) return cached;
    const url =
      `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes/` +
      'Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets';
    const payload = await getJson<{ value?: LookupAttributeMetadata[] }>(url);
    const targets = new Map(
      (payload.value || [])
        .filter((attribute) => attribute.LogicalName)
        .map((attribute) => [attribute.LogicalName as string, attribute.Targets || []])
    );
    lookupCache.set(entity.logicalName, targets);
    return targets;
  };

  const getChoiceOptions = async (
    entity: ResolvedDataverseEntity,
    column: ResolvedDataverseColumn
  ): Promise<Array<{ value: number; label: string }>> => {
    const key = `${entity.logicalName}.${column.logicalName}`;
    const cached = choiceCache.get(key);
    if (cached) return cached;
    const metadataType =
      column.attributeType === 'State'
        ? 'StateAttributeMetadata'
        : column.attributeType === 'Status'
          ? 'StatusAttributeMetadata'
          : 'PicklistAttributeMetadata';
    const url =
      `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${entity.logicalName}')/` +
      `Attributes(LogicalName='${column.logicalName}')/Microsoft.Dynamics.CRM.${metadataType}` +
      '?$select=LogicalName&$expand=OptionSet';
    const payload = await getJson<ChoiceAttributeMetadata>(url);
    const options = (payload.OptionSet?.Options || [])
      .filter(
        (option): option is NonNullable<typeof option> & { Value: number } =>
          typeof option.Value === 'number'
      )
      .map((option) => ({
        value: option.Value,
        label: option.Label?.UserLocalizedLabel?.Label || String(option.Value)
      }));
    choiceCache.set(key, options);
    return options;
  };

  const resolveChoiceValue = async (
    entity: ResolvedDataverseEntity,
    column: ResolvedDataverseColumn,
    proposedValue: unknown
  ): Promise<{ value: number; label: string }> => {
    const options = await getChoiceOptions(entity, column);
    if (!options.length) {
      throw new Error(
        `No Dataverse options were returned for ${column.displayName || column.logicalName}.`
      );
    }
    const numericValue =
      typeof proposedValue === 'number'
        ? proposedValue
        : typeof proposedValue === 'string' && /^-?\d+$/.test(proposedValue.trim())
          ? Number(proposedValue.trim())
          : undefined;
    const match =
      numericValue !== undefined
        ? options.find((option) => option.value === numericValue)
        : typeof proposedValue === 'string'
          ? options.find(
              (option) => option.label.trim().toLowerCase() === proposedValue.trim().toLowerCase()
            )
          : undefined;
    if (!match) {
      throw new Error(
        `${formatChoiceInput(proposedValue)} is not a valid option for ${column.displayName || column.logicalName}. Valid options: ${options.map((option) => `${option.label} (${option.value})`).join(', ')}.`
      );
    }
    return match;
  };

  const formatChoiceInput = (value: unknown): string =>
    typeof value === 'string' ? `“${value}”` : String(value);

  const resolveColumn = (
    requestedName: string,
    attributes: AttributeMetadata[]
  ): ResolvedDataverseColumn | undefined => {
    const lower = requestedName.trim().toLowerCase();
    const normalized = normalize(requestedName);
    const exact = attributes.find((item) => item.LogicalName?.toLowerCase() === lower);
    const labels = attributes.filter(
      (item) => item.DisplayName?.UserLocalizedLabel?.Label?.toLowerCase() === lower
    );
    const candidates = exact
      ? [exact]
      : labels.length
        ? labels
        : attributes.filter(
            (item) =>
              normalize(item.LogicalName || '') === normalized ||
              normalize(item.DisplayName?.UserLocalizedLabel?.Label || '') === normalized
          );
    if (candidates.length > 1)
      throw new Error(
        `Column “${requestedName}” is ambiguous. Use an exact logical name: ${candidates.map((item) => item.LogicalName).join(', ')}.`
      );
    const attribute = candidates[0];
    if (!attribute?.LogicalName) return undefined;
    return {
      requestedName,
      logicalName: attribute.LogicalName,
      displayName: attribute.DisplayName?.UserLocalizedLabel?.Label,
      attributeType: attribute.AttributeType
    };
  };

  const resolveLookupReference = async (
    entity: ResolvedDataverseEntity,
    column: ResolvedDataverseColumn,
    lookup: { table: string; recordId: string; recordName?: string }
  ): Promise<{
    tableLogicalName: string;
    entitySetName: string;
    recordId: string;
    recordName?: string;
    navigationPropertyName: string;
  }> => {
    const recordId = lookup.recordId.replace(/[{}]/g, '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
      throw new Error(
        `A valid target record GUID is required for ${column.displayName || column.logicalName}.`
      );
    }
    const target = await resolveEntity(lookup.table);
    const lookupTargets = await getLookupTargets(entity);
    const allowedTargets = lookupTargets.get(column.logicalName) || [];
    if (allowedTargets.length && !allowedTargets.includes(target.logicalName)) {
      throw new Error(
        `${column.displayName || column.logicalName} cannot reference ${target.displayName || target.logicalName}. Allowed targets: ${allowedTargets.join(', ')}.`
      );
    }

    const relationshipUrl = new URL(
      `${request.origin}/api/data/v9.2/RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata`
    );
    relationshipUrl.searchParams.set(
      '$select',
      'SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName'
    );
    relationshipUrl.searchParams.set(
      '$filter',
      `ReferencingEntity eq '${odataEscape(entity.logicalName)}' and ` +
        `ReferencingAttribute eq '${odataEscape(column.logicalName)}' and ` +
        `ReferencedEntity eq '${odataEscape(target.logicalName)}'`
    );
    const relationships = await getJson<{ value?: RelationshipMetadata[] }>(
      relationshipUrl.toString()
    );
    const relationship = relationships.value?.find(
      (item) => item.ReferencingEntityNavigationPropertyName
    );
    const navigationPropertyName = relationship?.ReferencingEntityNavigationPropertyName;
    if (!navigationPropertyName) {
      throw new Error(
        `Could not resolve the Dataverse navigation property for ${column.displayName || column.logicalName} → ${target.logicalName}.`
      );
    }

    const targetColumns = [target.primaryIdAttribute, target.primaryNameAttribute].filter(
      (value): value is string => Boolean(value)
    );
    const targetUrl = new URL(
      `${request.origin}/api/data/v9.2/${target.entitySetName}(${recordId})`
    );
    targetUrl.searchParams.set('$select', targetColumns.join(','));
    const targetRecord = await getJson<Record<string, unknown>>(targetUrl.toString());
    const recordName =
      lookup.recordName?.trim() ||
      (target.primaryNameAttribute
        ? String(targetRecord[target.primaryNameAttribute] ?? '') || undefined
        : undefined);

    return {
      tableLogicalName: target.logicalName,
      entitySetName: target.entitySetName,
      recordId,
      recordName,
      navigationPropertyName
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

    const columns = (query.columns || [])
      .map(resolve)
      .filter((value): value is string => Boolean(value));
    const filters = (query.filters || [])
      .slice(0, 20)
      .map((filter) => {
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
      })
      .filter((value): value is DataverseFilterSpec => Boolean(value));
    const orderBy = (query.orderBy || [])
      .slice(0, 5)
      .map((order) => {
        const column = resolve(order.column);
        return column ? { column, direction: order.direction } : undefined;
      })
      .filter((value): value is DataverseOrderSpec => Boolean(value));

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
        const entityType = filter.entityType ? ` uitype="${xmlEscape(filter.entityType)}"` : '';
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
        (entity.objectTypeCode !== undefined && returnedType === String(entity.objectTypeCode))
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

  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const normalizeGuid = (value: string, label: string): string => {
    const normalized = value.replace(/[{}]/g, '').trim().toLowerCase();
    if (!guidPattern.test(normalized)) throw new Error(`A valid ${label} GUID is required.`);
    return normalized;
  };
  const actionSignatureKey = (signature: DataverseActionSignature): string =>
    JSON.stringify({
      name: signature.name,
      isBound: signature.isBound,
      parameters: signature.parameters
    });
  const canInvokeAddListMembers = (signature: DataverseActionSignature): boolean => {
    const parameters = signature.isBound ? signature.parameters.slice(1) : signature.parameters;
    if (signature.isBound && !signature.parameters[0]?.type.toLowerCase().endsWith('.list'))
      return false;
    const names = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));
    const hasList = signature.isBound || names.has('list') || names.has('listid');
    const hasMembers = names.has('members') || names.has('memberids');
    return (
      hasList &&
      hasMembers &&
      parameters.every((parameter) =>
        ['list', 'listid', 'members', 'memberids'].includes(parameter.name.toLowerCase())
      )
    );
  };
  const resolveAddListMembersSignature = async (): Promise<DataverseActionSignature> => {
    const response = await fetch(`${request.origin}/api/data/v9.2/$metadata`, {
      credentials: 'include',
      // The CSDL metadata document is XML, unlike the JSON data endpoints.
      headers: {
        Accept: 'application/xml',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
      }
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Could not read Dataverse action metadata (${response.status}): ${detail || response.statusText}`
      );
    }
    const metadataXml = await response.text();
    const attributeValue = (source: string, name: string): string =>
      source.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] || '';
    const candidates: DataverseActionSignature[] = [];
    const actionPattern = /<(?:\w+:)?Action\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Action>/gi;
    for (const actionMatch of metadataXml.matchAll(actionPattern)) {
      const actionAttributes = actionMatch[1] || '';
      if (attributeValue(actionAttributes, 'Name') !== 'AddListMembersList') continue;
      const parameters: Array<{ name: string; type: string }> = [];
      const parameterPattern = /<(?:\w+:)?Parameter\b([^>]*?)(?:\/>|>)/gi;
      for (const parameterMatch of (actionMatch[2] || '').matchAll(parameterPattern)) {
        const parameterAttributes = parameterMatch[1] || '';
        const name = attributeValue(parameterAttributes, 'Name');
        const type = attributeValue(parameterAttributes, 'Type');
        if (name && type) parameters.push({ name, type });
      }
      candidates.push({
        name: 'AddListMembersList',
        isBound: attributeValue(actionAttributes, 'IsBound').toLowerCase() === 'true',
        parameters
      });
    }
    const signature = candidates.find(canInvokeAddListMembers);
    if (!signature) {
      throw new Error(
        'This Dataverse environment does not expose a supported AddListMembersList action signature.'
      );
    }
    return signature;
  };
  const buildAddListMembersInvocation = (
    membership: PreparedMarketingListMembership,
    members: PreparedMarketingListMember[],
    signature: DataverseActionSignature
  ): { url: string; body: Record<string, unknown> } => {
    const parameters = signature.isBound ? signature.parameters.slice(1) : signature.parameters;
    const body: Record<string, unknown> = {};
    for (const parameter of parameters) {
      switch (parameter.name.toLowerCase()) {
        case 'listid':
          body[parameter.name] = membership.listId;
          break;
        case 'memberids':
          body[parameter.name] = members.map((member) => member.recordId);
          break;
        case 'list':
          body[parameter.name] = {
            listid: membership.listId,
            '@odata.type': 'Microsoft.Dynamics.CRM.list'
          };
          break;
        case 'members':
          body[parameter.name] = members.map((member) => ({
            [member.primaryIdAttribute]: member.recordId,
            '@odata.type': `Microsoft.Dynamics.CRM.${member.tableLogicalName}`
          }));
          break;
        default:
          throw new Error(`Unsupported AddListMembersList parameter: ${parameter.name}.`);
      }
    }
    return {
      url: signature.isBound
        ? `${request.origin}/api/data/v9.2/${membership.listEntitySetName}(${membership.listId})/Microsoft.Dynamics.CRM.${signature.name}`
        : `${request.origin}/api/data/v9.2/${signature.name}`,
      body
    };
  };

  const prepareListMembership = async (
    listIdInput: string,
    memberInputs: MarketingListMemberInput[],
    allowEmpty = false
  ): Promise<PreparedMarketingListMembership> => {
    const listId = normalizeGuid(listIdInput, 'marketing-list record');
    if (!Array.isArray(memberInputs) || memberInputs.length === 0) {
      throw new Error('At least one marketing-list member is required.');
    }
    if (memberInputs.length > 50) {
      throw new Error('A maximum of 50 members can be added in one approval.');
    }

    const listEntity = await resolveEntity('list');
    const listAttributes = await getAttributes(listEntity);
    const listNameColumn = resolveColumn('listname', listAttributes);
    const listTypeColumn = resolveColumn('type', listAttributes);
    const memberTypeColumn = resolveColumn('createdfromcode', listAttributes);
    if (!listNameColumn || !listTypeColumn || !memberTypeColumn) {
      throw new Error('Could not resolve the standard Dataverse marketing-list columns.');
    }
    const listUrl = new URL(
      `${request.origin}/api/data/v9.2/${listEntity.entitySetName}(${listId})`
    );
    listUrl.searchParams.set(
      '$select',
      [
        listEntity.primaryIdAttribute,
        listNameColumn.logicalName,
        listTypeColumn.logicalName,
        memberTypeColumn.logicalName
      ].join(',')
    );
    const listRecord = await getJson<Record<string, unknown>>(listUrl.toString(), true);
    if (listRecord[listTypeColumn.logicalName] !== false) {
      throw new Error(
        'Members can only be added manually to a static marketing list. This list is dynamic.'
      );
    }
    const listMemberObjectType = listRecord[memberTypeColumn.logicalName];
    if (typeof listMemberObjectType !== 'number') {
      throw new Error('Dataverse did not return the marketing list member type.');
    }
    const listName = String(listRecord[listNameColumn.logicalName] ?? '').trim() || listId;

    const resolvedMemberEntities = new Map<string, ResolvedDataverseEntity>();
    for (const input of memberInputs) {
      const requestedTable = input.table.trim();
      if (!requestedTable) throw new Error('Every proposed list member requires a table.');
      if (!resolvedMemberEntities.has(requestedTable.toLowerCase())) {
        resolvedMemberEntities.set(
          requestedTable.toLowerCase(),
          await resolveEntity(requestedTable)
        );
      }
    }
    const memberEntities = [...resolvedMemberEntities.values()];
    const distinctLogicalNames = [...new Set(memberEntities.map((entity) => entity.logicalName))];
    if (distinctLogicalNames.length !== 1) {
      throw new Error(
        'All members in one AddListMembersList proposal must belong to the same Dataverse table.'
      );
    }
    const memberEntity = memberEntities[0]!;
    if (!['account', 'contact', 'lead'].includes(memberEntity.logicalName)) {
      throw new Error('Marketing-list members must be accounts, contacts, or leads.');
    }
    if (typeof memberEntity.objectTypeCode !== 'number') {
      throw new Error(
        `Dataverse did not return the object type code for ${memberEntity.logicalName}.`
      );
    }
    if (memberEntity.objectTypeCode !== listMemberObjectType) {
      throw new Error(
        `${listName} accepts ${String(listRecord[`${memberTypeColumn.logicalName}@OData.Community.Display.V1.FormattedValue`] || `object type ${listMemberObjectType}`)} members, not ${memberEntity.displayCollectionName || memberEntity.logicalName}.`
      );
    }

    const memberIds: string[] = [];
    const seenIds = new Set<string>();
    for (const input of memberInputs) {
      const id = normalizeGuid(input.recordId, `${memberEntity.logicalName} record`);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        memberIds.push(id);
      }
    }
    const memberUrl = new URL(`${request.origin}/api/data/v9.2/${memberEntity.entitySetName}`);
    memberUrl.searchParams.set(
      '$select',
      [memberEntity.primaryIdAttribute, memberEntity.primaryNameAttribute]
        .filter((column): column is string => Boolean(column))
        .join(',')
    );
    memberUrl.searchParams.set(
      '$filter',
      memberIds.map((id) => `${memberEntity.primaryIdAttribute} eq ${id}`).join(' or ')
    );
    const memberPayload = await getJson<{ value?: Array<Record<string, unknown>> }>(
      memberUrl.toString()
    );
    const recordsById = new Map(
      (memberPayload.value || []).map((record) => [
        String(record[memberEntity.primaryIdAttribute] || '')
          .replace(/[{}]/g, '')
          .toLowerCase(),
        record
      ])
    );
    const missingIds = memberIds.filter((id) => !recordsById.has(id));
    if (missingIds.length) {
      throw new Error(
        `Could not find ${missingIds.length} proposed ${memberEntity.logicalName} member${missingIds.length === 1 ? '' : 's'} in Dataverse.`
      );
    }
    const resolvedMembers: PreparedMarketingListMember[] = memberIds.map((id) => {
      const record = recordsById.get(id)!;
      return {
        tableLogicalName: memberEntity.logicalName,
        primaryIdAttribute: memberEntity.primaryIdAttribute,
        recordId: id,
        recordName: memberEntity.primaryNameAttribute
          ? String(record[memberEntity.primaryNameAttribute] ?? '').trim() || undefined
          : undefined
      };
    });

    const listMemberEntity = await resolveEntity('listmember');
    const listMemberAttributes = await getAttributes(listMemberEntity);
    const listLookup = resolveColumn('listid', listMemberAttributes);
    const entityLookup = resolveColumn('entityid', listMemberAttributes);
    if (!listLookup || !entityLookup) {
      throw new Error('Could not resolve the standard marketing-list membership columns.');
    }
    const listValueColumn = `_${listLookup.logicalName}_value`;
    const entityValueColumn = `_${entityLookup.logicalName}_value`;
    const existingUrl = new URL(
      `${request.origin}/api/data/v9.2/${listMemberEntity.entitySetName}`
    );
    existingUrl.searchParams.set('$select', entityValueColumn);
    existingUrl.searchParams.set(
      '$filter',
      `${listValueColumn} eq ${listId} and (` +
        memberIds.map((id) => `${entityValueColumn} eq ${id}`).join(' or ') +
        ')'
    );
    const existingPayload = await getJson<{ value?: Array<Record<string, unknown>> }>(
      existingUrl.toString()
    );
    const existingIds = new Set(
      (existingPayload.value || [])
        .map((record) =>
          String(record[entityValueColumn] || '')
            .replace(/[{}]/g, '')
            .toLowerCase()
        )
        .filter(Boolean)
    );
    const alreadyMembers = resolvedMembers.filter((member) => existingIds.has(member.recordId));
    const members = resolvedMembers.filter((member) => !existingIds.has(member.recordId));
    if (!members.length && !allowEmpty) {
      throw new Error(
        `All ${resolvedMembers.length} matching ${memberEntity.displayCollectionName || memberEntity.logicalName} are already members of ${listName}.`
      );
    }
    const actionSignature = await resolveAddListMembersSignature();

    return {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      environmentOrigin: request.origin,
      listId,
      listName,
      listEntitySetName: listEntity.entitySetName,
      memberTableLogicalName: memberEntity.logicalName,
      memberTableDisplayName: memberEntity.displayCollectionName || memberEntity.displayName,
      memberObjectTypeCode: memberEntity.objectTypeCode,
      members,
      alreadyMembers,
      actionSignature
    };
  };

  const executeListMembership = async (
    membership: PreparedMarketingListMembership,
    selectedMemberIds: string[],
    expectedUserId?: string
  ): Promise<MarketingListMembershipExecutionResult> => {
    if (membership.environmentOrigin !== request.origin) {
      throw new Error(
        'The approved membership change belongs to a different Dataverse environment.'
      );
    }
    const approvedMembers = new Map(
      membership.members.map((member) => [member.recordId.toLowerCase(), member])
    );
    const selectedIds = [
      ...new Set(selectedMemberIds.map((id) => normalizeGuid(id, 'selected member record')))
    ].filter((id) => approvedMembers.has(id));
    if (!selectedIds.length) throw new Error('Select at least one marketing-list member to add.');
    if (
      selectedIds.length !==
      new Set(selectedMemberIds.map((id) => id.replace(/[{}]/g, '').trim().toLowerCase())).size
    ) {
      throw new Error('The approved selection contains a member that was not part of the preview.');
    }
    const revalidated = await prepareListMembership(
      membership.listId,
      selectedIds.map((id) => ({
        table: approvedMembers.get(id)!.tableLogicalName,
        recordId: id
      })),
      Boolean(expectedUserId)
    );
    if (
      !expectedUserId &&
      (revalidated.members.length !== selectedIds.length || revalidated.alreadyMembers.length > 0)
    ) {
      throw new Error(
        'Marketing-list membership changed after the preview was prepared. Ask Oddy to prepare a fresh preview.'
      );
    }
    if (
      revalidated.listName !== membership.listName ||
      revalidated.memberTableLogicalName !== membership.memberTableLogicalName ||
      revalidated.memberObjectTypeCode !== membership.memberObjectTypeCode
    ) {
      throw new Error(
        'The marketing list changed after the preview was prepared. Ask Oddy to prepare a fresh preview.'
      );
    }
    if (
      actionSignatureKey(revalidated.actionSignature) !==
      actionSignatureKey(membership.actionSignature)
    ) {
      throw new Error(
        'The Dataverse action metadata changed after the preview was prepared. Ask Oddy to prepare a fresh preview.'
      );
    }
    if (expectedUserId) {
      if (window.location.origin !== request.origin)
        throw new Error('The Dataverse environment changed.');
      const identity = await getJson<{ UserId?: string }>(`${request.origin}/api/data/v9.2/WhoAmI`);
      if (normalizeGuid(identity.UserId || '', 'signed-in user') !== expectedUserId)
        throw new Error('The signed-in Dataverse user changed.');
      if (!revalidated.members.length)
        return {
          listId: revalidated.listId,
          listName: revalidated.listName,
          memberTableLogicalName: revalidated.memberTableLogicalName,
          addedMemberIds: [],
          addedMemberNames: []
        };
    }
    const invocation = buildAddListMembersInvocation(
      revalidated,
      revalidated.members,
      revalidated.actionSignature
    );
    const response = await fetch(invocation.url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(invocation.body)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Could not add the approved marketing-list members (${response.status}): ${detail || response.statusText}`
      );
    }
    return {
      listId: revalidated.listId,
      listName: revalidated.listName,
      memberTableLogicalName: revalidated.memberTableLogicalName,
      addedMemberIds: revalidated.members.map((member) => member.recordId),
      addedMemberNames: revalidated.members.map((member) => member.recordName || member.recordId)
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
      `The proposed value for ${column} must be text, a number, true/false, or null.`
    );
  };

  const prepareMutation = async (
    input: DataverseMutationInput,
    readCurrent = true
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
    const fields: PreparedDataverseMutationField[] = [];
    for (const item of input.values) {
      const column = resolveColumn(item.column, attributes);
      if (!column) throw new Error(`Could not resolve writable column “${item.column}”.`);
      if (seen.has(column.logicalName)) {
        throw new Error(`Column ${column.logicalName} was proposed more than once.`);
      }
      seen.add(column.logicalName);
      const metadata = attributes.find((attribute) => attribute.LogicalName === column.logicalName);
      const writeAllowed =
        input.operation === 'create'
          ? metadata?.IsValidForCreate === true
          : metadata?.IsValidForUpdate === true;
      if (!writeAllowed || column.logicalName === entity.primaryIdAttribute) {
        throw new Error(
          `${column.displayName || column.logicalName} cannot be ${input.operation === 'create' ? 'set during creation' : 'updated'}.`
        );
      }
      if (['PartyList', 'MultiSelectPicklist'].includes(column.attributeType || '')) {
        throw new Error(
          `${column.displayName || column.logicalName} uses ${column.attributeType}; this complex field type is not supported yet.`
        );
      }

      if (['Lookup', 'Customer', 'Owner'].includes(column.attributeType || '')) {
        if (!item.lookup) {
          throw new Error(
            `${column.displayName || column.logicalName} is a lookup. Query the target record and provide its table and exact record ID.`
          );
        }
        const lookup = await resolveLookupReference(entity, column, item.lookup);
        fields.push({
          requestedName: item.column,
          logicalName: column.logicalName,
          displayName: column.displayName,
          attributeType: column.attributeType,
          proposedValue: {
            tableLogicalName: lookup.tableLogicalName,
            recordId: lookup.recordId,
            recordName: lookup.recordName
          },
          lookup
        });
        continue;
      }

      if (item.lookup) {
        throw new Error(`${column.displayName || column.logicalName} is not a lookup field.`);
      }
      if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
        throw new Error(
          `A proposed value is required for ${column.displayName || column.logicalName}.`
        );
      }
      if (['Picklist', 'State', 'Status'].includes(column.attributeType || '')) {
        const choice = await resolveChoiceValue(entity, column, item.value);
        fields.push({
          requestedName: item.column,
          logicalName: column.logicalName,
          displayName: column.displayName,
          attributeType: column.attributeType,
          proposedValue: choice.value,
          proposedFormattedValue: choice.label
        });
        continue;
      }
      fields.push({
        requestedName: item.column,
        logicalName: column.logicalName,
        displayName: column.displayName,
        attributeType: column.attributeType,
        proposedValue: ensureMutationValue(item.value, column.displayName || column.logicalName)
      });
    }

    let recordId: string | undefined;
    let recordName: string | undefined;
    let etag: string | undefined;
    if (input.operation === 'update' && readCurrent) {
      recordId = input.recordId?.replace(/[{}]/g, '').trim() || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) {
        throw new Error('A valid record GUID is required for an update preview.');
      }
      const columns = [
        entity.primaryNameAttribute,
        ...fields.map((field) => (field.lookup ? `_${field.logicalName}_value` : field.logicalName))
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
        const currentColumn = field.lookup ? `_${field.logicalName}_value` : field.logicalName;
        const currentValue = current[currentColumn];
        if (field.lookup && typeof currentValue === 'string') {
          field.currentValue = {
            recordId: currentValue,
            tableLogicalName: current[`${currentColumn}@Microsoft.Dynamics.CRM.lookuplogicalname`]
          };
        } else {
          field.currentValue = sanitize(currentValue);
        }
        const formatted = current[`${currentColumn}@OData.Community.Display.V1.FormattedValue`];
        if (typeof formatted === 'string') field.currentFormattedValue = formatted;
      }
    } else if (entity.primaryNameAttribute) {
      const nameField = fields.find((field) => field.logicalName === entity.primaryNameAttribute);
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
      const metadata = attributes.find((attribute) => attribute.LogicalName === column.logicalName);
      const writeAllowed =
        mutation.operation === 'create'
          ? metadata?.IsValidForCreate === true
          : metadata?.IsValidForUpdate === true;
      if (!writeAllowed || column.logicalName === entity.primaryIdAttribute) {
        throw new Error(`${column.displayName || column.logicalName} is not writable.`);
      }
      if (['PartyList', 'MultiSelectPicklist'].includes(column.attributeType || '')) {
        throw new Error(
          `${column.displayName || column.logicalName} uses an unsupported complex field type.`
        );
      }
      if (['Lookup', 'Customer', 'Owner'].includes(column.attributeType || '')) {
        if (!field.lookup) {
          throw new Error(
            `${column.displayName || column.logicalName} has no approved lookup target.`
          );
        }
        const lookup = await resolveLookupReference(entity, column, {
          table: field.lookup.tableLogicalName,
          recordId: field.lookup.recordId,
          recordName: field.lookup.recordName
        });
        payload[`${lookup.navigationPropertyName}@odata.bind`] =
          `/${lookup.entitySetName}(${lookup.recordId})`;
        continue;
      }
      if (['Picklist', 'State', 'Status'].includes(column.attributeType || '')) {
        const choice = await resolveChoiceValue(entity, column, field.proposedValue);
        payload[column.logicalName] = choice.value;
        continue;
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
          throw new Error(
            'This record changed after the preview was prepared. Ask Oddy to prepare a fresh preview before approving it.'
          );
        }
        throw new Error(
          `Could not update the record (${response.status}): ${detail || response.statusText}`
        );
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
      throw new Error(
        `Could not create the record (${response.status}): ${detail || response.statusText}`
      );
    }
    const created = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const entityIdHeader = response.headers.get('OData-EntityId') || '';
    const createdId =
      String(created[entity.primaryIdAttribute] || '') ||
      entityIdHeader.match(/\(([^)]+)\)/)?.[1]?.replace(/[{}]/g, '') ||
      '';
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

  const bulkRecord = (
    entity: ResolvedDataverseEntity,
    record: Record<string, unknown>,
    columns: string[]
  ) => {
    const values: Record<string, unknown> = {};
    const lookupTypes: Record<string, string> = {};
    for (const column of columns) {
      const property = Object.hasOwn(record, column) ? column : `_${column}_value`;
      values[column] = record[property] ?? null;
      const type = record[`${property}@Microsoft.Dynamics.CRM.lookuplogicalname`];
      if (typeof type === 'string') lookupTypes[column] = type;
    }
    return {
      id: normalizeGuid(String(record[entity.primaryIdAttribute] || ''), 'bulk record'),
      name: entity.primaryNameAttribute
        ? String(record[entity.primaryNameAttribute] || '') || undefined
        : undefined,
      etag: typeof record['@odata.etag'] === 'string' ? record['@odata.etag'] : undefined,
      values,
      lookupTypes
    };
  };
  const validateBulkFields = (fields: PreparedDataverseMutationField[]) => {
    for (const field of fields) {
      if (field.lookup || field.proposedValue === null) continue;
      let value = field.proposedValue;
      const type = field.attributeType;
      if (['Integer', 'BigInt', 'Decimal', 'Double', 'Money'].includes(type || '')) {
        if (
          typeof value === 'string' &&
          value.trim() &&
          /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())
        )
          value = Number(value);
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (['Integer', 'BigInt'].includes(type!) && !Number.isSafeInteger(value)) ||
          (type === 'Integer' && (value < -2147483648 || value > 2147483647))
        )
          throw new Error(`Invalid numeric value for ${field.logicalName}.`);
      } else if (type === 'Boolean') {
        if (value === 'true') value = true;
        if (value === 'false') value = false;
        if (typeof value !== 'boolean')
          throw new Error(`Invalid boolean value for ${field.logicalName}.`);
      } else if (['String', 'Memo', 'DateTime', 'Uniqueidentifier'].includes(type || '')) {
        if (typeof value !== 'string')
          throw new Error(`${field.logicalName} requires text, not an inferred conversion.`);
        if (
          type === 'DateTime' &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
            !Number.isFinite(Date.parse(value)))
        )
          throw new Error(
            `Use an explicit ISO date/time with UTC or offset for ${field.logicalName}; the browser time zone is never inferred.`
          );
        if (type === 'Uniqueidentifier') normalizeGuid(value, field.logicalName);
      } else if (!['Picklist', 'State', 'Status'].includes(type || ''))
        throw new Error(`Unsupported bulk field type: ${type}.`);
      field.proposedValue = value;
    }
    return fields;
  };

  try {
    if (request.action.startsWith('bulk_') && window.location.origin !== request.origin)
      throw new Error('The Dataverse environment changed.');
    if (request.action === 'bulk_identity') {
      const identity = await getJson<{ UserId?: string }>(`${request.origin}/api/data/v9.2/WhoAmI`);
      return {
        ok: true,
        action: request.action,
        userId: normalizeGuid(identity.UserId || '', 'signed-in user')
      };
    }
    if (request.action === 'bulk_fields') {
      if (!request.values.length || request.values.length > 50)
        throw new Error('Validate 1–50 bounded rows at a time.');
      const entity = await resolveEntity(request.table);
      const bulkFields = [];
      for (const values of request.values)
        bulkFields.push(
          validateBulkFields(
            (
              await prepareMutation(
                { operation: request.operation, table: entity.logicalName, values },
                false
              )
            ).fields
          )
        );
      return { ok: true, action: request.action, entity, bulkFields };
    }
    if (request.action === 'bulk_page') {
      if (request.query.top !== undefined)
        throw new Error('Bulk selection cannot have a top limit.');
      const resolved = await resolveQuery(request.query);
      if (resolved.unresolvedColumns.length)
        throw new Error(
          `Unresolved bulk columns: ${resolved.unresolvedColumns.join(', ')}. No filters were dropped.`
        );
      for (const filter of resolved.query.filters || []) {
        const column = resolved.resolvedColumns.find(
          (column) => column.logicalName === filter.column
        )!;
        if (
          filter.value !== undefined &&
          ['Picklist', 'State', 'Status'].includes(column.attributeType || '')
        )
          filter.value = String(
            (await resolveChoiceValue(resolved.entity, column, filter.value)).value
          );
      }
      const page = request.cursor?.page || 1;
      if (!Number.isSafeInteger(page) || page < 1 || (page > 1 && !request.cursor?.cookie))
        throw new Error('A valid paging cookie is required.');
      let xml = buildFetchXml(
        resolved.entity,
        {
          ...resolved.query,
          orderBy: [{ column: resolved.entity.primaryIdAttribute, direction: 'asc' }]
        },
        { pageSize: 50 }
      ).fetchXml;
      xml = xml.replace('count="50"', 'count="500"').replace('page="1"', `page="${page}"`);
      if (request.cursor) {
        if (request.cursor.cookie.length > 100000 || /<!DOCTYPE/i.test(request.cursor.cookie))
          throw new Error('Invalid paging cookie.');
        xml = xml.replace('<fetch ', `<fetch paging-cookie="${xmlEscape(request.cursor.cookie)}" `);
      }
      const url = new URL(`${request.origin}/api/data/v9.2/${resolved.entity.entitySetName}`);
      url.searchParams.set('fetchXml', xml);
      const response = await fetch(url.toString(), {
        credentials: 'include',
        headers: {
          ...headers,
          Prefer:
            'odata.include-annotations="Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords,Microsoft.Dynamics.CRM.lookuplogicalname"'
        }
      });
      if (!response.ok)
        throw new Error(
          `Bulk selection failed (${response.status}): ${(await response.text()).slice(0, 300)}`
        );
      const payload = (await response.json()) as Record<string, unknown> & {
        value?: Array<Record<string, unknown>>;
      };
      let cookie =
        typeof payload['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'] === 'string'
          ? (payload['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'] as string)
          : '';
      if (cookie) {
        const parsed = new DOMParser().parseFromString(cookie, 'application/xml');
        if (parsed.querySelector('parsererror')) throw new Error('Invalid server paging cookie.');
        cookie = parsed.documentElement.getAttribute('pagingcookie') ?? cookie;
        for (let decode = 0; decode < 3 && /^\s*%/.test(cookie); decode++)
          cookie = decodeURIComponent(cookie);
      }
      const more = payload['@Microsoft.Dynamics.CRM.morerecords'];
      if ((more === true || (more === undefined && (payload.value?.length || 0) >= 500)) && !cookie)
        throw new Error(
          'Dataverse did not provide a safe paging cookie; selection was not truncated or approved.'
        );
      const cursor = more !== false && cookie ? { page: page + 1, cookie } : undefined;
      return {
        ok: true,
        action: request.action,
        entity: resolved.entity,
        query: resolved.query,
        bulkPage: {
          records: (payload.value || []).map((record) =>
            bulkRecord(resolved.entity, record, resolved.query.columns || [])
          ),
          cursor
        }
      };
    }
    if (request.action === 'bulk_read_versions') {
      if (!request.ids.length || request.ids.length > 50 || request.columns.length > 20)
        throw new Error('Read at most 50 record versions and 20 fields.');
      const entity = await resolveEntity(request.table);
      if (request.requireConcurrency !== false && entity.optimisticConcurrencyEnabled !== true)
        throw new Error(
          'This table does not advertise optimistic concurrency; safe bulk updates are unavailable.'
        );
      const attributes = await getAttributes(entity);
      const columns = request.columns.map((name) => {
        const column = resolveColumn(name, attributes);
        if (!column) throw new Error(`Unreadable bulk column ${name}.`);
        return column;
      });
      const url = new URL(`${request.origin}/api/data/v9.2/${entity.entitySetName}`);
      url.searchParams.set(
        '$select',
        [
          ...new Set(
            [
              entity.primaryIdAttribute,
              entity.primaryNameAttribute,
              ...columns.map((column) =>
                ['Lookup', 'Customer', 'Owner'].includes(column.attributeType || '')
                  ? `_${column.logicalName}_value`
                  : column.logicalName
              )
            ].filter(Boolean)
          )
        ].join(',')
      );
      url.searchParams.set(
        '$filter',
        request.ids
          .map((id) => `${entity.primaryIdAttribute} eq ${normalizeGuid(id, 'bulk record')}`)
          .join(' or ')
      );
      const payload = await getJson<{
        value?: Array<Record<string, unknown>>;
        '@odata.nextLink'?: string;
      }>(url.toString(), true);
      if (payload['@odata.nextLink'])
        throw new Error(
          'Record-version response was unexpectedly paged; no incomplete preview is allowed.'
        );
      return {
        ok: true,
        action: request.action,
        entity,
        bulkPage: {
          records: (payload.value || []).map((record) =>
            bulkRecord(
              entity,
              record,
              columns.map((column) => column.logicalName)
            )
          )
        }
      };
    }
    if (request.action === 'bulk_list_info') {
      const entity = await resolveEntity(request.table);
      if (
        !['account', 'contact', 'lead'].includes(entity.logicalName) ||
        entity.objectTypeCode === undefined
      )
        throw new Error('Marketing lists require a resolved account, contact, or lead table.');
      const list = await resolveEntity('list');
      const attrs = await getAttributes(list);
      const name = resolveColumn('listname', attrs),
        type = resolveColumn('type', attrs),
        memberType = resolveColumn('createdfromcode', attrs);
      if (!name || !type || !memberType)
        throw new Error('Could not resolve marketing-list columns.');
      const listId = normalizeGuid(request.listId, 'marketing list');
      const record = await getJson<Record<string, unknown>>(
        `${request.origin}/api/data/v9.2/${list.entitySetName}(${listId})?$select=${name.logicalName},${type.logicalName},${memberType.logicalName}`
      );
      if (
        record[type.logicalName] !== false ||
        record[memberType.logicalName] !== entity.objectTypeCode
      )
        throw new Error('The list must be static and match the selected member table.');
      const bulkList: PreparedMarketingListMembership = {
        id: crypto.randomUUID(),
        environmentOrigin: request.origin,
        listId,
        listName: String(record[name.logicalName] || listId),
        listEntitySetName: list.entitySetName,
        memberTableLogicalName: entity.logicalName,
        memberTableDisplayName: entity.displayCollectionName,
        memberObjectTypeCode: entity.objectTypeCode,
        members: [],
        alreadyMembers: [],
        actionSignature: await resolveAddListMembersSignature()
      };
      return { ok: true, action: request.action, entity, bulkList };
    }
    if (request.action === 'prepare_list_membership') {
      const listMembership = await prepareListMembership(request.listId, request.members);
      return {
        ok: true,
        action: request.action,
        listMembership
      };
    }

    if (request.action === 'execute_list_membership') {
      const listMembershipResult = await executeListMembership(
        request.membership,
        request.selectedMemberIds,
        request.expectedUserId
      );
      return {
        ok: true,
        action: request.action,
        listMembershipResult
      };
    }

    if (request.action === 'prepare_mutation') {
      const mutation = await prepareMutation(request.mutation);
      return {
        ok: true,
        action: request.action,
        mutation
      };
    }

    if (request.action === 'execute_mutation') {
      const mutationResult = await executeMutation(request.mutation, request.selectedColumns);
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
      if (
        resolvedColumns.some((column) =>
          ['Lookup', 'Customer', 'Owner'].includes(column.attributeType || '')
        )
      ) {
        const lookupTargets = await getLookupTargets(entity);
        for (const column of resolvedColumns) {
          const targets = lookupTargets.get(column.logicalName);
          if (targets?.length) column.targets = targets;
        }
      }
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
        hasTop ? { top: resolved.query.top } : { pageSize: 10, includeTotalCount: true }
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
        .filter((relationship) => relationship.SchemaName && relationship.ReferencingAttribute)
        .map((relationship) => {
          const sourceIsParent = relationship.ReferencedEntity === source.logicalName;
          return {
            schemaName: relationship.SchemaName as string,
            sourceTable: source.logicalName,
            targetTable: target.logicalName,
            lookupColumn: relationship.ReferencingAttribute as string,
            direction: sourceIsParent ? 'source-parent' : 'source-child',
            referencedNavigationPropertyName: relationship.ReferencedEntityNavigationPropertyName,
            referencingNavigationPropertyName: relationship.ReferencingEntityNavigationPropertyName
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
        throw new Error(
          `The ${managedViewName} personal view does not exist for ${entity.logicalName}.`
        );
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
        .filter(
          (column, index, values) =>
            column !== resolved.entity.primaryIdAttribute && values.indexOf(column) === index
        )
        .slice(0, 12);
      const cells = layoutColumns
        .map(
          (column, index) =>
            `<cell name="${xmlEscape(column)}" width="${index === 0 ? 300 : 140}" />`
        )
        .join('');
      const layoutXml =
        `<grid name="resultset" object="${resolved.entity.objectTypeCode}" jump="${xmlEscape(resolved.entity.primaryNameAttribute || resolved.entity.primaryIdAttribute)}" ` +
        `select="1" icon="1" preview="1"><row name="result" id="${xmlEscape(resolved.entity.primaryIdAttribute)}">` +
        `${cells}</row></grid>`;
      const existing = await getView(resolved.entity);
      const payload = {
        name: managedViewName,
        description: 'Managed by Oddy using structured Dataverse query primitives.',
        querytype: 0,
        returnedtypecode: resolved.entity.logicalName,
        fetchxml: compiled.fetchXml,
        layoutxml: layoutXml
      };
      let viewId = existing?.id;
      let created = false;
      if (viewId) {
        const response = await fetch(`${request.origin}/api/data/v9.2/userqueries(${viewId})`, {
          method: 'PATCH',
          credentials: 'include',
          headers,
          body: JSON.stringify(payload)
        });
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
      throw new Error(
        `The ${managedViewName} personal view does not exist for ${entity.logicalName}.`
      );
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
    const payload = await getJson<{ value?: Array<Record<string, unknown>> }>(url.toString(), true);
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
