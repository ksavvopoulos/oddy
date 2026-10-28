import type {
  DataverseFilterOperator,
  DataverseFilterSpec,
  DataverseOrderSpec,
  DataverseQuerySpec
} from '../dataverse-primitives';
import type { DataverseMutationValueInput, OddySkill, OddySkillToolName } from '../types';
import { SKILL_TOOL_OPTIONS } from './tool-catalog';

const ALLOWED_OPERATORS = new Set<DataverseFilterOperator>([
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

export function skillFromToolArguments(value: unknown): OddySkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A complete skill definition is required.');
  }
  const candidate = value as Record<string, unknown>;
  const allowedTools = stringArray(
    candidate.allowedTools,
    SKILL_TOOL_OPTIONS.length
  ) as OddySkillToolName[];
  const inputs = Array.isArray(candidate.inputs)
    ? candidate.inputs
        .filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
        .map((item) => {
          const type: OddySkill['inputs'][number]['type'] =
            item.type === 'number' || item.type === 'select' ? item.type : 'text';
          return {
            id: stringValue(item.id),
            label: stringValue(item.label),
            type,
            required: item.required === true,
            ...(type === 'select' ? { options: stringArray(item.options, 50) } : {})
          };
        })
        .slice(0, 20)
    : [];
  const steps = Array.isArray(candidate.steps)
    ? candidate.steps
        .filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
        .map((item) => ({
          id: stringValue(item.id),
          instruction: stringValue(item.instruction)
        }))
        .slice(0, 20)
    : [];

  return {
    id: stringValue(candidate.id),
    name: stringValue(candidate.name),
    description: stringValue(candidate.description),
    version: stringValue(candidate.version),
    source: 'user',
    enabled: candidate.enabled !== false,
    instructions: stringValue(candidate.instructions),
    allowedTools,
    inputs,
    steps
  };
}

export function queryFromArguments(args: Record<string, unknown>): DataverseQuerySpec {
  return {
    table: stringValue(args.table),
    columns: stringArray(args.columns, 20),
    filters: filterArray(args.filters),
    orderBy: orderArray(args.orderBy),
    ...(typeof args.top === 'number' ? { top: numberValue(args.top, 10, 1, 50) } : {})
  };
}

export function marketingListMemberArray(
  value: unknown
): Array<{ table: string; recordId: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      table: stringValue(item.table),
      recordId: stringValue(item.recordId)
    }))
    .filter((item) => item.table && item.recordId)
    .slice(0, 50);
}

export function mutationValueArray(value: unknown): DataverseMutationValueInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): DataverseMutationValueInput | undefined => {
      const column = stringValue(item.column);
      const hasScalarValue =
        Object.prototype.hasOwnProperty.call(item, 'value') &&
        (item.value == null ||
          typeof item.value === 'string' ||
          typeof item.value === 'number' ||
          typeof item.value === 'boolean');
      const lookupValue =
        item.lookup && typeof item.lookup === 'object' && !Array.isArray(item.lookup)
          ? (item.lookup as Record<string, unknown>)
          : undefined;
      const lookupRecordName = lookupValue ? optionalString(lookupValue.recordName) : undefined;
      const lookup = lookupValue
        ? {
            table: stringValue(lookupValue.table),
            recordId: stringValue(lookupValue.recordId),
            ...(lookupRecordName ? { recordName: lookupRecordName } : {})
          }
        : undefined;
      if (!column || (!hasScalarValue && (!lookup?.table || !lookup.recordId))) return undefined;
      return {
        column,
        ...(hasScalarValue ? { value: item.value } : {}),
        ...(lookup?.table && lookup.recordId ? { lookup } : {})
      } satisfies DataverseMutationValueInput;
    })
    .filter((item): item is DataverseMutationValueInput => Boolean(item))
    .slice(0, 20);
}

function filterArray(value: unknown): DataverseFilterSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const operator = stringValue(item.operator) as DataverseFilterOperator;
      if (!ALLOWED_OPERATORS.has(operator)) return undefined;
      const column = stringValue(item.column);
      if (!column) return undefined;
      return {
        column,
        operator,
        ...(item.value != null ? { value: String(item.value) } : {}),
        ...(typeof item.entityType === 'string' && item.entityType.trim()
          ? { entityType: item.entityType.trim() }
          : {})
      } satisfies DataverseFilterSpec;
    })
    .filter((item): item is DataverseFilterSpec => Boolean(item))
    .slice(0, 20);
}

function orderArray(value: unknown): DataverseOrderSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const column = stringValue(item.column);
      if (!column) return undefined;
      return {
        column,
        direction: item.direction === 'desc' ? 'desc' : 'asc'
      } satisfies DataverseOrderSpec;
    })
    .filter((item): item is DataverseOrderSpec => Boolean(item))
    .slice(0, 5);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function optionalString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result || undefined;
}

export function stringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
}

export function numberValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}
