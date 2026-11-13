import type {
  FormControl,
  FormControlKind,
  FormDefinition,
  FormEventSummary,
  FormPrimitiveRequest,
  FormPrimitiveResult,
  FormSection,
  FormSummary,
  FormTab,
  FormTypeName
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
  const guid = (v: unknown): string => {
    const value = typeof v === 'string' ? v.replace(/^\{|\}$/g, '') : '';
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
      throw new Error('Invalid form ID.');
    return value.toLowerCase();
  };
  // Main, quick view, quick create, and card forms. Dashboards and legacy types are excluded.
  const formTypes: Record<number, FormTypeName> = {
    2: 'main',
    6: 'quickView',
    7: 'quickCreate',
    11: 'card'
  };
  const maximumBytes = 4 * 1024 * 1024;

  const api = async (path: string): Promise<Obj> => {
    let response: Response;
    try {
      response = await fetch(`${request.origin}/api/data/v9.2/${path}`, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json',
          'OData-Version': '4.0',
          'OData-MaxVersion': '4.0',
          Prefer: 'odata.include-annotations="*"'
        }
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new Error('Dataverse did not respond within 30 seconds.');
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
        { status: response.status }
      );
    const result: unknown = content ? JSON.parse(content) : {};
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

  const parseFormXml = (xml: string, languageCode?: number) => {
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const root = document.documentElement;
    if (!root || root.nodeName !== 'form' || document.getElementsByTagName('parsererror').length)
      throw new Error('The form XML could not be parsed.');
    const children = (element: Element | null | undefined, tag: string): Element[] =>
      element ? Array.from(element.children).filter((child) => child.nodeName === tag) : [];
    const child = (element: Element | null | undefined, tag: string) => children(element, tag)[0];
    const bool = (element: Element, attribute: string, fallback: boolean) => {
      const value = element.getAttribute(attribute);
      return value == null ? fallback : value.toLowerCase() === 'true';
    };
    const label = (element: Element): string | undefined => {
      const labels = children(child(element, 'labels'), 'label');
      const match =
        labels.find((l) => Number(l.getAttribute('languagecode')) === languageCode) ?? labels[0];
      return match?.getAttribute('description') ?? undefined;
    };
    const optional = <K extends string>(key: K, value: string | null | undefined) =>
      value ? ({ [key]: value } as Record<K, string>) : {};

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
        ...optional('label', label(cell)),
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
      ...optional('label', label(tab)),
      showLabel: bool(tab, 'showlabel', true),
      visible: bool(tab, 'visible', true),
      expanded: bool(tab, 'expanded', true),
      sections: children(child(tab, 'columns'), 'column').flatMap((column, tabColumn) =>
        children(child(column, 'sections'), 'section').map((section): FormSection => ({
          ...optional('name', section.getAttribute('name')),
          ...optional('label', label(section)),
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
      let row: Obj;
      let source: FormDefinition['source'] = 'unpublished';
      try {
        // Latest saved definition, including edits not yet published by any maker.
        row = await api(`systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 400 && status !== 404 && status !== 501) throw error;
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
      const { description: _description, ...rest } = formSummary;
      const formDefinition: FormDefinition = {
        ...rest,
        tableLogicalName: table,
        source,
        revision: await sha256(row.formxml),
        ...parseFormXml(row.formxml, languageCode)
      };
      return { ok: true, action: request.action, formDefinition };
    }

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
