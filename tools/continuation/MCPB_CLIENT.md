# Default-off MCPB outbound client

This is a standalone **real HTTP protocol client**, not a fake coordinator transport and not a
production integration. Importing it, constructing it, or calling `status()` performs no network
or credential lookup. It is not connected to the extension, Native host, coordinator, or service.

## Public contract and supported subset

- [MCP 2025-03-26 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)
- Public MCPB contract reviewed at Bridge revision `bf60fb5f008d2c902fedc819cf5e94d03e429376`:
  [manifest](https://github.com/Fanch-hui/codex-bridge/blob/bf60fb5f008d2c902fedc819cf5e94d03e429376/Integrations/MCPB/manifest.json),
  [proxy](https://github.com/Fanch-hui/codex-bridge/blob/bf60fb5f008d2c902fedc819cf5e94d03e429376/Integrations/MCPB/server.mjs).

Node.js >=22 and Git >=2.15 are the only dependencies; no npm install or plugin installation is needed.
Each explicit operation uses `initialize`, `notifications/initialized`, `tools/list`, then
`tools/call`. JSON and bounded SSE POST responses are accepted, including UTF-8 split across
chunks, CR/LF/CRLF, notifications, and a matching JSON-RPC reply. Results accept
`structuredContent` or one JSON text content item. Request IDs must match.

Only protocol `2025-03-26` is negotiated. Unsupported versions, server-initiated requests,
truncated/paged tool catalogs, or schemas needing unknown arguments stop before submission.
There is no legacy SSE endpoint fallback, GET listener, resumability, automatic 404 recovery,
redirect following, background timer, or retry. Every failure after the write-ahead submit
reservation is unresolved; this client does not retry the tool request or recover it by guessing.

## Entry point and limits

`tools/continuation/mcpb_adapter.mjs` exports `createMcpbAdapter(options)` and `LIMITS`.

| Option/operation | Contract |
|---|---|
| `enabled` | defaults false; only literal true opts in |
| `grant` | explicit `kind=continuation`, matching project/installation/session/workspace, approved time, expiry, and maxTasks 1..3 |
| `projectId/installationId/sessionId` | fixed for the object and persisted binding; no default project/provider/session fallback |
| `workspaceRoot` | absolute actual Git repository root |
| `stateDir` | fixed private journal directory outside the repository; initially **absent**, with a private existing parent |
| credential variables | future explicit `CODEX_BRIDGE_MCP_URL` and `CODEX_BRIDGE_MCP_TOKEN`; no file/registry/tunnel discovery |
| URL | `/mcp`, HTTP/HTTPS, literal `127.0.0.1` or `[::1]`; localhost DNS, credentials/query/fragment rejected |
| token | visible ASCII, 16..4096 chars; never logged, returned, hashed into the journal, or persisted |
| timeouts | read <=10000 ms, submit <=15000 ms per POST; only downward overrides |
| `submitTask({clientRequestId,prompt,acceptanceCriteria})` | fixed binding plus bounded user task text; no raw-tool API |
| `getTask(taskId)` | only an exact already-recorded task; no listing, latest/prompt/time matching, approval or cancel APIs |
| `status()` | local metadata only; always `productionVerified=false` |

The outgoing tool is `submit_task`, `provider_id=deepseek-harness-desktop`, and the original DSH
session is transmitted as `thread_id`. The ephemeral `Mcp-Session-Id` header is unrelated to the
DSH session. No DSH session-open/create path exists. Model/effort/Skill/attachments are omitted.
The client does not override Bridge's Qwen client permissions, task permission selection, or
existing local-start approval policy.

## Persistence and fail-closed behavior

The fixed journal holds at most **three distinct intents**, including failures/unknowns, with one
nonterminal task and one operation at a time. Same key/same content returns the persisted receipt
without a POST; changed content returns `idempotency_conflict`. Unknown keys return
`unknown_outcome` and stop all new submissions. A new local intent unexpectedly reused by the
server also becomes unknown rather than being attributed to this run.

`mcpb-intents.json` contains only binding/content hashes, nonsensitive request IDs, phases and
minimal task receipts, never token/prompt/criteria or raw upstream errors. Before the only submit
attempt, an `unknown` reservation is written to an exclusive 0600 temporary file, fsynced, and
renamed over the journal. Authorization expiry is rechecked after the final blocking Git preflight
and after reservation, immediately before the submit POST. Expiry after reservation sends no POST
and preserves the unresolved record; no reset/retry is inferred. After a valid reply it is replaced
with the receipt. Process failure or
lost/malformed response preserves the reservation. There is **zero automatic submit retry**.

An atomic `.mcpb-lock` directory prevents another instance from writing the same journal. Locks
are not reclaimed automatically, including stale ones. Missing/corrupt journals, binding changes,
extra fields, and symlinks fail closed; an existing empty directory is not silently initialized.
There is no reset/force-unlock API. Preserve unresolved state for exact operator reconciliation;
do not delete/recreate the store or change request keys to resume an unknown operation.

`getTask` releases a nonterminal slot only after an exact recorded `task_id` and matching
`project_id/provider_id/provider_session_id/installation_id` in `result.task` plus a recognized
terminal status. **This nested binding projection has not been verified against a live authorized
Bridge.** Missing/different fields deliberately produce sticky UNKNOWN, not inference or a fresh
session. The inspected public `list_tasks` contract has no exact request-ID lookup.

Git preflight copies only named OS/runtime environment fields; it never enumerates or forwards
internal credential variables. It sets `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and uses
`--no-optional-locks`, `core.fsmonitor=false`, and `core.untrackedCache=false`.
Git status includes tracked/staged/untracked changes. It is checked before networking and again
immediately before the write-ahead submit reservation; dirty/unreadable workspaces send no task.
No reset, clean, checkout, stash, auto-commit, or file discard occurs. Read-only owned-task queries
remain possible while the model's worktree is dirty. The scan is a preflight, **not an atomic Git
filesystem lease**: another writer can change files after it. Private journal access/unchanged
location and a trusted caller are premises, not OS sandbox or cross-client concurrency guarantees.
File fsync/rename is a process-crash guard; whole-machine power-loss durability is unverified.

## Tests — mock only

```powershell
node test_t095b259_mcpb_adapter.mjs
```

The suite starts its own random-port loopback server, temporary Git repositories, and fictional
credentials; it never inherits a real endpoint/token. Windows full gate and Ubuntu's explicit
MCPB step execute it. Passing proves protocol packets and application guards against the mock,
**not live authorization, installed Bridge compatibility, actual model behavior, or production
readiness**. No simulated production terminal event or notification is sent.

A default-off construction needs no credentials and makes no request:

```js
import { createMcpbAdapter } from './tools/continuation/mcpb_adapter.mjs';
const client = createMcpbAdapter();
console.log(client.status()); // enabled=false, productionVerified=false
```

Before any future opt-in, the operator must supply an authorized client configuration and verify
its Qwen permission, exact project/installation/original session, effective native continuation,
protocol/schema compatibility, terminal binding projection and existing approval policy with
separate read-only evidence. No such authorization request or real submit was made for T259.
