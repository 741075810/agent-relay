# Continuation coordinator (offline prototype)

Purpose: hand a completed task to the **same** DSH native session, once, without a browser or a
ChatGPT page. This directory is a prototype plus its tests. **Nothing here is wired into
`extension/`**, nothing is scheduled, and no daemon starts by itself.

## What runs

```
tools/continuation/continuation_state.mjs   # job record: admit / lease / complete / recover
tools/continuation/eventsource.mjs          # durable mirror of completions + paged replay
tools/continuation/coordinator.mjs          # the state machine over those two
tools/continuation/transport_fake_bridge.mjs# the adapter seam, faked
tools/continuation/scenario.mjs             # ten-step timeline, prints as it goes
test_t095b152_continuation_coordinator.mjs  # 12 tests, no browser, no page
```

Run the timeline:

```
node tools/continuation/scenario.mjs
node test_t095b152_continuation_coordinator.mjs
```

## Authorisation, and what it is not

A continuation run needs a grant of its own:

```js
{ kind: 'continuation', sessionId: 'dsh-native-session-0001', epoch: 'epoch-A',
  armedAt: 1793446400000, expiresAt: 1793493200000, maxTasks: 8, scopes: ['repo:agent-relay'] }
```

The page-notice grants the popup arms (T058 `AUTOSEND`, T059 `AUTOTRIGGER`) authorise writing a
message into a conversation. They do **not** authorise running work in a session, so passing one is
refused with `wrong_authorisation_kind`. Two capabilities, two grants, deliberately not
interchangeable.

## User boundaries

* **Start** – construct the coordinator with `config.enabled: false` (the default), call
  `enable(grant)` yourself, then call `step()` when you want work to happen. There is no timer in
  this directory; a caller owns the loop.
* **Pause** – `disable('operator')`. Queued work stays queued; nothing is dispatched.
* **Stop** – `stop('operator')`. It is terminal for that process: `step()` answers `stopped` until a
  new coordinator is created.
* **Roll back** – delete the process. Because `checkpoint()` is the only durable state and it lives
  with the caller (no global file, no storage area is touched here), rollback is "do not restore the
  checkpoint". Nothing in `extension/`, the host, the queue, the ACK table, the grants or the page is
  affected by any of this.
* **Never** – run two coordinators against one checkpoint, and never restore a checkpoint into a
  process that already dispatched from a newer one: the lease is per-record, not global.

## Verification it provides

* one dispatch per completion, including across a restart and an event replay;
* a crash between the write-ahead lease and the reply becomes `unknown_outcome`, never a retry;
* a truncated `terminal-list` window (the host caps at ~40) raises `event_gap` and dispatches
  nothing until a whole window proves the source readable;
* the durable mirror can be replayed in pages (`scan`, 100 per page), so a backlog is not lost to the
  live window's cap;
* an unavailable transport claims nothing, so the event survives the outage;
* failure retries with backoff and then escalates;
* scope, expiry, session binding and the two termination conditions (per-run cap, grant cap) all
  refuse.

## Why there is still no real transport (T153, read-only evidence)

The DSH side of the Bridge is the installed package `@codex-bridge/dsh-desktop-connector` v1.0.0,
protocol `codex-bridge-dsh/1`. Read from that install:

* `transport.mjs` builds the interface with `net.createServer` — it is a **server**;
* its dispatch table, from the module sources, is exactly
  `pairing/state`, `pairing/request`, `pairing/revoke`, `project/sync`,
  `run/start`, `run/observe`, `run/steer`, `run/cancel`,
  `session/list`, `session/open`, `session/read`, `session/rename`, `session/event`;
* `index.mjs` also registers a POST route `/api/codex-bridge-desktop` that forwards a Bridge
  `client-request` into `clientRpc`.

Every one of those is the Bridge addressing DSH. There is no outbound call, no "list my tasks" and
no "submit a task" in that package, so a coordinator in this process has nothing supported to call.

The `mcp__Codex_Bridge__list_tasks|get_task|submit_task` tools are the **ChatGPT client's** tools.
They prove a capability of that client; they say nothing about the DSH host process, which registers
no such MCP client. Treating the two as the same thing is the mistake `transport_capability.mjs`
exists to make impossible.

`transport_capability.mjs` therefore takes a declaration instead of a guess:

```js
{ api: 'codex-bridge-dsh/1', version: '1.0.0', direction: 'inbound',
  docsRef: 'connector:transport.mjs + dispatch table',
  ops: { listTasks: false, getTask: false, submitTask: false, observeRuns: true } }
// -> code: 'direction_not_outbound'
```

and a well-formed outbound declaration with no injected client reports `client_absent`, with
`probeEnvironment()` returning `unavailable / no_supported_outbound_channel`. Submission is refused
twice over: `submit_not_authorised` without a `kind: 'continuation'` grant, and
`submit_not_implemented` even with one, because no supported submission path exists here.

The read-only adapter (`createReadOnlyAdapter`) is the only part that can be exercised: it pages
`list_tasks` by cursor, redacts task bodies, accepts both `tasks`/`items` and
`next_cursor`/`nextCursor` spellings, errors on malformed replies instead of returning an empty
list, and refuses any tool outside `list_tasks` / `get_task` before a call is made.

### What would make a real adapter possible

1. The Bridge publishes a **documented, outbound** interface for task read/submit (a client API, not
   its current DSH-facing server), with a version string and an auth scheme; then a declaration with
   `direction: 'outbound'` and that `docsRef` passes validation.
2. Or DSH is given an MCP client for the same Bridge MCP server the ChatGPT client already uses,
   with a token the operator issues; the adapter then takes that client as an injected dependency.
3. Either way the operator issues a `kind: 'continuation'` grant; page-notice grants (T058/T059) do
   not authorise execution.

## What it does not provide

* **No real transport.** `transport_fake_bridge.mjs` fakes `request/ack/unknown/failed`. Do not
  guess an interface from the host's binary or from an internal endpoint.
* **No Bridge ledger reader.** Reading the ledger's private JSON by guesswork is how wrong joins
  happen. The event source here is the mirror the coordinator maintains itself; a `LedgerAdapter`
  that pages over a *supported* source could replace it, and until one exists `event_gap` stays
  fail-closed.
* **No claim about a locked screen.** Whether ChatGPT produces a new turn by itself is a property of
  the site's session, not of this bookkeeping. That needs the operator-present acceptance run
  described in T151/T152 reports.
