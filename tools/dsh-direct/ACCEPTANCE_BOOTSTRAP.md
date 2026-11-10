# Explicit two-task Direct acceptance canary

Run `acceptance_bootstrap.mjs` from an external foreground terminal AFTER the active agent turn ends.
No delayed job, after-turn hook, daemon or schedule is installed by this module. Default invocation:

```powershell
node tools/dsh-direct/acceptance_bootstrap.mjs
# {"code":"disabled","submitted":false}
```

## Prerequisites

- Existing live Direct Host, configured token file and original bound session; no new credential/session.
- Original Direct ledger/stateDir already exists and has one owner. Other legacy DirectServer clients
  do not honor this CLI's reservation; establish exclusive ownership without stopping live services.
- Host positively reports original session idle and agent available. Busy/unknown is rejected immediately,
  not polled until this active Bridge turn ends. Never launch synchronously from that occupied turn.
- Explicit authorization for exactly the seed and successor canaries, no development/file-mutation task.
- No preserved `.completion-owner` reservation or prior same-session T324 journal. The command never
  removes an old reservation, rewrites a journal or generates a different key to bypass prior uncertainty.

## Post-turn start command

From the agent-relay repository, with the original session ID and its exact cwd from supported listing:

```powershell
node tools/dsh-direct/acceptance_bootstrap.mjs --enable --config "$env:DSH_HOME\dsh-direct\config.json" --session "$env:CANARY_BOUND_SESSION" --project "$env:CANARY_BOUND_CWD"
```

The session above is supplied explicitly: no session discovery fallback or new-session creation. This
command is a procedure, not evidence that it ran. Do not rerun a failed launch with a fresh stateDir.

## Actual chain

1. Acquire existing stateDir/.completion-owner exclusively; refuse an existing reservation.
2. Create exclusive canary-t324-<SHA256(sessionId)>.jsonl with owner-only requested mode. Existing journal
   refuses another canary campaign. Mode0600 is not a Windows ACL guarantee; existing private directory
   ownership is required. Journal rows are fsynced; no unconditional power-loss guarantee is claimed.
3. Read exact bound session via existing HostClient/DirectServer; require idle/available/matching cwd.
4. Persist seed reservation before the only seed submit. Stable requestId is seed-t324-<SHA256(sessionId)>.
   DirectServer persists its normal task receipt and rechecks admission. Prompt requests EXACTLY
   `DIRECT-SEED-OK`, no tools, files, goals or additional tasks.
5. Record exact seed task/request/session/project receipt; a turn may be unknown until result reads.
   Invoke existing T323 completion owner with that real taskId, never a Bridge/chat task ID.
6. Owner reads exact completed seed result, verifies text hash/admission and idle, then invokes T322
   once. Its deterministic successor requestId and Direct ledger prevent duplicate intent admission.
   Successor prompt requests EXACTLY `DIRECT-NEXT-OK` with the same no-tools instruction.
7. Record exact seed/successor turn, admission and result evidence. Only expected canary text is written
   to this extra journal; unexpected model text is not copied. Existing Direct ledger behavior is unchanged.
   `canary_verified` requires both exact results through the real task machinery, not just two ACKs.

No tools is a model instruction, not a new sandbox/permission profile. Existing permissions are unchanged.
The CLI does not prove absence of every possible side effect from output text alone. The fixed benign
prompts request no live development mutations; no arbitrary prompt flag is exposed.

## Bounds and uncertainty

Total async wait budget120s; owner poll1s; HostClient request timeout3s. At most one seed submit call
and one successor submit call. No reconcile or automatic retry. Timeout is not cancellation; an admitted
prompt may finish later. Keep original ledger/journal/lock on unknown or any incomplete outcome. Only
fully verified success removes the reservation this invocation acquired; journal remains permanently.
A synchronous stall is not preempted. No retry/recovery command is included.

Exit0: canary_verified. Exit2: start refused, incomplete or unknown; inspect sanitized output and exact
stored evidence without deleting it. This command is not a general recovery tool or 24/7 supervisor.

## Test versus live status

Tests use actual DirectServer, TaskStore, T323 owner and T322 runner with an existing fake Host. The
fixture customizes only fake model answer text to the fixed canaries. It proves chaining and guards,
not live model instruction adherence, Host compatibility or real same-session execution. Default-off
CLI is separately run. Enabled live CLI/OS journal lifecycle needs the explicitly authorized post-turn
acceptance; it has not been represented as executed merely because tests pass.

Installed Direct Host routes inspected expose read snapshots (/events,/admission), not after-turn
registration. No documented hot hook suitable for scheduling this canary after return was demonstrated.
A configured goal driver is not a Direct task receipt or a permission to inject into the current turn.
Therefore start externally after completion; no unmanaged waiting process is left behind.

Next lifecycle milestone after actual canary receipts: an explicitly approved long-lived owner with
productive task acceptance/stop policy and restart handling. This finite canary does not install that policy.
