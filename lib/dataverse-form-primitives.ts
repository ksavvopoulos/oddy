import type {
  FormChangeResult,
  FormControl,
  FormControlKind,
  FormDefinition,
  FormEdit,
  FormEventSummary,
  FormPlan,
  FormPrimitiveRequest,
  FormPrimitiveResult,
  FormSection,
  FormStepOutcome,
  FormSummary,
  FormTab,
  FormTypeName,
  PreparedFormChange
} from './forms/contracts';

/** Injected into the signed-in Dataverse page. All runtime helpers must stay inside this function. */
export async function executeDataverseFormPrimitive(
  request: FormPrimitiveRequest
): Promise<FormPrimitiveResult> {
  type Obj = Record<string, unknown>;
  const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
  const name = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/i.test(v))
      throw new Error('Invalid table logical name.');
    return v.toLowerCase();
  };
  const fieldName = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/i.test(v))
      throw new Error('Invalid column logical name.');
    return v.toLowerCase();
  };
  const guid = (v: unknown): string => {
    const value = typeof v === 'string' ? v.replace(/^\{|\}$/g, '') : '';
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
      throw new Error('Invalid form ID.');
    return value.toLowerCase();
  };
  const text = (v: unknown, label: string, max = 200): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${label}.`);
    return v;
  };
  const integer = (v: unknown, label: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`Invalid ${label}.`);
    return v;
  };
  const optionalBoolean = (v: unknown, label: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') throw new Error(`Invalid ${label}.`);
    return v;
  };
  // Main, quick view, quick create, and card forms. Dashboards and legacy types are excluded.
  const formTypes: Record<number, FormTypeName> = {
    2: 'main',
    6: 'quickView',
    7: 'quickCreate',
    11: 'card'
  };
  const editableTypes: FormTypeName[] = ['main', 'quickCreate'];
  const maximumBytes = 4 * 1024 * 1024;

  const api = async (
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: Obj,
    extra: Record<string, string> = {}
  ): Promise<Obj> => {
    const timeoutMs = method === 'GET' ? 30_000 : 300_000;
    let response: Response;
    try {
      response = await fetch(`${request.origin}/api/data/v9.2/${path}`, {
        method,
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          'OData-Version': '4.0',
          'OData-MaxVersion': '4.0',
          ...(method === 'GET'
            ? { Prefer: 'odata.include-annotations="*"' }
            : { 'Content-Type': 'application/json; charset=utf-8' }),
          ...extra
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new Error(
          `Dataverse did not respond within ${timeoutMs / 1000} seconds; the request may still complete on the server.`
        );
      throw error;
    }
    if (Number(response.headers.get('Content-Length')) > maximumBytes)
      throw new Error('Form response exceeds the 4 MiB safety limit.');
    const content = await response.text();
    if (content.length > maximumBytes)
      throw new Error('Form response exceeds the 4 MiB safety limit.');
    if (!response.ok)
      throw Object.assign(
        new Error(`Dataverse form request failed (${response.status}): ${content.slice(0, 700)}`),
        {
          status: response.status,
          definitiveRejection:
            response.status >= 400 && response.status < 500 && response.status !== 408
        }
      );
    let result: unknown = {};
    try {
      result = content ? JSON.parse(content) : {};
    } catch {
      throw new Error(
        'Dataverse returned a web page instead of data; the session may need a refresh. Reload the Dataverse tab and try again.'
      );
    }
    if (!object(result)) throw new Error('Invalid Dataverse form response.');
    return result;
  };

  // Managed properties come back as { Value } objects; plain booleans are accepted too.
  const managedFlag = (v: unknown): boolean => (object(v) ? v.Value === true : v === true);

  const summary = (row: Obj): FormSummary | undefined => {
    const type = formTypes[Number(row.type)];
    if (!type || typeof row.name !== 'string') return undefined;
    return {
      formId: guid(row.formid),
      name: row.name,
      ...(typeof row.description === 'string' && row.description
        ? { description: row.description.slice(0, 500) }
        : {}),
      type,
      isDefault: row.isdefault === true,
      isManaged: row.ismanaged === true,
      isCustomizable: managedFlag(row.iscustomizable),
      isActive: row.formactivationstate !== 0
    };
  };

  const sha256 = async (value: string): Promise<string> => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
  };

  // ---- Form XML helpers -------------------------------------------------------------------

  const parse = (xml: string): Document => {
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const root = document.documentElement;
    if (!root || root.nodeName !== 'form' || document.getElementsByTagName('parsererror').length)
      throw new Error('The form XML could not be parsed.');
    return document;
  };
  const children = (element: Element | null | undefined, tag: string): Element[] =>
    element ? Array.from(element.children).filter((child) => child.nodeName === tag) : [];
  const child = (element: Element | null | undefined, tag: string) => children(element, tag)[0];
  const ensureChild = (element: Element, tag: string, first = false): Element => {
    const existing = child(element, tag);
    if (existing) return existing;
    const created = element.ownerDocument.createElementNS(null, tag);
    if (first) element.insertBefore(created, element.firstElementChild);
    else element.appendChild(created);
    return created;
  };
  const bool = (element: Element, attribute: string, fallback: boolean) => {
    const value = element.getAttribute(attribute);
    return value == null ? fallback : value.toLowerCase() === 'true';
  };
  const labelOf = (element: Element, languageCode?: number): string | undefined => {
    const labels = children(child(element, 'labels'), 'label');
    const match =
      labels.find((l) => Number(l.getAttribute('languagecode')) === languageCode) ?? labels[0];
    return match?.getAttribute('description') ?? undefined;
  };
  const setLabel = (element: Element, value: string, languageCode: number) => {
    const labels = ensureChild(element, 'labels', true);
    const existing = children(labels, 'label').find(
      (l) => Number(l.getAttribute('languagecode')) === languageCode
    );
    const label =
      existing ?? labels.appendChild(element.ownerDocument.createElementNS(null, 'label'));
    label.setAttribute('description', value);
    label.setAttribute('languagecode', String(languageCode));
  };
  const optional = <K extends string>(key: K, value: string | null | undefined) =>
    value ? ({ [key]: value } as Record<K, string>) : {};
  const sameName = (element: Element, value: string) =>
    (element.getAttribute('name') ?? '').toLowerCase() === value.toLowerCase();
  const idOf = (element: Element) =>
    element
      .getAttribute('id')
      ?.replace(/^\{|\}$/g, '')
      .toLowerCase() || undefined;
  /** Matches a tab/section by its `name`, or by its `id` (with or without braces). */
  const matches = (element: Element, value: string) =>
    sameName(element, value) || idOf(element) === value.replace(/^\{|\}$/g, '').toLowerCase();

  const project = (document: Document, languageCode?: number) => {
    const root = document.documentElement;
    const customTargets = new Set(
      children(child(root, 'controlDescriptions'), 'controlDescription')
        .map((d) =>
          d
            .getAttribute('forControl')
            ?.replace(/^\{|\}$/g, '')
            .toLowerCase()
        )
        .filter((v): v is string => !!v)
    );
    const kinds: Record<string, FormControlKind> = {
      'E7A81278-8635-4D9E-8D4D-59480B391C5B': 'subgrid',
      '5C5600E0-1D6E-4205-A272-BE80DA87FD42': 'quickView',
      '9FDF5F91-88B1-47F4-AD53-C11EFC01A01D': 'webResource',
      'FD2A7985-3187-444E-908D-6624B21F69C0': 'iframe',
      '06375649-C143-495E-A496-C962E5B4488E': 'timeline'
    };
    const limit = 600;
    let count = 0;
    let truncated = false;

    const cellControl = (cell: Element): FormControl | undefined => {
      if (count >= limit) {
        truncated = true;
        return undefined;
      }
      count++;
      const control = child(cell, 'control');
      const base = {
        ...optional('label', labelOf(cell, languageCode)),
        showLabel: bool(cell, 'showlabel', true),
        visible: bool(cell, 'visible', true)
      };
      if (!control || bool(cell, 'userspacer', false))
        return { kind: 'spacer', ...base, readOnly: false, customControl: false };
      const classId = (control.getAttribute('classid') ?? '').replace(/^\{|\}$/g, '').toUpperCase();
      const field = control.getAttribute('datafieldname')?.toLowerCase();
      const parameters = child(control, 'parameters');
      const parameter = (tag: string) => child(parameters, tag)?.textContent?.trim();
      const uniqueId = control
        .getAttribute('uniqueid')
        ?.replace(/^\{|\}$/g, '')
        .toLowerCase();
      return {
        kind: kinds[classId] ?? (field ? 'field' : 'other'),
        ...optional('field', field),
        ...optional('controlId', control.getAttribute('id')),
        ...base,
        readOnly: bool(control, 'disabled', false),
        customControl: !!uniqueId && customTargets.has(uniqueId),
        ...optional('relationship', parameter('RelationshipName')),
        ...optional('targetTable', parameter('TargetEntityType')),
        ...optional(
          'viewId',
          parameter('ViewId')
            ?.replace(/^\{|\}$/g, '')
            .toLowerCase()
        )
      };
    };
    const rowControls = (container: Element | undefined): FormControl[] =>
      children(child(container, 'rows'), 'row')
        .flatMap((row) => children(row, 'cell'))
        .map(cellControl)
        .filter((v): v is FormControl => !!v);

    const tabs: FormTab[] = children(child(root, 'tabs'), 'tab').map((tab) => ({
      ...optional('name', tab.getAttribute('name')),
      ...optional('id', idOf(tab)),
      ...optional('label', labelOf(tab, languageCode)),
      showLabel: bool(tab, 'showlabel', true),
      visible: bool(tab, 'visible', true),
      expanded: bool(tab, 'expanded', true),
      sections: children(child(tab, 'columns'), 'column').flatMap((column, tabColumn) =>
        children(child(column, 'sections'), 'section').map((section): FormSection => ({
          ...optional('name', section.getAttribute('name')),
          ...optional('id', idOf(section)),
          ...optional('label', labelOf(section, languageCode)),
          showLabel: bool(section, 'showlabel', true),
          visible: bool(section, 'visible', true),
          tabColumn,
          // Layout strings such as "1", "11", "111" encode one digit per column.
          columns: /^\d{1,4}$/.test(section.getAttribute('columns') ?? '')
            ? section.getAttribute('columns')!.length
            : 1,
          controls: rowControls(section)
        }))
      )
    }));

    const events: FormEventSummary[] = children(child(root, 'events'), 'event')
      .map((event) => ({
        name: event.getAttribute('name') ?? 'unknown',
        ...optional('field', event.getAttribute('attribute')?.toLowerCase()),
        handlers: children(child(event, 'Handlers'), 'Handler').length
      }))
      .filter((event) => event.handlers > 0);

    return {
      tabs,
      header: rowControls(child(root, 'header')),
      footer: rowControls(child(root, 'footer')),
      events,
      libraries: children(child(root, 'formLibraries'), 'Library')
        .map((library) => library.getAttribute('name'))
        .filter((v): v is string => !!v),
      customControls: customTargets.size,
      ...(truncated ? { truncated } : {})
    };
  };

  // ---- Dataverse reads ----------------------------------------------------------------------

  const readForm = async (table: string, formId: string, requireUnpublished: boolean) => {
    let row: Obj;
    let source: FormDefinition['source'] = 'unpublished';
    try {
      // Latest saved definition, including edits not yet published by any maker.
      row = await api(`systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (requireUnpublished || (status !== 400 && status !== 404 && status !== 501)) throw error;
      row = await api(
        `systemforms(${formId})?$select=formid,name,type,objecttypecode,formxml,isdefault,ismanaged,iscustomizable,formactivationstate`
      );
      source = 'published';
    }
    if (guid(row.formid) !== formId) throw new Error('Dataverse returned a different form.');
    if (String(row.objecttypecode).toLowerCase() !== table)
      throw new Error(`The form does not belong to table ${table}.`);
    const formSummary = summary(row);
    if (!formSummary)
      throw new Error('Only main, quick create, quick view, and card forms are supported.');
    if (typeof row.formxml !== 'string' || !row.formxml)
      throw new Error('The form XML was not returned.');
    return { formSummary, xml: row.formxml, source };
  };

  const readSolution = async (uniqueName: unknown) => {
    if (typeof uniqueName !== 'string' || !/^[a-z_][a-z0-9_]{0,99}$/i.test(uniqueName))
      throw new Error('Invalid solution unique name.');
    const result = await api(
      `solutions?$select=solutionid,uniquename,friendlyname,ismanaged&$filter=${encodeURIComponent(`uniquename eq '${uniqueName}'`)}`
    );
    const rows = Array.isArray(result.value) ? result.value.filter(object) : [];
    if (rows.length !== 1) throw new Error('The exact solution was not found.');
    if (rows[0]!.ismanaged !== false) throw new Error('Select an unmanaged solution.');
    return {
      uniqueName: String(rows[0]!.uniquename),
      displayName: String(rows[0]!.friendlyname ?? rows[0]!.uniquename)
    };
  };

  type Attribute = {
    type: string;
    typeName?: string;
    validForForm: boolean;
    required: string;
    primaryName: boolean;
    label?: string;
  };
  const readAttributes = async (table: string, languageCode: number) => {
    const result = await api(
      `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,AttributeType,AttributeTypeName,IsValidForForm,RequiredLevel,IsPrimaryName,DisplayName`
    );
    if (!Array.isArray(result.value)) throw new Error('The table columns could not be read.');
    const attributes = new Map<string, Attribute>();
    for (const row of result.value.filter(object)) {
      const display = object(row.DisplayName) ? row.DisplayName : {};
      const localized = Array.isArray(display.LocalizedLabels)
        ? display.LocalizedLabels.filter(object)
        : [];
      const label =
        localized.find((l) => l.LanguageCode === languageCode)?.Label ??
        (object(display.UserLocalizedLabel) ? display.UserLocalizedLabel.Label : undefined);
      attributes.set(String(row.LogicalName).toLowerCase(), {
        type: String(row.AttributeType),
        ...(object(row.AttributeTypeName) ? { typeName: String(row.AttributeTypeName.Value) } : {}),
        validForForm: row.IsValidForForm !== false,
        required: object(row.RequiredLevel) ? String(row.RequiredLevel.Value) : 'None',
        primaryName: row.IsPrimaryName === true,
        ...(typeof label === 'string' && label ? { label } : {})
      });
    }
    return attributes;
  };

  // Field control class IDs by attribute type. Unlisted types cannot be added by Oddy.
  const classIdFor = (attribute: Attribute): string | undefined => {
    if (attribute.typeName === 'MultiSelectPicklistType')
      return '{4AA28AB7-9C13-4F57-A73D-AD894D048B5F}';
    return {
      String: '{4273EDBD-AC1D-40D3-9FB2-095C621B552D}',
      Memo: '{E0DECE4B-6FC8-4A8F-A065-082708572369}',
      Integer: '{C6D124CA-7EDA-4A60-AEA9-7FB8D318B68F}',
      Decimal: '{C3EFE0C3-0EC6-42BE-8349-CBD9079DFD8E}',
      Double: '{0D2C745A-E5A8-4C8F-BA63-C6D3BB604660}',
      Money: '{533B9E00-756B-4312-95A0-DC888637AC78}',
      DateTime: '{5B773807-9FB2-42DB-97C3-7A91EFF8ADFF}',
      Boolean: '{67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED}',
      Picklist: '{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}',
      State: '{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}',
      Status: '{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}',
      Lookup: '{270BD3DB-D9AF-4782-9025-509E298DEC0A}',
      Customer: '{270BD3DB-D9AF-4782-9025-509E298DEC0A}',
      Owner: '{270BD3DB-D9AF-4782-9025-509E298DEC0A}'
    }[attribute.type];
  };

  // ---- Edits ----------------------------------------------------------------------------------

  const editKeys: Record<FormEdit['op'], string[]> = {
    add_field: ['field', 'tab', 'section', 'position', 'label', 'readOnly', 'showLabel'],
    move_field: ['field', 'tab', 'section', 'position'],
    remove_field: ['field'],
    set_field: ['field', 'label', 'readOnly', 'visible', 'showLabel'],
    add_section: ['tab', 'name', 'label', 'columns', 'tabColumn', 'position', 'showLabel'],
    set_section: ['tab', 'section', 'label', 'visible', 'showLabel'],
    add_tab: ['name', 'label', 'position'],
    set_tab: ['tab', 'label', 'visible', 'expanded', 'showLabel'],
    remove_section: ['tab', 'section'],
    remove_tab: ['tab']
  };
  // Model tool calls send null for unused options.
  const compact = (value: Obj): Obj =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
  const elementName = (v: unknown, label: string) => {
    if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(v))
      throw new Error(`Invalid ${label}: use letters, digits, and underscores.`);
    return v;
  };

  const applyEdits = async (
    document: Document,
    edits: FormEdit[],
    context: {
      table: string;
      languageCode: number;
      nextId: () => string;
      attributes: () => Promise<Map<string, Attribute>>;
    }
  ) => {
    const root = document.documentElement;
    const tabsElement = child(root, 'tabs');
    if (!tabsElement) throw new Error('The form has no tabs element.');
    const summaryLines: string[] = [];
    const warnings: string[] = [];
    const create = (tag: string, attributes: Record<string, string> = {}) => {
      // Null namespace keeps exact element-name case (createElement may upper-case it).
      const element = document.createElementNS(null, tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };
    const tabs = () => children(tabsElement, 'tab');
    const sectionsOf = (tab: Element) =>
      children(child(tab, 'columns'), 'column').flatMap((column) =>
        children(child(column, 'sections'), 'section')
      );
    const findTab = (value: unknown) => {
      const tabName = text(value, 'tab name or id', 100);
      const found = tabs().filter((tab) => matches(tab, tabName));
      if (found.length !== 1)
        throw new Error(`Tab "${tabName}" was ${found.length ? 'ambiguous' : 'not found'}.`);
      return found[0]!;
    };
    const findSection = (tabValue: unknown, sectionValue: unknown) => {
      const tab = findTab(tabValue);
      const sectionName = text(sectionValue, 'section name or id', 100);
      const found = sectionsOf(tab).filter((section) => matches(section, sectionName));
      if (found.length !== 1)
        throw new Error(
          `Section "${sectionName}" was ${found.length ? 'ambiguous' : 'not found'} in tab "${tab.getAttribute('name') ?? idOf(tab)}".`
        );
      return { tab, section: found[0]! };
    };
    const tabTitle = (tab: Element) =>
      labelOf(tab, context.languageCode) ?? tab.getAttribute('name') ?? idOf(tab);
    const contentOf = (section: Element) =>
      children(child(section, 'rows'), 'row')
        .flatMap((row) => children(row, 'cell'))
        .map((cell) => child(cell, 'control'))
        .filter((control): control is Element => !!control)
        .map(
          (control) =>
            control.getAttribute('datafieldname') || control.getAttribute('id') || 'control'
        );
    const ownHandlers = (element: Element) =>
      children(child(element, 'events'), 'event').reduce(
        (sum, event) => sum + children(child(event, 'Handlers'), 'Handler').length,
        0
      );
    const scriptNote = (kind: string, element: Element) => {
      if (children(child(root, 'formLibraries'), 'Library').length)
        warnings.push(
          `This form has script libraries; scripts that refer to the removed ${kind} ${element.getAttribute('name') ?? ''} by name may fail.`
        );
    };
    const bodyCells = (field: string) =>
      tabs()
        .flatMap(sectionsOf)
        .flatMap((section) => children(child(section, 'rows'), 'row'))
        .flatMap((row) => children(row, 'cell'))
        .filter(
          (cell) => child(cell, 'control')?.getAttribute('datafieldname')?.toLowerCase() === field
        );
    const findCell = (value: unknown) => {
      const field = fieldName(value);
      const cells = bodyCells(field);
      if (cells.length !== 1)
        throw new Error(
          cells.length
            ? `Field ${field} appears ${cells.length} times in the form body; edit it in the form designer.`
            : `Field ${field} is not in the form body (header fields cannot be edited yet).`
        );
      return { field, cell: cells[0]! };
    };
    const detach = (cell: Element) => {
      const row = cell.parentElement!;
      row.removeChild(cell);
      if (!children(row, 'cell').length) row.parentElement!.removeChild(row);
    };
    const insertRow = (section: Element, cell: Element, position: unknown) => {
      const rows = ensureChild(section, 'rows');
      const existing = children(rows, 'row');
      const index =
        position === undefined
          ? existing.length
          : integer(position, 'row position', 0, existing.length);
      const row = create('row');
      row.appendChild(cell);
      rows.insertBefore(row, existing[index] ?? null);
      return index;
    };
    const where = (tab: Element, section: Element) =>
      `${labelOf(tab, context.languageCode) ?? tab.getAttribute('name')} › ${labelOf(section, context.languageCode) ?? section.getAttribute('name')}`;
    const multiColumnNote = (section: Element) => {
      if ((section.getAttribute('columns') ?? '1').length > 1)
        warnings.push(
          `Section ${section.getAttribute('name')} has several columns; new or moved fields get their own row. Rearrange columns in the form designer if needed.`
        );
    };
    const allSectionNames = () =>
      tabs()
        .flatMap(sectionsOf)
        .map((s) => (s.getAttribute('name') ?? '').toLowerCase());
    const handlerCount = (field: string) =>
      children(child(root, 'events'), 'event')
        .filter((event) => event.getAttribute('attribute')?.toLowerCase() === field)
        .reduce((sum, event) => sum + children(child(event, 'Handlers'), 'Handler').length, 0);
    const scriptMentions = (field: string) =>
      children(child(root, 'events'), 'event').some((event) =>
        children(child(event, 'Handlers'), 'Handler').some((handler) =>
          (handler.getAttribute('parameters') ?? '').toLowerCase().includes(field)
        )
      );
    const newSection = (sectionName: string, label: string, columns: number, showLabel = true) => {
      const section = create('section', {
        name: sectionName,
        showlabel: String(showLabel),
        showbar: 'false',
        id: context.nextId(),
        IsUserDefined: '0',
        columns: '1'.repeat(columns)
      });
      setLabel(section, label, context.languageCode);
      section.appendChild(create('rows'));
      return section;
    };

    for (const raw of edits) {
      if (!object(raw)) throw new Error('Each form edit must be an object.');
      const edit = compact(raw);
      const op = edit.op as FormEdit['op'];
      if (!Object.hasOwn(editKeys, op)) throw new Error('Unsupported form edit.');
      const extra = Object.keys(edit).filter((key) => key !== 'op' && !editKeys[op].includes(key));
      if (extra.length) throw new Error(`Unsupported ${op} option: ${extra.join(', ')}.`);

      if (op === 'add_field') {
        const field = fieldName(edit.field);
        const attribute = (await context.attributes()).get(field);
        if (!attribute) throw new Error(`Column ${field} does not exist on ${context.table}.`);
        if (!attribute.validForForm) throw new Error(`Column ${field} cannot be placed on forms.`);
        const classId = classIdFor(attribute);
        if (!classId)
          throw new Error(
            `Column ${field} (${attribute.typeName ?? attribute.type}) cannot be added by Oddy; use the form designer.`
          );
        if (bodyCells(field).length)
          throw new Error(`Field ${field} is already on the form; use move_field instead.`);
        const { tab, section } = findSection(edit.tab, edit.section);
        const label =
          edit.label === undefined ? (attribute.label ?? field) : text(edit.label, 'field label');
        const readOnly = optionalBoolean(edit.readOnly, 'readOnly') ?? false;
        const cell = create('cell', {
          id: context.nextId(),
          showlabel: String(optionalBoolean(edit.showLabel, 'showLabel') ?? true),
          locklevel: '0'
        });
        setLabel(cell, label, context.languageCode);
        cell.appendChild(
          create('control', {
            id: field,
            classid: classId,
            datafieldname: field,
            disabled: String(readOnly)
          })
        );
        const index = insertRow(section, cell, edit.position);
        multiColumnNote(section);
        summaryLines.push(
          `Add ${label} (${field}) to ${where(tab, section)} at row ${index + 1}${readOnly ? ', read-only' : ''}`
        );
        continue;
      }

      if (op === 'move_field') {
        const { field, cell } = findCell(edit.field);
        const { tab, section } = findSection(edit.tab, edit.section);
        detach(cell);
        const index = insertRow(section, cell, edit.position);
        multiColumnNote(section);
        summaryLines.push(`Move ${field} to ${where(tab, section)} at row ${index + 1}`);
        continue;
      }

      if (op === 'remove_field') {
        const { field, cell } = findCell(edit.field);
        const handlers = handlerCount(field);
        if (handlers)
          throw new Error(
            `Field ${field} has ${handlers} OnChange script handler(s). Remove them in the form designer before removing the field.`
          );
        const attribute = (await context.attributes()).get(field);
        detach(cell);
        if (attribute?.primaryName)
          warnings.push(`${field} is the table's primary name column; most forms should show it.`);
        if (
          attribute?.required === 'ApplicationRequired' ||
          attribute?.required === 'SystemRequired'
        )
          warnings.push(
            `${field} is business-required. Removing it from the form does not make it optional; saving records may require a value from another form or process.`
          );
        if (scriptMentions(field))
          warnings.push(
            `A form script handler mentions ${field} in its parameters; check the script still works.`
          );
        summaryLines.push(`Remove ${field} from the form (column and data are unchanged)`);
        continue;
      }

      if (op === 'set_field') {
        const { field, cell } = findCell(edit.field);
        const changes: string[] = [];
        if (edit.label !== undefined) {
          setLabel(cell, text(edit.label, 'field label'), context.languageCode);
          changes.push(`label "${edit.label}"`);
        }
        const readOnly = optionalBoolean(edit.readOnly, 'readOnly');
        if (readOnly !== undefined) {
          child(cell, 'control')!.setAttribute('disabled', String(readOnly));
          changes.push(readOnly ? 'read-only' : 'editable');
        }
        const visible = optionalBoolean(edit.visible, 'visible');
        if (visible !== undefined) {
          cell.setAttribute('visible', String(visible));
          changes.push(visible ? 'visible' : 'hidden');
          if (!visible && scriptMentions(field))
            warnings.push(`A form script handler mentions ${field}; scripts may show it again.`);
        }
        const showLabel = optionalBoolean(edit.showLabel, 'showLabel');
        if (showLabel !== undefined) {
          cell.setAttribute('showlabel', String(showLabel));
          changes.push(showLabel ? 'label shown' : 'label hidden');
        }
        if (!changes.length) throw new Error(`set_field for ${field} changes nothing.`);
        summaryLines.push(`Set ${field}: ${changes.join(', ')}`);
        continue;
      }

      if (op === 'add_section') {
        const tab = findTab(edit.tab);
        const sectionName = elementName(edit.name, 'section name');
        if (allSectionNames().includes(sectionName.toLowerCase()))
          throw new Error(`A section named ${sectionName} already exists.`);
        const columns = integer(edit.columns, 'section column count', 1, 4);
        const tabColumns = children(child(tab, 'columns'), 'column');
        const column =
          tabColumns[
            edit.tabColumn === undefined
              ? 0
              : integer(edit.tabColumn, 'tab column', 0, tabColumns.length - 1)
          ];
        if (!column) throw new Error('The tab has no columns.');
        const sections = ensureChild(column, 'sections');
        const existing = children(sections, 'section');
        const index =
          edit.position === undefined
            ? existing.length
            : integer(edit.position, 'section position', 0, existing.length);
        const label = text(edit.label, 'section label');
        sections.insertBefore(
          newSection(sectionName, label, columns, optionalBoolean(edit.showLabel, 'showLabel')),
          existing[index] ?? null
        );
        summaryLines.push(
          `Add section ${label} (${sectionName}, ${columns} column${columns === 1 ? '' : 's'}) to tab ${labelOf(tab, context.languageCode) ?? tab.getAttribute('name')}`
        );
        continue;
      }

      if (op === 'set_section') {
        const { tab, section } = findSection(edit.tab, edit.section);
        const changes: string[] = [];
        if (edit.label !== undefined) {
          setLabel(section, text(edit.label, 'section label'), context.languageCode);
          changes.push(`label "${edit.label}"`);
        }
        const visible = optionalBoolean(edit.visible, 'visible');
        if (visible !== undefined) {
          section.setAttribute('visible', String(visible));
          changes.push(visible ? 'visible' : 'hidden');
        }
        const showLabel = optionalBoolean(edit.showLabel, 'showLabel');
        if (showLabel !== undefined) {
          section.setAttribute('showlabel', String(showLabel));
          changes.push(showLabel ? 'label shown' : 'label hidden');
        }
        if (!changes.length) throw new Error('set_section changes nothing.');
        summaryLines.push(`Set section ${where(tab, section)}: ${changes.join(', ')}`);
        continue;
      }

      if (op === 'add_tab') {
        const tabName = elementName(edit.name, 'tab name');
        if (tabs().some((tab) => sameName(tab, tabName)))
          throw new Error(`A tab named ${tabName} already exists.`);
        const sectionName = `${tabName}_section_1`;
        if (allSectionNames().includes(sectionName.toLowerCase()))
          throw new Error(`A section named ${sectionName} already exists.`);
        const label = text(edit.label, 'tab label');
        const existing = tabs();
        const index =
          edit.position === undefined
            ? existing.length
            : integer(edit.position, 'tab position', 0, existing.length);
        const tab = create('tab', {
          name: tabName,
          id: context.nextId(),
          IsUserDefined: '0',
          expanded: 'true',
          showlabel: 'true',
          verticallayout: 'true'
        });
        setLabel(tab, label, context.languageCode);
        const sections = tab
          .appendChild(create('columns'))
          .appendChild(create('column', { width: '100%' }))
          .appendChild(create('sections'));
        sections.appendChild(newSection(sectionName, label, 1, false));
        tabsElement.insertBefore(tab, existing[index] ?? null);
        summaryLines.push(
          `Add tab ${label} (${tabName}) at position ${index + 1} with one section ${sectionName}`
        );
        continue;
      }

      if (op === 'remove_section') {
        const { tab, section } = findSection(edit.tab, edit.section);
        const content = contentOf(section);
        if (content.length)
          throw new Error(
            `Section ${section.getAttribute('name') ?? idOf(section)} still contains ${content.join(', ')}. Move or remove them first (earlier edits in the same preview count).`
          );
        if (ownHandlers(section))
          throw new Error('This section has script handlers; remove it in the form designer.');
        section.parentElement!.removeChild(section);
        scriptNote('section', section);
        summaryLines.push(
          `Remove empty section ${labelOf(section, context.languageCode) ?? section.getAttribute('name') ?? idOf(section)} from tab ${tabTitle(tab)}`
        );
        continue;
      }

      if (op === 'remove_tab') {
        const tab = findTab(edit.tab);
        const content = sectionsOf(tab).flatMap(contentOf);
        if (content.length)
          throw new Error(
            `Tab ${tabTitle(tab)} still contains ${content.join(', ')}. Move or remove them first (earlier edits in the same preview count).`
          );
        if (ownHandlers(tab))
          throw new Error(
            'This tab has TabStateChange script handlers; remove it in the form designer.'
          );
        if (tabs().filter((t) => t !== tab && bool(t, 'visible', true)).length === 0)
          throw new Error('At least one visible tab must remain.');
        tabsElement.removeChild(tab);
        scriptNote('tab', tab);
        summaryLines.push(`Remove empty tab ${tabTitle(tab)} and its sections`);
        continue;
      }

      // set_tab
      const tab = findTab(edit.tab);
      const changes: string[] = [];
      if (edit.label !== undefined) {
        setLabel(tab, text(edit.label, 'tab label'), context.languageCode);
        changes.push(`label "${edit.label}"`);
      }
      for (const [key, attribute, on, off] of [
        ['visible', 'visible', 'visible', 'hidden'],
        ['expanded', 'expanded', 'expanded', 'collapsed'],
        ['showLabel', 'showlabel', 'label shown', 'label hidden']
      ] as const) {
        const value = optionalBoolean(edit[key], key);
        if (value === undefined) continue;
        tab.setAttribute(attribute, String(value));
        changes.push(value ? on : off);
      }
      if (!changes.length) throw new Error('set_tab changes nothing.');
      if (
        tab.getAttribute('visible') === 'false' &&
        tabs().every((t) => bool(t, 'visible', true) === false)
      )
        throw new Error('At least one tab must stay visible.');
      summaryLines.push(
        `Set tab ${labelOf(tab, context.languageCode) ?? tab.getAttribute('name')}: ${changes.join(', ')}`
      );
    }
    return { summaryLines, warnings };
  };

  // ---- Prepare / execute ----------------------------------------------------------------------

  type Prepared = PreparedFormChange & { afterXml?: string };
  const prepare = async (rawPlan: unknown, replayIds?: string[]): Promise<Prepared> => {
    if (!object(rawPlan)) throw new Error('A form plan is required.');
    if (JSON.stringify(rawPlan).length > 64_000)
      throw new Error('The form plan exceeds the safety limit.');
    const plan = compact(rawPlan);
    const allowed: Record<FormPlan['operation'], string[]> = {
      edit_form: [
        'solutionUniqueName',
        'languageCode',
        'tableLogicalName',
        'formId',
        'baseRevision',
        'edits'
      ],
      publish_table_forms: ['tableLogicalName']
    };
    const operation = plan.operation as FormPlan['operation'];
    if (!Object.hasOwn(allowed, operation)) throw new Error('Unsupported form operation.');
    const extra = Object.keys(plan).filter(
      (key) => key !== 'operation' && !allowed[operation].includes(key)
    );
    if (extra.length) throw new Error(`Unsupported form plan option: ${extra.join(', ')}.`);
    const table = name(plan.tableLogicalName);

    if (operation === 'publish_table_forms') {
      const exists = await api(
        `EntityDefinitions?$select=LogicalName&$filter=${encodeURIComponent(`LogicalName eq '${table}'`)}`
      );
      if (!Array.isArray(exists.value) || exists.value.length !== 1)
        throw new Error(`Table ${table} was not found.`);
      return {
        mode: 'form-v1',
        id: crypto.randomUUID(),
        environmentOrigin: request.origin,
        plan: { operation, tableLogicalName: table },
        tableLogicalName: table,
        summary: [`Publish all pending customizations for table ${table}`],
        warnings: [
          `PublishXml publishes ALL pending customizations for ${table}: every form, view, and column change by any maker, not only Oddy's edits.`,
          'Published forms are immediately visible to users of apps that include them.'
        ]
      };
    }

    const languageCode = integer(plan.languageCode, 'language LCID', 1, 65535);
    const formId = guid(plan.formId);
    const baseRevision = plan.baseRevision;
    if (typeof baseRevision !== 'string' || !/^[0-9a-f]{64}$/.test(baseRevision))
      throw new Error(
        'baseRevision must be the exact revision from get_dataverse_form_definition.'
      );
    if (!Array.isArray(plan.edits) || !plan.edits.length || plan.edits.length > 30)
      throw new Error('Provide 1 to 30 form edits.');
    const solution = await readSolution(plan.solutionUniqueName);
    const form = await readForm(table, formId, true);
    if (!editableTypes.includes(form.formSummary.type))
      throw new Error('Only main and quick create forms can be edited.');
    if (!form.formSummary.isCustomizable) throw new Error('This form is not customizable.');
    if ((await sha256(form.xml)) !== baseRevision)
      throw new Error(
        'The form changed since it was read. Read it again with get_dataverse_form_definition and prepare a fresh preview.'
      );

    const document = parse(form.xml);
    const before = project(document, languageCode).tabs;
    const generatedIds: string[] = [];
    const replay = replayIds ? [...replayIds] : undefined;
    let attributes: Map<string, Attribute> | undefined;
    const { summaryLines, warnings } = await applyEdits(document, plan.edits as FormEdit[], {
      table,
      languageCode,
      nextId: () => {
        const id = replay ? replay.shift() : `{${crypto.randomUUID()}}`;
        if (!id || !/^\{[0-9a-f-]{36}\}$/.test(id))
          throw new Error('The approved form preview could not be reproduced.');
        generatedIds.push(id);
        return id;
      },
      attributes: async () => (attributes ??= await readAttributes(table, languageCode))
    });
    if (replay?.length) throw new Error('The approved form preview could not be reproduced.');
    const afterXml = new XMLSerializer().serializeToString(document);
    const after = project(parse(afterXml), languageCode).tabs;
    if (form.formSummary.isManaged)
      warnings.push(
        'This form is managed. Your edits become an unmanaged customization layered on top; a later update of the managed solution does not remove them.'
      );
    if (!form.formSummary.isActive)
      warnings.push('This form is inactive; users will not see it until it is activated.');
    warnings.push(
      'Saving does not publish. Users see the change only after the table is published (a separate approval).',
      'Form-level read-only and hidden settings are presentation only; they do not secure data.',
      'Oddy checks that the form is unchanged right before saving, but the check and the save are not atomic.'
    );
    return {
      mode: 'form-v1',
      id: crypto.randomUUID(),
      environmentOrigin: request.origin,
      plan: {
        operation,
        solutionUniqueName: solution.uniqueName,
        languageCode,
        tableLogicalName: table,
        formId,
        baseRevision,
        edits: (plan.edits as Obj[]).map((edit) => compact(edit)) as FormEdit[]
      },
      tableLogicalName: table,
      formId,
      formName: form.formSummary.name,
      formType: form.formSummary.type,
      solution,
      baseRevision,
      afterRevision: await sha256(afterXml),
      generatedIds,
      summary: summaryLines,
      before: { tabs: before },
      after: { tabs: after },
      warnings: [...new Set(warnings)],
      afterXml
    };
  };

  const execute = async (change: PreparedFormChange): Promise<FormChangeResult> => {
    if (change.mode !== 'form-v1' || change.environmentOrigin !== request.origin)
      throw new Error('This form preview is invalid or belongs to another environment.');
    const fresh = await prepare(change.plan, change.generatedIds ?? []);
    if (
      fresh.tableLogicalName !== change.tableLogicalName ||
      fresh.formId !== change.formId ||
      fresh.afterRevision !== change.afterRevision ||
      fresh.solution?.uniqueName !== change.solution?.uniqueName
    )
      throw new Error(
        'The approved form change no longer matches the form. Prepare a fresh preview.'
      );

    const steps: Array<{ step: FormStepOutcome['step']; run: () => Promise<unknown> }> =
      change.plan.operation === 'publish_table_forms'
        ? [
            {
              step: 'publish',
              run: () =>
                api('PublishXml', 'POST', {
                  ParameterXml: `<importexportxml><entities><entity>${fresh.tableLogicalName}</entity></entities></importexportxml>`
                })
            }
          ]
        : [
            {
              step: 'add_to_solution',
              run: () =>
                api('AddSolutionComponent', 'POST', {
                  ComponentId: fresh.formId,
                  ComponentType: 60,
                  SolutionUniqueName: fresh.solution!.uniqueName,
                  AddRequiredComponents: false
                })
            },
            {
              step: 'save_form',
              // If-Match: * prevents an upsert from creating a form if the ID vanished.
              run: () =>
                api(
                  `systemforms(${fresh.formId})`,
                  'PATCH',
                  { formxml: fresh.afterXml },
                  {
                    'If-Match': '*',
                    'MSCRM.SolutionUniqueName': fresh.solution!.uniqueName
                  }
                )
            }
          ];
    const outcomes: FormStepOutcome[] = steps.map(({ step }) => ({
      step,
      status: 'not-attempted'
    }));
    const base = {
      operation: change.plan.operation,
      tableLogicalName: fresh.tableLogicalName,
      ...(fresh.formId ? { formId: fresh.formId } : {}),
      ...(fresh.formName ? { formName: fresh.formName } : {})
    };
    for (const [index, { step, run }] of steps.entries()) {
      try {
        await run();
        outcomes[index] = { step, status: 'succeeded' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const definite = (error as { definitiveRejection?: boolean }).definitiveRejection === true;
        outcomes[index] = { step, status: definite ? 'failed' : 'unknown', message: detail };
        const saveUncertain = step === 'save_form' && !definite;
        return {
          ...base,
          status: index > 0 ? 'partial' : 'failed',
          message: `Form change did not complete. ${detail} ${saveUncertain || step === 'publish' ? 'The outcome is uncertain; read the form again before preparing a new preview.' : 'No later steps were attempted.'} No rollback or automatic retry was performed.`,
          outcomes
        };
      }
    }
    return {
      ...base,
      status: change.plan.operation === 'publish_table_forms' ? 'published' : 'saved',
      message:
        change.plan.operation === 'publish_table_forms'
          ? `Published all pending customizations for ${fresh.tableLogicalName}.`
          : `Saved ${fresh.formName}. Not published yet; users see it after the table is published.`,
      outcomes
    };
  };

  try {
    if (request.action === 'list_forms') {
      const table = name(request.tableLogicalName);
      const types = Object.keys(formTypes)
        .map((type) => `type eq ${type}`)
        .join(' or ');
      const filter = `objecttypecode eq '${table}' and (${types})`;
      const result = await api(
        `systemforms?$select=formid,name,description,type,isdefault,ismanaged,iscustomizable,formactivationstate&$filter=${encodeURIComponent(filter)}&$orderby=type,name`
      );
      if (!Array.isArray(result.value)) throw new Error('Invalid Dataverse form list.');
      const forms = result.value
        .filter(object)
        .map(summary)
        .filter((v): v is FormSummary => !!v);
      return {
        ok: true,
        action: request.action,
        forms: forms.slice(0, 100),
        ...(forms.length > 100 || result['@odata.nextLink'] ? { moreForms: true } : {})
      };
    }

    if (request.action === 'get_form_definition') {
      const table = name(request.tableLogicalName);
      const formId = guid(request.formId);
      const languageCode =
        typeof request.languageCode === 'number' && Number.isInteger(request.languageCode)
          ? request.languageCode
          : undefined;
      const form = await readForm(table, formId, false);
      const { description: _description, ...rest } = form.formSummary;
      const formDefinition: FormDefinition = {
        ...rest,
        tableLogicalName: table,
        source: form.source,
        revision: await sha256(form.xml),
        ...project(parse(form.xml), languageCode)
      };
      return { ok: true, action: request.action, formDefinition };
    }

    if (request.action === 'prepare_form_change') {
      const { afterXml: _afterXml, ...formChange } = await prepare(request.plan);
      return { ok: true, action: request.action, formChange };
    }

    if (request.action === 'execute_form_change')
      return {
        ok: true,
        action: request.action,
        formChangeResult: await execute(request.change)
      };

    return {
      ok: false,
      action: (request as FormPrimitiveRequest).action,
      error: 'Unsupported form action.'
    };
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
