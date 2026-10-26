import { describe, expect, it } from 'vitest';
import { parseBulkPlan } from '../lib/bulk/plan';
import { createDataset, parseDatasetFile, validateDatasetRecords } from '../lib/bulk/datasets';
import { updatePlan } from './fixtures/bulk';

describe('strict bulk plans and datasets', () => {
  it('accepts an explicit unfiltered selection and preserves a literal update', () => {
    expect(parseBulkPlan(updatePlan)).toEqual(updatePlan);
  });
  it.each([
    { ...updatePlan, selection: { table: 'contact', filters: [] } },
    { ...updatePlan, selection: { table: 'contact', filters: [], allRecords: false } },
    { ...updatePlan, selection: { ...updatePlan.selection, top: 50 } },
    {
      ...updatePlan,
      selection: {
        ...updatePlan.selection,
        filters: [{ column: 'firstname', operator: 'bogus', value: 'A' }]
      }
    },
    {
      ...updatePlan,
      selection: { ...updatePlan.selection, filters: [{ column: 'firstname', operator: 'eq' }] }
    },
    { ...updatePlan, values: [{ column: 'firstname' }] },
    { ...updatePlan, values: [{ column: 'firstname', value: { expression: 'doSomething()' } }] },
    { ...updatePlan, values: [{ column: 'firstname', value: undefined }] },
    {
      ...updatePlan,
      values: Array.from({ length: 21 }, () => ({ column: 'firstname', value: 'X' }))
    },
    {
      operation: 'create',
      table: 'contact',
      datasetId: 'id',
      mapping: { A: 'firstname', B: 'firstname' }
    },
    { operation: 'membership', selection: updatePlan.selection, listId: 'not-a-guid' }
  ])('rejects malformed or broadening input without dropping constraints: %j', (plan) => {
    expect(() => parseBulkPlan(plan)).toThrow();
  });
  it('parses quoted CSV and preserves scalar strings without evaluating formulas', () => {
    expect(
      parseDatasetFile(
        'test.csv',
        '\uFEFFName,Note\r\n"Doe, Jane","line 1\nline ""2"""\r\n=SUM(A1:A2),007\r\n'
      )
    ).toEqual([
      { Name: 'Doe, Jane', Note: 'line 1\nline "2"' },
      { Name: '=SUM(A1:A2)', Note: '007' }
    ]);
  });
  it.each(['A,A\n1,2', 'A,B\n1', 'A\n"unclosed', 'A\n"closed"x', 'A\nnot"quoted'])(
    'rejects malformed CSV: %s',
    (text) => {
      expect(() => parseDatasetFile('test.csv', text)).toThrow();
    }
  );
  it('accepts JSON nulls and assigns a local handle with a 24-hour lifetime', () => {
    const rows = parseDatasetFile('test.json', '[{"A":null,"B":3}]');
    const dataset = createDataset('test.json', rows, new Date('2026-01-01T00:00:00Z'));
    expect(dataset.summary).toMatchObject({
      rowCount: 1,
      columns: ['A', 'B'],
      expiresAt: '2026-01-02T00:00:00.000Z'
    });
  });
  it.each(
    [
      [],
      [{ A: {} }],
      [{ A: [] }],
      [{ A: Infinity }],
      [{ A: undefined }],
      [{ A: 'x' }, { B: 'y' }]
    ].map((rows) => ({ rows }))
  )('rejects unsafe/incomplete datasets', ({ rows }) => {
    expect(() => validateDatasetRecords(rows)).toThrow();
  });
});
