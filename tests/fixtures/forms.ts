export const formOrigin = 'https://contoso.crm.dynamics.com';
export const mainFormId = '1fed44d1-ae68-4a41-bd2b-f13acac4acfa';

/** Hand-written to mirror exported main-form XML; replace with real exports when available. */
export const mainFormXml = `<form showImage="true">
  <tabs>
    <tab name="SUMMARY_TAB" id="{f8b0a1b2-0000-0000-0000-000000000001}" IsUserDefined="0" expanded="true" showlabel="true" verticallayout="true">
      <labels>
        <label description="Summary" languagecode="1033" />
        <label description="Σύνοψη" languagecode="1032" />
      </labels>
      <columns>
        <column width="34%">
          <sections>
            <section name="CONTACT_INFORMATION" showlabel="true" showbar="false" id="{f8b0a1b2-0000-0000-0000-000000000002}" columns="1">
              <labels>
                <label description="CONTACT INFORMATION" languagecode="1033" />
              </labels>
              <rows>
                <row>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000003}" showlabel="true">
                    <labels><label description="Full Name" languagecode="1033" /></labels>
                    <control id="fullname" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="fullname" disabled="false" uniqueid="{aaaaaaaa-0000-0000-0000-000000000001}" />
                  </cell>
                </row>
                <row>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000004}" showlabel="true" visible="false">
                    <labels><label description="Email" languagecode="1033" /></labels>
                    <control id="emailaddress1" classid="{ADA2203E-B4CD-49be-9DDF-234642B43B52}" datafieldname="emailaddress1" disabled="true" />
                  </cell>
                </row>
                <row>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000005}" userspacer="true" showlabel="false">
                    <labels><label description="" languagecode="1033" /></labels>
                  </cell>
                </row>
              </rows>
            </section>
          </sections>
        </column>
        <column width="66%">
          <sections>
            <section name="ORDERS" showlabel="false" visible="false" id="{f8b0a1b2-0000-0000-0000-000000000006}" columns="11">
              <labels><label description="Orders" languagecode="1033" /></labels>
              <rows>
                <row>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000007}" showlabel="true" colspan="2">
                    <labels><label description="Recent orders" languagecode="1033" /></labels>
                    <control id="orders_grid" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true">
                      <parameters>
                        <RelationshipName>contact_salesorders</RelationshipName>
                        <TargetEntityType>salesorder</TargetEntityType>
                        <ViewId>{B1D4B4A5-0000-0000-0000-000000000009}</ViewId>
                      </parameters>
                    </control>
                  </cell>
                </row>
              </rows>
            </section>
          </sections>
        </column>
      </columns>
    </tab>
    <tab name="DETAILS_TAB" id="{f8b0a1b2-0000-0000-0000-000000000010}" expanded="false" visible="false">
      <labels><label description="Details" languagecode="1033" /></labels>
      <columns>
        <column width="100%">
          <sections>
            <section name="PERSONAL" id="{f8b0a1b2-0000-0000-0000-000000000011}" columns="111">
              <labels><label description="Personal" languagecode="1033" /></labels>
              <rows>
                <row>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000012}">
                    <labels><label description="Birthday" languagecode="1033" /></labels>
                    <control id="birthdate" classid="{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}" datafieldname="birthdate" />
                  </cell>
                  <cell id="{f8b0a1b2-0000-0000-0000-000000000013}">
                    <labels><label description="Map" languagecode="1033" /></labels>
                    <control id="WebResource_map" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}" />
                  </cell>
                </row>
              </rows>
            </section>
          </sections>
        </column>
      </columns>
    </tab>
  </tabs>
  <header id="{f8b0a1b2-0000-0000-0000-000000000020}" celllabelposition="Top" columns="111">
    <rows>
      <row>
        <cell id="{f8b0a1b2-0000-0000-0000-000000000021}" showlabel="true">
          <labels><label description="Owner" languagecode="1033" /></labels>
          <control id="header_ownerid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="ownerid" disabled="false" />
        </cell>
      </row>
    </rows>
  </header>
  <events>
    <event name="onload" application="false" active="false">
      <Handlers>
        <Handler functionName="Contoso.Contact.onLoad" libraryName="contoso_/scripts/contact.js" handlerUniqueId="{11111111-0000-0000-0000-000000000001}" enabled="true" parameters="" passExecutionContext="true" />
      </Handlers>
    </event>
    <event name="onchange" application="false" active="false" attribute="emailaddress1">
      <Handlers>
        <Handler functionName="Contoso.Contact.onEmailChange" libraryName="contoso_/scripts/contact.js" handlerUniqueId="{11111111-0000-0000-0000-000000000002}" enabled="true" />
      </Handlers>
    </event>
    <event name="onsave" application="true" active="true">
      <InternalHandlers>
        <Handler functionName="Mscrm.Form_onsave" libraryName="Form_onsave.js" handlerUniqueId="{11111111-0000-0000-0000-000000000003}" enabled="true" />
      </InternalHandlers>
    </event>
  </events>
  <formLibraries>
    <Library name="contoso_/scripts/contact.js" libraryUniqueId="{22222222-0000-0000-0000-000000000001}" />
  </formLibraries>
  <controlDescriptions>
    <controlDescription forControl="{AAAAAAAA-0000-0000-0000-000000000001}">
      <customControl formFactor="0" name="Contoso.NameControl" />
    </controlDescription>
  </controlDescriptions>
  <Navigation>
    <NavBar />
  </Navigation>
</form>`;

export const mainFormRow = {
  formid: mainFormId,
  name: 'Contact',
  description: 'Main contact form',
  type: 2,
  objecttypecode: 'contact',
  isdefault: true,
  ismanaged: true,
  iscustomizable: { Value: true, CanBeChanged: false },
  formactivationstate: 1,
  formxml: mainFormXml
};

export const formListRows = [
  { ...mainFormRow, formxml: undefined },
  {
    formid: '2fed44d1-ae68-4a41-bd2b-f13acac4acfa',
    name: 'Contact Quick Create',
    type: 7,
    isdefault: false,
    ismanaged: false,
    iscustomizable: { Value: true },
    formactivationstate: 0
  }
];

export const formSolutionRow = {
  solutionid: '9a0b5f43-0000-0000-0000-000000000001',
  uniquename: 'ConsentSolution',
  friendlyname: 'Consent Solution',
  ismanaged: false
};

const attribute = (
  LogicalName: string,
  AttributeType: string,
  label: string,
  extra: Record<string, unknown> = {}
) => ({
  LogicalName,
  AttributeType,
  AttributeTypeName: { Value: `${AttributeType}Type` },
  IsValidForForm: true,
  IsPrimaryName: false,
  RequiredLevel: { Value: 'None' },
  DisplayName: {
    LocalizedLabels: [{ Label: label, LanguageCode: 1033 }],
    UserLocalizedLabel: { Label: label, LanguageCode: 1033 }
  },
  ...extra
});

export const contactAttributes = [
  attribute('fullname', 'String', 'Full Name', {
    IsPrimaryName: true,
    RequiredLevel: { Value: 'ApplicationRequired' }
  }),
  attribute('emailaddress1', 'String', 'Email'),
  attribute('birthdate', 'DateTime', 'Birthday'),
  attribute('telephone1', 'String', 'Business Phone'),
  attribute('parentcustomerid', 'Customer', 'Company Name'),
  attribute('donotbulkemail', 'Boolean', 'Do not allow Bulk Emails'),
  attribute('new_interests', 'Virtual', 'Interests', {
    AttributeTypeName: { Value: 'MultiSelectPicklistType' }
  }),
  attribute('contactid', 'Uniqueidentifier', 'Contact'),
  attribute('versionnumber', 'BigInt', 'Version Number', { IsValidForForm: false })
];

export const formEditPlan = {
  operation: 'edit_form' as const,
  solutionUniqueName: 'ConsentSolution',
  languageCode: 1033,
  tableLogicalName: 'contact',
  formId: mainFormId
};
