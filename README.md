# Oddy

Oddy is a Chrome Manifest V3 side-panel navigator that reads the active Microsoft Dataverse/model-driven app context and sends user-approved context to an Azure OpenAI deployment.

## MVP features

- Detects the active Dataverse environment, table, record, form, and available form fields
- Reads `Xrm.Page` form context across accessible app frames when available
- Falls back to the Dataverse Web API using the existing signed-in browser session
- Provides bundled workflow skills for creating marketing lists and adding matching accounts, contacts, or leads
- Lets users create, enable, disable, and export local workflow skills from extension settings
- Can inspect custom skills and prepare create, update, or delete proposals when explicitly allowed, with an atomic approval preview before local storage changes
- Protects skill edits with revision checks and keeps bundled skills immutable
- Restricts each active skill to its declared Dataverse tools and validates required inputs before execution
- Exports standard `SKILL.md` instructions alongside an Oddy workflow JSON definition
- Gives Azure OpenAI composable schema/query/navigation tools, typed cloud-flow primitives, and preparation-only bulk-job tools, without exposing write execution
- Lists modern cloud flows and existing Dataverse connection references, reads complete saved definitions, opens exact flows in Power Automate, and prepares approval-gated creates or general edits
- Creates Dataverse-only flows from a constrained graph of manual/row triggers and sequential list/get/add/update-row actions; new flows remain Off by default
- Uses a shared structured query model for filters, selected columns, sorting, row limits, view FetchXML, and grid layouts
- Resolves table and column display names to logical metadata at runtime, including valid target tables for lookup columns
- Composes multi-step workflows such as finding a named contact, discovering its invoice relationship, creating `AI Result`, navigating to it, and opening its first sorted record
- Can navigate the active tab to a general list, personal/system view, or specific record
- Enables the side panel only for Dataverse tabs and disables it on other sites
- Sends messages with Enter and inserts a new line with Shift+Enter
- Requires field-level previews for single-record changes and frozen-scope previews for bulk jobs, followed by explicit approval before writes
- Supports query-backed bulk updates, related-record counts (including zero), uploaded-dataset creates, and static marketing-list membership across thousands of records
- Keeps selections, source datasets, before-images, row outcomes, and approval-row samples outside model context; the model receives job metadata/counts, while full previews stay local
- Uses conditional Web API `$batch` requests for bulk updates, reserved-ID `$batch` creates, and tenant-validated `AddListMembersList` membership chunks; the existing small explicit-ID membership tool remains available
- Shows job progress, local paginated inspection, stop-after-chunk controls, and fresh remaining-work previews that reconcile uncertain outcomes rather than replaying writes
- Refreshes the matching open form or list after approved writes, while protecting forms with other unsaved changes
- Includes recent conversation turns, tool calls, and approved execution successes or failures as authoritative audit details for follow-up requests
- Automatically resumes unfinished live requests after successful record, cloud-flow, membership, or completed bulk-job approvals, using the original intent and exact saved IDs; every additional write needs fresh approval
- Reads the signed-in Dataverse user's time-zone code, named zone, local date/time, and locale settings automatically; server conversion applies daylight-saving rules
- Supplies an exact rolling UTC 30-day interval and distinguishes Dataverse user settings from browser settings, without asking for today’s date
- Provides opt-in local conversation history using IndexedDB, with resume, individual deletion, clear-all, retention, and count limits
- Restores historical approval cards as read-only and requires fresh previews before any resumed write
- Shows the selected record payload and reports which primitives were executed
- Supports permanent field exclusions by logical name
- Calls Azure OpenAI from the extension background service worker
- Stores settings and the API key in `chrome.storage.local` (never sync storage)

## Development

Requirements: Node.js 22 recommended (20 also supported) and Chrome 116+.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run check
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

## Cloud-flow workflows

Oddy manages modern cloud flows through the signed-in Dataverse `workflows` Web API. New flows use a typed Dataverse-only graph: Oddy resolves metadata, validates an existing connection reference, compiles the definition, and shows the complete trigger/action specification before approval. Existing unmanaged flows support general definition edits, regardless of who created them. Oddy reads their complete saved `clientdata` and row version, then proposes a revised definition for explicit approval.

The first version supports manual or Dataverse row create/update/delete triggers and sequential Dataverse list/get/add/update-row actions. Trigger definitions use Dataverse logical table names such as `contact`, while connector actions are compiled with the required entity-set names such as `contacts`. Oddy can resolve the current Power Platform environment through Dataverse and open an exact workflow ID directly in a new Power Automate designer tab. Creates go to the environment's default solution and remain **Off**. Updates require an exact workflow ID and ETag. General edits support triggers, conditions, loops, parallel branches, nested actions, expressions, and existing connectors without an Oddy ownership marker. Approval shows every changed JSON path and expandable complete before/after definitions, including connection references. Unrelated content must be preserved. General edits receive structural checks, not full connector/expression validation; review and validate in Power Automate before publishing. Managed flows and missing, malformed, or over-1-MB definitions remain inspection-only.

### Saving existing flow drafts

Flow updates read the latest unpublished definition with `MSCRM.IncludeUnpublished: true` and save using `MSCRM.AsUnpublished: true` plus the exact captured ETag. The approval explicitly authorizes **Save cloud-flow draft**, not publication or activation. Existing published automation is not intentionally changed; publish separately in Power Automate after review. Older update previews must be prepared again. There is no automatic publish, activation, deletion of drafts, or fallback retry after a save failure.

The draft-save header has limited public Microsoft documentation; validate it in a development tenant before relying on this path. Automated tests verify the request contract and approval boundaries, not server-side header behavior. If the tenant rejects the draft request, Oddy stops and reports the error rather than retrying a published update.

## Bulk workflows

Example requests:

- “For every contact whose City is Athens, set Country to Greece.”
- “For all contacts, fill my specified whole-number field with the number of related cases.” Oddy must resolve the exact case/contact lookup and clarify whether to include all cases or a filtered status scope.
- “Add all contacts created in the last 30 days to this existing static marketing list.”
- Upload a CSV or JSON array in **Bulk workspace**, then ask Oddy to create records from it. Dataset handles expose column names and row counts, not the uploaded rows. The local creation preview shows the proposed mapping and a small sample; bulk row samples are stripped from model-facing tool outputs.

The pipeline is **select → derive/map → validate → freeze → preview → approve → execute**. A related-count job groups paged source records outside the model, includes target records with zero related rows, and skips values already correct. It is a one-off calculation, not an automatically maintained counter. Counts include only records visible to the signed-in user; derived-count approval requires acknowledging that scope. Verify the user has adequate access before treating them as organization-wide totals.

One approval covers the stored, frozen rows—not an expanding query. The first executor uses at most 50 operations per chunk and a conservative estimated 1 MiB payload budget. Updates require optimistic-concurrency-enabled tables and captured ETags; conflicting rows stop further chunks. There is **no transaction across the whole job**. Stop, conflict, throttle, or communication failure leaves prior successful writes intact. Use **Prepare remaining-work preview** to reconcile actual state and approve only unfinished work. Creates retain their reserved IDs and never silently become upserts. Remaining-work previews retain original derived-count values; ask for a new count job to recalculate them.

Keep the side panel open and the signed-in Dataverse tab active while execution runs. Checkpoints survive worker/panel interruption, but jobs never restart from history or workspace inspection. This is not an unattended server-side job runner.

### Initial bulk limits

- 100,000 selected target rows or uploaded source rows; up to 1,000,000 source/membership rows scanned.
- A two-minute preparation budget; oversized/slow/incomplete selections fail instead of becoming truncated approvals.
- Up to 20 local jobs and five datasets; delete individual unrelated jobs/files in Bulk workspace to free space without losing another job's recovery evidence. Files/cell data are bounded to 25 MiB, with 20 writable fields per row.
- Approval authority expires after one hour. Full job rows/datasets have a 24-hour cleanup policy, enforced on workspace use; closed-browser data remains until cleanup or explicit deletion. Compact chat previews/audits follow normal conversation-history retention.
- Upload cells must be scalar JSON values or CSV text. Creates currently support explicit scalar/Choice mappings; per-row lookup mappings and executable expressions are not supported. Empty CSV cells stay empty strings; use JSON `null` explicitly. Bulk DateTime inputs require ISO timestamps with UTC or an explicit offset.
- Native `CreateMultiple`/`UpdateMultiple` optimization and a server-hosted runner are future adapters, not capabilities assumed for every table. Conditional `$batch` updates deliberately preserve row-version protection.

## Security and privacy

An API key stored in a browser extension cannot be considered fully secret. This direct-call mode is intended for personal development and controlled internal evaluation.

Before production/team distribution, use an authenticated backend with Microsoft Entra ID and preferably managed identity. The backend should enforce authorization, rate limits, auditing, data-loss-prevention rules, and approved model deployments.

The extension:

- Stores the key only in local extension storage
- Does not send record context to Azure OpenAI until the user submits a prompt
- Allows record context, related-record queries, cloud-flow inspection/previews, personal-view updates, record-change previews, and navigation tools to be disabled per request
- Shows the selected active-record payload before sending and labels dynamic related-record queries in responses
- Allows individual fields to be deselected
- Supports an always-excluded logical-field list
- Persists chat transcripts only when local history is explicitly enabled; saved history stays in the current Chrome profile and can be deleted at any time
- Stores necessary bulk rows/datasets/checkpoints locally even when chat history is off, without independent encryption; Bulk workspace can clear them explicitly, but deletion does not undo Dataverse writes and removes recovery evidence
- Never exposes Dataverse mutation, cloud-flow definition writes, marketing-list membership, or custom-skill change execution to the model; Azure OpenAI can only prepare proposals
- Executes only fields selected in the record approval card and uses Dataverse optimistic concurrency for updates
- Records approval execution outcomes in the transcript so Oddy can diagnose failures and prepare a fresh corrected preview
- Revalidates static-list status, member type, record existence, existing membership, and the tenant's `AddListMembersList` metadata immediately before execution
- Applies custom-skill changes only after approval and rejects stale previews when the underlying skill has changed

## Project structure

```text
entrypoints/
  background.ts           Chrome listeners and message routing
  content.ts              Detects model-driven app navigation
  options/                Azure OpenAI, privacy, history, and skill settings
  sidepanel/              UI composition, transcript cards, approval adapters
lib/
  assistant/              Tool catalog, argument parsing, dispatch, audits, model loop
  browser/                Active-tab context, navigation, injection, refresh
  bulk/                   Strict plans, dataset parsing, local jobs, derived counts, transport, recovery
  dataverse/              Primitive request/result and metadata contracts
  flows/                  Typed cloud-flow graph, proposal, and execution contracts
  dataverse-primitives.ts Self-contained signed-session page executor
  dataverse-flow-primitives.ts Self-contained cloud-flow reader/compiler/executor
  approvals.ts            Shared approval rules and synchronous execution lock
  approval-continuation.ts Request-scoped post-approval continuation guards
  conversation-model.ts   Transcript contracts, restoration, authoritative history
  conversations.ts        IndexedDB repository and atomic save/pruning
  history-policy.ts       Shared retention/default/limit policy
  azure-openai.ts         Provider adapter
  dataverse-context.ts    URL, Xrm, and Web API context extraction
  dataverse-user-context.ts Signed-in user time-zone/locale lookup and server time conversion
  prompts.ts              Prompt/context construction
  skills.ts               Built-in and custom workflows, validation/storage/export
  storage.ts              Local settings storage
  types.ts                Shared extension contracts
tests/                    Unit, boundary, rendering, and IndexedDB tests
```

See [Architecture and contributor guide](docs/architecture.md) for execution boundaries, the tool-extension checklist, test seams, and manual smoke tests.

Development commands:

- `npm run test:watch` — fast feedback while changing one area
- `npm run format` — consistent TypeScript/JSX, documentation, and config formatting
- `npm run check` — run formatting, strict typecheck, tests, and the production build locally before pushing

## Current limitations

- Form-field extraction first uses the legacy-compatible `Xrm.Page` surface across app frames, then falls back to the Dataverse Web API for existing records.
- Web API fallback labels are derived from logical names; localized Dataverse display-name metadata is not loaded yet.
- Relationship discovery currently supports direct one-to-many and many-to-one metadata. Many-to-many and indirect paths are not supported yet.
- Related-table display-name resolution may require loading the environment's table catalog when a logical name is not known.
- Only the eight most recent visible turns are sent to Azure OpenAI for a request. Automatic approval continuations also include the original request and the approved execution outcome so IDs and intent are not lost. When local history is enabled, the full visible transcript remains available locally for browsing and resuming.
- Automatic continuation applies only to successful live business-record, cloud-flow, membership, or fully completed bulk-job approvals. It stops on failure, rejection, changed environment, revoked consent, or a newer user request. Restored histories never automatically resume; ask Oddy to continue an existing task explicitly.
- Local conversation history is protected by the Chrome profile and operating-system account but is not independently encrypted by Oddy.
- Custom skills currently use a restricted, model-executed workflow: tool access and inputs are enforced by the extension, while ordered workflow instructions are followed by the model. Arbitrary scripts and imported skill packages are not supported.
- AI-assisted skill management is limited to custom skills and must be enabled per request or by default in settings. Skill changes are atomic; individual workflow fields cannot yet be selectively approved.
- Opening a filtered native list requires permission to create or update personal views (`userquery`). Navigation uses `Xrm.Navigation.navigateTo` first and verifies the requested destination; if an app shell ignores the view ID or the API is unavailable, Oddy falls back to the documented `main.aspx` entity-list URL with personal-view type code `4230`.
- Personal-view primitives are locked to the name `AI Result`. For each target table, the executor reuses the oldest matching view and updates it instead of creating another. Existing duplicates are left untouched.
- Structured queries and view layouts require requested columns to be readable and resolvable from the target table's localized metadata.
- Approved business-record writes support scalar text, number, boolean, date, null, Choice/State/Status labels resolved through option metadata, and single-record Lookup, Owner, and Customer values. Lookup targets are validated through metadata and written with the resolved Dataverse navigation property. Clearing lookups, party-list fields, and multi-select updates are not yet supported.
- Cloud-flow creation remains typed and Dataverse-only: one existing connection reference, a linear action chain, scalar literals/row outputs, and the default solution. Existing unmanaged flows support approval-gated complete definition edits, including conditions, loops, branches, expressions, and existing connectors. General edits rely on structural validation and user review, not full Power Automate schema validation. Managed flows, solution selection, publication, activation/deactivation, deletion, sharing, and connection creation are not supported.
- Marketing-list membership is limited to static lists and one member table per job. Query-backed jobs page all matching accounts, contacts, or leads within the stated bulk limits; the explicit-ID tool retains its 50-member limit. Dynamic-list membership remains query-driven.
- User time-zone settings use documented `usersettingscollection`, `timezonedefinitions`, and `LocalTimeFromUtcTime` reads. If these are denied, the current Xrm user offset can provide a clearly labeled fallback; it is not a historical/future daylight-saving rule. Browser settings are never silently substituted for Dataverse user settings.
- The selected Azure OpenAI deployment and resource region must support the Responses API for related-record tools.
- Only API-key authentication is implemented for the initial Azure OpenAI provider.

## Suggested next milestones

1. Add lookup clearing, party-list, and multi-select mutation support.
2. Add many-to-many and indirect relationship traversal.
3. Add richer structured filter groups (`and`/`or`) and linked-entity queries.
4. Replace direct API-key calls with an Entra-authenticated backend.
5. Add environment-specific policies and administrator-managed settings.
