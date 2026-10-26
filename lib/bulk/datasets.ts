import type { BulkDataset, BulkDatasetRecord } from './contracts';

export function validateDatasetRecords(value: unknown): BulkDatasetRecord[] {
  if (!Array.isArray(value) || !value.length || value.length > 100000)
    throw new Error('A dataset must contain 1–100,000 rows.');
  let columns: string[] | undefined;
  let characters = 0;
  return value.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('Every dataset row must be an object.');
    const entries = Object.entries(record);
    const names = entries.map(([name]) => name);
    if (
      !names.length ||
      names.length > 100 ||
      names.some((name) => !name.trim() || name.length > 100)
    )
      throw new Error('Dataset columns must have bounded, non-empty names (maximum 100 columns).');
    columns ||= names;
    if (names.length !== columns.length || columns.some((name) => !Object.hasOwn(record, name)))
      throw new Error(
        'All dataset rows must have the same columns; use explicit null for missing values.'
      );
    for (const [, item] of entries) {
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item))
        throw new Error(
          'Dataset cells must be scalar values, not objects or executable expressions.'
        );
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new Error('Dataset numbers must be finite.');
      if (typeof item === 'string' && item.length > 10000)
        throw new Error('A dataset cell exceeds 10,000 characters.');
      characters += String(item).length;
    }
    if (characters > 25 * 1024 * 1024) throw new Error('Dataset cell data exceeds 25 MiB.');
    return Object.fromEntries(entries) as BulkDatasetRecord;
  });
}

/** RFC-style quoted CSV; no automatic type guessing and no spreadsheet-formula execution. */
export function parseDatasetFile(name: string, input: string): BulkDatasetRecord[] {
  if (input.length > 25 * 1024 * 1024) throw new Error('Dataset file exceeds 25 MiB.');
  const text = input.replace(/^\uFEFF/, '');
  if (/\.json$/i.test(name)) return validateDatasetRecords(JSON.parse(text));
  if (!/\.csv$/i.test(name))
    throw new Error('Upload a .json array or a comma-separated .csv file.');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += character;
    } else if (character === ',') endCell();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      endRow();
    } else if (character === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || character === '"') throw new Error('Malformed CSV quoting.');
      cell += character;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (cell || row.length || closed) endRow();
  const header = rows.shift();
  if (
    !header?.length ||
    new Set(header).size !== header.length ||
    header.some((name) => !name.trim())
  )
    throw new Error('CSV needs unique, non-empty column headers.');
  return validateDatasetRecords(
    rows.map((values) => {
      if (values.length !== header.length)
        throw new Error('CSV row width does not match its header.');
      return Object.fromEntries(header.map((name, index) => [name, values[index]!]));
    })
  );
}
export function createDataset(name: string, records: unknown, now = new Date()): BulkDataset {
  const validated = validateDatasetRecords(records);
  return {
    summary: {
      id: crypto.randomUUID(),
      name: name.slice(0, 200),
      rowCount: validated.length,
      columns: Object.keys(validated[0]!),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString()
    },
    records: validated
  };
}
