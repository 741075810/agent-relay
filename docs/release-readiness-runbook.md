# Reversible rollout runbook (T215)

Every step is reversible, and each one states what proves it worked and what undoes it. Nothing here runs unattended:
the switches are marked **operator present**. Paths use `%LOCALAPPDATA%`, `EXT_INSTALL`, `REPO` so the document can be
published without publishing an account name.

Placeholders:

| Name | Meaning |
|---|---|
| `REPO` | this repository checkout |
| `EXT_INSTALL` | the directory the unpacked extension is loaded from |
| `HOST_INSTALL` | the directory holding the installed `host.py` (today: the t044 tree) |
| `BRIDGE_DB` | `%LOCALAPPDATA%\CodexBridgeService\service.sqlite` |
| `LEDGER` | `%LOCALAPPDATA%\CodexBridgeService\AgentState\DSHDesktop` |
| `STATE` | the sampling host's state directory (holds `terminal-source.json`, `terminal-arm.json`) |

## 0. Pre-flight, no changes

```powershell
# 0.1 what is installed, what is missing, and the verdict
python -B $REPO\tools\rollout\readiness_audit.py --audit `
  --repo-root $REPO --installed-root $HOST_INSTALL `
  --manifest $HOST_INSTALL\host_manifest.json `
  --bridge-db $BRIDGE_DB --state-dir $STATE
```

Expect `NO-GO` today, with `blocking_failed` naming the installed host's missing `--relay-url`/`armTakenAtMs` and the
installed extension's missing epoch binding. Record the output; it is the "before" evidence.

```powershell
# 0.2 what the chain would report right now, against a copy, with nothing started
python -B $REPO\tools\rollout\shadow_observe.py --enable --repo-root $REPO `
  --bridge-db $BRIDGE_DB --ledger-root $LEDGER
```

Expect `read-only proof: refused:OperationalError (productionWrites=0)`, a candidate count, and a `deferred` count equal
to the runs with no terminal event (235 terminal runs, 112 without an event, measured 2026-11-03). If the two numbers
disagree, stop: the evidence path is not behaving as audited.

## 1. Backup, before anything is replaced

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$env:LOCALAPPDATA\DSH-relay-rollout-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item $HOST_INSTALL\host.py            "$backup\host.py"            # the host being replaced
Copy-Item $HOST_INSTALL\host_launcher.exe  "$backup\host_launcher.exe"
Copy-Item $HOST_INSTALL\host_manifest.json "$backup\host_manifest.json"
Copy-Item -Recurse $EXT_INSTALL            "$backup\extension"
if (Test-Path $STATE) { Copy-Item -Recurse $STATE "$backup\state" }
# the registration itself, so it can be restored verbatim
reg export "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify" "$backup\nmh.reg" /y
```

Success: `$backup` contains `host.py`, `host_launcher.exe`, `host_manifest.json`, `extension\`, `state\`, `nmh.reg`,
and `Get-ChildItem $backup -Recurse | Measure-Object Length -Sum` prints a non-zero total. Undo: nothing has changed
yet — deleting `$backup` restores the previous state.

## 2. Turn every default-off switch off, explicitly

```powershell
# the sidecar must not be running before the switch, and neither must the service
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'host_mirror|relay_service' } |
  Select-Object ProcessId, CommandLine
```

Expect no rows. If there are rows, stop and kill them by PID — a sidecar that survives a rollback keeps posting
candidates to a service nobody is watching.

## 3. Shadow traffic, while nothing is switched

Run the sidecar against a **copy** of the database, pointed at a throwaway service, for one observation window:

```powershell
$tmp = Join-Path $env:TEMP ("relay-shadow-" + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item $BRIDGE_DB "$tmp\service.sqlite"
node $REPO\tools\service\relay_service.mjs --state-dir "$tmp\svc"      # terminal 1, ephemeral port
node $REPO\tools\service\host_mirror.mjs --once `
  --host-script $REPO\host.py --python python --origin chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ `
  --state-dir "$tmp\state" --ledger-root $LEDGER --bridge-db "$tmp\service.sqlite" `
  --native-root "$tmp\native" --manifest $REPO\host_manifest.example.json `
  --service-url http://127.0.0.1:<port from terminal 1> --service-token-file "$tmp\svc\service.token"
```

Success: the sidecar's JSON reports `counts.candidates` equal to the number of runs in the ledger, and each candidate
carries `completedAtSource: bridge.task_events.task.<status>` or `unknown` — never a bare number. Undo: delete `$tmp`.
The production database was copied, never opened for writing.

## 4. The one-shot switch (operator present)

Only after `readiness_audit.py` reports **GO** against the *new* install:

1. Replace the host binary in a **new** directory, leave the old one in place:
   `New-Item -ItemType Directory $HOST_INSTALL-next; Copy-Item $REPO\host.py $HOST_INSTALL-next\`.
2. Point the launcher at the new directory by editing `host_manifest.json`'s `path` **or** by installing a launcher
   built from `REPO\launcher\`. Changing the manifest is the reversible half of a launcher swap.
3. Reload the extension from the build that carries `postArmEpoch` (`extension/lib/terminal_trigger.js`
   `postArmUsable`). This is the only step that cannot be done unattended, and it must not be done by an agent.
4. Start the service and the sidecar with production paths, in that order:
   `node $REPO\tools\service\relay_service.mjs --state-dir $STATE\relay` then the sidecar without `--once`.
5. Write the arm snapshot exactly once, with the operator watching the clock:
   `python -B $REPO\tools\service\arm_with_relay.py --state-dir $STATE --epoch <epoch>`
   Confirm `terminal-arm.json` contains `armTakenAtMs` and that `armPrecision` reports `ms`.

## 5. Acceptance, in this order (see `release-readiness-matrix.md` for the full matrix)

| # | Check | Command / observation | Pass |
|---|---|---|---|
| A1 | audit says GO | `readiness_audit.py --audit …` | `verdict: GO`, `blocking_failed` empty |
| A2 | candidates carry provenance | sidecar output | every `completedAt` has a `bridge.task_events.*` source or is `unknown` |
| A3 | nothing pre-arm is offered | one `terminal-list` after the arm | a run that finished before `armTakenAtMs` is absent, and `relayAbsenceRefused`/deferred counts account for it |
| A4 | a post-arm run is offered once | next `terminal-list` after a real completion | appears once, `postArmEvidence: relay_completed_at` |
| A5 | ACK idempotency | `terminal-ack` with the bare run id, then another `terminal-list` | the run does not come back |
| A6 | restart | stop/start the service and the host | the ACKed run stays gone, a deferred run stays deferred |
| A7 | disconnect | stop the service, run one `terminal-list` | `relayCode: relay_unavailable`, no candidate invented |
| A8 | page delivery | observe the popup / page | `pageDelivery` still reports `unknown`; a host ACK is **not** presented as delivery |

Any failed A-item is a rollback, not a debugging session on production.

## 6. Rollback, one command per layer, newest first

```powershell
# 6.1 stop the two new processes (identified by their command lines, then by PID)
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'host_mirror|relay_service' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 6.2 restore the launcher registration and the manifest
reg import "$backup\nmh.reg"
Copy-Item "$backup\host_manifest.json" $HOST_INSTALL\host_manifest.json -Force

# 6.3 restore the host and launcher binaries
Copy-Item "$backup\host.py"           $HOST_INSTALL\host.py -Force
Copy-Item "$backup\host_launcher.exe" $HOST_INSTALL\host_launcher.exe -Force

# 6.4 restore the extension only if step 4.3 replaced it
Remove-Item -Recurse -Force $EXT_INSTALL; Copy-Item -Recurse "$backup\extension" $EXT_INSTALL

# 6.5 keep the state directory: it records what was already announced. Deleting it would replay history.
```

Success: `readiness_audit.py --audit` returns the same `blocking_failed` list it printed in §0.1, and the popup shows no
candidate that was not there before the rollout. Undo of the rollback: re-apply §4 from `$backup`.

## 7. What must never be done during a rollout

* no synthetic terminal event, no replay of a historical completion, no back-fill of `completedAt`;
* no hand-editing of `terminal-arm.json` or the consent store to "pre-arm" anything;
* no widening of the relay token beyond the state directory it was minted in (`service.token`, 48 hex chars, mode 0600);
* no pointing the sidecar at another account's ledger;
* no treating a host ACK as page delivery in any report.
