# Bounded productive owner: prepared, deployment gate closed

The two-message Direct canary is not repeated. This module defines one productive campaign using
existing DirectServer/HostClient methods; it is **not a deployed 24/7 service**.

## Exact approved maintenance manifest

`productive_manifest.mjs` fixes the task, prompt and command; there are no arbitrary command/prompt
flags. `MANIFEST` has two jobs:

1. In `tools/dsh-direct/AFTER_TURN_ONCE.md`, replace the single prerequisite sentence requiring
   `pwsh` with `Windows PowerShell 5.1 or PowerShell 7`. All other bytes stay identical; no commit/push.
2. Read-only verification of that exact diff, then `powershell.exe -NoProfile -NonInteractive -File
   test_t331_scheduler_shell.ps1`. The external owner independently runs the pinned named test and
   requires exit0, unchanged HEAD, no staged/extra tracked or nonignored untracked changes, and the
   exact expected document bytes. Model prose is not acceptance.

The actual repository prerequisite is intentionally NOT edited by this delivery; that is the queued
productive task. Temporary-directory tests do not count as its live execution.

## Shipped entry point and missing admission gate

Node >=22 on Windows; existing config, state directory, session and grants are retained.

```powershell
node tools/dsh-direct/productive_owner.mjs
# {"code":"disabled","submitted":false}
node tools/dsh-direct/productive_owner.mjs --enable
# exit2; {"ok":false,"code":"writer_fencing_unavailable","submitted":false,...}
```

Both branches avoid credentials, ledger mutation and scheduling. There is no `--force`, lease JSON,
boolean override or process-list bypass. The existing `.completion-owner` lock only coordinates
cooperating CLI owners; old DirectServer instances use independent in-memory TaskStore snapshots and
write the entire ledger. `session/writer-held` protects the native storage writer, not exclusive
ownership among prompt callers. Idle checks are observations, not an atomic admission lease.

T337 adds mandatory operation-scoped `.direct-writer.lock` coordination and snapshot validation to
updated TaskStore/DirectServer entry points; [DIRECT_WRITER_BOUNDARY.md](DIRECT_WRITER_BOUNDARY.md)
defines that limited guarantee. It is not a campaign lease, does not upgrade installed/old binaries,
and does not fence raw Host/Bridge/native callers. The productive CLI remains blocked.

`runPreparedOwner` is an integration library, not a claimed installed lease API. Its trusted embedding
requires a real `lease.assertHeld({sessionId,stateDir})`, acquired **before constructing** the original
DirectServer/TaskStore, with enforcement at every ledger write and Host prompt admission. Supplying
`() => true` is not that enforcement. No compliant production embedding exists or was activated here.

Smallest next deployment step: put all Direct ledger access behind one authoritative serialized writer
(or make every writer enforce the same fenced lease), and enforce its generation/owner token at Host
admission for the bound session. Prove legacy/unfenced writers get a specific rejection BEFORE writing
or admitting a prompt. Bridge/manual session submissions must also obey that session ownership rule;
a process snapshot cannot establish this. Deploying such a gate needs explicit coordinated activation,
not a local lock file or source-only claim. This delivery changes no installed Host/Bridge configuration.

Only after that gate is real: use the corrected `Resolve-SchedulerShell` and current Interactive/Limited
principal for ONE production registration with PT30M ceiling, no restart, IgnoreNew and a fresh exact
originating native request/turn. Do NOT invoke `schedule_after_turn.ps1` for productive work as-is:
that action is hardwired to the T324 canary and PT5M. No productive scheduler registration is created.

## Engine contract and durable evidence

Trusted plan fields: `campaignId`, `sessionId`, `projectId` (exact native cwd), `repoRoot` (within that
project), `stateDir`, `campaignDir` (outside repository), `expectedHead`, `sourceRequestId`, `sourceTurnId`.
No file is inferred from task timing or prompt similarity. The lease-bound caller supplies the existing
HostClient and DirectServer objects. The engine checks all ledger tasks terminal and rejects any
preserved owner/uncertainty. The successful T324 journal remains untouched.

`openCampaign` creates a NEW exclusive directory; existing campaigns are never overwritten. Its
plan.json pins manifest, baseline HEAD/content/test hashes and deterministic job request IDs. Fsynced
JSONL events record source admission/terminal, admissibility, dispatch reservation BEFORE invocation,
receipt/task ID, exact native turn terminal and independent artifact/test acceptance before job2 can
advance. Hashes prove equality, not authenticated ownership. No model result text is copied.

Limits:2 tasks,900s/job,1800s activation including after-turn wait (max120s),1s observation interval,
30s maximum named-test subprocess,10s per Git command. Deadlines bound async observations; they do
not cancel an admitted prompt or a pending Direct callback. Synchronous checks can overrun an await
boundary; the future OS PT30M execution ceiling is required as the hard process bound. On any
incomplete/unknown result return `preserveOwnership:true`; caller keeps coordination evidence and
observes the exact existing task rather than releasing/replaying it.

Retries: **0**, intentionally within the requested maximum of one proven-non-admission retry. Neither
admitted/unknown nor failed tasks are retried. A provider403 stops the activation through the existing
terminal/error path. No provider probes or client-identity changes.

## Pause, stop, resume

Each campaign has a separate strict control.json, initially `{ "revision": 1, "mode": "run" }`.
The only fields are a monotonically increasing positive integer revision and mode run/pause/stop.

- pause blocks new job admission; observations of an already in-flight task may finish. Budgets keep
  running. Switching to run with a higher revision resumes the SAME living owner, no repeat prompt.
- stop prevents further admission, preserves any in-flight task and returns. It is not task cancellation.
- Unreadable/invalid/regressed controls stop rather than defaulting to run. A race at the last pause
  check stops that campaign. No stop/consent stored elsewhere is changed.
- Process restart/crash-resume is NOT implemented: existing campaign creation fails closed. Durable
  request/task/turn records support exact read-only diagnosis; no new campaign ID may be used to replay
  unresolved work. A future resume tool must observe those records before any dependent admission.

Control files and campaign directories are cooperative trusted-owner mechanisms, not a security
boundary against the agent account. Prompts request an allowlisted edit, but existing tools/grants
are unchanged. Git checks detect disallowed tracked/nonignored changes; they do not sandbox model
operations, inspect ignored/outside files, or prove absence of transient side effects. Such enforcement
is a separate deployment requirement before calling this a general unattended development service.

## Focused verification

```powershell
node --test --test-isolation=none --test-concurrency=1 --test-timeout=40000 test_t336_productive_owner.mjs
```

Tests use temp repositories and actual Git/Windows PowerShell/named test, not another fake model chain:
exact approved artifact acceptance; extra-file/wrong-content rejection; durable controls/exclusive
campaign creation; disabled/missing-fence paths touching no client. Full engine dispatch, lease
integration, scheduled execution and productive live task acceptance remain UNVERIFIED.
