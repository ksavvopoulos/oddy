import type {
  DataverseConnectionReferenceSummary,
  DataverseFlowAction,
  DataverseFlowDetail,
  DataverseFlowFilter,
  DataverseFlowPrimitiveRequest,
  DataverseFlowPrimitiveResult,
  DataverseFlowScalar,
  DataverseFlowSpec,
  DataverseFlowState,
  DataverseFlowValue
} from './flows/contracts';

/** Runs in the Dataverse page MAIN world and must remain self-contained. */
export async function executeDataverseFlowPrimitive(
  request: DataverseFlowPrimitiveRequest
): Promise<DataverseFlowPrimitiveResult> {
  type EntityMetadata = {
    LogicalName?: string;
    EntitySetName?: string;
    PrimaryIdAttribute?: string;
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
  type WorkflowRecord = {
    workflowid?: string;
    name?: string;
    description?: string;
    statecode?: number;
    componentstate?: number;
    category?: number;
    type?: number;
    ismanaged?: boolean;
    modifiedon?: string;
    clientdata?: string;
    '@odata.etag'?: string;
  };
  type ConnectionReferenceRecord = {
    connectionreferencelogicalname?: string;
    connectionreferencedisplayname?: string;
    connectorid?: string;
    ismanaged?: boolean;
  };
  type ResolvedEntity = {
    logicalName: string;
    entitySetName: string;
    primaryIdAttribute: string;
  };

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0'
  };
  const connectorName = 'shared_commondataserviceforapps';
  const connectorApiId = `/providers/Microsoft.PowerApps/apis/${connectorName}`;
  const definitionSchema =
    'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
  const actionIdPattern = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
  const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stateName = (value?: number): DataverseFlowState =>
    value === 1 ? 'activated' : value === 2 ? 'suspended' : 'draft';
  const errorText = async (response: Response) => {
    const detail = (await response.text()).slice(0, 700);
    return `${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`;
  };
  const getJson = async <T>(url: string, includeUnpublished = false): Promise<T> => {
    const response = await fetch(url, {
      credentials: 'include',
      headers: includeUnpublished ? { ...headers, 'MSCRM.IncludeUnpublished': 'true' } : headers
    });
    if (!response.ok) throw new Error(await errorText(response));
    return (await response.json()) as T;
  };
  const isScalar = (value: unknown): value is DataverseFlowScalar =>
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean';
  const requireString = (value: unknown, label: string, maximum = 200): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
    const result = value.trim();
    if (result.length > maximum) throw new Error(`${label} is too long.`);
    return result;
  };

  try {
    if (window.location.origin !== request.origin) {
      throw new Error('The Dataverse environment changed before the flow operation ran.');
    }

    const entityCache = new Map<string, ResolvedEntity>();
    const attributeCache = new Map<string, AttributeMetadata[]>();
    const resolveEntity = async (table: string): Promise<ResolvedEntity> => {
      const requested = requireString(table, 'A Dataverse table name', 100);
      const cached = entityCache.get(requested.toLowerCase());
      if (cached) return cached;
      const safe = requested.toLowerCase().replace(/\s+/g, '_');
      const candidates = [safe];
      if (safe.endsWith('ies')) candidates.push(`${safe.slice(0, -3)}y`);
      if (safe.endsWith('s')) candidates.push(safe.slice(0, -1));
      const select =
        'LogicalName,EntitySetName,PrimaryIdAttribute,DisplayName,DisplayCollectionName';
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
        if (response.status !== 404) throw new Error(await errorText(response));
      }
      if (!metadata) {
        const url = new URL(`${request.origin}/api/data/v9.2/EntityDefinitions`);
        url.searchParams.set('$select', select);
        url.searchParams.set('$filter', 'IsIntersect eq false');
        const catalog = await getJson<{ value?: EntityMetadata[] }>(url.toString());
        const hints = new Set([requested, ...candidates].map(normalizeName));
        metadata = catalog.value?.find((entity) =>
          [
            entity.LogicalName,
            entity.EntitySetName,
            entity.DisplayName?.UserLocalizedLabel?.Label,
            entity.DisplayCollectionName?.UserLocalizedLabel?.Label
          ]
            .filter((value): value is string => Boolean(value))
            .some((value) => hints.has(normalizeName(value)))
        );
      }
      if (!metadata?.LogicalName || !metadata.EntitySetName || !metadata.PrimaryIdAttribute) {
        throw new Error(`Could not resolve the Dataverse table “${table}”.`);
      }
      const resolved = {
        logicalName: metadata.LogicalName,
        entitySetName: metadata.EntitySetName,
        primaryIdAttribute: metadata.PrimaryIdAttribute
      };
      entityCache.set(requested.toLowerCase(), resolved);
      entityCache.set(resolved.logicalName.toLowerCase(), resolved);
      entityCache.set(resolved.entitySetName.toLowerCase(), resolved);
      return resolved;
    };
    const attributes = async (entity: ResolvedEntity) => {
      const cached = attributeCache.get(entity.logicalName);
      if (cached) return cached;
      const url =
        `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes` +
        '?$select=LogicalName,AttributeType,IsValidForRead,IsValidForCreate,IsValidForUpdate,DisplayName';
      const payload = await getJson<{ value?: AttributeMetadata[] }>(url);
      const result = (payload.value || []).filter((item) => item.LogicalName);
      attributeCache.set(entity.logicalName, result);
      return result;
    };
    const resolveAttribute = async (
      entity: ResolvedEntity,
      column: string,
      mode: 'read' | 'create' | 'update'
    ): Promise<AttributeMetadata & { LogicalName: string }> => {
      const requested = requireString(column, 'A Dataverse column name', 100);
      const hints = new Set([requested].map(normalizeName));
      const match = (await attributes(entity)).find((attribute) =>
        [attribute.LogicalName, attribute.DisplayName?.UserLocalizedLabel?.Label]
          .filter((value): value is string => Boolean(value))
          .some((value) => hints.has(normalizeName(value)))
      );
      if (!match?.LogicalName) {
        throw new Error(`Could not resolve ${entity.logicalName}.${column}.`);
      }
      const allowed =
        mode === 'read'
          ? match.IsValidForRead !== false
          : mode === 'create'
            ? match.IsValidForCreate === true
            : match.IsValidForUpdate === true;
      if (!allowed)
        throw new Error(`${entity.logicalName}.${match.LogicalName} cannot be used for ${mode}.`);
      return match as AttributeMetadata & { LogicalName: string };
    };
    const resolveColumn = async (
      entity: ResolvedEntity,
      column: string,
      mode: 'read' | 'create' | 'update'
    ): Promise<string> => (await resolveAttribute(entity, column, mode)).LogicalName;
    const validateWritableLiteral = (
      entity: ResolvedEntity,
      attribute: AttributeMetadata & { LogicalName: string },
      value: DataverseFlowValue
    ) => {
      const supportedTypes = new Set([
        'String',
        'Memo',
        'Integer',
        'BigInt',
        'Decimal',
        'Double',
        'Money',
        'Boolean',
        'DateTime',
        'Uniqueidentifier'
      ]);
      const type = attribute.AttributeType || '';
      if (!supportedTypes.has(type)) {
        throw new Error(
          `${entity.logicalName}.${attribute.LogicalName} has unsupported flow-write type ${type || 'unknown'}. Choice, lookup, owner, customer, party-list, multi-select, file, and image values are not supported.`
        );
      }
      if (value.kind !== 'literal' || value.value === null) return;
      const scalar = value.value;
      if (type === 'Boolean' && typeof scalar !== 'boolean')
        throw new Error(
          `${entity.logicalName}.${attribute.LogicalName} requires a boolean literal.`
        );
      if (
        ['Integer', 'BigInt', 'Decimal', 'Double', 'Money'].includes(type) &&
        typeof scalar !== 'number'
      )
        throw new Error(
          `${entity.logicalName}.${attribute.LogicalName} requires a numeric literal.`
        );
      if (
        ['String', 'Memo', 'DateTime', 'Uniqueidentifier'].includes(type) &&
        typeof scalar !== 'string'
      )
        throw new Error(`${entity.logicalName}.${attribute.LogicalName} requires a text literal.`);
      if (
        type === 'DateTime' &&
        typeof scalar === 'string' &&
        (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(scalar) || !Number.isFinite(Date.parse(scalar)))
      )
        throw new Error(
          `${entity.logicalName}.${attribute.LogicalName} requires an ISO date/time literal.`
        );
      if (
        type === 'Uniqueidentifier' &&
        typeof scalar === 'string' &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scalar)
      )
        throw new Error(`${entity.logicalName}.${attribute.LogicalName} requires a GUID literal.`);
    };

    const listConnectionReferences = async (): Promise<DataverseConnectionReferenceSummary[]> => {
      const url = new URL(`${request.origin}/api/data/v9.2/connectionreferences`);
      url.searchParams.set(
        '$select',
        'connectionreferencelogicalname,connectionreferencedisplayname,connectorid,ismanaged'
      );
      url.searchParams.set('$filter', `contains(connectorid,'${connectorName}')`);
      url.searchParams.set(
        '$top',
        String(
          Math.min(
            Math.max(
              request.action === 'list_flow_connection_references' ? request.top || 50 : 100,
              1
            ),
            100
          )
        )
      );
      const payload = await getJson<{ value?: ConnectionReferenceRecord[] }>(url.toString());
      return (payload.value || [])
        .filter(
          (
            item
          ): item is ConnectionReferenceRecord & {
            connectionreferencelogicalname: string;
            connectorid: string;
          } => Boolean(item.connectionreferencelogicalname && item.connectorid)
        )
        .map((item) => ({
          logicalName: item.connectionreferencelogicalname,
          displayName: item.connectionreferencedisplayname || item.connectionreferencelogicalname,
          connectorId: item.connectorid,
          isManaged: item.ismanaged === true
        }));
    };
    const requireConnectionReference = async (logicalName: string) => {
      const requested = requireString(
        logicalName,
        'A Dataverse connection reference logical name',
        200
      );
      const match = (await listConnectionReferences()).find(
        (item) => item.logicalName.toLowerCase() === requested.toLowerCase()
      );
      if (!match) {
        throw new Error(
          `The Dataverse connection reference “${logicalName}” was not found. List available flow connection references first.`
        );
      }
      return match;
    };

    const markerSpec = (clientData?: string): DataverseFlowSpec | undefined => {
      if (!clientData) return undefined;
      try {
        const parsed = JSON.parse(clientData) as Record<string, unknown>;
        const properties = parsed.properties as Record<string, unknown> | undefined;
        const definition = properties?.definition as Record<string, unknown> | undefined;
        const triggers = definition?.triggers as Record<string, unknown> | undefined;
        if (!triggers) return undefined;
        for (const trigger of Object.values(triggers)) {
          if (!trigger || typeof trigger !== 'object') continue;
          const metadata = (trigger as Record<string, unknown>).metadata as
            Record<string, unknown> | undefined;
          const oddy = metadata?.oddy as Record<string, unknown> | undefined;
          if (oddy?.schemaVersion === 1 && oddy.spec && typeof oddy.spec === 'object') {
            return oddy.spec as DataverseFlowSpec;
          }
        }
      } catch {
        return undefined;
      }
      return undefined;
    };
    const flowDetail = (record: WorkflowRecord): DataverseFlowDetail => {
      if (!record.workflowid || !record.name)
        throw new Error('Dataverse returned an invalid flow record.');
      if (record.category !== undefined && record.category !== 5)
        throw new Error('The requested workflow is not a modern cloud flow.');
      if (record.type !== undefined && record.type !== 1)
        throw new Error('The requested workflow is not a cloud-flow definition.');
      const spec = markerSpec(record.clientdata);
      const isManaged = record.ismanaged === true;
      const definitionMatches = Boolean(
        spec && record.clientdata && definitionMatchesSpec(record.clientdata, spec)
      );
      return {
        workflowId: record.workflowid,
        name: record.name,
        description: record.description || undefined,
        state: stateName(record.statecode),
        isManaged,
        modifiedOn: record.modifiedon,
        oddyEditable: Boolean(spec) && definitionMatches && !isManaged,
        componentState: record.componentstate,
        etag: record['@odata.etag'],
        spec,
        warnings: isManaged
          ? ['Managed flows are read-only in Oddy.']
          : spec && !definitionMatches
            ? [
                'This Oddy flow definition changed outside Oddy or contains unsupported generated fields. Read it as inspection-only and prepare a new flow instead of overwriting it.'
              ]
            : spec
              ? undefined
              : ['Oddy can inspect this flow but cannot safely edit definitions it did not create.']
      };
    };
    const getFlow = async (workflowId: string): Promise<DataverseFlowDetail> => {
      const id = requireString(workflowId, 'A workflow ID', 60).replace(/[{}]/g, '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('The workflow ID is invalid.');
      const url =
        `${request.origin}/api/data/v9.2/workflows(${id})?` +
        '$select=workflowid,name,description,statecode,componentstate,category,type,ismanaged,modifiedon,clientdata';
      // Read the latest saved definition, not an older published version hidden beneath a draft.
      return flowDetail(await getJson<WorkflowRecord>(url, true));
    };
    const listFlows = async () => {
      const url = new URL(`${request.origin}/api/data/v9.2/workflows`);
      url.searchParams.set(
        '$select',
        'workflowid,name,description,statecode,componentstate,category,type,ismanaged,modifiedon,clientdata'
      );
      url.searchParams.set('$filter', 'category eq 5 and type eq 1');
      url.searchParams.set('$orderby', 'modifiedon desc');
      url.searchParams.set(
        '$top',
        String(Math.min(Math.max(request.action === 'list_flows' ? request.top || 20 : 20, 1), 50))
      );
      const payload = await getJson<{ value?: WorkflowRecord[] }>(url.toString(), true);
      return (payload.value || [])
        .map(flowDetail)
        .map(({ etag: _etag, spec: _spec, warnings: _warnings, ...summary }) => summary);
    };

    const normalizeFilter = async (
      filter: DataverseFlowFilter,
      entity: ResolvedEntity
    ): Promise<DataverseFlowFilter> => {
      const operators = new Set([
        'eq',
        'ne',
        'gt',
        'ge',
        'lt',
        'le',
        'contains',
        'begins-with',
        'ends-with'
      ]);
      if (
        !filter ||
        typeof filter !== 'object' ||
        !operators.has(filter.operator) ||
        !isScalar(filter.value)
      ) {
        throw new Error('A flow filter is invalid.');
      }
      return {
        column: await resolveColumn(entity, filter.column, 'read'),
        operator: filter.operator,
        value: filter.value
      };
    };
    const normalizeValue = async (
      value: DataverseFlowValue,
      triggerEntity: ResolvedEntity | undefined,
      priorActions: Map<string, { action: DataverseFlowAction; entity: ResolvedEntity }>
    ): Promise<DataverseFlowValue> => {
      if (!value || typeof value !== 'object') throw new Error('A flow value is invalid.');
      if (value.kind === 'literal') {
        if (!isScalar(value.value)) throw new Error('Flow literal values must be scalar.');
        return { kind: 'literal', value: value.value };
      }
      if (value.kind === 'trigger-column') {
        if (!triggerEntity) throw new Error('Manual triggers do not expose Dataverse columns.');
        return {
          kind: 'trigger-column',
          column: await resolveColumn(triggerEntity, value.column, 'read')
        };
      }
      if (value.kind === 'action-output') {
        const source = priorActions.get(value.actionId);
        if (!source)
          throw new Error(`Action output ${value.actionId} must reference an earlier action.`);
        if (source.action.kind === 'list-rows') {
          throw new Error(
            'List rows returns a collection and cannot be used as a single action-output value in this version.'
          );
        }
        return {
          kind: 'action-output',
          actionId: value.actionId,
          column: await resolveColumn(source.entity, value.column, 'read')
        };
      }
      throw new Error('The flow value kind is unsupported.');
    };
    const normalizeSpec = async (input: DataverseFlowSpec): Promise<DataverseFlowSpec> => {
      if (!input || typeof input !== 'object')
        throw new Error('A complete flow specification is required.');
      const name = requireString(input.name, 'Flow name', 200);
      const description =
        typeof input.description === 'string' && input.description.trim()
          ? input.description.trim().slice(0, 2000)
          : undefined;
      const connection = await requireConnectionReference(input.connectionReferenceLogicalName);
      let triggerEntity: ResolvedEntity | undefined;
      let trigger: DataverseFlowSpec['trigger'];
      if (input.trigger?.kind === 'manual') {
        trigger = { kind: 'manual' };
      } else if (input.trigger?.kind === 'dataverse-row') {
        triggerEntity = await resolveEntity(input.trigger.table);
        const changes = new Set(['create', 'update', 'delete']);
        const scopes = new Set([
          'user',
          'business-unit',
          'parent-child-business-units',
          'organization'
        ]);
        if (!changes.has(input.trigger.change) || !scopes.has(input.trigger.scope)) {
          throw new Error('The Dataverse trigger change or scope is invalid.');
        }
        const selectColumns: string[] = [];
        for (const column of (input.trigger.selectColumns || []).slice(0, 20)) {
          selectColumns.push(await resolveColumn(triggerEntity, column, 'read'));
        }
        const filters: DataverseFlowFilter[] = [];
        for (const filter of (input.trigger.filters || []).slice(0, 20)) {
          filters.push(await normalizeFilter(filter, triggerEntity));
        }
        trigger = {
          kind: 'dataverse-row',
          table: triggerEntity.logicalName,
          change: input.trigger.change,
          scope: input.trigger.scope,
          ...(selectColumns.length ? { selectColumns } : {}),
          ...(filters.length ? { filters } : {})
        };
      } else {
        throw new Error('Only manual and Dataverse row triggers are supported.');
      }
      if (!Array.isArray(input.actions) || input.actions.length > 20) {
        throw new Error('A flow must contain at most 20 actions.');
      }
      const ids = new Set<string>();
      const priorActions = new Map<
        string,
        { action: DataverseFlowAction; entity: ResolvedEntity }
      >();
      const actions: DataverseFlowAction[] = [];
      for (const candidate of input.actions) {
        const id = requireString(candidate.id, 'Action ID', 80);
        if (!actionIdPattern.test(id)) throw new Error(`Action ID “${id}” is invalid.`);
        if (ids.has(id)) throw new Error(`Action ID “${id}” is duplicated.`);
        ids.add(id);
        const entity = await resolveEntity(candidate.table);
        let action: DataverseFlowAction;
        if (candidate.kind === 'list-rows') {
          const selectColumns: string[] = [];
          for (const column of (candidate.selectColumns || []).slice(0, 20))
            selectColumns.push(await resolveColumn(entity, column, 'read'));
          const filters: DataverseFlowFilter[] = [];
          for (const filter of (candidate.filters || []).slice(0, 20))
            filters.push(await normalizeFilter(filter, entity));
          const orderBy: Array<{ column: string; direction: 'asc' | 'desc' }> = [];
          for (const order of (candidate.orderBy || []).slice(0, 5)) {
            orderBy.push({
              column: await resolveColumn(entity, order.column, 'read'),
              direction: order.direction === 'desc' ? 'desc' : 'asc'
            });
          }
          action = {
            id,
            kind: 'list-rows',
            table: entity.entitySetName,
            ...(selectColumns.length ? { selectColumns } : {}),
            ...(filters.length ? { filters } : {}),
            ...(orderBy.length ? { orderBy } : {}),
            ...(typeof candidate.top === 'number'
              ? { top: Math.min(Math.max(Math.trunc(candidate.top), 1), 5000) }
              : {})
          };
        } else if (candidate.kind === 'get-row') {
          const selectColumns: string[] = [];
          for (const column of (candidate.selectColumns || []).slice(0, 20))
            selectColumns.push(await resolveColumn(entity, column, 'read'));
          action = {
            id,
            kind: 'get-row',
            table: entity.entitySetName,
            rowId: await normalizeValue(candidate.rowId, triggerEntity, priorActions),
            ...(selectColumns.length ? { selectColumns } : {})
          };
        } else if (candidate.kind === 'add-row' || candidate.kind === 'update-row') {
          if (
            !Array.isArray(candidate.values) ||
            candidate.values.length < 1 ||
            candidate.values.length > 30
          ) {
            throw new Error(`${id} must define between 1 and 30 field values.`);
          }
          const values = [];
          const columns = new Set<string>();
          for (const item of candidate.values) {
            const mode = candidate.kind === 'add-row' ? 'create' : 'update';
            const attribute = await resolveAttribute(entity, item.column, mode);
            const column = attribute.LogicalName;
            if (columns.has(column)) throw new Error(`${id} sets ${column} more than once.`);
            columns.add(column);
            const value = await normalizeValue(item.value, triggerEntity, priorActions);
            validateWritableLiteral(entity, attribute, value);
            values.push({ column, value });
          }
          action =
            candidate.kind === 'add-row'
              ? { id, kind: 'add-row', table: entity.entitySetName, values }
              : {
                  id,
                  kind: 'update-row',
                  table: entity.entitySetName,
                  rowId: await normalizeValue(candidate.rowId, triggerEntity, priorActions),
                  values
                };
        } else {
          throw new Error(`Action ${id} has an unsupported kind.`);
        }
        actions.push(action);
        priorActions.set(id, { action, entity });
      }
      return {
        name,
        ...(description ? { description } : {}),
        connectionReferenceLogicalName: connection.logicalName,
        trigger,
        actions
      };
    };

    const formatScalar = (value: DataverseFlowScalar) => {
      if (value === null) return 'null';
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return `'${value.replace(/'/g, "''")}'`;
    };
    const compileFilter = (filter: DataverseFlowFilter) => {
      if (filter.operator === 'contains')
        return `contains(${filter.column},${formatScalar(filter.value)})`;
      if (filter.operator === 'begins-with')
        return `startswith(${filter.column},${formatScalar(filter.value)})`;
      if (filter.operator === 'ends-with')
        return `endswith(${filter.column},${formatScalar(filter.value)})`;
      return `${filter.column} ${filter.operator} ${formatScalar(filter.value)}`;
    };
    const compileValue = (value: DataverseFlowValue): DataverseFlowScalar => {
      if (value.kind === 'literal') return value.value;
      if (value.kind === 'trigger-column') return `@triggerOutputs()?['body/${value.column}']`;
      return `@outputs('${value.actionId}')?['body/${value.column}']`;
    };
    function compileClientData(spec: DataverseFlowSpec): string {
      const connectionName = connectorName;
      const host = (operationId: string) => ({
        apiId: connectorApiId,
        connectionName,
        operationId
      });
      const triggerName = spec.trigger.kind === 'manual' ? 'manual' : 'When_a_row_changes';
      const trigger =
        spec.trigger.kind === 'manual'
          ? {
              metadata: { oddy: { schemaVersion: 1, spec } },
              type: 'Request',
              kind: 'Button',
              inputs: { schema: { type: 'object', properties: {}, required: [] } }
            }
          : {
              metadata: { oddy: { schemaVersion: 1, spec } },
              type: 'OpenApiConnectionWebhook',
              inputs: {
                host: host('SubscribeWebhookTrigger'),
                parameters: {
                  'subscriptionRequest/message': { create: 1, delete: 2, update: 3 }[
                    spec.trigger.change
                  ],
                  'subscriptionRequest/entityname': spec.trigger.table,
                  'subscriptionRequest/scope': {
                    user: 1,
                    'business-unit': 2,
                    'parent-child-business-units': 3,
                    organization: 4
                  }[spec.trigger.scope],
                  ...(spec.trigger.selectColumns?.length
                    ? {
                        'subscriptionRequest/filteringattributes':
                          spec.trigger.selectColumns.join(',')
                      }
                    : {}),
                  ...(spec.trigger.filters?.length
                    ? {
                        'subscriptionRequest/filterexpression': spec.trigger.filters
                          .map(compileFilter)
                          .join(' and ')
                      }
                    : {})
                },
                authentication: "@parameters('$authentication')"
              }
            };
      const actions: Record<string, unknown> = {};
      let previous: string | undefined;
      for (const action of spec.actions) {
        const parameters: Record<string, unknown> = { entityName: action.table };
        let operationId: string;
        if (action.kind === 'list-rows') {
          operationId = 'ListRecords';
          if (action.selectColumns?.length) parameters.$select = action.selectColumns.join(',');
          if (action.filters?.length)
            parameters.$filter = action.filters.map(compileFilter).join(' and ');
          if (action.orderBy?.length)
            parameters.$orderby = action.orderBy
              .map((item) => `${item.column} ${item.direction}`)
              .join(',');
          if (action.top) parameters.$top = action.top;
        } else if (action.kind === 'get-row') {
          operationId = 'GetItem';
          parameters.recordId = compileValue(action.rowId);
          if (action.selectColumns?.length) parameters.$select = action.selectColumns.join(',');
        } else if (action.kind === 'add-row') {
          operationId = 'CreateRecord';
          for (const item of action.values)
            parameters[`item/${item.column}`] = compileValue(item.value);
        } else {
          operationId = 'UpdateOnlyRecord';
          parameters.recordId = compileValue(action.rowId);
          for (const item of action.values)
            parameters[`item/${item.column}`] = compileValue(item.value);
        }
        actions[action.id] = {
          runAfter: previous ? { [previous]: ['Succeeded'] } : {},
          metadata: {},
          type: 'OpenApiConnection',
          inputs: {
            host: host(operationId),
            parameters,
            authentication: "@parameters('$authentication')"
          }
        };
        previous = action.id;
      }
      return JSON.stringify({
        properties: {
          connectionReferences: {
            [connectionName]: {
              runtimeSource: 'embedded',
              connection: {
                connectionReferenceLogicalName: spec.connectionReferenceLogicalName
              },
              api: { name: connectorName }
            }
          },
          definition: {
            $schema: definitionSchema,
            contentVersion: '1.0.0.0',
            parameters: {
              $connections: { defaultValue: {}, type: 'Object' },
              $authentication: { defaultValue: {}, type: 'SecureObject' }
            },
            triggers: { [triggerName]: trigger },
            actions,
            outputs: {}
          }
        },
        schemaVersion: '1.0.0.0'
      });
    }
    function definitionMatchesSpec(clientData: string, spec: DataverseFlowSpec): boolean {
      const stable = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, stable(item)])
          );
        }
        return value;
      };
      const core = (text: string) => {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const properties = parsed.properties as Record<string, unknown> | undefined;
        const definition = properties?.definition as Record<string, unknown> | undefined;
        const connectionReferences =
          (properties?.connectionReferences as Record<string, unknown> | undefined) || {};
        const connections = Object.fromEntries(
          Object.entries(connectionReferences).map(([key, value]) => {
            const reference = value as Record<string, unknown>;
            const connection = reference.connection as Record<string, unknown> | undefined;
            const api = reference.api as Record<string, unknown> | undefined;
            return [
              key,
              {
                connectionReferenceLogicalName: connection?.connectionReferenceLogicalName,
                apiName: api?.name
              }
            ];
          })
        );
        const triggers = Object.fromEntries(
          Object.entries((definition?.triggers as Record<string, unknown> | undefined) || {}).map(
            ([key, value]) => {
              const trigger = value as Record<string, unknown>;
              return [key, { type: trigger.type, kind: trigger.kind, inputs: trigger.inputs }];
            }
          )
        );
        const actions = Object.fromEntries(
          Object.entries((definition?.actions as Record<string, unknown> | undefined) || {}).map(
            ([key, value]) => {
              const action = value as Record<string, unknown>;
              return [key, { type: action.type, runAfter: action.runAfter, inputs: action.inputs }];
            }
          )
        );
        return stable({ connections, triggers, actions });
      };
      try {
        return JSON.stringify(core(clientData)) === JSON.stringify(core(compileClientData(spec)));
      } catch {
        return false;
      }
    }

    if (request.action === 'list_flows') {
      return { ok: true, action: request.action, flows: await listFlows() };
    }
    if (request.action === 'get_flow') {
      return { ok: true, action: request.action, flow: await getFlow(request.workflowId) };
    }
    if (request.action === 'list_flow_connection_references') {
      return {
        ok: true,
        action: request.action,
        connectionReferences: await listConnectionReferences()
      };
    }
    if (request.action === 'get_flow_designer_target') {
      const flow = await getFlow(request.workflowId);
      const organization = await getJson<{ Detail?: { EnvironmentId?: string } }>(
        `${request.origin}/api/data/v9.2/RetrieveCurrentOrganization(AccessType=@p1)?` +
          `@p1=Microsoft.Dynamics.CRM.EndpointAccessType'Default'`
      );
      const environmentId = organization.Detail?.EnvironmentId?.trim() || '';
      if (!environmentId || environmentId.length > 200 || !/^[a-z0-9-]+$/i.test(environmentId)) {
        throw new Error('Dataverse did not return a valid Power Platform environment ID.');
      }
      return {
        ok: true,
        action: request.action,
        flowDesignerTarget: {
          environmentId,
          workflowId: flow.workflowId,
          flowName: flow.name
        }
      };
    }
    if (request.action === 'prepare_flow_change') {
      if (request.operation === 'update' && !request.workflowId) {
        throw new Error('A workflow ID is required to update a flow.');
      }
      const after = await normalizeSpec(request.spec);
      const before =
        request.operation === 'update' ? await getFlow(request.workflowId!) : undefined;
      if (before?.isManaged) throw new Error('Managed cloud flows cannot be edited.');
      if (before && !before.oddyEditable) {
        throw new Error(
          'This flow was not created by Oddy, so its definition cannot yet be edited safely. Oddy can still inspect it.'
        );
      }
      if (before && (!before.etag || before.etag === '*')) {
        throw new Error(
          'Dataverse did not return a row version for the flow draft. A safe update cannot be prepared.'
        );
      }
      const generatedClientData = compileClientData(after);
      const warnings =
        request.operation === 'create'
          ? [
              'The flow will be created in the environment default solution.',
              'The new flow will remain Off until it is activated separately.'
            ]
          : [
              'This approval saves an unpublished draft only. It does not publish, activate, or change the running flow.',
              'Review and publish the saved draft separately in Power Automate when ready.'
            ];
      return {
        ok: true,
        action: request.action,
        flowChange: {
          id: crypto.randomUUID(),
          operation: request.operation,
          environmentOrigin: request.origin,
          workflowId: before?.workflowId,
          etag: before?.etag,
          before,
          after,
          generatedClientData,
          ...(request.operation === 'update' ? { saveMode: 'draft' as const } : {}),
          warnings
        }
      };
    }
    if (request.action === 'execute_flow_change') {
      const change = request.change;
      if (change.environmentOrigin !== request.origin) {
        throw new Error('The approved flow preview belongs to a different Dataverse environment.');
      }
      if (change.operation === 'update' && change.saveMode !== 'draft') {
        throw new Error(
          'This older flow preview does not authorize a draft save. Prepare a fresh preview.'
        );
      }
      const normalized = await normalizeSpec(change.after);
      const generatedClientData = compileClientData(normalized);
      if (generatedClientData !== change.generatedClientData) {
        throw new Error('The prepared flow definition changed. Prepare a fresh preview.');
      }
      if (change.operation === 'create') {
        const response = await fetch(`${request.origin}/api/data/v9.2/workflows`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            category: 5,
            type: 1,
            primaryentity: 'none',
            name: normalized.name,
            description: normalized.description || null,
            clientdata: generatedClientData
          })
        });
        if (!response.ok) throw new Error(await errorText(response));
        const entityId =
          response.headers.get('OData-EntityId') || response.headers.get('odata-entityid');
        const workflowId = entityId?.match(/workflows\(([0-9a-f-]{36})\)/i)?.[1];
        if (!workflowId)
          throw new Error('Dataverse created the flow but did not return its workflow ID.');
        return {
          ok: true,
          action: request.action,
          flowChangeResult: {
            operation: 'create',
            workflowId,
            name: normalized.name,
            state: 'draft'
          }
        };
      }
      if (!change.workflowId || !change.etag || change.etag === '*') {
        throw new Error('The update preview is missing its workflow ID or row version.');
      }
      const current = await getFlow(change.workflowId);
      if (current.isManaged)
        throw new Error('The flow became managed and can no longer be edited.');
      if (!current.oddyEditable)
        throw new Error(
          'The current flow draft is no longer safely editable by Oddy. Prepare a fresh preview.'
        );
      if (
        current.etag !== change.etag ||
        current.componentState !== change.before?.componentState
      ) {
        throw new Error(
          'The flow changed after this preview was prepared. Prepare a fresh preview.'
        );
      }
      const response = await fetch(
        `${request.origin}/api/data/v9.2/workflows(${change.workflowId})`,
        {
          method: 'PATCH',
          credentials: 'include',
          // No publish call, activation, SkipComponentVersioning, wildcard ETag, or retry fallback.
          headers: { ...headers, 'If-Match': change.etag, 'MSCRM.AsUnpublished': 'true' },
          body: JSON.stringify({
            name: normalized.name,
            description: normalized.description || null,
            clientdata: generatedClientData
          })
        }
      );
      if (!response.ok) throw new Error(await errorText(response));
      return {
        ok: true,
        action: request.action,
        flowChangeResult: {
          operation: 'update',
          workflowId: change.workflowId,
          name: normalized.name,
          state: current.state,
          savedAs: 'unpublished-draft'
        }
      };
    }
    throw new Error('Unsupported Dataverse flow primitive.');
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export type {
  DataverseFlowPrimitiveRequest,
  DataverseFlowPrimitiveResult
} from './flows/contracts';
