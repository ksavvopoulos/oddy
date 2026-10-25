export function formatPreviewValue(
  value: unknown,
  emptyLabel = 'Not set',
  nullLabel = 'Not set'
): string {
  if (value === undefined || value === '') return emptyLabel;
  if (value === null) return nullLabel;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    const lookup = value as {
      recordName?: unknown;
      tableLogicalName?: unknown;
      recordId?: unknown;
    };
    if (typeof lookup.recordName === 'string' && lookup.recordName) return lookup.recordName;
    if (typeof lookup.tableLogicalName === 'string' && typeof lookup.recordId === 'string') {
      return `${lookup.tableLogicalName}: ${lookup.recordId}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export function normalizeMarkdown(content: string): string {
  return content
    .replace(/^(\s*)(#{1,6})(?=\S)/gm, '$1$2 ')
    .replace(/^(\s*)(\d+[.)]|[-*+])(?=\S)/gm, '$1$2 ');
}
