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
  }
];

const string = { type: 'string' };
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties)
});

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
        'Read one form’s latest saved layout (including unpublished edits when Dataverse allows) as tabs → sections → controls, plus header/footer fields, script libraries, event handler counts, custom (PCF) control count, and a revision hash. Controls report field logical names, labels, visibility, and form-level read-only. Form read-only/hidden is presentation only, not security. Read-only: Oddy cannot edit forms yet.',
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
  }
];
