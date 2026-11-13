import type { AzureToolDefinition } from '../azure-openai';
import type { OddySkillToolName } from '../types';

export const FORM_TOOL_OPTIONS: Array<{
  name: OddySkillToolName;
  label: string;
  description: string;
}> = [
  {
    name: 'list_dataverse_forms',
    label: 'List table forms',
    description: 'List main, quick create, quick view, and card forms for a table.'
  },
  {
    name: 'get_dataverse_form_definition',
    label: 'Read form layout',
    description: 'Read a form’s tabs, sections, fields, sub-grids, and scripts as a layout tree.'
  },
  {
    name: 'prepare_dataverse_form_change',
    label: 'Prepare form change',
    description:
      'Prepare field, section, and tab edits on a main or quick create form, or table publishing, for approval.'
  }
];

const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };
const position = {
  type: ['integer', 'null'],
  minimum: 0,
  description: 'Zero-based insert index; null appends at the end.'
};
const fieldRef = { ...string, description: 'Column logical name, e.g. emailaddress1.' };
const tabRef = {
  ...string,
  description:
    'Exact tab `name` from get_dataverse_form_definition, or its `id` when it has no name.'
};
const sectionRef = {
  ...string,
  description:
    'Exact section `name` from get_dataverse_form_definition, or its `id` when it has no name.'
};
const newName = {
  ...string,
  description: 'New unique name: letters, digits, underscores; start with a letter.'
};
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties)
});

const op = (name: string) => ({ type: 'string', enum: [name] });
const edit = {
  anyOf: [
    object({
      op: op('add_field'),
      field: fieldRef,
      tab: tabRef,
      section: sectionRef,
      position,
      label: { ...nullableString, description: 'Null uses the column display name.' },
      readOnly: nullableBoolean,
      showLabel: nullableBoolean
    }),
    object({ op: op('move_field'), field: fieldRef, tab: tabRef, section: sectionRef, position }),
    object({ op: op('remove_field'), field: fieldRef }),
    object({
      op: op('set_field'),
      field: fieldRef,
      label: nullableString,
      readOnly: nullableBoolean,
      visible: nullableBoolean,
      showLabel: nullableBoolean
    }),
    object({
      op: op('add_section'),
      tab: tabRef,
      name: newName,
      label: string,
      columns: { type: 'integer', minimum: 1, maximum: 4 },
      tabColumn: { type: ['integer', 'null'], minimum: 0, description: 'Null uses the first.' },
      position,
      showLabel: nullableBoolean
    }),
    object({
      op: op('set_section'),
      tab: tabRef,
      section: sectionRef,
      label: nullableString,
      visible: nullableBoolean,
      showLabel: nullableBoolean
    }),
    object({ op: op('add_tab'), name: newName, label: string, position }),
    object({ op: op('remove_section'), tab: tabRef, section: sectionRef }),
    object({ op: op('remove_tab'), tab: tabRef }),
    object({
      op: op('set_tab'),
      tab: tabRef,
      label: nullableString,
      visible: nullableBoolean,
      expanded: nullableBoolean,
      showLabel: nullableBoolean
    })
  ]
};
const plan = {
  anyOf: [
    object({
      operation: op('edit_form'),
      solutionUniqueName: {
        ...string,
        description: 'Exact unmanaged solution uniqueName from list_dataverse_solutions.'
      },
      languageCode: { type: 'integer', description: 'Label language LCID, e.g. 1033.' },
      tableLogicalName: string,
      formId: string,
      baseRevision: {
        ...string,
        description: 'Exact latest get_dataverse_form_definition revision. Re-read after a save.'
      },
      edits: { type: 'array', items: edit, minItems: 1, maxItems: 30 }
    }),
    object({ operation: op('publish_table_forms'), tableLogicalName: string })
  ]
};

export const FORM_TOOLS: AzureToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_dataverse_forms',
      description:
        'List model-driven forms (main, quick create, quick view, card) for one table, with form IDs, default/managed/customizable flags, and activation state. isDefault is the stored system flag and is often false for every main form; which form a user sees depends on the app’s form order and security-role form access, which this tool does not read. Do not call any form "the default" from this flag alone. Read-only.',
      parameters: object({
        tableLogicalName: { ...string, description: 'Exact table logical name, e.g. contact.' }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dataverse_form_definition',
      description:
        'Read one form’s latest saved layout (including unpublished edits when Dataverse allows) as tabs → sections → controls, plus header/footer fields, script libraries, event handler counts, custom (PCF) control count, and a revision hash. Controls report field logical names, labels, visibility, and form-level read-only. Form read-only/hidden is presentation only, not security. Pass the revision and tab/section `name` (or `id` when unnamed) values to prepare_dataverse_form_change.',
      parameters: object({
        tableLogicalName: {
          ...string,
          description: 'Exact table logical name the form belongs to.'
        },
        formId: { ...string, description: 'Exact form ID from list_dataverse_forms.' },
        languageCode: {
          type: ['integer', 'null'],
          description: 'Label language LCID, e.g. 1033. Null uses the first label.'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_dataverse_form_change',
      description:
        'Prepare a form edit for explicit user approval; NEVER writes. edit_form applies ordered edits to one main or quick create form: add/move/remove/set fields in the form body, add/set/remove sections and tabs. Tabs and sections are addressed by `name`, or by `id` when they have no name. Only EMPTY sections/tabs can be removed (spacers are fine): put move_field/remove_field edits for their fields earlier in the same preview, and keep the primary name field somewhere on the form. Columns must already exist on the table (create them with schema tools first). Removing a field removes it from the form only, never the column or data. Fields with OnChange handlers cannot be removed. Header fields, sub-grids, scripts, and custom controls are not editable. One preview may hold up to 30 edits; put all requested edits for one form in one preview. Saving does not publish. publish_table_forms is a separate approval, only when the user asks to publish: it publishes ALL pending customizations for the table by any maker; disclose that. Pass null for unused edit options.',
      parameters: object({ plan })
    }
  }
];
