import type {
  DataverseFilterOperator,
  DataverseFilterSpec,
  DataverseOrderSpec,
  DataverseQuerySpec
} from '../dataverse-primitives';
import type { DataverseMutationValueInput, OddySkill, OddySkillToolName } from '../types';
import type {
  DataverseFlowAction,
  DataverseFlowFilter,
  DataverseFlowScalar,
  DataverseFlowSpec,
  DataverseFlowValue
} from '../flows/contracts';
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

export function flowSpecFromArguments(value: unknown): DataverseFlowSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A complete flow specification is required.');
  }
  const candidate = value as Record<string, unknown>;
  const triggerValue = objectValue(candidate.trigger, 'A flow trigger is required.');
  const trigger: DataverseFlowSpec['trigger'] =
    triggerValue.kind === 'manual'
      ? { kind: 'manual' }
      : triggerValue.kind === 'dataverse-row'
        ? {
            kind: 'dataverse-row',
            table: stringValue(triggerValue.table),
            change: flowTriggerChange(triggerValue.change),
            scope: flowTriggerScope(triggerValue.scope),
            selectColumns: stringArray(triggerValue.selectColumns, 20),
            filters: flowFilters(triggerValue.filters)
          }
        : (() => {
            throw new Error('Only manual and Dataverse row triggers are supported.');
          })();
  if (!Array.isArray(candidate.actions)) throw new Error('Flow actions must be an array.');
  if (candidate.actions.length > 20) throw new Error('A flow may contain at most 20 actions.');
  const actions = candidate.actions.map((item) => flowAction(item));
  return {
    name: stringValue(candidate.name),
    ...(optionalString(candidate.description)
      ? { description: optionalString(candidate.description) }
      : {}),
    connectionReferenceLogicalName: stringValue(candidate.connectionReferenceLogicalName),
    trigger,
    actions
  };
}

function flowAction(value: unknown): DataverseFlowAction {
  const item = objectValue(value, 'A flow action is invalid.');
  const common = {
    id: stringValue(item.id),
    table: stringValue(item.table)
  };
  if (item.kind === 'list-rows') {
    if (Array.isArray(item.orderBy) && item.orderBy.length > 5)
      throw new Error('A flow action may contain at most five sorts.');
    const orderBy = Array.isArray(item.orderBy)
      ? item.orderBy.map((entry) => {
          const order = objectValue(entry, 'A flow sort is invalid.');
          if (order.direction !== 'asc' && order.direction !== 'desc')
            throw new Error('A flow sort direction is invalid.');
          return {
            column: stringValue(order.column),
            direction: order.direction as 'asc' | 'desc'
          };
        })
      : [];
    return {
      ...common,
      kind: 'list-rows',
      selectColumns: stringArray(item.selectColumns, 20),
      filters: flowFilters(item.filters),
      orderBy,
      ...(typeof item.top === 'number' ? { top: numberValue(item.top, 100, 1, 5000) } : {})
    };
  }
  if (item.kind === 'get-row') {
    return {
      ...common,
      kind: 'get-row',
      rowId: flowValue(item.rowId),
      selectColumns: stringArray(item.selectColumns, 20)
    };
  }
  if (item.kind === 'add-row' || item.kind === 'update-row') {
    if (!Array.isArray(item.values)) throw new Error('Row actions require field values.');
    if (item.values.length > 30) throw new Error('A row action may set at most 30 fields.');
    const values = item.values.map((entry) => {
      const field = objectValue(entry, 'A flow field value is invalid.');
      return { column: stringValue(field.column), value: flowValue(field.value) };
    });
    return item.kind === 'add-row'
      ? { ...common, kind: 'add-row', values }
      : { ...common, kind: 'update-row', rowId: flowValue(item.rowId), values };
  }
  throw new Error('The flow action kind is unsupported.');
}

function flowValue(value: unknown): DataverseFlowValue {
  const item = objectValue(value, 'A flow value is invalid.');
  if (item.kind === 'literal') {
    if (!isFlowScalar(item.value)) throw new Error('A flow literal must be scalar.');
    return { kind: 'literal', value: item.value };
  }
  if (item.kind === 'trigger-column') {
    return { kind: 'trigger-column', column: stringValue(item.column) };
  }
  if (item.kind === 'action-output') {
    return {
      kind: 'action-output',
      actionId: stringValue(item.actionId),
      column: stringValue(item.column)
    };
  }
  throw new Error('The flow value kind is unsupported.');
}

function flowFilters(value: unknown): DataverseFlowFilter[] {
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
  if (!Array.isArray(value)) return [];
  if (value.length > 20) throw new Error('A flow may contain at most 20 filters per step.');
  return value.map((entry) => {
    const filter = objectValue(entry, 'A flow filter is invalid.');
    if (!operators.has(String(filter.operator)) || !isFlowScalar(filter.value)) {
      throw new Error('A flow filter operator or value is invalid.');
    }
    return {
      column: stringValue(filter.column),
      operator: filter.operator as DataverseFlowFilter['operator'],
      value: filter.value
    };
  });
}

function flowTriggerChange(value: unknown): 'create' | 'update' | 'delete' {
  if (value === 'create' || value === 'update' || value === 'delete') return value;
  throw new Error('A Dataverse row trigger requires create, update, or delete.');
}

function flowTriggerScope(
  value: unknown
): 'user' | 'business-unit' | 'parent-child-business-units' | 'organization' {
  if (
    value === 'user' ||
    value === 'business-unit' ||
    value === 'parent-child-business-units' ||
    value === 'organization'
  )
    return value;
  throw new Error('A Dataverse row trigger scope is invalid.');
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function isFlowScalar(value: unknown): value is DataverseFlowScalar {
  return (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
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
