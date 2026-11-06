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
| `page` | `SessionPageRequest { address: { kind: 'session', sessionId }, throughSeq, beforeSeq?, maxMessages?, turnWindow? }` | `SessionPage { records, hasMore }` | `lib/index.js:1417`; `throughSeq === -1` means "newest" |

`SessionSummary = { agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`.
**There is no `projectId`** — `cwd` is the identity a caller can bind to.

T271 guessed `listSessions` / `getEvents({sessionId,turnId,cursor})`. Those never existed in rc.2. `adapters.mjs` now
requires `list`/`prompt`/`page` and reports a build that only has the guessed names as
`host_capability_missing` + `legacyGuessPresent`.

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
| prompt accepted | `running` → `succeeded` | held until terminal | nothing |
| Host explicitly refused (`session/writer-held`, `session/agent-busy`, `gateway/bad-request`, `session/not-found`, …) | `failed` | released | fix the cause, submit again |
| no answer (`host_unreachable`, `host_error`, `cancelled`, `internal`) | **`unsettled`** | **kept** | `reconcile_task` |
| process restart while active | `unknown` (`unknownReason: process_restart`) | kept | `get_task` |
| process restart while `unsettled` | `unsettled` (unchanged) | kept | `reconcile_task` |

`get_result` refuses an unsettled task with `task_unsettled`: an unknown outcome is not a result.

`reconcile_task` then settles it in the cheapest correct order:

1. scan the durable log for the requestId; found → the earlier attempt was admitted, go straight to collecting;
2. otherwise re-submit **the same** `requestId` with the original text, which the Host acknowledges without inserting
   a second message. The text is not stored here (only `promptSha256`), so the caller must pass `prompt` and it must
   hash to the recorded digest, otherwise `invalid_arguments`.

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
mcp_server.mjs    stdio JSON-RPC; five tools: list_sessions, submit_task, reconcile_task, get_task, get_result
preflight.mjs     read-only deployment check (package, Cordis version, config, endpoint, port, docs)
plugin/           the installable Cordis plugin (see INSTALL-WINDOWS.md)
```

Tools: `list_sessions`, `submit_task`, `reconcile_task`, `get_task`, `get_result`.

## Installing into the Desktop

The plugin half is packaged and tested, but **it is not installed on this machine**. `INSTALL-WINDOWS.md` has the
exact steps; they are labelled as not performed, because installing requires a Desktop restart and a production
profile change.

## Acceptance levels — keep them apart

| level | meaning | status |
|---|---|---|
| **A** | the plugin, the MCP server and the preflight verified in isolation against a fake Host and a fake Cordis context | **done**, `test_t271_*` … `test_t273_*` |
| **B** | the real Desktop Host loads the plugin and serves the bridge on loopback | **not done** — needs the operator to install |
| **C** | an existing session received a real prompt through that bridge | **not done** — needs B |

The MCP server is a working stdio MCP server, and it is **not** registered with ChatGPT's custom-MCP settings: that
registration is a Web-side action, and a Web client needs an HTTPS transport while this bridge binds loopback only.
Stdio works for a desktop MCP client that launches the process itself. That boundary is stated here rather than implied
away by a working local server.

Everything in this directory is level A. No claim in the repo says otherwise.

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
| `install.state` | never: it only reports whether the plugin is installed, and writes nothing |

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
```

The reconcile suite injects the failure that matters: the fake Host **admits** the prompt and then throws on the way
back. The assertions are that the task is `unsettled`, the session is still busy, `get_result` refuses, and
`admissions().length === 1` after reconcile — one admission for the whole episode, in both the "log already has the
rpcId" and the "re-prompt with the same id" paths.
