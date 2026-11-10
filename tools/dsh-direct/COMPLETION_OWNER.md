# Finite completion-triggered owner (T323)

This foreground command connects the existing DirectServer read/result API to T322's continue_once.
It observes ONE exact recorded Direct task, waits for completion and confirmed idle, submits at most
one approved successor, verifies that successor result and exits. It is not a daemon, Host plugin,
Bridge adapter, schedule installation or browser extension. Default invocation does no I/O:

```powershell
node tools/dsh-direct/completion_owner.mjs
# {"code":"disabled","submitted":false}
```

## Start procedure

Use Node >=22, the existing dsh-direct configuration/credential, and its ORIGINAL task ledger.
Before starting, give this foreground process exclusive ownership of the direct ledger/session;
other DirectServer processes do not honor this command's lock. Do not stop existing services to
force that condition. If ownership is unavailable, postpone launch.

1. Obtain sourceTaskId from an actual earlier DirectServer submit_task receipt. A Bridge task ID,
   current chat ID, prompt text or observed timestamp is not a Direct task. No mapping is invented.
2. Approve a next prompt and expected exact source/successor result text in advance. Store a private
   plan outside the repo. SHA256 below means UTF-8 exact text, without automatic trimming/newline.
   Hash is an acceptance check, not authenticated provenance. For development this minimal CLI supports
   exact-result acceptance only, not a general test-command evaluator or arbitrary shell execution.
3. Use the existing config (endpointFile/tokenFile/stateDir/session binding); do not copy a token into
   the plan. The command loads that credential only through the existing HostClient when enabled.
4. Launch the foreground command below. It may start while the source Direct task is running: only
   reads happen until its successful result is verified and its SAME session is confirmed idle.

Plan schema (replace every placeholder from exact receipts/approved text; unknown values mean stop):

```json
{
  "sourceTaskId": "<exact Direct taskId>",
  "sessionId": "<original sessionId>",
  "projectId": "<exact task projectId and session cwd>",
  "nextPrompt": "Reply exactly DIRECT-ONE-OK. Do not call tools or start another task.",
  "sourceResultSha256": "<64 lowercase hex: approved source result>",
  "successorResultSha256": "<64 lowercase hex: DIRECT-ONE-OK>"
}
```

```powershell
node tools/dsh-direct/completion_owner.mjs --enable --config "$env:DSH_HOME\dsh-direct\config.json" --plan "E:\ApkTest\.nixiang-analysis\approved-owner-plan.json"
```

This is a start procedure, NOT a statement that the plan exists or the command ran on the live session.
No command in this document creates a new session or new credential. An absent source task is a refusal.

## Runtime contract

- CLI overall async deadline120s; read polling every1s; underlying HostClient request timeout3s.
  No overlapping read polls; only task_not_finished is polled again. Other errors stop.
- Source identity comes from getTask in the existing ledger; getResult must join request/session/project
  and a succeeded same-turn result with admission evidence. Existing non-null turn ID must still match.
- Idle wait requires exactly one original session with matching cwd, running=false and agentAvailable=true.
  continue_once and DirectServer recheck before submission; an idle race stops rather than resubmits.
- Stable successor request ID comes from continuationRequestId; the existing journal handles duplicate
  intent. No reconcile_task, repeated submit, new request key, or history reset exists in this owner.
- After a recognized submit receipt, owner polls ONLY that exact successor task result, checks its
  session/request/terminal/admission and expected text hash. Output `successor_verified`/exit0 means
  both predecessor and successor acceptance passed. Receipt alone is not a completed task.
- CLI acquires an exclusive `.completion-owner` directory inside stateDir before constructing the ledger
  client. Existing directory refuses startup. It is removed only after fully verified success; on all
  other outcomes it remains for explicit operator reconciliation. No automatic stale-lock reclaim.
  This prevents cooperating owner instances, not unrelated legacy clients or writers.
- Exceptions after submit or lost reply are unresolved; output is sanitized (no prompt/result/token).
  The process does not retry. Preserve task ledger and owner reservation; do not launch another owner.
- A deadline bounds asynchronous waiting, not forced cancellation of in-flight I/O. HostClient has a
  bounded request timeout; already admitted tasks may run beyond the command's wait. Pending operations
  may finish after owner.run returns, and synchronous code is not preempted. The retained reservation
  prevents this being represented as safe to rerun.

## Library and test boundary

`createCompletionOwner({enabled:false,client,deadlineMs:120000,intervalMs:1000}).run(plan)` is an
injectable single-use operation. Bounds: deadline1..300000ms, interval1..10000ms. Library callers own
exclusive ledger/process lifecycle themselves; only CLI acquires the filesystem reservation.

Tests use real DirectServer, TaskStore and continuation runner with the existing in-process fake Host.
No installed configuration or secrets are read. Two tests cover running source -> completion -> idle
wait -> one successor -> verified result, plus default-off, source mismatch, rejected result, busy
expiry and lost submission reply. They do not prove live Host compatibility or locked-screen operation.

The installed Host inspected for T323 has /events and /admission GET snapshots, not subscription/SSE.
The configured goal-round-driver is not an exposed Direct-task subscription hook. No supported hot
registration API was demonstrated, so this owner uses documented reads rather than patching the Host.

Path to24/7: actual authorized source receipt + exclusive foreground owner first; then separately
approve a resident lifecycle/event owner and richer project acceptance policy, stop/pause controls,
restart reconciliation and machine availability tests. T323 installs none of that lifecycle policy.
