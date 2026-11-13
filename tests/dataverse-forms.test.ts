// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFormPrimitive as execute } from '../lib/dataverse-form-primitives';
import {
  formListRows,
  formOrigin as origin,
  mainFormId,
  mainFormRow,
  mainFormXml
} from './fixtures/forms';

type Handler = (path: string) => Response | Promise<Response>;
let handler: Handler;
let paths: string[];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  paths = [];
  handler = (path) => {
    if (path.includes('RetrieveUnpublished')) return json(mainFormRow);
    if (path.startsWith('systemforms?')) return json({ value: formListRows });
    throw new Error(`Unexpected request ${path}`);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      const path = decodeURIComponent(url.split('/api/data/v9.2/')[1]!);
      paths.push(path);
      return handler(path);
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const read = (overrides: Record<string, unknown> = {}) =>
  execute({
    action: 'get_form_definition',
    origin,
    tableLogicalName: 'contact',
    formId: mainFormId,
    ...overrides
  });

describe('form primitives', () => {
  it('lists supported form types for one table', async () => {
    handler = () =>
      json({
        value: [...formListRows, { formid: mainFormId, name: 'Dashboard', type: 0 }],
        '@odata.nextLink': 'next'
      });
    const result = await execute({ action: 'list_forms', origin, tableLogicalName: 'Contact' });
    expect(result.ok, result.error).toBe(true);
    expect(paths[0]).toContain(
      "$filter=objecttypecode eq 'contact' and (type eq 2 or type eq 6 or type eq 7 or type eq 11)"
    );
    expect(result.forms).toEqual([
      {
        formId: mainFormId,
        name: 'Contact',
        description: 'Main contact form',
        type: 'main',
        isDefault: true,
        isManaged: true,
        isCustomizable: true,
        isActive: true
      },
      {
        formId: '2fed44d1-ae68-4a41-bd2b-f13acac4acfa',
        name: 'Contact Quick Create',
        type: 'quickCreate',
        isDefault: false,
        isManaged: false,
        isCustomizable: true,
        isActive: false
      }
    ]);
    expect(result.moreForms).toBe(true);
  });

  it('projects the unpublished form XML into a layout tree', async () => {
    const result = await read();
    expect(result.ok, result.error).toBe(true);
    expect(paths).toEqual([
      `systemforms(${mainFormId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`
    ]);
    const form = result.formDefinition!;
    expect(form).toMatchObject({
      formId: mainFormId,
      name: 'Contact',
      tableLogicalName: 'contact',
      type: 'main',
      isManaged: true,
      isCustomizable: true,
      source: 'unpublished',
      libraries: ['contoso_/scripts/contact.js'],
      customControls: 1,
      events: [
        { name: 'onload', handlers: 1 },
        { name: 'onchange', field: 'emailaddress1', handlers: 1 }
      ]
    });
    expect(form.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(form.truncated).toBeUndefined();
    expect(form.tabs.map((tab) => [tab.name, tab.label, tab.visible, tab.expanded])).toEqual([
      ['SUMMARY_TAB', 'Summary', true, true],
      ['DETAILS_TAB', 'Details', false, false]
    ]);
    const [contactInfo, orders] = form.tabs[0]!.sections;
    expect(contactInfo).toMatchObject({ name: 'CONTACT_INFORMATION', tabColumn: 0, columns: 1 });
    expect(contactInfo!.controls).toEqual([
      {
        kind: 'field',
        field: 'fullname',
        controlId: 'fullname',
        label: 'Full Name',
        showLabel: true,
        visible: true,
        readOnly: false,
        customControl: true
      },
      {
        kind: 'field',
        field: 'emailaddress1',
        controlId: 'emailaddress1',
        label: 'Email',
        showLabel: true,
        visible: false,
        readOnly: true,
        customControl: false
      },
      { kind: 'spacer', showLabel: false, visible: true, readOnly: false, customControl: false }
    ]);
    expect(orders).toMatchObject({
      name: 'ORDERS',
      tabColumn: 1,
      columns: 2,
      visible: false,
      showLabel: false
    });
    expect(orders!.controls[0]).toMatchObject({
      kind: 'subgrid',
      controlId: 'orders_grid',
      relationship: 'contact_salesorders',
      targetTable: 'salesorder',
      viewId: 'b1d4b4a5-0000-0000-0000-000000000009'
    });
    expect(form.tabs[1]!.sections[0]!.columns).toBe(3);
    expect(form.tabs[1]!.sections[0]!.controls.map((c) => c.kind)).toEqual([
      'field',
      'webResource'
    ]);
    expect(form.header).toMatchObject([{ kind: 'field', field: 'ownerid', label: 'Owner' }]);
    expect(form.footer).toEqual([]);
  });

  it('uses the requested label language and falls back to the first label', async () => {
    const result = await read({ languageCode: 1032 });
    expect(result.formDefinition!.tabs[0]!.label).toBe('Σύνοψη');
    expect(result.formDefinition!.tabs[1]!.label).toBe('Details');
  });

  it('hashes the exact XML so any edit changes the revision', async () => {
    const first = (await read()).formDefinition!.revision;
    handler = () => json({ ...mainFormRow, formxml: mainFormXml.replace('Full Name', 'Name') });
    expect((await read()).formDefinition!.revision).not.toBe(first);
  });

  it('falls back to the published form only when RetrieveUnpublished is rejected', async () => {
    handler = (path) =>
      path.includes('RetrieveUnpublished')
        ? json({ error: { message: 'not found' } }, 404)
        : json(mainFormRow);
    const result = await read();
    expect(result.ok, result.error).toBe(true);
    expect(result.formDefinition!.source).toBe('published');
    expect(paths[1]).toContain(`systemforms(${mainFormId})?$select=`);

    paths = [];
    handler = () => json({ error: { message: 'server' } }, 500);
    const failed = await read();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('(500)');
    expect(paths).toHaveLength(1);
  });

  it('rejects forms from another table, unsupported types, and malformed XML', async () => {
    expect((await read({ tableLogicalName: 'account' })).error).toContain(
      'does not belong to table account'
    );
    handler = () => json({ ...mainFormRow, type: 0 });
    expect((await read()).error).toContain('Only main, quick create');
    handler = () => json({ ...mainFormRow, formxml: '<form><tabs></form>' });
    expect((await read()).error).toBe('The form XML could not be parsed.');
    handler = () => json({ ...mainFormRow, formxml: '<grid />' });
    expect((await read()).error).toBe('The form XML could not be parsed.');
  });

  it('validates identifiers before any request', async () => {
    expect((await read({ formId: "x' or 1 eq 1" })).error).toBe('Invalid form ID.');
    expect(
      (await execute({ action: 'list_forms', origin, tableLogicalName: "contact' or 1 eq 1" }))
        .error
    ).toBe('Invalid table logical name.');
    expect(paths).toEqual([]);
  });

  it('accepts braced, upper-case form IDs', async () => {
    const result = await read({ formId: `{${mainFormId.toUpperCase()}}` });
    expect(result.ok, result.error).toBe(true);
    expect(paths[0]).toContain(`systemforms(${mainFormId})`);
  });
});
