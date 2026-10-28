# Architecture and contributor guide

Oddy is a Manifest V3 extension with three execution environments. Keep their boundaries explicit:

1. **Extension UI**: React settings and side panel. Shows proposals and collects approval.
2. **Background worker**: receives messages, calls Azure OpenAI, selects tools, and coordinates browser operations.
3. **Dataverse page MAIN world**: uses the signed-in browser session. No extension APIs or imported runtime helpers are available here.

## Shared panel and active-tab context

The background configures the default `sidepanel.html` without `tabId`, creating one global panel per browser window. It must not set the same path per tab: Chrome creates separate instances even when paths match, which previously lost the visible conversation when a flow opened in Power Automate. See [Chrome's PanelOptions instance semantics](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-PanelOptions).

The mounted panel listens to activation, active-tab URL/status updates, and focus events for its own window. Context requests carry that window ID. Each refresh immediately clears the previous context/fields and invalidates older replies. Missing tabs/URLs and uncommitted `pendingUrl` pages return a non-executable passive context; no scripts run there. Power Automate is recognized only for guidance, never as Dataverse. Data approvals and tool consent are gated by the current Dataverse context, but local custom-skill approvals remain separate. Background origin checks still apply; normal context-enabled model requests also carry the expected Dataverse origin. No new host permissions or background-tab write routing are introduced.

The shared instance preserves in-flight responses and approval state across ordinary tab switches. Conversation history metadata is captured from explicit Dataverse requests or loaded history, so merely viewing a designer cannot relabel the saved environment. Closing/reloading the panel still uses the existing optional historical-restoration lifecycle, not a live-session replay.

## Module map

| Area                           | Files                                                                               | Responsibility                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background entry point         | `entrypoints/background.ts`                                                         | Register Chrome listeners and route extension messages. Keep business logic elsewhere.                                                           |
| Assistant catalog              | `lib/assistant/tool-catalog.ts`                                                     | Function schemas, skill-builder choices, and request-specific tool selection.                                                                    |
| Assistant loop                 | `lib/assistant/run.ts`                                                              | Responses API continuation, allowlist enforcement, proposal collection, tool audits.                                                             |
| Tool dispatch                  | `lib/assistant/execute-tool.ts`, `arguments.ts`, `contracts.ts`                     | Parse model arguments and map allowed operations to typed primitives.                                                                            |
| Audit presentation             | `lib/assistant/activity.ts`                                                         | Summarize tool results without mixing UI text into executors.                                                                                    |
| Browser integration            | `lib/browser/`                                                                      | Active-tab checks, context extraction, native navigation/fallback, refresh, script injection.                                                    |
| Dataverse contracts            | `lib/dataverse/contracts.ts`                                                        | Requests, query/filter types, resolved metadata, and primitive results.                                                                          |
| Dataverse execution            | `lib/dataverse-primitives.ts`                                                       | Self-contained page executor. Metadata validation, reads, previews, and approved writes. Re-exports existing contract imports for compatibility. |
| Cloud-flow contracts/execution | `lib/flows/`, `lib/dataverse-flow-primitives.ts`, `lib/browser/flows.ts`            | Native definitions, graph/metadata validation, approval diffs, stale-preview protection, Off creation, and draft-only updates.                   |
| Bulk execution/workspace       | `lib/bulk/`, `lib/browser/bulk.ts`                                                  | Typed plans, local datasets/rows, paged preparation, counts, checkpointed runner, signed-session batch transport, recovery.                      |
| Bulk UI                        | `entrypoints/sidepanel/BulkJobCards.tsx`, `BulkWorkspace.tsx`                       | Frozen-scope approval, permission acknowledgement, paginated inspection, progress, upload, and recovery.                                         |
| Shared application contracts   | `lib/types.ts`                                                                      | Extension messages, settings, model responses, proposal/result types.                                                                            |
| Conversation model             | `lib/conversation-model.ts`                                                         | Shared transcript/approval types, authoritative audit serialization, read-only restoration. No React or IndexedDB dependency.                    |
| History repository             | `lib/conversations.ts`                                                              | IndexedDB connection/transaction handling and CRUD. Existing store name, version, and data shape are unchanged.                                  |
| History policy                 | `lib/history-policy.ts`                                                             | Defaults, limits, and expiration/count decisions shared by settings and persistence.                                                             |
| Approval rules                 | `lib/approvals.ts`                                                                  | Editability, display status, immutable selection, synchronous execution lock. No React or Chrome dependency.                                     |
| Approval adapters              | `entrypoints/sidepanel/useApprovals.ts`                                             | One queue lifecycle with domain-specific messages and result audits for records, memberships, and skills.                                        |
| Transcript UI                  | `entrypoints/sidepanel/TranscriptMessage.tsx`, `ApprovalCards.tsx`, `formatting.ts` | Render messages and proposals; no mutation execution in rendering.                                                                               |
| UI composition                 | `entrypoints/sidepanel/App.tsx`                                                     | Context, request submission, history lifecycle, and page composition.                                                                            |
| Skills                         | `lib/skills.ts`                                                                     | Built-in workflows, custom-skill validation/storage/revision checks, export. Uses the shared tool catalog.                                       |

## Approval boundary

The model sees **preparation** tools, not execution tools. Preparation may read metadata and records but must not write business records, cloud-flow definitions, memberships, or custom skills.

```text
user request → allowed model tool → validated preview → approval card
                                                     ↓ explicit approval
background execution message → environment/metadata revalidation → write
                                                     ↓
                                      outcome appended to transcript audit
```

- Personal `AI Result` view management remains the existing explicitly exposed tool exception; it is not a general business-record mutation tool.
- Cloud-flow lists expose summaries only. Exact reads expose the latest full definition and ETag for general editing. The model can propose complete revised `clientdata` for unmanaged flows but cannot execute writes. Creation uses the same native definition format. Generated execution payloads remain local; proposals show complete new definitions or before/after definitions and changed JSON paths for approval. The tool schema has one required definition and nullable identifiers/description, so unused fields are unambiguous even with strict provider schemas.
- The assistant loop rejects unadvertised tool calls **before dispatch**, even if the model emits a syntactically valid function call.
- Pending is the only editable/executable approval status. An in-flight lock is acquired synchronously before an async request starts.
- Failed, rejected, completed, and historical proposals cannot execute through the shared approval lifecycle. Corrections need a new preview and fresh approval.
- Restored items are always historical. Interrupted `approving` states become expired pending previews, never presumed successes.
- The side panel disables conversation switching and new submissions during approval execution so outcomes stay with their originating conversation.
- These checks protect the supported extension flow; they are not a substitute for server-side authorization. Dataverse permissions still apply.

## Cloud-flow primitives

Modern cloud flows are read and written through the signed-in Dataverse `workflows` endpoint. `lib/dataverse-flow-primitives.ts` is a separate self-contained MAIN-world executor because flow compilation and workflow-table validation are a distinct domain from generic record mutation.

The model can list flows, read one flow, open its exact Power Automate designer, list existing connection references for all connectors, and prepare creates/updates using one native definition format. Designer navigation calls documented `RetrieveCurrentOrganization` through the signed-in Dataverse session to resolve `EnvironmentId`, then opens `https://make.powerautomate.com/environments/{environmentId}/flows/{workflowId}` in a new tab. Oddy's typed flow graph, parser/compiler, and ownership checks have been removed. Native triggers, actions, conditions, scopes, loops, cases, expressions, and designer metadata are preserved rather than reconstructed. Legacy embedded Oddy metadata is treated as opaque data, never as an authority.

```text
model: complete native definition → graph/metadata/connection validation
                                                   ↓ local preview
                                    full definition / before-after diff
                                                   ↓ explicit approval
page: revalidate + environment/snapshot/ETag checks → POST Off / PATCH draft
```

Creation uses documented modern-flow fields (`category=5`, `type=1`, `primaryentity=none`, `statecode=0`) and leaves the new flow Draft/Off. Both operations accept complete `clientdata` with a maximum of 1 MB, 1,000 graph nodes, and 50 action-nesting levels. The validator recursively checks node shapes and sibling `runAfter` dependencies/cycles. New/changed connection-reference declarations and bindings used by changed nodes are checked against exact logical names and connector IDs from Dataverse. Changed static Dataverse connector nodes must use logical table names for webhook triggers and entity-set names for actions; selected/sorted/written columns are checked for existence, read/write permission, and basic literal types. Unchanged nodes/references are not rewritten or forced through metadata validation. Dynamic bindings/tables and lookup target validation limitations are disclosed as warnings. Full connector schemas and arbitrary expression semantics remain service/designer responsibilities. Preparation requires the exact ETag from the prior read for updates and preserves omitted/null descriptions (empty text explicitly clears). Approval renders the complete new definition or a changed-path diff plus complete before/after JSON. Execution repeats validation, compares the approved payload, and checks the saved snapshot plus ETag/component state before writing. Managed flows remain read-only. Legacy typed previews render as non-executable history and are rejected by the executor before any reads or writes; new previews require a complete native definition. Workflow reads use `MSCRM.IncludeUnpublished: true` to select the latest saved draft rather than a stale published definition. Update preparation requires a row version and discloses `saveMode: draft`. Execution rejects legacy previews without that consent, re-reads the latest workflow, checks editability, component state and exact ETag, then sends one `PATCH` with `MSCRM.AsUnpublished: true`. It never sends `SkipComponentVersioning`, wildcard ETags, publish/activate calls, or a fallback published update. Runtime `statecode` and solution `componentstate` are distinct; success audits report an unpublished draft saved, not a published/running change. Publication and activation are separate future authorities.

`AsUnpublished` has limited public documentation; the draft request is based on observed maker/API integrations, not a documented general-purpose guarantee. Live development-tenant verification must check draft contents, version history, unchanged published definition/runtime state and stale-ETag rejection. Rejected draft requests stop without retries. Reference: [draft-save request example](https://www.skillsdirectory.com/skills/hydr-cloud-flows), [Microsoft's IncludeUnpublished example for workflow reads](https://learn.microsoft.com/en-us/power-automate/developer/desktop-flow-public-apis).

## Bulk jobs: data plane versus model context

`lib/bulk/plan.ts` parses complete typed plans strictly: malformed/unsupported filters, values, mappings, and extra properties fail rather than being dropped. An empty filter requires `allRecords: true`. There are four operations:

- `update`: select target records and apply constant, metadata-validated scalar/Choice/lookup values.
- `count_related`: select targets, resolve an explicit source lookup referencing that target table, page source records, and count distinct source IDs by typed parent lookup. Missing counts are zero. Polymorphic lookup types must be returned; ambiguous/missing types fail closed. The destination must be a writable whole-number field.
- `create`: map a locally uploaded scalar CSV/JSON dataset into validated fields and reserve each record GUID before execution.
- `membership`: select all matching members for an existing, static, type-compatible marketing list; enumerate existing memberships and exclude them.

```text
model: typed plan → prepare_bulk_job → job metadata/counts, no row samples
                              ↓
worker: validate / page / derive → separate IndexedDB manifest + frozen rows
                                                ↓ explicit approval
live side-panel loop → approve nonce → private execution token → next chunk
                                                ↓
worker: revalidate identity/environment/metadata → commit in-flight marker
                                                ↓
page: conditional PATCH / reserved-ID POST in $batch, or AddListMembersList
                                                ↓
worker: atomically commit outcomes + next index → compact UI progress
                                                ↓
completed job only → authoritative count audit → guarded model continuation
```

`lib/bulk/repository.ts` uses **oddy-bulk-workspace**, separate from optional chat history. Job manifests, indexed row records, and uploaded datasets are independent stores. A checkpoint commits row outcomes and manifest progress in one transaction. Dataset listing returns metadata only. The assistant loop explicitly strips the job's five-row UI sample from model-facing JSON; full arrays, before-images, ETags, identity IDs, and execution tokens never enter model outputs or transcript audits. Inspection of 25 local rows is a UI-only extension message, not a model tool. Compact five-row previews may be retained by the user's normal chat-history policy.

`lib/bulk/engine.ts` handles preparation, approval, chunks, and reconciliation. `bulk_fields`, `bulk_page`, `bulk_read_versions`, `bulk_list_info`, and `bulk_identity` are internal page primitives, not advertised model tools. Metadata caches last only one injection, amortizing repeated field validation without carrying stale metadata across approvals. FetchXML pages use a primary-key order and real paging cookies, never `top 50` or a capped total count. Unknown filters, failed pages, no-progress cookies, unreadable versions, missing lookup types, over-limit scans, and time-budget failures never produce an executable partial selection. Enumeration is not snapshot isolation across records, and row-level read permissions may make counts incomplete.

The model sees only `prepare_bulk_job`, `prepare_bulk_job_remaining`, `get_bulk_job`, and `list_bulk_datasets`. The old small explicit-ID membership proposal remains supported. The bundled membership workflow now prepares a query-backed job rather than enumerating at most 50 members.

### Approval and execution invariants

- Frozen row payloads are immutable after preparation. Approval resolves a locally stored ID/revision, not a client-supplied member/payload array.
- Approval binds the environment, signed-in user, stored plan/rows, nonce, and one-hour expiry. Related-count approval additionally requires acknowledging that the execution identity sees only readable source records.
- Execution requires a private token returned only to the live approval callback. Tokens are not model-visible, included in conversation history, or reconstructed by inspection.
- A worker lock prevents concurrent calls for the same job; `expectedOffset` rejects a replayed chunk even after its original call finishes.
- The runner saves an in-flight marker **before** handing any chunk to a mutating transport. A lost response or failed outcome commit leaves recovery evidence and cannot authorize a replay.
- `lib/bulk/transport.ts` is a separate, self-contained MAIN-world function. Updates use exact captured ETags in independent change sets. Creates use reserved GUIDs, never implicit upserts. Each chunk contains at most 50 operations and a conservative estimated 1 MiB payload budget.
- The transport rechecks WhoAmI immediately before POST, parses multipart responses by Content-ID, and distinguishes confirmed successes, conflicts, failures, and uncertainty. An outer HTTP 200 or asynchronous acceptance does not prove writes completed. Missing/duplicate results and lost responses stay uncertain.
- Membership chunks use the tenant-advertised action signature and revalidate list/type/records/membership/identity. Already-added members may be skipped under the explicitly disclosed bulk-job policy; ordinary small-ID proposals retain their stricter stale-preview behavior.
- A failed/conflicting/uncertain chunk stops later chunks and invalidates its token. `Retry-After` is reported; remaining-work preparation respects the recorded cooldown. There is no silent failed-write retry, global rollback, or success claim for partial completion.
- Stop runs after the current chunk settles. Closing the panel stops the live loop; active-tab/session loss blocks further writes. Checkpoints support recovery, not unattended execution or history replay.

### Remaining-work previews

A fresh remaining-work preview invalidates the old token, treats an abandoned in-flight chunk as uncertain, excludes confirmed successes, and reconciles current state before offering another approval. For updates, already-matching values are skipped and new ETags/before-images are captured. For creates, the original reserved IDs are retained: existing matching records are skipped, differing existing records block the preview, and nothing is overwritten or silently upserted. Membership recovery excludes existing members. Original derived-count values are retained and labeled with their original preparation time; a new count job is needed to recalculate them.

The initial browser runner caps target/dataset rows at 100,000, source/membership scans at 1,000,000, and preparation at two minutes. The workspace guard permits 20 jobs and five datasets; datasets are limited to 25 MiB and scalar cells. Full workspace data has a 24-hour cleanup policy enforced on use (not a guaranteed deletion timer while Chrome is closed). Individual job/dataset deletion can free a workspace slot without erasing a different job's recovery evidence; job deletion is owner/environment checked and locked against an active chunk. Clearing data removes recovery evidence, not Dataverse changes. Expired unknown writes must never be assumed to have failed.

Native `CreateMultiple`/`UpdateMultiple` optimization and a separately authenticated server runner are future adapters. The initial CRUD transport uses `$batch`; do not describe it as native bulk-message execution or bypass row-version checks for speed. No codemode or model-generated script execution is introduced.

## Adding a Dataverse capability

1. Add proposal/result contracts to `lib/types.ts` if the operation needs approval. Add the primitive request/result shape in `lib/dataverse/contracts.ts`.
2. Implement metadata-backed preparation and revalidated execution inside `executeDataversePrimitive`. Do not guess Choice values, entity-set names, lookup targets, or action signatures.
3. Add the model-facing **preparation** schema and skill-builder option in `lib/assistant/tool-catalog.ts`. Update `OddySkillToolName` in `lib/types.ts`. Catalog consistency tests should fail if a registration is missed.
4. Parse arguments in `lib/assistant/arguments.ts` and route them in `execute-tool.ts`. Collect prepared proposals in `run.ts`; provide a preparation audit in `activity.ts`.
5. Route the explicit execution message in `entrypoints/background.ts`; recheck the active environment before injection. Never add this execution message to the model catalog.
6. For a new approval kind, add a typed adapter in `useApprovals.ts` and its card in `ApprovalCards.tsx`. Extend the shared conversation model and restoration together. Older saved histories must remain readable.
7. Add a workflow in `lib/skills.ts` only if it provides a useful guided path. Skills declare tool access; they cannot bypass consent or approval.
8. Add tests for valid preview/execution, wrong environment, stale metadata, failures, selection limits, restored read-only cards, and MAIN-world serialization. Flow capabilities additionally need native-definition round-trip, connection-reference, metadata, nested-graph, managed-flow, legacy-preview, and ETag tests.
9. Bump the package version with `npm version <version> --no-git-tag-version`. Build and verify `.output/chrome-mv3/manifest.json` matches `package.json`.

## Continuing after an approval

`lib/approval-continuation.ts` keeps automatic follow-up separate from mutation execution. Each live user request and assistant response carries optional request context: original prompt, request lineage, environment, consent flags, and any skill tool ceiling. Older saved conversations remain readable without it.

After a successful record/membership approval or a fully completed bulk job, `useApprovals.ts` appends the actual execution result (including IDs) to the audit and queues a transient continuation event. The side panel waits for context refresh and outstanding sibling approvals, then sends one internal follow-up using that original scope. It does not append a synthetic user message. The next assistant response may prepare the next proposal, but never executes it.

- A per-conversation/proposal guard prevents duplicate continuations, including React StrictMode effect replay.
- A newer user request, restored history, changed environment, revoked consent, or failed/rejected sibling stops automatic continuation.
- Custom-skill approvals do not independently trigger automatic continuation.
- The background rechecks the expected origin before model/tool calls. Resumed skills intersect the current tool set with the original ceiling.
- Follow-up provider failures leave the successful approval marked Applied; they do not retry the saved operation.
- Events are not persisted and are not replayed when history is opened. Legacy conversations require an explicit follow-up request.

`lib/dataverse-user-context.ts` is a self-contained, read-only MAIN-world collector. It gets the signed-in user ID from `Xrm.Utility.getGlobalContext().userSettings` or `WhoAmI`, reads that user's `usersettingscollection` time-zone code, and looks up the current `timezonedefinitions` name. `LocalTimeFromUtcTime` converts the request UTC instant using Dataverse's time-zone/DST rules. This works on list pages and does not depend on `Xrm.Page` form fields. The user ID is used internally and is not returned to the model; names and security roles are not read.

`lib/browser/context.ts` collects these settings alongside form context and preserves them through the record Web API fallback. Custom-skill-only requests skip this additional Dataverse read. `lib/assistant/runtime-clock.ts` receives the resulting `currentUser` settings **after** context collection, separately from `browserLocalDate`/`browserTimeZone`, and includes them in the authoritative request clock. A read audit makes the source visible in the side panel.

The UTC interval and user-local date share the collector's observation instant. The model can use `createdon ge` and `createdon le` with the computed rolling 30-day timestamps rather than guessing today or doing calendar arithmetic. A rolling duration is time-zone-independent; calendar-day requests remain distinct. Windows time-zone names are not guessed into IANA identifiers. If Web API settings/conversion are denied, the current `getTimeZoneOffsetMinutes()` value can supply an explicitly labeled fallback only for the observed instant; no historical/future DST rule is inferred. If neither source is available, warnings are supplied instead of silently using the browser zone.

Reference APIs: [current-user Client API settings](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-utility/getglobalcontext/usersettings), [UserSettings table](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/usersettings), [time-zone definitions](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/timezonedefinition), and [LocalTimeFromUtcTime](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/localtimefromutctime?view=dataverse-latest).

## Why the injected executor is intentionally self-contained

`chrome.scripting.executeScript({ func })` serializes a function, not its module graph. Moving helpers into ordinary imports would compile successfully but fail in the Dataverse page because those imports are absent.

Keep runtime helpers nested inside `executeDataversePrimitive` (and other injected functions). Extract type-only contracts freely. A future runtime split requires an explicit bundled-injection strategy; do not pass arbitrary code strings or use eval in production. `tests/browser.test.ts` reconstructs the executor without its module closure as a regression check; this test-only technique is not used by the extension.

## Tests and local workflow

Use Node 22 (Node 20 is also supported by the dependencies):

```bash
npm ci
npm run format
npm run check
```

`check` runs formatting verification, strict typechecking, all tests, and a production build. `npm run test:watch` supports fast focused development; e.g. `npm run test:watch -- tests/approvals.test.ts`.

Tests are divided by boundary:

- `dataverse-tools.test.ts`: signed-session API request/response behavior, including Choice, lookup, bulk action, and XML metadata headers.
- `dataverse-flow-tools.test.ts`: native creation Off, all-connector references, static Dataverse metadata validation, nested graph/dependency checks, MAIN-world compatibility, and legacy-preview rejection.
- `dataverse-flow-definition.test.ts`: complete-definition updates, unpublished reads, draft-save consent/headers, no publish/retry fallback, snapshot/ETag conflicts, and approval diffs.
- `assistant.test.ts`: tool selection, allowlist rejection, proposal collection, continuation, and loop limits using mocked provider/browser seams.
- `tool-dispatch.test.ts`: argument parsing and preparation-only routing.
- `approvals.test.ts`: lifecycle rules, duplicate execution, failures, and history guards without React.
- `approval-cards.test.tsx`: server-rendered live, historical, and failed cards without browser dependencies.
- `approval-continuation.test.ts`: continuation scope, original intent/result IDs, consent, sibling approvals, and deduplication.
- `approval-continuation-ui.test.tsx`: the real side panel under React StrictMode in Happy DOM; verifies create → continue → membership preview → fresh approval, plus failure handling.
- `bulk-engine.test.ts`: thousands-row paging/frozen selections, related counts/zeroes, version conflicts, identity/expiry, private-token checkpoints, uncertain-create reconciliation, interrupted commits, membership jobs, cooldown, and retention.
- `bulk-primitives.test.ts`: cached metadata validation, strict full paging, lookup types, concurrency support, and serialization.
- `bulk-transport.test.ts`: conditional batch formatting, reserved create IDs, multipart Content-ID results, asynchronous/uncertain responses, identity/origin checks, and throttling without replay.
- `bulk-client.test.ts`: live approval-owned chunk loop, consent/stop handling, failure interruption, compact audits, and no model execution authority.
- `bulk-plan.test.ts`: strict non-broadening plan parsing and safe scalar JSON/quoted CSV input.
- `bulk-ui.test.tsx`: real side panel plus job engine under StrictMode, local inspection, explicit approval, count-scope acknowledgement, compact continuation, and separate remaining-work approval.
- `runtime-clock.test.ts`: exact rolling intervals across year boundaries/leap years and distinct browser/Dataverse user clocks.
- `dataverse-user-context.test.ts`: signed-in settings, WhoAmI fallback, server conversion/DST authority, date boundaries, permissions, current-offset fallback, and injection serialization.
- `browser.test.ts` also verifies that user settings survive form-field early returns, list-page context, and record Web API fallback.
- `conversation-model.test.ts`: backward-compatible restoration and authoritative outcome serialization.
- `conversations.test.ts`: real IndexedDB API semantics via `fake-indexeddb`, atomic save/retention, CRUD, and policy decisions.
- `browser.test.ts`: origin checks, injection contract, serialization safety, navigation matching, and passive missing/pending/Power Automate contexts.
- `sidepanel-background.test.ts`: global-only panel configuration and window-scoped passive context reads.
- `sidepanel-navigation.test.tsx`: shared live conversations/in-flight responses, data-approval gating, return-to-Dataverse recovery, stale context replies, window isolation, listener cleanup, and stable history attribution.

No test needs live credentials or a Dataverse tenant. That also means tests do **not** replace a live-tenant smoke test.

### Manual smoke test after a structural change

1. Load `.output/chrome-mv3`, open a Dataverse app, and verify context detection.
2. Query records, create/update `AI Result`, and navigate to a record.
3. Read an unmanaged flow created outside Oddy. Propose changes to nested conditions/actions and an expression, inspect every changed JSON path and both complete definitions, reject once, then prepare again and approve. Verify unrelated actions, metadata, and connection references survive unchanged. Repeat with an outdated Oddy marker and confirm general edits remain available. Change the flow between read/preparation and again between preparation/approval; both must require fresh reads/previews. Confirm a managed flow stays read-only. List flow connection references, prepare a manual Dataverse list-rows flow, inspect its complete native definition approval card, approve it, and verify it is created Off. Ask Oddy to show it in Power Automate and verify the exact designer opens in a new tab. Read it back, prepare a rename, alter it externally before approval, and verify the stale update is refused. Prepare a fresh update while an unpublished draft exists; approve the draft save and verify the latest draft changes without a publish/activation. Repeat for an active flow in a development tenant, verifying the previously published definition and runtime state remain unchanged.
4. Prepare a record change; deselect/reselect fields; reject it. Prepare another and approve it.
5. Ask to create a static marketing list and add contacts created in the last 30 days. Approve creation; Oddy should automatically use the saved list ID and prepare the matching members. Approve membership separately and verify bounded `AddListMembersList` chunks for the frozen matching selection, never per-contact writes. Check dynamic-list rejection.
6. Trigger an execution failure and confirm the next assistant turn receives the exact audit error and requires a fresh preview.
7. Enable local history; resume a conversation. Old cards must have no approval buttons; new requests must still work. Delete a conversation and clear all.
8. Verify a custom-skill change still requires approval and bundled skills remain immutable.
9. In a test environment, prepare an update over thousands of contacts using a dedicated test field. Inspect multiple local pages, reject once, then prepare again. Change a selected row externally before approval and verify a conflict stops later chunks with accurate partial counts.
10. Prepare contact case counts using the explicitly selected Customer or Primary Contact relationship. Verify active/all-case filtering, typed contact-versus-account lookups, zero-case contacts, the permission-scope acknowledgement, and independent manual counts.
11. Upload a small CSV/JSON dataset, inspect mappings, approve creates, and verify reserved GUIDs. Simulate a lost chunk response or panel close; prepare remaining work and verify no successful record is recreated. Start small before scaling to thousands.
12. Close/reopen the panel during a bulk job; no writes may restart automatically. Use Bulk workspace to inspect progress and explicitly prepare/approve remaining work. Verify history restoration and workspace clearing cannot trigger writes.

## Scope of this refactor

The original module split preserves existing histories and primitive behavior. Version 0.12 adds approval-gated native cloud-flow creation/editing and exact Power Automate navigation. Existing unmanaged flows also support general definition edits after explicit before/after approval, without requiring Oddy ownership. Automatic publication/activation, connection creation, codemode, changed consent defaults, native bulk-message optimization, and unattended server execution remain outside this scope.
