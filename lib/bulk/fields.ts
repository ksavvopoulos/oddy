import type { DataverseMutationValueInput, PreparedDataverseMutationField } from '../types';
import type { BulkReadRecord, BulkRow } from './contracts';

export function fieldInputs(
  fields: PreparedDataverseMutationField[]
): DataverseMutationValueInput[] {
  return fields.map((field) =>
    field.lookup
      ? {
          column: field.logicalName,
          lookup: { table: field.lookup.tableLogicalName, recordId: field.lookup.recordId }
        }
      : { column: field.logicalName, value: field.proposedValue }
  );
}
export function fieldPayload(fields: PreparedDataverseMutationField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) =>
      field.lookup
        ? [
            `${field.lookup.navigationPropertyName}@odata.bind`,
            `/${field.lookup.entitySetName}(${field.lookup.recordId})`
          ]
        : [field.logicalName, field.proposedValue]
    )
  );
}
export function matchesFields(
  record: BulkReadRecord,
  fields: PreparedDataverseMutationField[]
): boolean {
  return fields.every((field) =>
    field.lookup
      ? String(record.values[field.logicalName] || '').toLowerCase() ===
          field.lookup.recordId.toLowerCase() &&
        record.lookupTypes[field.logicalName] === field.lookup.tableLogicalName
      : Object.is(record.values[field.logicalName] ?? null, field.proposedValue)
  );
}
export function withBefore(
  fields: PreparedDataverseMutationField[],
  record: BulkReadRecord
): PreparedDataverseMutationField[] {
  return fields.map((field) => ({
    ...field,
    currentValue: record.values[field.logicalName] ?? null
  }));
}
export function sampleRow(row: BulkRow) {
  const small = (value: unknown) =>
    typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return {
    recordId: row.recordId,
    recordName: row.recordName?.slice(0, 200),
    before: Object.fromEntries(
      row.fields.map((field) => [field.logicalName, small(field.currentValue)])
    ),
    after: Object.fromEntries(
      row.fields.map((field) => [
        field.logicalName,
        small(field.proposedFormattedValue ?? field.proposedValue)
      ])
    )
  };
}
