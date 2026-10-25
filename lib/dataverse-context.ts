import type { DataverseContext, DataverseContextSource, DataverseField } from './types';

export interface PageContextSnapshot {
  source?: DataverseContextSource;
  tableLogicalName?: string;
  recordId?: string;
  recordName?: string;
  formName?: string;
  fields?: DataverseField[];
  warning?: string;
}

export interface WebApiContextRequest {
  origin: string;
  tableLogicalName: string;
  recordId: string;
}

export function isDataverseUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.endsWith('.dynamics.com') || hostname.endsWith('.powerapps.com');
  } catch {
    return false;
  }
}

export function contextFromUrl(url: string, title?: string): DataverseContext {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  const hostnameParts = parsed.hostname.split('.');

  return {
    isDataverse: isDataverseUrl(url),
    source: 'url',
    origin: parsed.origin,
    environmentName: hostnameParts[0],
    appId: params.get('appid') || undefined,
    pageType: params.get('pagetype') || undefined,
    tableLogicalName: params.get('etn') || undefined,
    recordId: normalizeRecordId(params.get('id')),
    title,
    url,
    fields: [],
    capturedAt: new Date().toISOString()
  };
}

export function mergePageContext(
  base: DataverseContext,
  snapshot?: PageContextSnapshot
): DataverseContext {
  if (!snapshot) return base;

  return {
    ...base,
    source: snapshot.source || base.source,
    tableLogicalName: snapshot.tableLogicalName || base.tableLogicalName,
    recordId: normalizeRecordId(snapshot.recordId) || base.recordId,
    recordName: snapshot.recordName || base.recordName,
    formName: snapshot.formName || base.formName,
    fields: snapshot.fields ?? base.fields,
    warning: snapshot.warning,
    capturedAt: new Date().toISOString()
  };
}

export function pickBestPageContext(
  snapshots: Array<PageContextSnapshot | undefined>
): PageContextSnapshot | undefined {
  return snapshots
    .filter((snapshot): snapshot is PageContextSnapshot => Boolean(snapshot))
    .sort((left, right) => scoreSnapshot(right) - scoreSnapshot(left))[0];
}

function scoreSnapshot(snapshot: PageContextSnapshot): number {
  return (
    (snapshot.fields?.length ? 1000 + snapshot.fields.length : 0) +
    (snapshot.tableLogicalName ? 100 : 0) +
    (snapshot.recordId ? 50 : 0) +
    (snapshot.recordName ? 25 : 0) +
    (snapshot.formName ? 10 : 0) +
    (snapshot.warning ? 0 : 5)
  );
}

export function normalizeRecordId(value?: string | null): string | undefined {
  const normalized = value?.replace(/[{}]/g, '').trim();
  return normalized || undefined;
}

/** Runs in every accessible Dataverse frame's MAIN world. */
export function collectXrmPageContext(): PageContextSnapshot {
  type XrmAttribute = {
    getName?: () => string;
    getAttributeType?: () => string;
    getValue?: () => unknown;
    getText?: () => string | null;
    controls?: { get?: (index?: number) => unknown };
  };

  const sanitize = (value: unknown, depth = 0): unknown => {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.length > 4000 ? `${value.slice(0, 4000)}… [truncated]` : value;
    }
    if (value instanceof Date) return value.toISOString();
    if (depth > 2) return String(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 20)
          .map(([key, item]) => [key, sanitize(item, depth + 1)])
      );
    }
    return String(value);
  };

  try {
    const pageWindow = window as typeof window & {
      Xrm?: {
        Page?: {
          data?: {
            entity?: {
              getEntityName?: () => string;
              getId?: () => string;
              getPrimaryAttributeValue?: () => string;
              attributes?: { get?: () => XrmAttribute[] };
            };
          };
          ui?: {
            formSelector?: { getCurrentItem?: () => { getLabel?: () => string } | null };
          };
        };
      };
    };

    const page = pageWindow.Xrm?.Page;
    const entity = page?.data?.entity;
    if (!entity) {
      return {
        source: 'url',
        warning: 'The Dataverse form API is not available in this frame.'
      };
    }

    const attributes = entity.attributes?.get?.() || [];
    const fields = attributes.slice(0, 200).map((attribute) => {
      const control = attribute.controls?.get?.(0) as { getLabel?: () => string } | undefined;
      const logicalName = attribute.getName?.() || 'unknown';
      const text = attribute.getText?.();

      return {
        logicalName,
        label: control?.getLabel?.() || logicalName,
        type: attribute.getAttributeType?.(),
        value: sanitize(attribute.getValue?.()),
        formattedValue: text || undefined
      };
    });

    return {
      source: 'xrm',
      tableLogicalName: entity.getEntityName?.(),
      recordId: entity.getId?.(),
      recordName: entity.getPrimaryAttributeValue?.(),
      formName: page?.ui?.formSelector?.getCurrentItem?.()?.getLabel?.(),
      fields
    };
  } catch (error) {
    return {
      source: 'url',
      warning: `Could not read the Dataverse form API: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** Runs in the Dataverse page's MAIN world so the request uses the signed-in browser session. */
export async function collectDataverseWebApiContext(
  request: WebApiContextRequest
): Promise<PageContextSnapshot> {
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.length > 4000 ? `${value.slice(0, 4000)}… [truncated]` : value;
    }
    if (depth > 2) return String(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 20)
          .map(([key, item]) => [key, sanitize(item, depth + 1)])
      );
    }
    return String(value);
  };

  const humanize = (logicalName: string): string => {
    const cleaned = logicalName.replace(/^_/, '').replace(/_value$/, '');
    return cleaned
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  try {
    if (!/^[a-z0-9_]+$/i.test(request.tableLogicalName)) {
      throw new Error('The table logical name is invalid.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.recordId)) {
      throw new Error('The record ID is not a valid GUID.');
    }

    const headers = {
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    };
    const metadataUrl =
      `${request.origin}/api/data/v9.2/EntityDefinitions(LogicalName='${request.tableLogicalName}')` +
      '?$select=EntitySetName,PrimaryNameAttribute,LogicalName';
    const metadataResponse = await fetch(metadataUrl, {
      credentials: 'include',
      headers
    });
    if (!metadataResponse.ok) {
      const detail = (await metadataResponse.text()).slice(0, 500);
      throw new Error(
        `Metadata request failed (${metadataResponse.status}): ${detail || metadataResponse.statusText}`
      );
    }

    const metadata = (await metadataResponse.json()) as {
      EntitySetName?: string;
      PrimaryNameAttribute?: string;
    };
    if (!metadata.EntitySetName) {
      throw new Error('Dataverse metadata did not return an entity-set name.');
    }

    const recordUrl = `${request.origin}/api/data/v9.2/${metadata.EntitySetName}(${request.recordId})`;
    const recordResponse = await fetch(recordUrl, {
      credentials: 'include',
      headers: {
        ...headers,
        Prefer:
          'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname"'
      }
    });
    if (!recordResponse.ok) {
      const detail = (await recordResponse.text()).slice(0, 500);
      throw new Error(
        `Record request failed (${recordResponse.status}): ${detail || recordResponse.statusText}`
      );
    }

    const record = (await recordResponse.json()) as Record<string, unknown>;
    const fields = Object.entries(record)
      .filter(([key, value]) => !key.includes('@') && value != null)
      .slice(0, 150)
      .map(([logicalName, value]) => {
        const formattedValue = record[`${logicalName}@OData.Community.Display.V1.FormattedValue`];
        const lookupType = record[`${logicalName}@Microsoft.Dynamics.CRM.lookuplogicalname`];

        return {
          logicalName,
          label: humanize(logicalName),
          type:
            typeof lookupType === 'string'
              ? `lookup (${lookupType})`
              : logicalName.startsWith('_') && logicalName.endsWith('_value')
                ? 'lookup'
                : Array.isArray(value)
                  ? 'array'
                  : typeof value,
          value: sanitize(value),
          formattedValue: typeof formattedValue === 'string' ? formattedValue : undefined
        };
      });

    const primaryName = metadata.PrimaryNameAttribute
      ? record[metadata.PrimaryNameAttribute]
      : undefined;

    return {
      source: 'webApi',
      tableLogicalName: request.tableLogicalName,
      recordId: request.recordId,
      recordName: typeof primaryName === 'string' ? primaryName : undefined,
      fields
    };
  } catch (error) {
    return {
      source: 'url',
      warning: `Dataverse Web API fallback failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
