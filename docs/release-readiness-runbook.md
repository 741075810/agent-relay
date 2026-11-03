# Reversible rollout runbook (T215/T216)

Every step is reversible, and each one states what proves it worked and what undoes it. Nothing here runs unattended:
the switches are marked **operator present**. Paths use `%LOCALAPPDATA%`, `EXT_INSTALL`, `HOST_INSTALL`, `REPO` so the
document can be published without publishing an account name.

**Read this first — two things this rollout cannot do by changing one file:**

1. The installed launcher builds the host command line itself and passes **only** `--state-dir <dir>\state` and
   `--manifest <dir>\host_manifest.json`, then Chrome's arguments. It contains no `--relay-url`, so a new `host.py`
   dropped beside it enables nothing. `readiness_audit.py` answers this from the launcher's bytes
   (`launcher.forwards_relay_flag`); today it is `False`.
2. The installed extension honours `postArm` but has no `postArmEpoch`/`postArmUsable`, so it would trust a verdict
   computed under a previous arm. Measured: `T150_EXT_ROOT=$EXT_INSTALL node test_t095b150_postarm_epoch.mjs` →
   3 of 6 fail; against the repo extension, 6/6 pass.

Both are operator-present steps (§4), and both must happen **before** the audit can return GO. The audit is a verdict on
the *new* install, never a ticket that lets the switch happen.

| Name | Meaning |
|---|---|
| `REPO` | this repository checkout |
| `EXT_INSTALL` | the directory the unpacked extension is loaded from |
| `HOST_INSTALL` | the directory holding the installed `host.py` and `host_launcher.exe` (today: the t044 tree) |
| `BRIDGE_DB` | `%LOCALAPPDATA%\CodexBridgeService\service.sqlite` |
| `LEDGER` | `%LOCALAPPDATA%\CodexBridgeService\AgentState\DSHDesktop` |
| `STATE` | the sampling host's state directory (holds `terminal-source.json`, `terminal-arm.json`) |
| `RELAY_DIR` | the relay service's own state directory (holds `relay.json`, `service.token`) |

## 0. Pre-flight — read-only, changes nothing

```powershell
# 0.1 what is installed, what is missing, and the verdict as it stands
python -B $REPO\tools\rollout\readiness_audit.py --audit `
  --repo-root $REPO --installed-root $HOST_INSTALL `
  --manifest $HOST_INSTALL\host_manifest.json `
  --bridge-db $BRIDGE_DB --state-dir $STATE --json | Tee-Object $env:TEMP\audit-before.json
```

Expect `"decision": "NO-GO"` today with `blocking_failed` = `installed_host_reads_relay`, `installed_host_arm_ms`,
`installed_ext_epoch_bound`, `launcher_passes_relay`. Record this file; it is the "before" evidence and the reference
the rollback in §6 is checked against.

```powershell
# 0.2 what the chain would report right now: against a copy, with nothing started
python -B $REPO\tools\rollout\shadow_observe.py --enable --repo-root $REPO `
  --bridge-db $BRIDGE_DB --ledger-root $LEDGER
```

Expect `read-only proof: refused:OperationalError (productionWrites=0)`, a candidate count, and a `deferred` count equal
to the runs with no terminal event (measured 2026-11-03: 70 candidates, 69 with a Bridge event, 1 without; the census
over all runs is 235 terminal, 112 without an event). If those numbers disagree, stop — the evidence path is not
behaving as audited.

## 1. Backup, before anything is replaced

```powershell
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$env:LOCALAPPDATA\DSH-relay-rollout-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item $HOST_INSTALL\host.py             "$backup\host.py"
Copy-Item $HOST_INSTALL\host_launcher.exe   "$backup\host_launcher.exe"
Copy-Item $HOST_INSTALL\host_manifest.json  "$backup\host_manifest.json"
if (Test-Path $HOST_INSTALL\python_path.txt) { Copy-Item $HOST_INSTALL\python_path.txt "$backup\python_path.txt" }
Copy-Item -Recurse $EXT_INSTALL             "$backup\extension"
if (Test-Path $STATE)     { Copy-Item -Recurse $STATE     "$backup\state" }
if (Test-Path $RELAY_DIR) { Copy-Item -Recurse $RELAY_DIR "$backup\relay" }
reg export "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify" "$backup\nmh.reg" /y
# a manifest of what was backed up, so the rollback can prove completeness rather than hope
Get-ChildItem $backup -Recurse -File |
  ForEach-Object { '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.FullName.Substring($backup.Length) } |
  Set-Content "$backup\SHA256SUMS.txt" -Encoding ascii
```

Success: `SHA256SUMS.txt` lists at least `\host.py`, `\host_launcher.exe`, `\host_manifest.json`, `\nmh.reg`, and the
whole `\extension\` tree; `(Get-ChildItem $backup -Recurse -File | Measure-Object Length -Sum).Sum` is non-zero.
Undo: nothing has changed yet — deleting `$backup` restores the previous state.

## 2. Turn every default-off switch off, explicitly

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'host_mirror|relay_service' } |
  Select-Object ProcessId, CommandLine
```

Expect no rows. A sidecar that survives a rollback keeps posting candidates to a service nobody is watching, so if
there are rows, stop and stop them by PID first.

## 3. Shadow traffic, while nothing is switched

```powershell
$tmp = Join-Path $env:TEMP ("relay-shadow-" + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item $BRIDGE_DB "$tmp\service.sqlite"          # the copy is what gets read; the original is never opened for write
node $REPO\tools\service\relay_service.mjs --state-dir "$tmp\svc"      # terminal 1; it prints base+tokenFile as JSON
node $REPO\tools\service\host_mirror.mjs --once `
  --host-script $REPO\host.py --python python `
  --origin chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ `
  --state-dir "$tmp\state" --ledger-root $LEDGER --bridge-db "$tmp\service.sqlite" `
  --native-root "$tmp\native" --manifest $REPO\host_manifest.example.json `
  --service-url http://127.0.0.1:<base port from terminal 1> --service-token-file "$tmp\svc\service.token"
```

Success: the sidecar's JSON reports `counts.candidates` equal to the runs in the ledger, and every candidate carries
`completedAtSource: bridge.task_events.task.<status>` or `unknown` — never a bare number. Undo: delete `$tmp`.

## 4. The one-shot switch — operator present, in this order

The order matters: each item makes the next one possible, and the audit is the exit criterion, not the entry.

1. **Rebuild the launcher with relay flags.** `launcher/HostLauncher.cs` must append `--relay-url` and
   `--relay-token-file` (from a file beside the launcher, e.g. `relay.txt`, so the token is not in the command line).
   Build with `launcher\build_launcher.ps1`, then update the pinned hash the preflight checks. Until this binary is
   replaced, no other step can enable relay.
2. **Install the new host** into a new directory, leaving the old one untouched:
   `New-Item -ItemType Directory $HOST_INSTALL-next; Copy-Item $REPO\host.py $HOST_INSTALL-next\`.
3. **Reload the extension** from the build carrying `postArmEpoch`/`postArmUsable`
   (`$EXT_INSTALL\lib\terminal_trigger.js` must contain `postArmUsable`). This is the step that cannot be done
   unattended.
4. **Point the registration at the new directory** by updating `host_manifest.json`'s `path` (the reversible half of a
   swap), leaving `nmh.reg` untouched unless the manifest file itself moves.
5. **Start the relay service, then the sidecar**, on production paths, without `--once`:
   `node $REPO\tools\service\relay_service.mjs --state-dir $RELAY_DIR`
   then `host_mirror.mjs` with `--service-url`/`--service-token-file` pointing at `$RELAY_DIR`.
6. **Re-run the audit against the new install** — this is the gate:
   `python -B $REPO\tools\rollout\readiness_audit.py --audit --installed-root $HOST_INSTALL-next … --json`.
   Only a `GO` with an empty `blocking_failed` permits step 7.
7. **Write the arm snapshot exactly once**, with the operator watching the clock. All five flags are required:

```powershell
python -B $REPO\tools\service\arm_with_relay.py `
  --state-dir $STATE `
  --ledger-root $LEDGER `
  --relay-url http://127.0.0.1:<base port from step 5> `
  --relay-token-file $RELAY_DIR\service.token `
  --epoch <operator-chosen-epoch> --json
```

Success: exit code 0 and `"ok": true` with `sources` containing both `bridge_ledger` and `relay`; the written
`$STATE\terminal-arm.json` contains `armTakenAtMs`. Refusals are named and mean stop, not retry:
`relay_source_unavailable_for_arm` (the relay could not be read — the snapshot would silently omit runs),
`source_unavailable` (the ledger could not be read), `snapshot_truncated` (partial snapshot would make dropped ids look
new). Undo: §6 — the arm file is restored from `$backup\state`.

## 5. Acceptance, in this order (full matrix in `release-readiness-matrix.md`)

| # | Check | How | Pass |
|---|---|---|---|
| A1 | audit says GO on the new install | §4.6 | `decision: GO`, `blocking_failed` empty, `launcher.forwards_relay_flag: true` |
| A2 | candidates carry provenance | sidecar output | every `completedAt` has a `bridge.task_events.*` source, or is `unknown` |
| A3 | nothing from before the arm is offered | one `terminal-list` after §4.7 | a run finishing before `armTakenAtMs` is absent; `relayDeferred`/`relayAbsenceRefused` account for it |
| A4 | a post-arm run is offered once | next `terminal-list` after a real completion | one candidate, `postArmEvidence: relay_completed_at` |
| A5 | ACK idempotency | `terminal-ack` with the bare run id, then `terminal-list` | it does not come back |
| A6 | restart | stop/start service and host | the ACKed run stays gone; a deferred run stays deferred |
| A7 | disconnect | stop the service, one `terminal-list` | `relayCode: relay_unavailable`; no candidate invented |
| A8 | page delivery | watch the popup and the page | `pageDelivery` still `unknown`; a host ACK is **not** reported as delivery |

Any failed A-item is a rollback, not a debugging session on production.

## 6. Rollback — one block per layer, newest first

```powershell
# 6.1 stop the two new processes
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'host_mirror|relay_service' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 6.2 restore the registration, the manifest and (if it was touched) the interpreter pointer
reg import "$backup\nmh.reg"
Copy-Item "$backup\host_manifest.json" $HOST_INSTALL\host_manifest.json -Force
if (Test-Path "$backup\python_path.txt") { Copy-Item "$backup\python_path.txt" $HOST_INSTALL\python_path.txt -Force }

# 6.3 restore the binaries the launcher actually executes
Copy-Item "$backup\host.py"           $HOST_INSTALL\host.py -Force
Copy-Item "$backup\host_launcher.exe" $HOST_INSTALL\host_launcher.exe -Force

# 6.4 restore the extension, only if §4.3 replaced it
Remove-Item -Recurse -Force $EXT_INSTALL; Copy-Item -Recurse "$backup\extension" $EXT_INSTALL

# 6.5 prove the restore rather than assume it
Get-ChildItem $backup -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | ForEach-Object {
  $rel = $_.FullName.Substring($backup.Length)
  $target = if ($rel -like '\extension\*') { $EXT_INSTALL + $rel.Substring(10) } else { $HOST_INSTALL + $rel }
}
Get-Content "$backup\SHA256SUMS.txt" | ForEach-Object { $hash, $rel = $_ -split '  ', 2
  if ($rel -notlike '\nmh.reg') { "$rel  {0}" -f (Get-FileHash ($HOST_INSTALL + $rel) -Algorithm SHA256).Hash -eq $hash } }
```

Complete verification is the audit, not a hash list:

```powershell
python -B $REPO\tools\rollout\readiness_audit.py --audit --installed-root $HOST_INSTALL --json |
  Tee-Object $env:TEMP\audit-after.json
```

Success: `audit-after.json`'s `blocking_failed` equals `audit-before.json`'s, field for field, and
`launcher.forwards_relay_flag` is back to its original value. The state directory is **kept**: it records what was
already announced, and deleting it would replay history. Undo of the rollback: re-apply §4 from `$backup`.

## 7. What must never be done during a rollout

* no synthetic terminal event, no replay of a historical completion, no back-fill of `completedAt`;
* no hand-editing of `terminal-arm.json` or the consent store to "pre-arm" anything;
* no copying `service.token` outside `$RELAY_DIR` (`randomBytes(24)`, mode 0600, minted once per state dir);
* no pointing the sidecar at another account's ledger;
* no treating a host ACK as page delivery in any report;
* no editing `host_manifest.json` to a path the launcher is not actually installed at — the launcher resolves
  `host.py`, `state\` and `python_path.txt` **relative to its own directory**, so a manifest that names a different
  directory silently runs the old host.
