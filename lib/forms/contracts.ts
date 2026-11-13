export type FormTypeName = 'main' | 'quickCreate' | 'quickView' | 'card';

export interface FormSummary {
  formId: string;
  name: string;
  description?: string;
  type: FormTypeName;
  isDefault: boolean;
  isManaged: boolean;
  isCustomizable: boolean;
  isActive: boolean;
}

export type FormControlKind =
  'field' | 'subgrid' | 'quickView' | 'webResource' | 'iframe' | 'timeline' | 'spacer' | 'other';

export interface FormControl {
  kind: FormControlKind;
  /** Logical column name for field controls. */
  field?: string;
  controlId?: string;
  label?: string;
  showLabel: boolean;
  visible: boolean;
  readOnly: boolean;
  /** A custom (PCF) control description targets this control. */
  customControl: boolean;
  /** Sub-grid parameters, when present. */
  relationship?: string;
  targetTable?: string;
  viewId?: string;
}

export interface FormSection {
  name?: string;
  label?: string;
  showLabel: boolean;
  visible: boolean;
  /** Zero-based tab column that holds this section. */
  tabColumn: number;
  /** Number of field columns inside the section. */
  columns: number;
  controls: FormControl[];
}

export interface FormTab {
  name?: string;
  label?: string;
  showLabel: boolean;
  visible: boolean;
  expanded: boolean;
  sections: FormSection[];
}

export interface FormEventSummary {
  name: string;
  field?: string;
  handlers: number;
}

export interface FormDefinition {
  formId: string;
  name: string;
  tableLogicalName: string;
  type: FormTypeName;
  isDefault: boolean;
  isManaged: boolean;
  isCustomizable: boolean;
  isActive: boolean;
  /** 'unpublished' includes pending edits by any maker; 'published' is the fallback. */
  source: 'unpublished' | 'published';
  /** SHA-256 of the exact form XML. A snapshot hash, not a server-enforced ETag. */
  revision: string;
  tabs: FormTab[];
  header: FormControl[];
  footer: FormControl[];
  events: FormEventSummary[];
  libraries: string[];
  customControls: number;
  /** Set when the projection hit its control limit. */
  truncated?: boolean;
}

/** One layout edit. Tabs and sections are addressed by their stable `name`, fields by logical name. */
export type FormEdit =
  | {
      op: 'add_field';
      field: string;
      tab: string;
      section: string;
      /** Zero-based row index inside the section; omitted appends. */
      position?: number;
      label?: string;
      readOnly?: boolean;
      showLabel?: boolean;
    }
  | { op: 'move_field'; field: string; tab: string; section: string; position?: number }
  | { op: 'remove_field'; field: string }
  | {
      op: 'set_field';
      field: string;
      label?: string;
      readOnly?: boolean;
      visible?: boolean;
      showLabel?: boolean;
    }
  | {
      op: 'add_section';
      tab: string;
      name: string;
      label: string;
      columns: number;
      /** Zero-based tab column; omitted uses the first. */
      tabColumn?: number;
      position?: number;
      showLabel?: boolean;
    }
  | {
      op: 'set_section';
      tab: string;
      section: string;
      label?: string;
      visible?: boolean;
      showLabel?: boolean;
    }
  | { op: 'add_tab'; name: string; label: string; position?: number }
  | {
      op: 'set_tab';
      tab: string;
      label?: string;
      visible?: boolean;
      expanded?: boolean;
      showLabel?: boolean;
    };

export type FormPlan =
  | {
      operation: 'edit_form';
      solutionUniqueName: string;
      languageCode: number;
      tableLogicalName: string;
      formId: string;
      baseRevision: string;
      edits: FormEdit[];
    }
  | {
      /** PublishXml for the table: publishes ALL its pending customizations, including forms. */
      operation: 'publish_table_forms';
      tableLogicalName: string;
    };

export interface PreparedFormChange {
  mode: 'form-v1';
  id: string;
  environmentOrigin: string;
  plan: FormPlan;
  tableLogicalName: string;
  formId?: string;
  formName?: string;
  formType?: FormTypeName;
  solution?: { uniqueName: string; displayName: string };
  baseRevision?: string;
  /** SHA-256 of the exact XML that execution must reproduce before saving. */
  afterRevision?: string;
  /** IDs minted for new cells/sections/tabs, replayed at execution so the XML is reproducible. */
  generatedIds?: string[];
  /** Human-readable list of approved edits. */
  summary: string[];
  before?: Pick<FormDefinition, 'tabs'>;
  after?: Pick<FormDefinition, 'tabs'>;
  warnings: string[];
}

export interface FormStepOutcome {
  step: 'add_to_solution' | 'save_form' | 'publish';
  status: 'succeeded' | 'failed' | 'unknown' | 'not-attempted';
  message?: string;
}

export interface FormChangeResult {
  operation: FormPlan['operation'];
  tableLogicalName: string;
  formId?: string;
  formName?: string;
  status: 'saved' | 'published' | 'partial' | 'failed';
  message: string;
  outcomes: FormStepOutcome[];
}

export type FormPrimitiveRequest =
  | { action: 'list_forms'; origin: string; tableLogicalName: string }
  | {
      action: 'get_form_definition';
      origin: string;
      tableLogicalName: string;
      formId: string;
      languageCode?: number;
    }
  | { action: 'prepare_form_change'; origin: string; plan: FormPlan }
  | { action: 'execute_form_change'; origin: string; change: PreparedFormChange };

export interface FormPrimitiveResult {
  ok: boolean;
  action: FormPrimitiveRequest['action'];
  forms?: FormSummary[];
  /** More forms exist than were returned. */
  moreForms?: boolean;
  formDefinition?: FormDefinition;
  formChange?: PreparedFormChange;
  formChangeResult?: FormChangeResult;
  error?: string;
}
