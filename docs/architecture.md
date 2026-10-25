# Architecture and contributor guide

Oddy is a Manifest V3 extension with three execution environments. Keep their boundaries explicit:

1. **Extension UI**: React settings and side panel. Shows proposals and collects approval.
2. **Background worker**: receives messages, calls Azure OpenAI, selects tools, and coordinates browser operations.
3. **Dataverse page MAIN world**: uses the signed-in browser session. No extension APIs or imported runtime helpers are available here.

## Module map

| Area                         | Files                                                                               | Responsibility                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background entry point       | `entrypoints/background.ts`                                                         | Register Chrome listeners and route extension messages. Keep business logic elsewhere.                                                           |
| Assistant catalog            | `lib/assistant/tool-catalog.ts`                                                     | Function schemas, skill-builder choices, and request-specific tool selection.                                                                    |
| Assistant loop               | `lib/assistant/run.ts`                                                              | Responses API continuation, allowlist enforcement, proposal collection, tool audits.                                                             |
| Tool dispatch                | `lib/assistant/execute-tool.ts`, `arguments.ts`, `contracts.ts`                     | Parse model arguments and map allowed operations to typed primitives.                                                                            |
| Audit presentation           | `lib/assistant/activity.ts`                                                         | Summarize tool results without mixing UI text into executors.                                                                                    |
| Browser integration          | `lib/browser/`                                                                      | Active-tab checks, context extraction, native navigation/fallback, refresh, script injection.                                                    |
| Dataverse contracts          | `lib/dataverse/contracts.ts`                                                        | Requests, query/filter types, resolved metadata, and primitive results.                                                                          |
| Dataverse execution          | `lib/dataverse-primitives.ts`                                                       | Self-contained page executor. Metadata validation, reads, previews, and approved writes. Re-exports existing contract imports for compatibility. |
| Shared application contracts | `lib/types.ts`                                                                      | Extension messages, settings, model responses, proposal/result types.                                                                            |
| Conversation model           | `lib/conversation-model.ts`                                                         | Shared transcript/approval types, authoritative audit serialization, read-only restoration. No React or IndexedDB dependency.                    |
| History repository           | `lib/conversations.ts`                                                              | IndexedDB connection/transaction handling and CRUD. Existing store name, version, and data shape are unchanged.                                  |
| History policy               | `lib/history-policy.ts`                                                             | Defaults, limits, and expiration/count decisions shared by settings and persistence.                                                             |
| Approval rules               | `lib/approvals.ts`                                                                  | Editability, display status, immutable selection, synchronous execution lock. No React or Chrome dependency.                                     |
| Approval adapters            | `entrypoints/sidepanel/useApprovals.ts`                                             | One queue lifecycle with domain-specific messages and result audits for records, memberships, and skills.                                        |
| Transcript UI                | `entrypoints/sidepanel/TranscriptMessage.tsx`, `ApprovalCards.tsx`, `formatting.ts` | Render messages and proposals; no mutation execution in rendering.                                                                               |
| UI composition               | `entrypoints/sidepanel/App.tsx`                                                     | Context, request submission, history lifecycle, and page composition.                                                                            |
| Skills                       | `lib/skills.ts`                                                                     | Built-in workflows, custom-skill validation/storage/revision checks, export. Uses the shared tool catalog.                                       |

## Approval boundary

The model sees **preparation** tools, not execution tools. Preparation may read metadata and records but must not write business records, memberships, or custom skills.

```text
user request → allowed model tool → validated preview → approval card
                                                     ↓ explicit approval
background execution message → environment/metadata revalidation → write
                                                     ↓
                                      outcome appended to transcript audit
```

- Personal `AI Result` view management remains the existing explicitly exposed tool exception; it is not a general business-record mutation tool.
- The assistant loop rejects unadvertised tool calls **before dispatch**, even if the model emits a syntactically valid function call.
- Pending is the only editable/executable approval status. An in-flight lock is acquired synchronously before an async request starts.
- Failed, rejected, completed, and historical proposals cannot execute through the shared approval lifecycle. Corrections need a new preview and fresh approval.
- Restored items are always historical. Interrupted `approving` states become expired pending previews, never presumed successes.
- The side panel disables conversation switching and new submissions during approval execution so outcomes stay with their originating conversation.
- These checks protect the supported extension flow; they are not a substitute for server-side authorization. Dataverse permissions still apply.

## Adding a Dataverse capability

1. Add proposal/result contracts to `lib/types.ts` if the operation needs approval. Add the primitive request/result shape in `lib/dataverse/contracts.ts`.
2. Implement metadata-backed preparation and revalidated execution inside `executeDataversePrimitive`. Do not guess Choice values, entity-set names, lookup targets, or action signatures.
3. Add the model-facing **preparation** schema and skill-builder option in `lib/assistant/tool-catalog.ts`. Update `OddySkillToolName` in `lib/types.ts`. Catalog consistency tests should fail if a registration is missed.
4. Parse arguments in `lib/assistant/arguments.ts` and route them in `execute-tool.ts`. Collect prepared proposals in `run.ts`; provide a preparation audit in `activity.ts`.
5. Route the explicit execution message in `entrypoints/background.ts`; recheck the active environment before injection. Never add this execution message to the model catalog.
6. For a new approval kind, add a typed adapter in `useApprovals.ts` and its card in `ApprovalCards.tsx`. Extend the shared conversation model and restoration together. Older saved histories must remain readable.
7. Add a workflow in `lib/skills.ts` only if it provides a useful guided path. Skills declare tool access; they cannot bypass consent or approval.
8. Add tests for valid preview/execution, wrong environment, stale metadata, failures, selection limits, and restored read-only cards.
9. Bump the package version with `npm version <version> --no-git-tag-version`. Build and verify `.output/chrome-mv3/manifest.json` matches `package.json`.

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
- `assistant.test.ts`: tool selection, allowlist rejection, proposal collection, continuation, and loop limits using mocked provider/browser seams.
- `tool-dispatch.test.ts`: argument parsing and preparation-only routing.
- `approvals.test.ts`: lifecycle rules, duplicate execution, failures, and history guards without React.
- `approval-cards.test.tsx`: server-rendered live, historical, and failed cards without browser dependencies.
- `conversation-model.test.ts`: backward-compatible restoration and authoritative outcome serialization.
- `conversations.test.ts`: real IndexedDB API semantics via `fake-indexeddb`, atomic save/retention, CRUD, and policy decisions.
- `browser.test.ts`: origin checks, injection contract, serialization safety, and navigation matching.

No test needs live credentials or a Dataverse tenant. That also means tests do **not** replace a live-tenant smoke test.

### Manual smoke test after a structural change

1. Load `.output/chrome-mv3`, open a Dataverse app, and verify context detection.
2. Query records, create/update `AI Result`, and navigate to a record.
3. Prepare a record change; deselect/reselect fields; reject it. Prepare another and approve it.
4. Prepare a static-list bulk membership change; verify one approved `AddListMembersList` request. Check dynamic-list rejection.
5. Trigger an execution failure and confirm the next assistant turn receives the exact audit error and requires a fresh preview.
6. Enable local history; resume a conversation. Old cards must have no approval buttons; new requests must still work. Delete a conversation and clear all.
7. Verify a custom-skill change still requires approval and bundled skills remain immutable.

## Scope of this refactor

The module split preserves the existing Dataverse API behavior and persisted history format. It does not introduce arbitrary action execution, change consent defaults, or change the eight-turn outbound history limit. The large injected executor remains deliberate; settings/editor UI and richer history lifecycle extraction can be tackled independently next.
