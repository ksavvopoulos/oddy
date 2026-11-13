// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDataverseFormPrimitive as execute } from '../lib/dataverse-form-primitives';
import type { FormEdit, PreparedFormChange } from '../lib/forms/contracts';
import {
  contactAttributes,
  formEditPlan,
  formOrigin as origin,
  formSolutionRow,
  mainFormId,
  mainFormRow,
  mainFormXml
} from './fixtures/forms';

type Call = { method: string; path: string; headers: Record<string, string>; body?: any };
let calls: Call[];
let formXml: string;
let formRow: Record<string, unknown>;
let failures: Record<string, number>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  calls = [];
  formXml = mainFormXml;
  formRow = {};
  failures = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = decodeURIComponent(url.split('/api/data/v9.2/')[1]!);
      const method = init.method ?? 'GET';
      calls.push({
        method,
        path,
        headers: init.headers as Record<string, string>,
        ...(init.body ? { body: JSON.parse(init.body as string) } : {})
      });
      const failure = Object.entries(failures).find(([prefix]) => path.startsWith(prefix));
      if (failure) return json({ error: { message: 'boom' } }, failure[1]);
      if (method === 'GET') {
        if (path.startsWith('solutions?')) return json({ value: [formSolutionRow] });
        if (path.includes('RetrieveUnpublished'))
          return json({ ...mainFormRow, formxml: formXml, ...formRow });
        if (path.startsWith("EntityDefinitions(LogicalName='contact')/Attributes"))
          return json({ value: contactAttributes });
        if (path.startsWith('EntityDefinitions?'))
          return json({ value: [{ LogicalName: 'contact' }] });
      }
      if (method === 'POST' || method === 'PATCH') return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${method} ${path}`);
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

async function revision(xml = formXml) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}

async function prepare(edits: Array<Record<string, unknown>>, overrides = {}) {
  return execute({
    action: 'prepare_form_change',
    origin,
    plan: {
      ...formEditPlan,
      baseRevision: await revision(),
      edits: edits as FormEdit[],
      ...overrides
    }
  });
}

async function prepared(edits: Array<Record<string, unknown>>) {
  const result = await prepare(edits);
  expect(result.ok, result.error).toBe(true);
  return result.formChange!;
}

const apply = (change: PreparedFormChange) =>
  execute({ action: 'execute_form_change', origin, change });
const writes = () => calls.filter((call) => call.method !== 'GET');
const fieldsIn = (change: PreparedFormChange, section: string) =>
  change
    .after!.tabs.flatMap((tab) => tab.sections)
    .find((s) => s.name === section)!
    .controls.map((control) => control.field ?? control.kind);

describe('form edit preparation', () => {
  it('previews ordered field, section, and tab edits without writing', async () => {
    const change = await prepared([
      {
        op: 'add_field',
        field: 'telephone1',
        tab: 'summary_tab',
        section: 'CONTACT_INFORMATION',
        position: 1,
        label: null,
        readOnly: null,
        showLabel: null
      },
      { op: 'add_tab', name: 'consents', label: 'Consents', position: 1 },
      {
        op: 'add_section',
        tab: 'consents',
        name: 'email_consent',
        label: 'Email',
        columns: 2,
        tabColumn: null,
        position: null,
        showLabel: null
      },
      { op: 'move_field', field: 'birthdate', tab: 'consents', section: 'email_consent' },
      {
        op: 'add_field',
        field: 'donotbulkemail',
        tab: 'consents',
        section: 'email_consent',
        label: 'Allow bulk emails',
        readOnly: true
      },
      { op: 'set_field', field: 'fullname', label: 'Name', visible: null },
      { op: 'set_tab', tab: 'DETAILS_TAB', visible: true, expanded: true }
    ]);
    expect(writes()).toEqual([]);
    expect(change).toMatchObject({
      mode: 'form-v1',
      environmentOrigin: origin,
      tableLogicalName: 'contact',
      formId: mainFormId,
      formName: 'Contact',
      formType: 'main',
      solution: { uniqueName: 'ConsentSolution', displayName: 'Consent Solution' }
    });
    expect(change.summary).toEqual([
      'Add Business Phone (telephone1) to Summary › CONTACT INFORMATION at row 2',
      'Add tab Consents (consents) at position 2 with one section consents_section_1',
      'Add section Email (email_consent, 2 columns) to tab Consents',
      'Move birthdate to Consents › Email at row 1',
      'Add Allow bulk emails (donotbulkemail) to Consents › Email at row 2, read-only',
      'Set fullname: label "Name"',
      'Set tab Details: visible, expanded'
    ]);
    // Nulls are dropped from the stored plan; it is replayed verbatim at execution.
    expect(change.plan.operation === 'edit_form' && change.plan.edits[0]).toEqual({
      op: 'add_field',
      field: 'telephone1',
      tab: 'summary_tab',
      section: 'CONTACT_INFORMATION',
      position: 1
    });
    expect(change.generatedIds).toHaveLength(5);
    expect(change.afterRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(change.after!.tabs.map((tab) => tab.name)).toEqual([
      'SUMMARY_TAB',
      'consents',
      'DETAILS_TAB'
    ]);
    expect(fieldsIn(change, 'CONTACT_INFORMATION')).toEqual([
      'fullname',
      'telephone1',
      'emailaddress1',
      'spacer'
    ]);
    expect(fieldsIn(change, 'email_consent')).toEqual(['birthdate', 'donotbulkemail']);
    expect(fieldsIn(change, 'PERSONAL')).toEqual(['webResource']);
    const added = change.after!.tabs[1]!.sections[1]!.controls[1]!;
    expect(added).toMatchObject({ label: 'Allow bulk emails', readOnly: true, visible: true });
    expect(change.after!.tabs[0]!.sections[0]!.controls[0]!.label).toBe('Name');
    expect(change.before!.tabs).toHaveLength(2);
    expect(change.warnings.join(' ')).toContain('This form is managed');
    expect(change.warnings.join(' ')).toContain('several columns');
    expect(change.warnings.join(' ')).toContain('Saving does not publish');
  });

  it('chooses field control types from column metadata', async () => {
    for (const field of ['parentcustomerid', 'new_interests']) {
      const change = await prepared([
        { op: 'add_field', field, tab: 'SUMMARY_TAB', section: 'CONTACT_INFORMATION' }
      ]);
      expect(fieldsIn(change, 'CONTACT_INFORMATION')).toContain(field);
    }
  });

  it('removes a field only from the form and warns about required and primary columns', async () => {
    const change = await prepared([{ op: 'remove_field', field: 'fullname' }]);
    expect(fieldsIn(change, 'CONTACT_INFORMATION')).toEqual(['emailaddress1', 'spacer']);
    expect(change.summary).toEqual([
      'Remove fullname from the form (column and data are unchanged)'
    ]);
    expect(change.warnings.join(' ')).toContain('primary name column');
    expect(change.warnings.join(' ')).toContain('business-required');
  });

  it.each([
    [
      [{ op: 'add_field', field: 'nosuchfield', tab: 'SUMMARY_TAB', section: 'ORDERS' }],
      'does not exist'
    ],
    [
      [{ op: 'add_field', field: 'versionnumber', tab: 'SUMMARY_TAB', section: 'ORDERS' }],
      'cannot be placed on forms'
    ],
    [
      [{ op: 'add_field', field: 'contactid', tab: 'SUMMARY_TAB', section: 'ORDERS' }],
      'cannot be added by Oddy'
    ],
    [
      [{ op: 'add_field', field: 'fullname', tab: 'SUMMARY_TAB', section: 'ORDERS' }],
      'already on the form'
    ],
    [
      [{ op: 'add_field', field: 'telephone1', tab: 'SUMMARY_TAB', section: 'NOPE' }],
      'Section "NOPE" was not found'
    ],
    [
      [
        { op: 'add_field', field: 'telephone1', tab: 'SUMMARY_TAB', section: 'ORDERS', position: 9 }
      ],
      'row position'
    ],
    [[{ op: 'remove_field', field: 'emailaddress1' }], 'OnChange script handler'],
    [[{ op: 'remove_field', field: 'ownerid' }], 'not in the form body'],
    [[{ op: 'set_field', field: 'fullname' }], 'changes nothing'],
    [
      [{ op: 'add_section', tab: 'SUMMARY_TAB', name: 'orders', label: 'Dup', columns: 1 }],
      'already exists'
    ],
    [
      [{ op: 'add_section', tab: 'SUMMARY_TAB', name: 'bad name', label: 'x', columns: 1 }],
      'Invalid section name'
    ],
    [
      [{ op: 'add_section', tab: 'SUMMARY_TAB', name: 'wide', label: 'x', columns: 5 }],
      'section column count'
    ],
    [[{ op: 'set_tab', tab: 'SUMMARY_TAB', visible: false }], 'At least one tab must stay visible'],
    [[{ op: 'delete_form' }], 'Unsupported form edit'],
    [
      [{ op: 'remove_field', field: 'fullname', formxml: '<form/>' }],
      'Unsupported remove_field option'
    ],
    [[], 'Provide 1 to 30 form edits']
  ])('rejects invalid edits: %j', async (edits, message) => {
    const result = await prepare(edits);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(message);
    expect(writes()).toEqual([]);
  });

  it('refuses stale revisions, uneditable forms, managed solutions, and unknown plan keys', async () => {
    const edit = [{ op: 'remove_field', field: 'birthdate' }];
    expect((await prepare(edit, { baseRevision: 'a'.repeat(64) })).error).toContain(
      'The form changed since it was read'
    );
    formRow = { type: 6 };
    expect((await prepare(edit)).error).toContain('Only main and quick create forms');
    formRow = { iscustomizable: { Value: false } };
    expect((await prepare(edit)).error).toBe('This form is not customizable.');
    formRow = {};
    expect((await prepare(edit, { formxml: '<form/>' })).error).toContain(
      'Unsupported form plan option: formxml'
    );
    vi.mocked(fetch).mockImplementationOnce(async () =>
      json({ value: [{ ...formSolutionRow, ismanaged: true }] })
    );
    expect((await prepare(edit)).error).toBe('Select an unmanaged solution.');
  });

  it('requires the unpublished definition for edits instead of falling back', async () => {
    failures = { [`systemforms(${mainFormId})/Microsoft.Dynamics.CRM.RetrieveUnpublished`]: 404 };
    const result = await prepare([{ op: 'remove_field', field: 'birthdate' }]);
    expect(result.error).toContain('(404)');
    expect(calls.some((call) => call.path.startsWith(`systemforms(${mainFormId})?`))).toBe(false);
  });
});

describe('form edit execution', () => {
  const edits = [
    { op: 'add_field', field: 'telephone1', tab: 'SUMMARY_TAB', section: 'CONTACT_INFORMATION' },
    { op: 'add_tab', name: 'consents', label: 'Consents' }
  ];

  it('re-validates, adds the form to the solution, and saves exactly the approved XML', async () => {
    const change = await prepared(edits);
    calls = [];
    const result = await apply(change);
    expect(result.ok, result.error).toBe(true);
    expect(result.formChangeResult).toEqual({
      operation: 'edit_form',
      tableLogicalName: 'contact',
      formId: mainFormId,
      formName: 'Contact',
      status: 'saved',
      message: 'Saved Contact. Not published yet; users see it after the table is published.',
      outcomes: [
        { step: 'add_to_solution', status: 'succeeded' },
        { step: 'save_form', status: 'succeeded' }
      ]
    });
    const [add, save] = writes();
    expect(add).toMatchObject({
      method: 'POST',
      path: 'AddSolutionComponent',
      body: {
        ComponentId: mainFormId,
        ComponentType: 60,
        SolutionUniqueName: 'ConsentSolution',
        AddRequiredComponents: false
      }
    });
    expect(save).toMatchObject({
      method: 'PATCH',
      path: `systemforms(${mainFormId})`,
      headers: expect.objectContaining({
        'If-Match': '*',
        'MSCRM.SolutionUniqueName': 'ConsentSolution'
      })
    });
    expect(Object.keys(save!.body)).toEqual(['formxml']);
    const saved: string = save!.body.formxml;
    expect(await revision(saved)).toBe(change.afterRevision);
    for (const id of change.generatedIds!) expect(saved).toContain(id);
    // Untouched parts survive the round trip.
    const document = new DOMParser().parseFromString(saved, 'text/xml');
    expect(document.querySelectorAll('events > event')).toHaveLength(3);
    expect(document.querySelector('formLibraries > Library')?.getAttribute('name')).toBe(
      'contoso_/scripts/contact.js'
    );
    expect(document.querySelector('controlDescription customControl')).toBeTruthy();
    expect(document.querySelector('header control')?.getAttribute('id')).toBe('header_ownerid');
    expect(
      document.querySelector('control[datafieldname="telephone1"]')?.getAttribute('classid')
    ).toBe('{4273EDBD-AC1D-40D3-9FB2-095C621B552D}');
  });

  it('refuses to save when the form changed after approval was prepared', async () => {
    const change = await prepared(edits);
    formXml = mainFormXml.replace('Full Name', 'Name (edited by someone else)');
    calls = [];
    const result = await apply(change);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('The form changed since it was read');
    expect(writes()).toEqual([]);
  });

  it('refuses tampered previews', async () => {
    const change = await prepared(edits);
    for (const tampered of [
      { ...change, afterRevision: 'f'.repeat(64) },
      { ...change, generatedIds: change.generatedIds!.slice(1) },
      { ...change, generatedIds: ['{not-a-guid}', ...change.generatedIds!.slice(1)] },
      { ...change, environmentOrigin: 'https://other.crm.dynamics.com' },
      { ...change, mode: 'form-v0' as 'form-v1' }
    ]) {
      calls = [];
      expect((await apply(tampered)).ok).toBe(false);
      expect(writes()).toEqual([]);
    }
  });

  it('reports a definite solution failure and does not save the form', async () => {
    const change = await prepared(edits);
    failures = { AddSolutionComponent: 403 };
    const result = (await apply(change)).formChangeResult!;
    expect(result.status).toBe('failed');
    expect(result.outcomes.map((o) => o.status)).toEqual(['failed', 'not-attempted']);
    expect(writes().map((w) => w.method)).toEqual(['POST']);
  });

  it('reports an uncertain save as partial without retrying', async () => {
    const change = await prepared(edits);
    failures = { [`systemforms(${mainFormId})`]: 503 };
    // The failure prefix also matches the preflight read; only fail the PATCH.
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if ((init as RequestInit).method !== 'PATCH') {
        const saved = failures;
        failures = {};
        try {
          return await original(url as string, init as RequestInit);
        } finally {
          failures = saved;
        }
      }
      return original(url as string, init as RequestInit);
    });
    const result = (await apply(change)).formChangeResult!;
    expect(result.status).toBe('partial');
    expect(result.outcomes.map((o) => o.status)).toEqual(['succeeded', 'unknown']);
    expect(result.message).toContain('outcome is uncertain');
    expect(writes().filter((w) => w.method === 'PATCH')).toHaveLength(1);
  });
});

describe('table publishing for forms', () => {
  it('is a separate preview that publishes exactly one table', async () => {
    const prepared = await execute({
      action: 'prepare_form_change',
      origin,
      plan: { operation: 'publish_table_forms', tableLogicalName: 'contact' }
    });
    expect(prepared.ok, prepared.error).toBe(true);
    const change = prepared.formChange!;
    expect(change.summary).toEqual(['Publish all pending customizations for table contact']);
    expect(change.warnings[0]).toContain('ALL pending customizations for contact');
    calls = [];
    const result = await apply(change);
    expect(result.formChangeResult).toMatchObject({ status: 'published' });
    expect(writes()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: 'PublishXml',
        body: {
          ParameterXml:
            '<importexportxml><entities><entity>contact</entity></entities></importexportxml>'
        }
      })
    ]);
  });
});
