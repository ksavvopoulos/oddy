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

export type FormPrimitiveRequest =
  | { action: 'list_forms'; origin: string; tableLogicalName: string }
  | {
      action: 'get_form_definition';
      origin: string;
      tableLogicalName: string;
      formId: string;
      languageCode?: number;
    };

export interface FormPrimitiveResult {
  ok: boolean;
  action: FormPrimitiveRequest['action'];
  forms?: FormSummary[];
  /** More forms exist than were returned. */
  moreForms?: boolean;
  formDefinition?: FormDefinition;
  error?: string;
}
