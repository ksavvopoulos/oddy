# Oddy Privacy Policy

**Effective date: November 5, 2026**

Oddy is a browser extension that provides conversational assistance for Microsoft Dataverse and Power Automate. This policy describes the published extension's data handling and the project's privacy-policy website. The project is maintained at [github.com/ksavvopoulos/oddy](https://github.com/ksavvopoulos/oddy).

## 1. The publisher does not operate a data-collection backend

Oddy does not send your prompts, Dataverse records, API key, or conversation history to a backend operated by the Oddy publisher. Normal extension requests go to your configured Azure OpenAI resource and your signed-in Dataverse environment to provide the features you use.

This does not mean the extension handles no data. Oddy processes information locally and transfers information to those services as described below. Information you voluntarily submit to the project's support channels is a separate exception: maintainers and the support platform can receive what you choose to share.

## 2. Information the extension handles

Depending on the features you enable and the requests you make, Oddy may handle:

- **Connection settings:** your Azure endpoint, deployment name, API version, API key, system prompt, and preferences.
- **Application context:** the active page's URL and title, Dataverse environment and app identifiers, table, record and form identifiers, selected record fields, and signed-in user time-zone and locale settings. Context may be read locally when the side panel refreshes, before a prompt is submitted.
- **Conversation content:** prompts, assistant responses, relevant recent conversation turns, tool results, proposed changes, approval outcomes, and workflow-skill instructions.
- **Dataverse information:** records and relationship metadata, personal-view definitions, cloud-flow definitions and connection-reference metadata, and other information returned by enabled tools within your existing permissions.
- **Bulk-workspace information:** uploaded CSV or JSON data, dataset names and column metadata, field mappings, frozen record selections, before-images, record versions, job checkpoints, and execution results.

CRM records, uploaded files, and messages can contain names, email addresses, other personal information, communications, business or financial information, or other sensitive data. Their contents depend on your environment and requests. Do not supply information you are not authorized to process, and avoid including sensitive information that is unnecessary for the task.

Oddy inspects the active page to provide application context and navigation. It does not build general browsing-history profiles or implement general click, mouse-movement, or keystroke tracking.

## 3. How information is used and transmitted

Oddy uses information to answer your requests, identify and navigate Dataverse records, prepare proposed changes, run approved operations, provide reusable skills, and support local history and recovery.

When you submit a prompt, Oddy sends the prompt, relevant conversation context, and included record context to the Azure OpenAI endpoint you configured. If you enable Dataverse tools, additional requests can send retrieved records, schema information, flow definitions, and tool outcomes to that endpoint. Approved multi-step workflows can continue automatically with the original request and execution outcome; this can involve further AI requests.

The configured Azure API key is sent in authentication headers to that Azure endpoint. Oddy does not automatically insert it into chat prompts. Dataverse operations use the browser's existing signed-in session; Oddy does not ask you to enter a separate Dataverse password.

Bulk processing keeps uploaded row arrays and frozen job rows in the local workspace rather than automatically sending the entire dataset to the AI service. Dataset metadata, column names, counts, mappings, and compact job summaries may be included in AI tool exchanges. Values can still be transmitted if you put them in a prompt or separately request record queries that return them.

Requests to supported Azure endpoints use HTTPS. Microsoft's processing, retention, service logging, and any abuse-monitoring arrangements depend on the services and resource configuration you use. The Oddy publisher does not control or promise a particular retention period for those services. Consult your Azure and Dataverse administrator and [Microsoft's privacy statement](https://privacy.microsoft.com/privacystatement).

## 4. Local storage and retention

- **Settings and custom skills** are stored in `chrome.storage.local` in your Chrome profile. Oddy does not use Chrome Sync to synchronize them.
- **The current conversation** is held for the active session. Persistent conversation history is optional and off by default. When enabled, transcripts and approval/audit information are stored locally in IndexedDB. Default history limits are 30 days and 50 conversations; you can change these settings and delete conversations.
- **Bulk workspace data** is stored locally in a separate IndexedDB database when those features are used, even if conversation history is off. Job rows, datasets, and checkpoints have a 24-hour cleanup policy.

Retention cleanup runs during relevant extension operations, such as saving history, applying history settings, or using the bulk workspace. It is not a background deletion guarantee while the browser is closed or the extension is unused. Settings and custom skills remain until changed or removed. Browser or operating-system backups can retain separate copies outside Oddy's control.

Local data, including the API key, is **not independently encrypted by Oddy**. It relies on Chrome-profile and operating-system protections. A key stored in a browser extension should not be treated as a protected secret vault. Use an appropriately restricted Azure resource and protect your browser profile and device.

## 5. Your controls

You can:

- Choose your Azure endpoint and deployment, and replace or remove the saved API key.
- Turn record-context inclusion and Dataverse-tool access on or off for requests, inspect the included context, and deselect active-record fields.
- Configure field exclusions for automatically included active-record context. **These exclusions are not a universal access-control rule for separately requested Dataverse tool queries**, which may retrieve additional fields and records within your permissions.
- Leave persistent conversation history disabled, adjust its limits, or delete individual conversations or all saved conversations.
- Delete uploaded datasets, individual bulk jobs, or all local bulk-workspace data using the Bulk workspace controls.
- Remove the extension or use Chrome's applicable extension-data controls to remove its local data.

Deleting local history or bulk data does not delete data already sent to Azure, undo Dataverse changes, or erase copies retained by Microsoft or your organization. Deleting bulk checkpoints also removes recovery evidence for uncertain operations. Contact your service administrator about access or deletion in Azure and Dataverse.

Business-record changes, cloud-flow changes, marketing-list membership changes, and model-proposed custom-skill changes require explicit approval in Oddy. Personal AI Result views may be created or updated as part of the explicitly enabled view-management functionality.

## 6. No advertising or unrelated data use

The extension contains no advertising, behavioral-analytics service, or publisher-operated telemetry endpoint. The Oddy publisher does not sell extension user data or use it for advertising, data brokering, unrelated AI-model training, or creditworthiness or lending decisions.

Oddy's use and transfer of information obtained through browser or Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including its Limited Use requirements. Information is used and transferred to provide the extension's disclosed functionality, not for unrelated profiling or monetization. The handling of information by your configured Microsoft services remains subject to their terms and your organization's configuration.

## 7. This website and support

This privacy-policy website is hosted on GitHub Pages. It contains no added analytics, advertising, forms, or third-party JavaScript. GitHub may process visitor IP addresses and request information as part of providing hosting; see the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Visiting this site is separate from using the extension's Dataverse and Azure features.

For privacy questions, contact the maintainer through the [Oddy GitHub issue tracker](https://github.com/ksavvopoulos/oddy/issues). Public issues are visible to others. Do not post API keys, credentials, personal CRM records, or other sensitive information. If private information is needed, request a suitable private contact method before sharing it.

The publisher does not have remote access to your browser's local extension storage and cannot erase your organization's Dataverse or Azure records on your behalf.

## 8. Changes to this policy

Changes will be published on this page with an updated effective date. The [repository history](https://github.com/ksavvopoulos/oddy/commits/main/docs/privacy.md) provides a record of policy updates. Review this policy and your organization's requirements before using Oddy with sensitive or regulated data.
