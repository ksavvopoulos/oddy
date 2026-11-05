# Oddy

![Oddy the raven](public/icons/128.png)

**Your Dataverse Raven.**

Oddy is a Chrome Manifest V3 side-panel assistant for Dataverse data and Power Automate flows. It reads the active Dataverse/model-driven app context, sends user-approved context to Azure OpenAI, and keeps you in control of changes.

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
- Gives Azure OpenAI composable schema/query/navigation tools, native cloud-flow definition tools, and preparation-only bulk-job tools, without exposing write execution
- Lists modern cloud flows and existing Dataverse connection references, reads complete saved definitions, opens exact flows in Power Automate, and prepares approval-gated creates or general edits
- Creates and edits native Power Automate definitions, including conditions, loops, branches, expressions, and existing connectors; new flows remain Off
- Executes native FetchXML reads and preserves complete native FetchXML/grid layouts for `AI Result` views, including nested filters, IN lists, joins, aliases, and aggregates
- Resolves table and column display names to logical metadata at runtime, including valid target tables for lookup columns
- Composes multi-step workflows such as finding a named contact, discovering its invoice relationship, creating `AI Result`, navigating to it, and opening its first sorted record
- Can navigate the active tab to a general list, personal/system view, or specific record
- Keeps one shared side panel per browser window so chats survive tab switches, including opening Power Automate; Dataverse tools remain restricted to active Dataverse pages
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

The raven mascot lives in `public/icons/oddy.svg`, shared by the side panel, settings, and favicon. After editing it, run `npm run icons` to regenerate all Chrome PNG icons. `npm run icons:check` and the branding tests verify that the PNGs match the vector source.

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

## Releases

GitHub Actions checks every pull request to `main` and every push to `main`. Pushing an **annotated** stable version tag such as `v0.13.2` runs the release workflow. It checks the tag against the exact commit, `package.json`, both lockfile root versions, the built manifest, and the manifest inside the ZIP. Only commits already on `main` can be released.

After all checks pass, the workflow publishes a GitHub release with generated notes, `oddy-X.Y.Z-chrome.zip`, and `SHA256SUMS`. It uses the built-in `GITHUB_TOKEN`; no personal access token or store credentials are needed. It does **not** publish to the Chrome Web Store.

To ship a new version:

```bash
# Start on main with the intended changes committed.
npm version 0.13.3 --no-git-tag-version
npm run check
git add package.json package-lock.json
git commit -m "Bump version to 0.13.3"
git tag -a v0.13.3 -m "Oddy 0.13.3"
git push origin main
git push origin v0.13.3
```

For the first `v0.13.2` release, do not bump again: commit and push the automation first, then tag that commit. A tag on an older commit without the workflow will not run this automation. Use `npm run release:verify -- --tag v0.13.2 --manifest .output/chrome-mv3/manifest.json` for a local version check; add `--require-tag` to check the actual annotated tag and clean working tree too.

Never move a published tag or replace its assets. Existing releases cause publication to fail instead of being overwritten. If uploading fails, an unpublished draft may remain; inspect it before manual recovery. Do not delete or replace a published release to retry. Enable **release immutability** in GitHub repository settings and a tag ruleset blocking updates/deletions of `v*` for server-enforced protection; workflow permissions cannot enforce that repository policy themselves.

To install a release, download and extract the Chrome ZIP, then choose the extracted folder with **Load unpacked** at `chrome://extensions`. To verify its checksum, download `SHA256SUMS` beside the ZIP and run `sha256sum --check SHA256SUMS` (or compare with PowerShell `Get-FileHash -Algorithm SHA256`).

## Azure OpenAI settings

New settings default to deployment `gpt-6.1-sol` and temperature `1.0`. Existing saved values are preserved. The deployment name must match a deployment in your Azure resource.

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

## Native record queries and personal views

`query_dataverse_records` accepts complete FetchXML, not a reduced structured filter language. Oddy can use native operators, nested AND/OR groups, IN lists, linked tables, aliases, distinct results, and aggregates. Resolve logical names first and select the primary key when record identity is needed. Multiple known IDs should normally use one IN query, not one tool call per ID.

Each read returns one page (default 50, maximum 100 rows), `recordPage.completeness`, and an opaque `recordPage.nextCursor`. Continue that cursor unchanged with other query arguments null. Server paging cookies are used when supplied; queries without cookies use simple paging with a disclosed 50,000-row ceiling. Distinct paging requires deterministic ordering. A cursor retains the query, not a database snapshot. Missing rows may be inaccessible, and interrupted or top-limited reads are not exhaustive results. There is no automatic extra count query; request a count in FetchXML if needed and heed server count-limit warnings.

`manage_dataverse_view` gets or saves only the existing managed `AI Result` personal view. Reads return its original FetchXML, layout XML, and ETag without flattening filters or joins. Saves require complete native definitions, with the exact returned ETag for updates (null for creation); concurrent changes fail without retry. Unrelated view fields are not overwritten. `execute_dataverse_view` pages the native definition without rewriting its selection or sort semantics.

Native execution remains environment-bound and read-only except for the explicitly exposed `AI Result` save. It accepts no arbitrary URL, HTTP method, headers, or batch operations. Each HTTP response is bounded to 1 MiB and each request to 30 seconds; XML and cursor sizes are bounded, DTD/entity declarations are rejected, and redirects are refused. Long queries use one constructed read-only GET inside `$batch`, within Dataverse URL limits. Full query semantics and permissions remain Dataverse responsibilities. Bulk jobs retain their separate validated structured selection and approval pipeline.

## Switching browser tabs

Oddy's conversation stays open when you move between tabs in the same window. On Power Automate, the panel explains that data/flow tools require returning to the Dataverse tab; it does not treat the designer as a Dataverse page or silently use another tab for writes. Pending data approvals are unavailable until a Dataverse page is active again. General conversation and local custom-skill management remain available without Dataverse context. No Power Automate scripting permission is required.

A tab that is still opening or has no readable URL produces a passive context notice, not a missing-tab error. Context reads are scoped to the panel's own browser window, and stale replies cannot reactivate tools for a previous tab. Local history remains associated with the Dataverse request, not the designer opened afterward. Closing/reloading the panel can still end the live session; optional conversation history provides read-only restoration, not automatic execution.

## Cloud-flow workflows

Oddy manages modern cloud flows through the signed-in Dataverse `workflows` Web API. Creation and editing use the same native definition format: a name, description, and complete `clientdata` JSON document. There is no separate Oddy flow language, compiler, or ownership requirement. For existing unmanaged flows, Oddy reads the latest saved definition and row version and preserves unrelated content when preparing changes for explicit approval.

Definitions support triggers, conditions, loops, parallel branches, nested actions, expressions, and existing connectors. Oddy checks nested action structure and dependencies, verifies new/changed connection references against Dataverse, and checks static Dataverse table/column names and basic literal types in changed connector nodes. Webhook triggers require logical table names such as `contact`; actions require entity-set names such as `contacts`. Unrelated existing nodes and legacy metadata are preserved, not regenerated. Dynamic bindings, lookup targets, full connector schemas, and expression semantics still need review and validation in Power Automate. Approval shows the complete new definition for creates, or changed JSON paths and complete before/after documents for updates. Creates go to the default solution and remain **Off**. Updates require the exact workflow ID and ETag. Managed flows and malformed, over-1-MB, over-1,000-node, or over-50-level definitions remain inspection-only. Oddy can open an exact flow directly in Power Automate.

### Finding flows by trigger

The existing `list_dataverse_flows` tool supports structured name/state/managed filters, sorting, page size, and an opaque continuation cursor. It can also inspect native definition JSON for an exact Dataverse row-trigger table and create/update/delete event. Resolve the table's logical name first; a flow name or an action mentioning vouchers is not evidence of a voucher-creation trigger. Combined change types match each subscribed event. The result includes trigger conditions, row filters, scope, and definition version without exposing unrelated action data.

For “Which enabled flows trigger when a voucher is created?”, use **published** definitions and runtime state **activated**. **Latest** scope (the default for general listing) includes saved drafts for editing. Runtime state `draft` means **Off**; it is separate from definition version `unpublished`. Neither published trigger configuration nor On state proves that a particular voucher actually caused a run. Run-history and indirect child-flow invocation analysis are not supported.

Paging uses `odata.maxpagesize` and Dataverse's unchanged `@odata.nextLink`, not a 50-flow `$top` cap. Page size counts candidate rows before JSON matching: an empty result can still have another page. Defaults are 100 candidates for trigger searches, otherwise 20; the maximum is 100 per page. Oddy must continue `nextCursor` and aggregate per-page results and inspection issues before claiming completeness. Cursors retain filters, order, page size, environment, and definition scope; continue with other arguments null. Missing, malformed, dynamic, or unsupported triggers are disclosed as inconclusive rather than silently treated as nonmatches. Coverage is limited to accessible solution-aware flows, and the existing assistant tool-call budget still applies. An interrupted scan is not an exhaustive result. Queries are read-only and need no change approval.

### Saving existing flow drafts

Flow updates read the latest unpublished definition with `MSCRM.IncludeUnpublished: true` and save using `MSCRM.AsUnpublished: true` plus the exact captured ETag. The approval explicitly authorizes **Save cloud-flow draft**, not publication or activation. Existing published automation is not intentionally changed; publish separately in Power Automate after review. Legacy typed previews cannot execute and must be prepared again; their saved history remains readable. There is no automatic publish, activation, deletion of drafts, or fallback retry after a save failure.

The draft-save header has limited public Microsoft documentation; validate it in a development tenant before relying on this path. Automated tests verify the request contract and approval boundaries, not server-side header behavior. If the tenant rejects the draft request, Oddy stops and reports the error rather than retrying a published update.

## Bulk workflows

Example requests:

- “For every contact whose City is Athens, set Country to Greece.”
- “For all contacts, fill my specified whole-number field with the number of related cases.” Oddy must resolve the exact case/contact lookup and clarify whether to include all cases or a filtered status scope.
- “Add all contacts created in the last 30 days to this existing static marketing list.”
- Upload a CSV or JSON array in **Bulk workspace**, then ask Oddy to create records from it. Dataset handles expose column names and row counts, not the uploaded rows. The local creation preview shows the proposed mapping and a small sample; bulk row samples are stripped from model-facing tool outputs.

The pipeline is **select → derive/map → validate → freeze → preview → approve → execute**. A related-count job groups paged source records outside the model, includes target records with zero related rows, and skips values already correct. It is a one-off calculation, not an automatically maintained counter. Counts include only records visible to the signed-in user; derived-count approval requires acknowledging that scope. Verify the user has adequate access before treating them as organization-wide totals.

Bulk record approval cards offer two independent automation options, both **off by default**: **Bypass custom plug-ins and classic workflows** and **Suppress Power Automate triggers**. Choices apply only to that approved run and are fixed across its chunks, recorded in the job/audit, and read-only in history. Fresh remaining-work previews reset them to off. Membership actions do not offer these options.

Custom-logic bypass skips custom synchronous/asynchronous plug-ins and workflows (including ISV logic), requires `prvBypassCustomBusinessLogic` (normally System Administrator), and does not bypass Microsoft system logic or security. Flow suppression prevents Dataverse-triggered flow jobs for those writes; flow owners are not notified. It does not disable flows globally, stop existing runs, or automatically suppress separate writes performed by plug-ins. Bypassing automation can skip business validation and downstream processing: coordinate follow-up with the owners. Dataverse enforces permissions; Oddy never retries without selected bypass options after a rejection. See Microsoft’s [custom-logic bypass](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bypass-custom-business-logic) and [Power Automate bypass](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bypass-power-automate-flows) documentation.

One approval covers the stored, frozen rows—not an expanding query. The executor uses at most 100 update/create operations per chunk and a conservative estimated 1 MiB payload budget; membership actions retain their separate 50-member chunk limit. Updates require optimistic-concurrency-enabled tables and captured ETags; conflicting rows stop further chunks. There is **no transaction across the whole job**. Stop, conflict, throttle, or communication failure leaves prior successful writes intact. Use **Prepare remaining-work preview** to reconcile actual state and approve only unfinished work. Creates retain their reserved IDs and never silently become upserts. Remaining-work previews retain original derived-count values; ask for a new count job to recalculate them.

Keep the side panel open and the signed-in Dataverse tab active while execution runs. Checkpoints survive worker/panel interruption, but jobs never restart from history or workspace inspection. This is not an unattended server-side job runner.

### Initial bulk limits

- 100,000 selected target rows or uploaded source rows; up to 1,000,000 source/membership rows scanned.
- A two-minute preparation budget; oversized/slow/incomplete selections fail instead of becoming truncated approvals.
- Up to 20 local jobs and five datasets; delete individual unrelated jobs/files in Bulk workspace to free space without losing another job's recovery evidence. Files/cell data are bounded to 25 MiB, with 20 writable fields per row.
- Approval authority expires after one hour. Full job rows/datasets have a 24-hour cleanup policy, enforced on workspace use; closed-browser data remains until cleanup or explicit deletion. Compact chat previews/audits follow normal conversation-history retention.
- Upload cells must be scalar JSON values or CSV text. Creates currently support explicit scalar/Choice mappings; per-row lookup mappings and executable expressions are not supported. Empty CSV cells stay empty strings; use JSON `null` explicitly. Bulk DateTime inputs require ISO timestamps with UTC or an explicit offset.
- Native `CreateMultiple`/`UpdateMultiple` optimization and a server-hosted runner are future adapters, not capabilities assumed for every table. Conditional `$batch` updates deliberately preserve row-version protection.

## Privacy policy website

The policy source is [docs/privacy.md](docs/privacy.md). A small static site is built with `npm run site:build` into `.output/site`; only the homepage and privacy policy are published, not other repository files or store screenshots.

To publish it:

1. In GitHub repository **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. This one-time repository setting must be enabled by a maintainer; the workflow does not enable it with a personal access token.
2. Commit and push the policy/site/workflow changes to `main`. The **Privacy site** workflow deploys automatically when its inputs change. If Pages was enabled after the push, use **Actions → Privacy site → Run workflow** on `main`.
3. Verify the public page opens without signing in, then enter `https://ksavvopoulos.github.io/oddy/privacy/` in the Chrome Web Store privacy-policy URL field. The URL is not live until a successful Pages deployment.

Policy-only changes do not require a new extension release tag. Review the policy whenever data handling changes; its statements and the Chrome Web Store disclosures must agree with the shipped extension.

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
  flows/                  Native definition/proposal contracts and approval diffs
  dataverse-primitives.ts Self-contained signed-session page executor
  dataverse-flow-primitives.ts Self-contained flow reader/validator/executor
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
- Native record/view tools use logical names and complete XML definitions. Dataverse validates operators, columns, joins, aliases, layout semantics, and signed-in access; schema discovery helps Oddy construct definitions. Internal bulk selections retain their validated structured model.
- Approved business-record writes support scalar text, number, boolean, date, null, Choice/State/Status labels resolved through option metadata, and single-record Lookup, Owner, and Customer values. Lookup targets are validated through metadata and written with the resolved Dataverse navigation property. Clearing lookups, party-list fields, and multi-select updates are not yet supported.
- Cloud-flow creates and updates use complete native definitions with explicit approval. Validation checks graph structure, relevant connection references, and static Dataverse metadata, not full Power Automate schemas or expression semantics. Review and validate in Power Automate before publishing. Managed flows, solution selection, publication, activation/deactivation, deletion, sharing, and connection creation are not supported.
- Marketing-list membership is limited to static lists and one member table per job. Query-backed jobs page all matching accounts, contacts, or leads within the stated bulk limits; the explicit-ID tool retains its 50-member limit. Dynamic-list membership remains query-driven.
- User time-zone settings use documented `usersettingscollection`, `timezonedefinitions`, and `LocalTimeFromUtcTime` reads. If these are denied, the current Xrm user offset can provide a clearly labeled fallback; it is not a historical/future daylight-saving rule. Browser settings are never silently substituted for Dataverse user settings.
- The selected Azure OpenAI deployment and resource region must support the Responses API for related-record tools.
- Only API-key authentication is implemented for the initial Azure OpenAI provider.

## Suggested next milestones

1. Add lookup clearing, party-list, and multi-select mutation support.
2. Add many-to-many and indirect relationship traversal.
3. Extend native query integration into bulk selection only after reviewing frozen-scope approval and reconciliation guarantees.
4. Replace direct API-key calls with an Entra-authenticated backend.
5. Add environment-specific policies and administrator-managed settings.

## License

Licensed under the [MIT License](LICENSE). Copyright (c) 2026 Kostas Savvopoulos.

Third-party dependencies retain their respective licenses.
