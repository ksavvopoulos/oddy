import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectDataverseWebApiContext,
  contextFromUrl,
  normalizeRecordId,
  pickBestPageContext
} from '../lib/dataverse-context';

afterEach(() => vi.unstubAllGlobals());

describe('Dataverse URL context', () => {
  it('extracts common model-driven app parameters', () => {
    const context = contextFromUrl(
      'https://contoso.crm.dynamics.com/main.aspx?appid=app-1&pagetype=entityrecord&etn=account&id=%7Babc-123%7D',
      'Account'
    );

    expect(context.isDataverse).toBe(true);
    expect(context.environmentName).toBe('contoso');
    expect(context.tableLogicalName).toBe('account');
    expect(context.recordId).toBe('abc-123');
  });

  it('normalizes record IDs', () => {
    expect(normalizeRecordId('{ABC}')).toBe('ABC');
  });

  it('prefers a frame snapshot containing form fields', () => {
    const best = pickBestPageContext([
      { source: 'url', warning: 'No form API' },
      {
        source: 'xrm',
        tableLogicalName: 'account',
        fields: [{ logicalName: 'name', label: 'Name', value: 'Contoso' }]
      }
    ]);

    expect(best?.source).toBe('xrm');
    expect(best?.fields).toHaveLength(1);
  });

  it('maps a Dataverse Web API record into context fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ EntitySetName: 'accounts', PrimaryNameAttribute: 'name' }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'Contoso',
            statuscode: 1,
            'statuscode@OData.Community.Display.V1.FormattedValue': 'Active'
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await collectDataverseWebApiContext({
      origin: 'https://contoso.crm.dynamics.com',
      tableLogicalName: 'account',
      recordId: '00000000-0000-0000-0000-000000000001'
    });

    expect(snapshot.source).toBe('webApi');
    expect(snapshot.recordName).toBe('Contoso');
    expect(
      snapshot.fields?.find((field) => field.logicalName === 'statuscode')?.formattedValue
    ).toBe('Active');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
