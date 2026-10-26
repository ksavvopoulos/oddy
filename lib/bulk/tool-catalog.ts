import type { AzureToolDefinition } from '../azure-openai';

export function bulkToolDefinitions(filterSchema: Record<string, unknown>): AzureToolDefinition[] {
  const selection = {
    type: 'object',
    additionalProperties: false,
    properties: {
      table: { type: 'string' },
      filters: { type: 'array', maxItems: 20, items: filterSchema },
      allRecords: {
        type: 'boolean',
        description:
          'Explicitly true when the user intends the entire readable table and filters is empty.'
      }
    },
    required: ['table', 'filters', 'allRecords']
  };
  const values = {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        column: { type: 'string' },
        value: { type: ['string', 'number', 'boolean', 'null'] },
        lookup: {
          type: 'object',
          additionalProperties: false,
          properties: { table: { type: 'string' }, recordId: { type: 'string' } },
          required: ['table', 'recordId']
        }
      },
      required: ['column']
    }
  };
  const jobId = {
    type: 'object',
    additionalProperties: false,
    properties: { jobId: { type: 'string' } },
    required: ['jobId']
  };
  return [
    {
      type: 'function',
      function: {
        name: 'prepare_bulk_job',
        description:
          'Prepare one approval-gated job for ALL records matching a validated query, or bulk creates from a locally uploaded dataset. Do not enumerate record IDs into the conversation or loop the 50-row tools. update sets specified values; count_related counts readable source rows through an exact metadata-resolved lookup and fills a writable whole-number target, including zero; membership adds matching accounts/contacts/leads to an existing static list; create maps uploaded dataset columns to fields. Clarify ambiguous relationships, source status filters, and intended access coverage. Preparation writes no Dataverse data. One approval covers the frozen rows and multiple bounded requests, not a global transaction.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: { operation: { const: 'update', type: 'string' }, selection, values },
                  required: ['operation', 'selection', 'values']
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    operation: { const: 'count_related', type: 'string' },
                    selection,
                    targetColumn: { type: 'string' },
                    related: {
                      ...selection,
                      properties: {
                        ...selection.properties,
                        lookupColumn: {
                          type: 'string',
                          description:
                            'Exact lookup on source records referencing the selected target table, resolved from metadata.'
                        }
                      },
                      required: [...selection.required, 'lookupColumn']
                    }
                  },
                  required: ['operation', 'selection', 'targetColumn', 'related']
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    operation: { const: 'membership', type: 'string' },
                    selection,
                    listId: { type: 'string' }
                  },
                  required: ['operation', 'selection', 'listId']
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    operation: { const: 'create', type: 'string' },
                    table: { type: 'string' },
                    datasetId: { type: 'string' },
                    mapping: {
                      type: 'object',
                      minProperties: 1,
                      maxProperties: 20,
                      additionalProperties: { type: 'string' },
                      description:
                        'Source dataset column name → target Dataverse field name. No JavaScript or expressions.'
                    }
                  },
                  required: ['operation', 'table', 'datasetId', 'mapping']
                }
              ]
            }
          },
          required: ['plan']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'prepare_bulk_job_remaining',
        description:
          'Reconcile a stopped/failed/expired job and prepare a NEW approval preview for only unfinished frozen rows. Confirmed successful rows are excluded. Uncertain creates are checked by their reserved IDs; never recreate, overwrite, or upsert existing records. Related-count values retain the original calculation, not a recalculation. Never executes writes.',
        parameters: jobId
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_bulk_job',
        description:
          'Read compact status/counts for an existing local bulk job. Never executes or resumes it. Detailed rows and execution tokens are not returned.',
        parameters: jobId
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_bulk_datasets',
        description:
          'List uploaded local dataset handles, column names, row counts, and expiry for bulk creation. Does not return the dataset rows.',
        parameters: { type: 'object', additionalProperties: false, properties: {} }
      }
    }
  ];
}
