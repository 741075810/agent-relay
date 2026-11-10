# Auditable Windows one-shot owner

`schedule_after_turn.ps1` registers a uniquely named `DSH-Canary-Once-<guid>` task only with
`-Enable -ExclusiveLedgerConfirmed`. Default invocation is inert. The task runs current user's
Interactive token with Limited run level, no password, no highest-privilege elevation, one trigger,
no retries, IgnoreNew overlap policy and a5-minute scheduler execution ceiling. It needs an already
logged-on user; it is not a service and does not promise execution after logout or machine sleep.

The payload `after_turn_once.mjs` waits up to120s for the EXACT originating native request/turn to
complete successfully, then requires the original bound session idle+available and unchanged ledger
eligibility. It invokes existing T324 bootstrap once (separate120s canary budget). Source-native
request is only a post-turn barrier, not a fabricated Direct source task. Bootstrap creates its own
Direct seed and records both canary receipts/results.

## Prerequisites and plan

Node >=22, pwsh, ScheduledTasks cmdlets and running Schedule service; existing Direct config/ledger,
existing credential file, original session, and exclusive ownership of that Direct ledger. All tasks
in tasks.json must be terminal succeeded/failed and not require reconciliation. Preserved owner or
canary journal blocks launch. Never change/delete these records to pass. The module intentionally
does not automatically reconcile any old Direct task.

Create a private plan outside the repository from independently verified exact native request/turn
provenance. The installed Bridge connector forwards requestID as sessionController.prompt requestId;
this identity can be used with HostClient.getEvents. Do not substitute a Bridge task_id, timestamps,
latest result or prompt similarity. Use the exact turnId encoding returned by the supported direct
history API, not a guessed integer/string conversion. Unknown provenance means do not arm.

```json
{
  "configPath": "<absolute existing dsh-direct config.json>",
  "sessionId": "<exact original bound session>",
  "projectId": "<exact session cwd>",
  "requestId": "<exact originating native requestId>",
  "turnId": "<exact originating native turnId>",
  "expiresAt": 0,
  "auditFile": "<new absolute private path for start audit>"
}
```

Set expiresAt to an explicit near-future Unix millisecond deadline covering the expected turn end;
zero is deliberately invalid. The scheduled payload starts20s after registration, waits at most120s
and stops if this turn is still busy. It never schedules a second try. Register only when this finite
window is appropriate; no positive idle/turn evidence means refusal, not forced submission.

```powershell
# Default-off check (no registration, config, secret or task access):
pwsh -NoProfile -File tools/dsh-direct/schedule_after_turn.ps1
# Explicit operator-authorized one-shot, after ownership and exact plan evidence established:
pwsh -NoProfile -File tools/dsh-direct/schedule_after_turn.ps1 -Enable -ExclusiveLedgerConfirmed -Plan "<absolute private plan.json>"
```

`ExclusiveLedgerConfirmed` is an explicit caller assertion, not fencing. Registration and execution
also refuse identifiable node processes running direct MCP/owner/bootstrap scripts. That bounded
process check is not a global proof: other clients do not honor this ownership protocol. Do not use
it while another Direct ledger writer remains active, and do not stop a live service to force passage.

## Audit and preservation

All audit files are beside the plan: `.registered` exclusive registration-attempt marker,
`.registration.json` (task name, trigger, account), `.attempt` exclusive execution marker,
`.output.txt` (sanitized bootstrap/refusal output), `.cleanup.txt`. `auditFile` records exact native
request/turn and bootstrap start. Existing T324 journal inside stateDir records exact seed/successor
receipts/result evidence. No token contents or model transcripts are logged; canary output remains
subject to the existing T324 redaction. This is a trusted private caller plan, not an untrusted input API.

Normal payload completion or refusal executes finally and unregisters only its own exact task name
when description matches this plan. It never deletes a prior reservation, journal or audit marker.
If the OS kills the process at its ceiling, finally is not guaranteed: report cleanup UNVERIFIED,
inspect the exact registration, and remove only that registration after confirming it is stopped.
It has no repeat trigger; do not rerun the same plan or remove attempt markers to manufacture eligibility.

```powershell
Get-ScheduledTask -TaskName '<exact name from registration.json>'
Get-ScheduledTaskInfo -TaskName '<exact name from registration.json>'
# Only if stopped and cleanup failed; never use a wildcard:
Unregister-ScheduledTask -TaskName '<exact name from registration.json>' -Confirm:$false
```

A timeout is not rejection/cancellation of a prompt already admitted. Preserve all bootstrap evidence;
no automatic retry, credential change, session creation, consent rearm, extension reload or Host restart.

## Scheduler executable validation

The launcher resolves the shell from the running PowerShell edition: Desktop uses
`powershell.exe`; Core uses `pwsh.exe`. It verifies the executable exists before creating
any registration marker. Concatenating `pwsh.exe` to a Desktop `$PSHOME` produces a nonexistent
action and scheduler error `0x80070002`, before the payload or its cleanup can run.
Run `test_t331_scheduler_shell.ps1` for temporary-directory selection checks and a real
default-off child invocation. Fixing source does not change an existing scheduled action;
never rerun an old registration or erase its markers as an implicit retry.

## T328 measured limitation

Scheduler service/cmdlets were available, but the existing Direct ledger contained a task still marked
running. This prevented safe arming. No registration was created and no canary was launched. Disabled
CLI, parser and isolated guard tests are verified; actual ScheduledTask registration/execution and live
two-task acceptance remain untested. An external authorized read-only reconciliation of that exact
old task's result is the next step, not deleting its ledger row or scheduling around it.
