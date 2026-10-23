# Oddy

Oddy is a Chrome Manifest V3 side-panel navigator that reads the active Microsoft Dataverse/model-driven app context and sends user-approved context to an Azure OpenAI deployment.

## MVP features

- Detects the active Dataverse environment, table, record, form, and available form fields
- Reads `Xrm.Page` form context across accessible app frames when available
- Falls back to the Dataverse Web API using the existing signed-in browser session
- Provides quick actions for record summaries, next steps, field explanations, and FetchXML drafting
- Gives Azure OpenAI seven composable primitives for schema resolution, structured record queries, relationship discovery, personal-view management, view execution, record-change previews, and navigation
- Uses a shared structured query model for filters, selected columns, sorting, row limits, view FetchXML, and grid layouts
- Resolves table and column display names to logical metadata at runtime
- Composes multi-step workflows such as finding a named contact, discovering its invoice relationship, creating `AI Result`, navigating to it, and opening its first sorted record
- Can navigate the active tab to a general list, personal/system view, or specific record
- Enables the side panel only for Dataverse tabs and disables it on other sites
- Sends messages with Enter and inserts a new line with Shift+Enter
- Requires field-level preview and explicit user approval before any business-record create or update
- Refreshes the matching open form or list after approved writes, while protecting forms with other unsaved changes
- Includes recent conversation turns and authoritative tool-audit details for follow-up requests
- Shows the selected record payload and reports which primitives were executed
- Supports permanent field exclusions by logical name
- Calls Azure OpenAI from the extension background service worker
- Stores settings and the API key in `chrome.storage.local` (never sync storage)

## Development

Requirements: Node.js 20+ and Chrome 116+.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run typecheck
npm test
npm run build
```

The unpacked extension is generated at:

```text
.output/chrome-mv3
```

Load it from `chrome://extensions`:

1. Enable **Developer mode**.
2. Select **Load unpacked**.
3. Choose `.output/chrome-mv3`.
4. Open a Dataverse model-driven app and click the extension action.
5. Open extension settings and configure Azure OpenAI.

## Azure OpenAI settings

Enter:

- Base endpoint, such as `https://your-resource.openai.azure.com`
- Deployment name (not merely the underlying model name)
- API version
- API key
- Optional system prompt and temperature

Supported endpoint domains:

- `*.openai.azure.com`
- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`

Standard prompts use the Azure deployment chat-completions route:

```text
/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}
```

Tool-enabled prompts use the Azure OpenAI Responses API so reasoning models can call functions:

```text
/openai/v1/responses
```

## Security and privacy

An API key stored in a browser extension cannot be considered fully secret. This direct-call mode is intended for personal development and controlled internal evaluation.

Before production/team distribution, use an authenticated backend with Microsoft Entra ID and preferably managed identity. The backend should enforce authorization, rate limits, auditing, data-loss-prevention rules, and approved model deployments.

The extension:

- Stores the key only in local extension storage
- Does not send data until the user submits a prompt
- Allows record context, related-record queries, personal-view updates, record-change previews, and navigation tools to be disabled per request
- Shows the selected active-record payload before sending and labels dynamic related-record queries in responses
- Allows individual fields to be deselected
- Supports an always-excluded logical-field list
- Does not persist chat transcripts
- Never exposes the mutation-execution capability to the model; Azure OpenAI can only prepare a proposal
- Executes only fields selected in the approval card and uses Dataverse optimistic concurrency for updates

## Project structure

```text
entrypoints/
  background.ts          Azure OpenAI calls and active-tab inspection
  content.ts             Detects model-driven app navigation
  options/                Azure OpenAI and privacy settings
  sidepanel/              Main assistant interface
lib/
  azure-openai.ts         Provider adapter
  dataverse-context.ts    URL, Xrm, and Dataverse Web API context extraction
  dataverse-primitives.ts Shared structured schema/query/relationship/view/mutation executor
  prompts.ts              Prompt/context construction
  storage.ts              Local settings storage
  types.ts                Shared contracts
tests/                    Unit tests
```

## Current limitations

- Form-field extraction first uses the legacy-compatible `Xrm.Page` surface across app frames, then falls back to the Dataverse Web API for existing records.
- Web API fallback labels are derived from logical names; localized Dataverse display-name metadata is not loaded yet.
- Relationship discovery currently supports direct one-to-many and many-to-one metadata. Many-to-many and indirect paths are not supported yet.
- Related-table display-name resolution may require loading the environment's table catalog when a logical name is not known.
- Conversation history is limited to the eight most recent visible turns and is not persisted after the side panel closes.
- Opening a filtered native list requires permission to create or update personal views (`userquery`). Navigation uses `Xrm.Navigation.navigateTo` first and verifies the requested destination; if an app shell ignores the view ID or the API is unavailable, Oddy falls back to the documented `main.aspx` entity-list URL with personal-view type code `4230`.
- Personal-view primitives are locked to the name `AI Result`. For each target table, the executor reuses the oldest matching view and updates it instead of creating another. Existing duplicates are left untouched.
- Structured queries and view layouts require requested columns to be readable and resolvable from the target table's localized metadata.
- Approved business-record writes currently support scalar text, number, boolean, date/choice, and null values. Lookup, owner/customer, party-list, and multi-select updates are not yet supported.
- The selected Azure OpenAI deployment and resource region must support the Responses API for related-record tools.
- Only API-key authentication is implemented for the initial Azure OpenAI provider.

## Suggested next milestones

1. Add lookup, owner/customer, party-list, and multi-select mutation support.
2. Add many-to-many and indirect relationship traversal.
3. Add richer structured filter groups (`and`/`or`) and linked-entity queries.
4. Replace direct API-key calls with an Entra-authenticated backend.
5. Add environment-specific policies and administrator-managed settings.
