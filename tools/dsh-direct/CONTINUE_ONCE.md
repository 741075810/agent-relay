# Finite same-session continuation caller

`continue_once.mjs` exports `createContinueOnce` and `continuationRequestId`. It calls the existing
`DirectServer` public methods, not a new transport. Import/construction does not read configuration,
secrets or session files, launch a server, arm a goal, or submit a prompt. `enabled` defaults false.

## Explicit caller contract

Inject an already configured, trusted `DirectServer` (or a wrapper preserving its exact method
semantics) as `client`. Its existing binding, task ledger and Host admission checks remain in force.
Do not substitute bare `HostClient.prompt`: that bypasses the task ledger. Only one owner may operate
that ledger/session. This runner does not add cross-process fencing or a durable scheduling service.

```js
import { createContinueOnce, continuationRequestId } from './continue_once.mjs';

// priorTask is an exact DirectServer task receipt, never inferred from time or prompt text.
const trigger = Object.fromEntries(
  ['taskId', 'requestId', 'sessionId', 'projectId', 'turnId'].map(k => [k, priorTask[k]])
);
const runner = createContinueOnce({
  enabled: true, client: existingDirectServer, budgetMs: 10000,
  // Application-owned acceptance check; for development, check actual tests/HEAD/worktree too.
  verifyResult: async task => task.result.text === 'EXPECTED-RESULT',
});
const result = await runner.run({
  trigger,
  next: { requestId: continuationRequestId(trigger), sessionId: trigger.sessionId,
    projectId: trigger.projectId, prompt: approvedNextPrompt },
});
```

Requires a real previously recorded direct task. An arbitrary Bridge task or the current chat turn
has no automatic mapping to a direct task ID. Missing exact provenance is a blocker, not permission
to guess. The caller supplies authorization for this exact next task; a notice grant is irrelevant.

## One invocation, one opportunity

- Enabled invocation consumes the runner even on refusal; concurrent/second invocation returns
  `runner_used`. Disabled invocation touches neither client nor verifier.
- Input is snapshotted. The next ID must be the deterministic hash of the predecessor's exact
  session/task/request/turn. Do not change the trigger to evade a refusal. Stable IDs plus the
  unchanged DirectServer ledger retain duplicate/content-conflict checks across sequential restarts.
- `getResult` must return `ok`, exact identity, succeeded state, admission evidence, no unknown/error
  and no reconciliation requirement. In DirectServer, succeeded is set only after a matching completed
  terminal. That trust derives from the client implementation, not from a caller's fabricated JSON.
- An injected acceptance verifier must return literal true. Exceptions, incomplete results and
  mismatches stop without submit. Idle is not completion or acceptance evidence.
- A fresh `listSessions` must report exactly the original session/project with running=false and
  agentAvailable=true. DirectServer rechecks idle during submission; no busy-session queue is added.
- There is at most one `submitTask` call and no reconcile, retry, periodic polling or recursive next
  task. A recognized receipt returns `handoff_recorded`, taskId and duplicate flag. The next task's
  application completion remains **unverified**, even when its receipt state is succeeded.
- Unrecognized reply, exception or elapsed budget after invoking submit -> `submission_unknown`.
  Even explicit refusals thrown at that boundary are conservatively reported unknown; no retry follows.
  Preserve the original ledger/request ID for operator reconciliation, never replace the journal.

## Budget and lifecycle limits

`budgetMs` is an integer 1..120000 (default10000), measured monotonically. Each awaited operation uses
remaining total budget. Pre-submit expiration -> `preflight_unverified`; post-submit expiration ->
`submission_unknown`. This bounds the caller's asynchronous wait, **not cancellation of the underlying
operation**. An already invoked DirectServer operation may finish or admit after the runner returns;
keep its owner/ledger alive and treat it as unresolved. Synchronous blocking JS is not preempted.
Injected clients/verifiers must themselves have bounded, nonblocking I/O. Never start another owner
because this wrapper timed out.

No automatic service startup, completion event subscription, secret loading, live invocation CLI,
closed-page test, locked-desktop test, restart recovery service or 24/7 availability is included.
A future approved execution owner must invoke this once after exact completion; this module is that
callable step, not the resident trigger. The current active chat is not a target for a busy-session submit.

## Verification

```powershell
node --test --test-isolation=none --test-concurrency=1 --test-timeout=10000 test_t322_continue_once.mjs
```

Fixtures use actual DirectServer and TaskStore in generated temporary directories with the existing
in-process fake session-controller adapter. No socket, credential, installed config or live session is
used. Tests cover default-off, success, duplicate sequential restart, concurrency, conflicting next
content, rejected evidence/acceptance/busy/unknown idle, idle race, lost response and budget exhaustion.
These tests are not a live Host admission/result or unattended execution claim.
