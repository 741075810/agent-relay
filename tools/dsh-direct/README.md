# dsh-direct

One prompt, into one **already existing** DSH session, from an MCP client. No session is created, no browser is
touched, no port leaves loopback.

T272 rebuilt this against the **installed** Desktop build rather than against an imagined API:

```
@deepseek-ai/dsh-desktop 0.2.0-rc.2
dshBuildCommit 04f392c9ddd144fa426da2045178797da6db6c11
```

## What rc.2 actually exposes

Read from the installed bytes under `<DSH_INSTALL>\resources\app\dsh\node_modules\@deepseek-ai\`:

| method | request | value | evidence |
|---|---|---|---|
| `list` | `SessionListRequest { cursor? }` | `SessionListValue { items: SessionSummary[] }` | `dsh-api-session-controller/lib/typert.host.js` (catalog id `session/list`) |
| `prompt` | `SessionPromptRequest { requestId, sessionId, mode: 'queue'\|'steer', content: PromptContentPart[], clientTimeZone? }` | `{ accepted: true }` | same file; admission check at `lib/index.js:855` |
| `page` | `SessionPageRequest { address: { kind: 'session', sessionId }, throughSeq, beforeSeq?, maxMessages?, turnWindow? }` | `SessionPage { records, hasMore }` | `throughSeq === -1` is the empty prefix; use a finite snapshot cursor |
| `projections` | `{ sessionId }`, plus AbortSignal | snapshot with `asOfSeq`, or `null` | read-only cursor for fixed-cut paging; no `follow` promotion |

`SessionSummary = { agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`.
**There is no `projectId`** — `cwd` is the identity a caller can bind to.

T271 guessed `listSessions` / `getEvents({sessionId,turnId,cursor})`. Those never existed in rc.2. `adapters.mjs` now
requires `list`/`prompt`/`page`/`projections` and reports a build that only has the guessed names as
`host_capability_missing` + `legacyGuessPresent`. The adapter passes real AbortSignals to `prompt`, `page` and
`projections`; missing signals fail in the shipped service, not just in a hypothetical future build.

A result joins the exact `user/message.data.source.rpcId` to its enclosing `turn/start`, the same turn's final
noninterrupted non-tool `assistant/message`, and a completed `turn/end`. Old replies and intermediate text do not count.
The history search uses one fixed snapshot and at most 32 backward pages. Missing correlation or a completed turn with
no final text does not become success; inspect `get_task` and history rather than sending another prompt.

There is also no `events`/`state`/`wait` in rc.2 (those are master-only). The read path here is `page`, and the
plugin does not pretend otherwise: `protocol` in every receipt says `dsh-api-session-controller@0.2.0-rc.2`.

## The rule this version exists for

A prompt whose answer never arrives is **not** a failure.

`@deepseek-ai/dsh-api-session-controller` dedupes on `requestId`: `hasPromptRequest(agent, request.requestId)` short
circuits and returns `{ accepted: true }` without inserting a second message (`lib/index.js:855`), and the created
user message carries `source.rpcId = request.requestId` (`lib/index.js:856-879`). So the durable log itself can answer
"was my prompt admitted?" — and a retry with the **same** id cannot duplicate it.

Therefore:

| situation | state | session lock | what the caller does |
|---|---|---|---|
| prompt accepted | `running` → `succeeded` or `failed` | held until correlated terminal | poll `get_result`; it refreshes history without another prompt |
| Host explicitly refused (`session/writer-held`, `session/agent-busy`, `gateway/bad-request`, `session/not-found`, …) | `failed` | released | fix the cause, submit again |
| no answer (`host_unreachable`, `host_error`, `cancelled`, `internal`) | **`unsettled`** | **kept** | `reconcile_task` |
| process restart while active | `unknown` (`unknownReason: process_restart`) | kept | `get_task` |
| process restart while `unsettled` | `unsettled` (unchanged) | kept | `reconcile_task` |

`get_result` refuses an unsettled task with `task_unsettled`: an unknown outcome is not a result.

`reconcile_task` then settles it in the cheapest correct order:

1. scan the durable log for the requestId; found → the earlier attempt was admitted, go straight to collecting;
2. otherwise require the bound session's `running === false` and `agentAvailable === true`, recheck the configured
   worktree guard, then re-submit **the same** `requestId` with the original text. The Host deduplicates the id. The text
   is not stored here (only `promptSha256`), so the caller must pass `prompt` matching that digest.

New submissions also require positive idle evidence. Unknown/missing idle state fails closed; a busy session is not a
queue target for this bridge. Durable history reads remain available while busy. Preserve unresolved ledgers and ids.

Host error codes seen in rc.2 and how they map: `gateway/bad-request` → `invalid_arguments`, `gateway/cancelled` →
`cancelled`, `gateway/internal` / `gateway/uplink-overflow` → `host_error`, `session/not-found` →
`session_not_found`, `session/writer-held` → `session_writer_held`, `session/agent-busy` → `session_busy`,
`session/model-unavailable` / `session/provider-models-unavailable` → `host_refused`.

## Pieces

```
session_api.mjs   rc.2 wire shapes, error mapping, admission scan (no I/O)
endpoint.mjs      the descriptor the plugin writes at bind time; identity check against /health
adapters.mjs      controller -> neutral adapter; assertCapabilities; offline fake with lost-response injection
protocol.mjs      tool schemas, error codes, task states
store.mjs         JSON ledger; unsettled survives restart; get_result refuses it
host_bridge.mjs   loopback HTTP: /health /sessions /prompt /events /admission; publish + remove the descriptor
host_client.mjs   the MCP server's client; resolves URL or descriptor; verifies identity before a prompt
mcp_server.mjs    stdio JSON-RPC and the one dispatcher; five tools: list_sessions, submit_task, reconcile_task,
                  get_task, get_result
http_transport.mjs the Streamable HTTP transport (opt-in): sessions, Origin, bearer auth, body/timeout limits, 202/405/504
preflight.mjs     read-only deployment check (package, Cordis version, config, endpoint, port, docs, http)
plugin/           the installable Cordis plugin (see INSTALL-WINDOWS.md)
```

Tools: `list_sessions`, `submit_task`, `reconcile_task`, `get_task`, `get_result`.

## Installing into the Desktop

[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) gives backup, profile dependency/bundle/override, official enable, loopback
configuration and rollback steps. Machine-specific installation status and session ids belong in a local evidence report,
not this source snapshot. First import may hot-load; replacing an already imported module can need a deferred Desktop
restart. Never terminate the process hosting the installation task. Cordis cleanup is owned through `ctx.effect`.

## Acceptance levels — keep them apart

| level | meaning | evidence required per installation |
|---|---|---|
| **A** | plugin, stdio/HTTP MCP, preflight and strict rc.2 contracts verified offline | `test_t271_*` … `test_t276_*`, full gate and exact-commit CI; optional actual Cordis Context teardown test |
| **B** | the actual Desktop Host loads the installed generation and serves on loopback | fresh endpoint, socket ownership and authenticated bound-session listing; an isolated Host or old health response is not B |
| **C** | the original existing session received the single harmless message after idle confirmation | exact session/request/turn/terminal/result evidence via the direct route; never substitute a replacement session |

Stdio works for a local MCP client that launches the process; optional HTTP works for a local HTTP MCP client. A cloud
Web connector is separate and is not a prerequisite for C. No public listener, tunnel or connector registration is part
of these installation steps. The direct route is MCP → private loopback Host bridge → `ctx.sessionController`; the
separate Bridge connector is not invoked. Record B/C per machine instead of deriving either from offline tests.

## Reachability: why there is an endpoint file (T273)

T272 shipped `port: 0` in the plugin and a frozen `hostUrl: http://127.0.0.1:<port>` in the MCP config. That pair cannot
survive a Desktop restart, and the failure is not benign: reproduced with the plugin's own defaults, the port moved
`42609 -> 42610`, every call answered `host_unreachable`, and because "no answer" means "unknown" the task went
`unsettled` with the session locked. The first submit after each Desktop start was lost.

There is now one descriptor, written after `listen` succeeds and removed when the bridge closes:

```json
{ "version": 1, "base": "http://127.0.0.1:42731", "host": "127.0.0.1", "port": 42731,
  "kind": "cordis_session_controller", "protocol": "dsh-api-session-controller@0.2.0-rc.2",
  "endpointId": "…", "tokenFile": null, "pid": 12345, "writtenAt": 1794000000000 }
```

* `config.endpointFile` makes the MCP side read it on every call, so a restarted Desktop is followed without restarting
  the MCP client. `config.hostUrl` still exists for a plugin pinned to a fixed `port`, and the two are mutually
  exclusive: `loadConfig` refuses both or neither.
* The plugin refuses to start with neither `port` nor `endpointFile` (and refuses `port: 0` by name) — a listener nobody
  can address is not a deployment.
* `/health` echoes `endpointId`. A client that resolved through the descriptor requires it to match, which catches a
  stale file pointing at a port another program now owns. Identity is checked **before** the first prompt; a mismatch is
  `host_identity_mismatch` and, being a refusal that never sent anything, it frees the session lock.
* A fixed port that is already taken is now `bind_failed`: a rejection the plugin logs, not the unhandled `error` event
  that used to take the Host process down with `EADDRINUSE`.

## Streamable HTTP: the same server, reachable by an HTTP MCP client (T274)

The stdio server is unchanged and remains the default. With `config.http.enabled` set to the boolean `true` the same
process serves the MCP Streamable HTTP transport at `http://127.0.0.1:<port>/mcp` instead of stdio.

It is the **same** `DirectServer`, the same `handle()` dispatcher, the same task ledger and the same Host bridge. The
transport adds no business logic: it validates a request, resolves a session, calls `handle()`, and frames the answer.

```json
"http": {
  "enabled": true,
  "port": 42732,
  "path": "/mcp",
  "authTokenFile": "<HOME>/.dsh/dsh-direct/http.token",
  "allowedOrigins": [],
  "maxBodyBytes": 1048576,
  "requestTimeoutMs": 120000,
  "maxSessions": 16
}
```

```powershell
node tools/dsh-direct/mcp_server.mjs --config <config.json>   # starts HTTP when config.http.enabled is true
```

Request rules, all enforced and each covered by a test in `test_t274_http_transport.mjs` (transport) and `test_t275_http_interop.mjs` (media type, revision boundary, rate limit, timed-out submit):

| rule | behaviour |
|---|---|
| `POST /mcp` with one JSON-RPC message | `200` + `application/json`, or a single `text/event-stream` event when the client accepts only SSE |
| `Content-Type` other than `application/json` (or absent) | `415` `unsupported_content_type`, decided **before** the body is parsed — a valid payload under the wrong media type is not a request this server understood. `application/json; charset=utf-8` is accepted |
| a body with no request id (notification) | `202` with no body — including `notifications/initialized`, and unknown notifications too |
| `initialize` | requires a string `params.protocolVersion`; anything else is `-32602` and opens no session. Negotiates over the **HTTP** set: echoes `2025-11-25` / `2025-06-18` / `2025-03-26`, otherwise offers `2025-11-25`. `2024-11-05` is deliberately absent — that revision has no Streamable HTTP, so echoing it would be a false claim. stdio still speaks it. Issues `Mcp-Session-Id` (32 hex) |
| any request before `initialize` | `400` `session_required`; unknown or terminated session id → `404` `session_not_found` |
| `notifications/initialized` not yet sent | `400` `session_required` — a client must complete the handshake |
| `MCP-Protocol-Version` | `400` for a revision this transport does not speak (the list starts at `2025-03-26`), and `400` when it disagrees with the negotiated one |
| `Origin` present | `403` `origin_rejected` unless listed in `allowedOrigins` (empty by default = every browser refused) |
| no/wrong `Authorization` | `401` + `WWW-Authenticate: Bearer realm="dsh-direct"`, compared in constant time |
| `GET /mcp` | `405` with `Allow: POST, DELETE` — this server has no server-initiated stream |
| `DELETE /mcp` | `204`, and the session id is dead afterwards |
| other path | `404` |
| malformed JSON | `400` `-32700`; a JSON-RPC batch → `400` `-32600` (batches were removed in 2025-06-18) |
| body over `maxBodyBytes` | `413`, refused before the body is buffered |
| `Accept` without JSON or SSE | `406` |
| unknown JSON-RPC method | `200` with `-32601` in-band, as JSON-RPC expects |
| more `tools/call` in flight than `maxConcurrentRequests` | `429` `too_many_requests` + `Retry-After: 1`. `initialize` and notifications are never rate-limited, so a client that filled the queue can still get a session handle |
| tool call slower than `requestTimeoutMs` | `504` `request_timeout` — **not** a refusal: the Host may already hold the prompt, so the transport never touches the ledger and the caller reconciles |

Deliberately absent: server-initiated SSE streaming (hence 405 on GET), resumability via `Last-Event-ID`, and OAuth
(the bearer token is a shared secret, not a delegated grant). None of the three is simulated.

**The Web gap, stated plainly.** This listener is `127.0.0.1` only and speaks plain HTTP. A ChatGPT *web* client cannot
reach it, and registering a custom MCP connector in ChatGPT is a user action in the ChatGPT settings — nothing in this
repository does it. What exists is an HTTP MCP endpoint that a local MCP client (or a tunnel the operator runs) can
reach; what does not exist is an authorised Web connection.

## Preflight: the read-only check before anyone installs

```
node tools/dsh-direct/preflight.mjs --config <config.json> [--port 42731] [--json] [--strict]
node tools/dsh-direct/preflight.mjs --alone            # package + docs only
```

| check | fails when |
|---|---|
| `package.manifest` | `name`, `type`, `main`, `version`, `files[]` or `dsh.bundle.patch` is missing |
| `package.imports` | a module reachable from `main` is absent, or is not covered by `files[]` |
| `package.patch` | the Cordis patch does not insert this plugin id |
| `cordis.compat` | the installed `@deepseek-ai/cordis` does not satisfy `peerDependencies.cordis` |
| `config.schema` | both/neither locator, a non-loopback URL, a privileged port, no binding |
| `config.token` | the token file is missing or shorter than 32 characters (contents never printed) |
| `endpoint.locate` | the descriptor is absent, unreadable, or not a descriptor |
| `endpoint.identity` | the port answers as a different kind, protocol, or `endpointId` |
| `port.availability` | the port is out of range or unprobeable (`warn` when it is occupied) |
| `docs.consistency` | the install document teaches a field the server does not read, names two token paths, mentions `port: 0`, or never mentions `endpointFile` |
| `install.state` | never: reports package-directory and profile-text presence only, not activation; writes nothing |

Exit code 0 when nothing failed, 1 otherwise, 2 for bad flags. `--strict` turns `warn` into failure.

## Tests

```
node test_t271_dsh_direct.mjs              # tool surface, binding, duplicate requestId, refusal
node test_t271_dsh_direct_hardening.mjs    # loopback/token, capabilities, worktree precheck, restart, unsettled
node test_t272_session_api.mjs             # rc.2 shapes, error mapping, admission scan, text extraction
node test_t272_reconcile.mjs               # lost response -> unsettled -> reconcile, exactly one admission
node test_t272_plugin.mjs                  # apply/dispose, binding filter, fail-closed, copy drift
node test_t273_endpoint.mjs                # descriptor lifecycle, bind_failed, follow a restart, stale-port identity
node test_t273_preflight.mjs               # every preflight check, including the defects it was written for
node test_t273_plugin_config.mjs           # listener rules, unload releases the port, bind_failed at the plugin level
node test_t274_http_transport.mjs          # Streamable HTTP over a real socket: session, Origin, auth, 202/405/413/504,
node test_t275_http_interop.mjs            # 415 media type, no 2024-11-05 claim, -32602 initialize, 429, 504 lock semantics
                                           # SSE framing, and a full submit→result→duplicate run against a fake Host
node test_t276_session_history.mjs          # fixed snapshot, real cursor semantics, request/turn/final result correlation
node test_t276_task_lifecycle.mjs           # idle admission, delayed get_result refresh, terminal failure, busy reconcile
```

The reconcile suite injects the failure that matters: the fake Host **admits** the prompt and then throws on the way
back. The assertions are that the task is `unsettled`, the session is still busy, `get_result` refuses, and
`admissions().length === 1` after reconcile — one admission for the whole episode, in both the "log already has the
rpcId" and the "re-prompt with the same id" paths.
