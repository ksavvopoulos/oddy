import type {
  DataverseConnectionReferenceSummary,
  DataverseFlowDefinition,
  DataverseFlowDetail,
  DataverseFlowPrimitiveRequest,
  DataverseFlowPrimitiveResult,
  DataverseFlowState
} from './flows/contracts';

/** Runs in the Dataverse page MAIN world and must remain self-contained. */
export async function executeDataverseFlowPrimitive(
  request: DataverseFlowPrimitiveRequest
): Promise<DataverseFlowPrimitiveResult> {
  type JsonObject = Record<string, unknown>;
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
  type ConnectionRecord = {
    connectionreferencelogicalname?: string;
    connectionreferencedisplayname?: string;
    connectorid?: string;
    ismanaged?: boolean;
  };
  type EntityMetadata = { LogicalName?: string; EntitySetName?: string };
  type AttributeMetadata = {
    LogicalName?: string;
    AttributeType?: string;
    IsValidForRead?: boolean;
    IsValidForCreate?: boolean;
    IsValidForUpdate?: boolean;
  };
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0'
  };
  const object = (value: unknown): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const requireString = (value: unknown, label: string, maximum = 200): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
    const result = value.trim();
    if (result.length > maximum) throw new Error(`${label} is too long.`);
    return result;
  };
  const workflowId = (value: unknown) => {
    const id = requireString(value, 'A workflow ID', 60).replace(/[{}]/g, '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('The workflow ID is invalid.');
    return id;
  };
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
  const normalizeDefinition = (input: DataverseFlowDefinition): DataverseFlowDefinition => {
    const name = requireString(input?.name, 'Flow name', 200);
    if (input.description !== undefined && typeof input.description !== 'string')
      throw new Error('Flow description must be text.');
    const parsed: unknown = JSON.parse(
      requireString(input.clientData, 'Complete flow clientdata JSON', 1_000_000)
    );
    if (!object(parsed) || !object(parsed.properties) || !object(parsed.properties.definition))
      throw new Error('Flow clientdata must contain properties.definition.');
    const definition = parsed.properties.definition;
    if (
      !object(definition.triggers) ||
      Object.keys(definition.triggers).length !== 1 ||
      !object(definition.actions)
    )
      throw new Error('A flow definition requires one trigger and an actions object.');
    if (
      parsed.properties.connectionReferences !== undefined &&
      !object(parsed.properties.connectionReferences)
    )
      throw new Error('Flow connectionReferences must be an object.');
    let count = 0;
    const nodes = (map: unknown, path: string, depth = 0, trigger = false) => {
      if (!object(map)) throw new Error(`${path} must be an actions object.`);
      if (depth > 50) throw new Error('The flow action nesting is too deep.');
      const dependencies = new Map<string, string[]>();
      for (const [id, node] of Object.entries(map)) {
        if (++count > 1000) throw new Error('The flow contains too many actions.');
        if (!id.trim() || !object(node) || typeof node.type !== 'string' || !node.type.trim())
          throw new Error(
            `Every flow trigger and action must have a name and type (${path}/${id}).`
          );
        if (!trigger && node.runAfter !== undefined) {
          if (!object(node.runAfter)) throw new Error(`${path}/${id}/runAfter must be an object.`);
          for (const [dependency, statuses] of Object.entries(node.runAfter)) {
            if (
              !Object.hasOwn(map, dependency) ||
              dependency === id ||
              !Array.isArray(statuses) ||
              !statuses.length ||
              statuses.some(
                (status) => !['Succeeded', 'Failed', 'Skipped', 'TimedOut'].includes(String(status))
              )
            )
              throw new Error(`${path}/${id} has an invalid runAfter dependency.`);
          }
          dependencies.set(id, Object.keys(node.runAfter));
        }
        if (node.actions !== undefined) nodes(node.actions, `${path}/${id}/actions`, depth + 1);
        for (const branch of ['else', 'default']) {
          if (node[branch] !== undefined) {
            if (!object(node[branch]))
              throw new Error(`${path}/${id}/${branch} must be an object.`);
            nodes(node[branch].actions, `${path}/${id}/${branch}/actions`, depth + 1);
          }
        }
        if (node.cases !== undefined) {
          if (!object(node.cases)) throw new Error(`${path}/${id}/cases must be an object.`);
          for (const [key, branch] of Object.entries(node.cases)) {
            if (!object(branch)) throw new Error(`${path}/${id}/cases/${key} must be an object.`);
            nodes(branch.actions, `${path}/${id}/cases/${key}/actions`, depth + 1);
          }
        }
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error(`${path} contains circular runAfter dependencies.`);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of dependencies.get(id) || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const id of Object.keys(map)) visit(id);
    };
    nodes(definition.triggers, 'triggers', 0, true);
    nodes(definition.actions, 'actions');
    return { name, description: input.description, clientData: JSON.stringify(parsed) };
  };

  try {
    if (window.location.origin !== request.origin)
      throw new Error('The Dataverse environment changed before the flow operation ran.');
    const connectionSummary = (record: ConnectionRecord): DataverseConnectionReferenceSummary => ({
      logicalName: record.connectionreferencelogicalname!,
      displayName: record.connectionreferencedisplayname || record.connectionreferencelogicalname!,
      connectorId: record.connectorid!,
      isManaged: record.ismanaged === true
    });
    const listConnections = async () => {
      const url = new URL(`${request.origin}/api/data/v9.2/connectionreferences`);
      url.searchParams.set(
        '$select',
        'connectionreferencelogicalname,connectionreferencedisplayname,connectorid,ismanaged'
      );
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
      const payload = await getJson<{ value?: ConnectionRecord[] }>(url.toString());
      return (payload.value || [])
        .filter((item) => item.connectionreferencelogicalname && item.connectorid)
        .map(connectionSummary);
    };
    const flowDetail = (record: WorkflowRecord): DataverseFlowDetail => {
      if (!record.workflowid || !record.name)
        throw new Error('Dataverse returned an invalid flow record.');
      if (
        (record.category !== undefined && record.category !== 5) ||
        (record.type !== undefined && record.type !== 1)
      )
        throw new Error('The requested workflow is not a modern cloud-flow definition.');
      let definition: DataverseFlowDefinition | undefined;
      try {
        definition = normalizeDefinition({
          name: record.name,
          description: record.description || undefined,
          clientData: record.clientdata || ''
        });
      } catch {
        // Inspection and navigation must still work for malformed or oversized definitions.
      }
      const isManaged = record.ismanaged === true;
      return {
        workflowId: record.workflowid,
        name: record.name,
        description: record.description || undefined,
        state: stateName(record.statecode),
        isManaged,
        modifiedOn: record.modifiedon,
        oddyEditable: Boolean(definition) && !isManaged,
        componentState: record.componentstate,
        etag: record['@odata.etag'],
        definition,
        warnings: isManaged
          ? ['Managed flows are read-only in Oddy.']
          : !definition
            ? [
                'The saved flow definition is missing, malformed, too large, or exceeds the supported nesting/action limits.'
              ]
            : undefined
      };
    };
    const getFlow = async (value: string) => {
      const id = workflowId(value);
      const url = `${request.origin}/api/data/v9.2/workflows(${id})?$select=workflowid,name,description,statecode,componentstate,category,type,ismanaged,modifiedon,clientdata`;
      return flowDetail(await getJson<WorkflowRecord>(url, true));
    };

    // Validation works on native definitions. It never compiles or rewrites the graph.
    const validateMetadata = async (
      after: DataverseFlowDefinition,
      before?: DataverseFlowDefinition
    ) => {
      const proposed = JSON.parse(after.clientData).properties;
      const original = before ? JSON.parse(before.clientData).properties : undefined;
      const references: JsonObject = proposed.connectionReferences || {};
      const originalReferences: JsonObject = original?.connectionReferences || {};
      const warnings = new Set<string>();
      const connections = new Map<string, DataverseConnectionReferenceSummary>();
      const entities = new Map<string, EntityMetadata>();
      const columns = new Map<string, AttributeMetadata[]>();
      const dynamic = (value: string) => value.startsWith('@') && !value.startsWith('@@');
      const connection = async (alias: string) => {
        const cached = connections.get(alias);
        if (cached) return cached;
        const reference = references[alias];
        if (!object(reference))
          throw new Error(`Connection reference ${alias} is missing from clientdata.`);
        const nested = object(reference.connection) ? reference.connection : {};
        const logicalName = requireString(
          nested.connectionReferenceLogicalName ?? reference.connectionReferenceLogicalName,
          `Existing connection reference for ${alias}`
        );
        const url = new URL(`${request.origin}/api/data/v9.2/connectionreferences`);
        url.searchParams.set(
          '$select',
          'connectionreferencelogicalname,connectionreferencedisplayname,connectorid,ismanaged'
        );
        url.searchParams.set(
          '$filter',
          `connectionreferencelogicalname eq '${logicalName.replace(/'/g, "''")}'`
        );
        const payload = await getJson<{ value?: ConnectionRecord[] }>(url.toString());
        const match = payload.value?.find(
          (item) =>
            item.connectionreferencelogicalname?.toLowerCase() === logicalName.toLowerCase() &&
            item.connectorid
        );
        if (!match)
          throw new Error(
            `The connection reference “${logicalName}” was not found. List existing flow connections first.`
          );
        const result = connectionSummary(match);
        const api = object(reference.api) ? reference.api : {};
        const declared = api.name ?? api.id ?? reference.id;
        if (
          typeof declared === 'string' &&
          declared.split('/').pop()?.toLowerCase() !==
            result.connectorId.split('/').pop()?.toLowerCase()
        )
          throw new Error(`Connection reference ${alias} does not match its declared connector.`);
        connections.set(alias, result);
        return result;
      };
      const entity = async (table: string) => {
        if (entities.has(table)) return entities.get(table)!;
        if (!/^[a-z0-9_]+$/i.test(table))
          throw new Error(`Invalid Dataverse table name “${table}”.`);
        const select = 'LogicalName,EntitySetName';
        const url = new URL(`${request.origin}/api/data/v9.2/EntityDefinitions`);
        url.searchParams.set('$select', select);
        url.searchParams.set('$filter', `LogicalName eq '${table}' or EntitySetName eq '${table}'`);
        const payload = await getJson<{ value?: EntityMetadata[] }>(url.toString());
        const match = payload.value?.find(
          (item) => item.LogicalName === table || item.EntitySetName === table
        );
        if (!match?.LogicalName || !match.EntitySetName)
          throw new Error(`Could not resolve the Dataverse table “${table}”.`);
        entities.set(table, match);
        return match;
      };
      const attribute = async (
        table: EntityMetadata,
        name: string,
        mode: 'read' | 'create' | 'update'
      ) => {
        const key = table.LogicalName!;
        if (!columns.has(key)) {
          const payload = await getJson<{ value?: AttributeMetadata[] }>(
            `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${key}')/Attributes?$select=LogicalName,AttributeType,IsValidForRead,IsValidForCreate,IsValidForUpdate`
          );
          columns.set(key, payload.value || []);
        }
        const match = columns.get(key)!.find((item) => item.LogicalName === name);
        if (!match)
          throw new Error(`Could not resolve ${key}.${name}. Use the column logical name.`);
        const allowed =
          mode === 'read'
            ? match.IsValidForRead !== false
            : mode === 'create'
              ? match.IsValidForCreate === true
              : match.IsValidForUpdate === true;
        if (!allowed) throw new Error(`${key}.${name} cannot be used for ${mode}.`);
        return match;
      };
      const validateNode = async (node: JsonObject) => {
        if (!['OpenApiConnection', 'OpenApiConnectionWebhook'].includes(String(node.type))) return;
        const inputs = object(node.inputs) ? node.inputs : {};
        const host = object(inputs.host) ? inputs.host : {};
        const alias = host.connectionReferenceName ?? host.connectionName;
        if (typeof alias !== 'string' || dynamic(alias)) {
          const legacyConnection = host.connection;
          if (
            typeof alias !== 'string' &&
            typeof legacyConnection !== 'string' &&
            !(object(legacyConnection) && typeof legacyConnection.name === 'string')
          )
            throw new Error(
              'A connector action or trigger must specify an existing connection reference.'
            );
          warnings.add(
            'Some connector bindings are dynamic or use a legacy format and could not be verified locally.'
          );
          return;
        }
        const ref = await connection(alias);
        if (!ref.connectorId.toLowerCase().endsWith('/shared_commondataserviceforapps')) return;
        const parameters = object(inputs.parameters) ? inputs.parameters : {};
        const trigger = node.type === 'OpenApiConnectionWebhook';
        const tableName = parameters[trigger ? 'subscriptionRequest/entityname' : 'entityName'];
        if (tableName === undefined) return; // Other Dataverse operations do not take a table.
        if (typeof tableName !== 'string') throw new Error('Dataverse entityName must be text.');
        if (dynamic(tableName)) {
          warnings.add(
            'Dynamic Dataverse table names cannot be checked against metadata before runtime.'
          );
          return;
        }
        const table = await entity(tableName);
        const expected = trigger ? table.LogicalName : table.EntitySetName;
        if (tableName !== expected)
          throw new Error(
            `Use ${expected}, not ${tableName}, for this Dataverse ${trigger ? 'trigger' : 'action'} table.`
          );
        const selections =
          parameters[trigger ? 'subscriptionRequest/filteringattributes' : '$select'];
        if (typeof selections === 'string' && !dynamic(selections)) {
          for (const column of selections
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean))
            await attribute(table, column, 'read');
        }
        if (typeof parameters.$orderby === 'string' && !dynamic(parameters.$orderby)) {
          for (const sort of parameters.$orderby.split(','))
            await attribute(table, sort.trim().split(/\s+/)[0]!, 'read');
        }
        const mode =
          host.operationId === 'CreateRecord'
            ? 'create'
            : ['UpdateOnlyRecord', 'UpdateRecord'].includes(String(host.operationId))
              ? 'update'
              : undefined;
        if (!mode) return;
        for (const [key, value] of Object.entries(parameters)) {
          if (!key.startsWith('item/')) continue;
          const column = key.slice(5);
          if (column.includes('@odata.bind')) {
            warnings.add(
              'Lookup binding syntax and target records require separate connector validation.'
            );
            continue;
          }
          const field = await attribute(table, column, mode);
          if (value === null || (typeof value === 'string' && dynamic(value))) continue;
          const type = field.AttributeType;
          if (type === 'Boolean' && typeof value !== 'boolean')
            throw new Error(`${table.LogicalName}.${column} requires a boolean literal.`);
          if (
            [
              'Integer',
              'BigInt',
              'Decimal',
              'Double',
              'Money',
              'Picklist',
              'State',
              'Status'
            ].includes(type || '') &&
            typeof value !== 'number'
          )
            throw new Error(`${table.LogicalName}.${column} requires a numeric literal.`);
          if (
            ['String', 'Memo', 'DateTime', 'Uniqueidentifier'].includes(type || '') &&
            typeof value !== 'string'
          )
            throw new Error(`${table.LogicalName}.${column} requires a text literal.`);
          if (
            type === 'DateTime' &&
            typeof value === 'string' &&
            (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value)))
          )
            throw new Error(`${table.LogicalName}.${column} requires an ISO date/time literal.`);
          if (
            type === 'Uniqueidentifier' &&
            typeof value === 'string' &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
          )
            throw new Error(`${table.LogicalName}.${column} requires a GUID literal.`);
        }
      };
      for (const [alias, reference] of Object.entries(references)) {
        if (JSON.stringify(reference) !== JSON.stringify(originalReferences[alias]))
          await connection(alias);
      }
      const walk = async (map: JsonObject, oldMap: JsonObject = {}) => {
        for (const [id, value] of Object.entries(map)) {
          const node = value as JsonObject;
          const old = object(oldMap[id]) ? oldMap[id] : {};
          const inputs = object(node.inputs) ? node.inputs : {};
          const host = object(inputs.host) ? inputs.host : {};
          const alias = host.connectionReferenceName ?? host.connectionName;
          const bindingChanged =
            typeof alias === 'string' &&
            JSON.stringify(references[alias]) !== JSON.stringify(originalReferences[alias]);
          if (bindingChanged || JSON.stringify(node) !== JSON.stringify(old))
            await validateNode(node);
          if (object(node.actions))
            await walk(node.actions, object(old.actions) ? old.actions : {});
          for (const branch of ['else', 'default']) {
            const currentBranch = node[branch];
            const oldBranch = old[branch];
            if (object(currentBranch) && object(currentBranch.actions))
              await walk(
                currentBranch.actions,
                object(oldBranch) && object(oldBranch.actions) ? oldBranch.actions : {}
              );
          }
          if (object(node.cases)) {
            for (const [key, branch] of Object.entries(node.cases)) {
              const oldBranch = object(old.cases) ? old.cases[key] : undefined;
              if (object(branch) && object(branch.actions))
                await walk(
                  branch.actions,
                  object(oldBranch) && object(oldBranch.actions) ? oldBranch.actions : {}
                );
            }
          }
        }
      };
      await walk(proposed.definition.triggers, original?.definition.triggers);
      await walk(proposed.definition.actions, original?.definition.actions);
      return [...warnings];
    };

    if (request.action === 'list_flow_connection_references')
      return { ok: true, action: request.action, connectionReferences: await listConnections() };
    if (request.action === 'get_flow')
      return { ok: true, action: request.action, flow: await getFlow(request.workflowId) };
    if (request.action === 'list_flows') {
      const url = new URL(`${request.origin}/api/data/v9.2/workflows`);
      url.searchParams.set(
        '$select',
        'workflowid,name,description,statecode,componentstate,category,type,ismanaged,modifiedon,clientdata'
      );
      url.searchParams.set('$filter', 'category eq 5 and type eq 1');
      url.searchParams.set('$orderby', 'modifiedon desc');
      url.searchParams.set('$top', String(Math.min(Math.max(request.top || 20, 1), 50)));
      const payload = await getJson<{ value?: WorkflowRecord[] }>(url.toString(), true);
      const flows = (payload.value || [])
        .map(flowDetail)
        .map(
          ({ etag: _etag, definition: _definition, warnings: _warnings, ...summary }) => summary
        );
      return { ok: true, action: request.action, flows };
    }
    if (request.action === 'get_flow_designer_target') {
      const flow = await getFlow(request.workflowId);
      const organization = await getJson<{ Detail?: { EnvironmentId?: string } }>(
        `${request.origin}/api/data/v9.2/RetrieveCurrentOrganization(AccessType=@p1)?@p1=Microsoft.Dynamics.CRM.EndpointAccessType'Default'`
      );
      const environmentId = organization.Detail?.EnvironmentId?.trim() || '';
      if (!environmentId || environmentId.length > 200 || !/^[a-z0-9-]+$/i.test(environmentId))
        throw new Error('Dataverse did not return a valid Power Platform environment ID.');
      return {
        ok: true,
        action: request.action,
        flowDesignerTarget: { environmentId, workflowId: flow.workflowId, flowName: flow.name }
      };
    }
    const draftWarnings = [
      'This approval saves an unpublished draft only. It does not publish, activate, or change the running flow.',
      'Review and publish the saved draft separately in Power Automate when ready.'
    ];
    if (request.action === 'prepare_flow_change') {
      if (!['create', 'update'].includes(request.operation))
        throw new Error('A valid flow-change operation is required.');
      if (request.operation === 'create' && (request.workflowId || request.etag))
        throw new Error('Create proposals cannot target an existing flow.');
      const before =
        request.operation === 'update' ? await getFlow(request.workflowId || '') : undefined;
      if (before?.isManaged) throw new Error('Managed cloud flows cannot be edited.');
      if (before && !before.definition)
        throw new Error('The current flow definition cannot be edited.');
      if (
        before &&
        (!request.etag || request.etag === '*' || !before.etag || before.etag !== request.etag)
      )
        throw new Error(
          'The flow changed or its row version is missing. Read it again before preparing changes.'
        );
      const after = normalizeDefinition({
        ...request.definition,
        description: request.definition?.description ?? before?.description
      });
      const warnings = await validateMetadata(after, before?.definition);
      return {
        ok: true,
        action: request.action,
        flowChange: {
          mode: 'definition',
          id: crypto.randomUUID(),
          operation: request.operation,
          environmentOrigin: request.origin,
          workflowId: before?.workflowId,
          etag: before?.etag,
          before,
          after,
          generatedClientData: after.clientData,
          ...(before ? { saveMode: 'draft' as const } : {}),
          warnings: [
            ...(before
              ? draftWarnings
              : [
                  'The flow will be created in the environment default solution.',
                  'The new flow will remain Off until it is activated separately.'
                ]),
            'Review the complete definition, nested actions, expressions, and connection references. Unchanged content must be preserved.',
            'Structure, changed connector bindings, and static Dataverse tables/columns are checked locally. Full connector schemas and expression semantics still require validation in Power Automate.',
            ...warnings
          ]
        }
      };
    }
    if (request.action === 'execute_flow_change') {
      const change = request.change;
      if (change.mode !== 'definition' || !change.after?.clientData)
        throw new Error('This legacy flow preview must be refreshed using a complete definition.');
      if (!['create', 'update'].includes(change.operation))
        throw new Error('A valid flow-change operation is required.');
      if (change.environmentOrigin !== request.origin)
        throw new Error('The approved flow preview belongs to a different Dataverse environment.');
      if (change.operation === 'update' && change.saveMode !== 'draft')
        throw new Error(
          'This older flow preview does not authorize a draft save. Prepare a fresh preview.'
        );
      const after = normalizeDefinition(change.after);
      if (after.clientData !== change.generatedClientData)
        throw new Error('The prepared flow definition changed. Prepare a fresh preview.');
      if (change.operation === 'create') {
        if (change.workflowId || change.etag || change.before)
          throw new Error('Create previews cannot target an existing flow.');
        await validateMetadata(after);
        const response = await fetch(`${request.origin}/api/data/v9.2/workflows`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            category: 5,
            type: 1,
            primaryentity: 'none',
            statecode: 0,
            name: after.name,
            description: after.description || null,
            clientdata: after.clientData
          })
        });
        if (!response.ok) throw new Error(await errorText(response));
        const entityId = response.headers.get('OData-EntityId');
        const id = entityId?.match(/workflows\(([0-9a-f-]{36})\)/i)?.[1];
        if (!id) throw new Error('Dataverse created the flow but did not return its workflow ID.');
        return {
          ok: true,
          action: request.action,
          flowChangeResult: {
            operation: 'create',
            workflowId: id,
            name: after.name,
            state: 'draft'
          }
        };
      }
      if (!change.workflowId || !change.etag || change.etag === '*' || !change.before?.definition)
        throw new Error(
          'The update preview is missing its workflow ID, row version, or saved definition.'
        );
      const current = await getFlow(change.workflowId);
      if (current.isManaged)
        throw new Error('The flow became managed and can no longer be edited.');
      if (
        !current.definition ||
        current.workflowId !== change.before.workflowId ||
        current.definition.clientData !== change.before.definition.clientData ||
        current.name !== change.before.name ||
        current.description !== change.before.description
      )
        throw new Error(
          'The flow definition changed after this preview was prepared. Prepare a fresh preview.'
        );
      if (current.etag !== change.etag || current.componentState !== change.before.componentState)
        throw new Error(
          'The flow changed after this preview was prepared. Prepare a fresh preview.'
        );
      await validateMetadata(after, current.definition);
      const response = await fetch(
        `${request.origin}/api/data/v9.2/workflows(${current.workflowId})`,
        {
          method: 'PATCH',
          credentials: 'include',
          // No activation/publish call, wildcard ETag, SkipComponentVersioning, or fallback retry.
          headers: { ...headers, 'If-Match': change.etag, 'MSCRM.AsUnpublished': 'true' },
          body: JSON.stringify({
            name: after.name,
            description: after.description || null,
            clientdata: after.clientData
          })
        }
      );
      if (!response.ok) throw new Error(await errorText(response));
      return {
        ok: true,
        action: request.action,
        flowChangeResult: {
          operation: 'update',
          workflowId: current.workflowId,
          name: after.name,
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
