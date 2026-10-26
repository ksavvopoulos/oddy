import type { DataverseFilterOperator } from '../dataverse/contracts';
import type { DataverseMutationValueInput } from '../types';
import type { BulkPlan, BulkSelection } from './contracts';

const operators = new Set([
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
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a complete bulk-plan object.');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    throw new Error('A non-empty, bounded string is required in the bulk plan.');
  return value.trim();
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported bulk-plan property. Nothing was silently discarded.');
};
export function parseBulkSelection(value: unknown, related = false): BulkSelection {
  const input = object(value);
  keys(input, ['table', 'filters', 'allRecords', ...(related ? ['lookupColumn'] : [])]);
  if (!Array.isArray(input.filters) || input.filters.length > 20)
    throw new Error('Supply all selection filters explicitly (maximum 20).');
  if (typeof input.allRecords !== 'boolean' || (!input.filters.length && input.allRecords !== true))
    throw new Error('An unfiltered selection requires allRecords: true.');
  return {
    table: text(input.table),
    allRecords: input.allRecords,
    filters: input.filters.map((raw) => {
      const filter = object(raw);
      keys(filter, ['column', 'operator', 'value', 'entityType']);
      const operator = text(filter.operator);
      if (!operators.has(operator)) throw new Error(`Unsupported bulk filter: ${operator}.`);
      const needsValue = operator !== 'null' && operator !== 'not-null';
      if (needsValue && (typeof filter.value !== 'string' || !filter.value.trim()))
        throw new Error('A bulk filter value is missing or invalid.');
      return {
        column: text(filter.column),
        operator: operator as DataverseFilterOperator,
        ...(needsValue ? { value: text(filter.value) } : {}),
        ...(filter.entityType !== undefined ? { entityType: text(filter.entityType) } : {})
      };
    })
  };
}
export function parseBulkValues(value: unknown): DataverseMutationValueInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new Error('Supply 1–20 complete field changes.');
  return value.map((raw) => {
    const item = object(raw);
    keys(item, ['column', 'value', 'lookup']);
    const column = text(item.column);
    if (item.lookup !== undefined) {
      if ('value' in item) throw new Error('Supply either value or lookup, not both.');
      const lookup = object(item.lookup);
      keys(lookup, ['table', 'recordId', 'recordName']);
      return {
        column,
        lookup: {
          table: text(lookup.table),
          recordId: text(lookup.recordId),
          ...(lookup.recordName !== undefined ? { recordName: text(lookup.recordName) } : {})
        }
      };
    }
    if (
      !('value' in item) ||
      (item.value !== null && !['string', 'number', 'boolean'].includes(typeof item.value)) ||
      (typeof item.value === 'number' && !Number.isFinite(item.value))
    )
      throw new Error('Invalid bulk field value.');
    if (typeof item.value === 'string' && item.value.length > 10000)
      throw new Error('Bulk field text exceeds 10,000 characters.');
    return { column, value: item.value };
  });
}
export function parseBulkPlan(value: unknown): BulkPlan {
  const input = object(value);
  switch (input.operation) {
    case 'update':
      keys(input, ['operation', 'selection', 'values']);
      return {
        operation: 'update',
        selection: parseBulkSelection(input.selection),
        values: parseBulkValues(input.values)
      };
    case 'count_related':
      keys(input, ['operation', 'selection', 'targetColumn', 'related']);
      return {
        operation: 'count_related',
        selection: parseBulkSelection(input.selection),
        targetColumn: text(input.targetColumn),
        related: {
          ...parseBulkSelection(input.related, true),
          lookupColumn: text(object(input.related).lookupColumn)
        }
      };
    case 'membership': {
      keys(input, ['operation', 'selection', 'listId']);
      const listId = text(input.listId).replace(/[{}]/g, '').toLowerCase();
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(listId))
        throw new Error('A resolved marketing-list GUID is required.');
      return { operation: 'membership', selection: parseBulkSelection(input.selection), listId };
    }
    case 'create': {
      keys(input, ['operation', 'table', 'datasetId', 'mapping']);
      const mapping = object(input.mapping);
      if (!Object.keys(mapping).length || Object.keys(mapping).length > 20)
        throw new Error('Map 1–20 dataset columns explicitly.');
      const result = Object.fromEntries(
        Object.entries(mapping).map(([source, target]) => [text(source), text(target)])
      );
      if (
        new Set(Object.values(result).map((v) => v.toLowerCase())).size !==
        Object.keys(result).length
      )
        throw new Error('Multiple dataset columns cannot map to the same destination.');
      return {
        operation: 'create',
        table: text(input.table),
        datasetId: text(input.datasetId),
        mapping: result
      };
    }
    default:
      throw new Error('Unsupported bulk operation.');
  }
}
