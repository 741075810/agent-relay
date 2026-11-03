# Switch log (T217, 2026-11-03)

What was actually changed on the machine, in order, with the hashes that prove it. Everything here was done under the
operator's explicit approval for this round; nothing here is planned-but-not-done except the two items in §5.

## 1. Backup, and proof it restores

| | |
|---|---|
| directory | `%USERPROFILE%\..\chatgpt_handoff\217-backup-20261103-153213` (beside the install) |
| contents | 43 entries: `host.py`, `host_launcher.exe`, `host_manifest.json`, `host_manifest.cmd-backup.json`, `run_host.cmd`, `protocol.py`, `terminal_source.py`, `run_origin.py`, `com.dsh.notify.json.template`, `install_host.ps1`, `state\*` (5 files), `extension\` (whole tree), `nmh.reg` |
| verification | a copy of the backup was compared against `SHA256SUMS.txt`: **0 problems over 43 entries** |

`reg export` had to be called as `C:\Windows\System32\reg.exe`: a bare `reg` on this machine resolves to
`E:\program\python312\Scripts\reg.py` (Impacket), which wrote nothing and whose failure looked like a successful run in
the script's output. The runbook now names the full path.

Control path untouched: the Bridge database was read only (`mode=ro`, `query_only=1`), no DSH file was edited, and the
registry key was exported, never imported.

## 2. What was replaced

| file | before (sha256, first 16) | after | note |
|---|---|---|---|
| `host.py` | `4A68DF2477F46E8F` | `C5353F29E1ED5A30` | 53,303 B |
| `protocol.py` | `44D91CB427314A66` | `0CF7ED382741621A` | |
| `terminal_source.py` | `FD0764A5F48C296B` | `FF506D64B35A5667` | 43,330 → 66,611 B |
| `run_origin.py` | `F6E00C3AFC068D26` | `8C29F940178A5B42` | |
| `native_turns.py` | `03523E59487B0565` | unchanged | identical already |
| `relay_merge.py` | absent | `6400D92F1FCA2DA1` | new file |
| `host_launcher.exe` | `34CFE482D518C690` | **unchanged** | locked by a running host, see §4 |

Not touched: `host_manifest.json` (its `path` still names the same launcher), the registry key, the installed extension,
`state\` (the live arm snapshot and sampler state are the operator's, not this round's), `run_host.cmd`, `install_host.ps1`.

## 3. The mistake this round made, and what caught it

The first attempt replaced `host.py` alone. The installed `terminal_source.py` was two generations older, so the new host
called `sample(..., relay_source=...)` on a function that does not accept it:

```
TypeError: sample() got an unexpected keyword argument 'relay_source'
```

Nothing served that error to the extension: the running host had the old modules in memory, and the failure would only
appear on the next spawn — as an extension that silently stopped offering work. `tools/rollout/installed_chain_probe.py`
found it by starting the installed launcher against the installed modules and printing the reply's error message. The set
was then installed together and both configurations answered `ok: true`.

Two checks were added because of it:

* `readiness_audit.py` → `installed_modules_coherent` (host mentions the relay ⇒ `terminal_source.py` accepts
  `relay_source` **and** `relay_merge.py` exists), plus `arm_ms_supported` now looks in the module that writes
  `armTakenAtMs` instead of only in `host.py`, which had reported a capable install as incapable;
* `launcher_forwards()` reads both ASCII and UTF-16LE, because a .NET literal is UTF-16 and the ASCII-only scan called the
  freshly built launcher incapable.

## 4. Why the launcher is still the old binary

```
PID 16228  host_launcher.exe        (old, 34CFE482…, on disk)
PID 1896   python.exe -B -u …\host.py --state-dir …   (the live host)
```

The executable is locked by the live `host_launcher.exe` that Chrome started. It is not killed: that would drop the
native messaging port the extension is using. The file is replaced at the same moment the extension is reloaded, because
that is when Chrome releases the port — one operator action, two effects, no separate window where the chain is down.

Until then the launcher passes no relay flag, which is also why the relay stays off: there is no `relay.txt` in the
install, and the launcher would ignore one anyway.

## 5. Audit, before and after

| check | before | after |
|---|---|---|
| `installed_host_reads_relay` | FAIL | **ok** |
| `installed_host_arm_ms` | FAIL (also a false negative: scanned the wrong module) | **ok** |
| `installed_modules_coherent` | not yet a check | **ok** |
| `installed_ext_epoch_bound` | FAIL | FAIL |
| `launcher_passes_relay` | FAIL | FAIL (file locked, §4) |
| verdict | NO-GO | **NO-GO**, blocking: `installed_ext_epoch_bound`, `launcher_passes_relay` |

Evidence the installed bytes answer a request, both configurations, from a copy of the install with the real Bridge
database read-only:

```
A. new module set + old launcher : {"ok": true, "armEpoch": "cd06078d-…", "armPrecision": "activation",
                                   "armRelayCovered": false, "relayCode": null, "candidates": 0}
B. new module set + new launcher : {"ok": true, "armEpoch": "cd06078d-…", "armPrecision": "activation",
                                   "armRelayCovered": false, "relayCode": null, "candidates": 0}
```

`armPrecision: activation` is correct for the snapshot that is on disk: it predates millisecond boundaries, so the host
falls back to the activation instant rather than inventing a millisecond.

## 6. What the operator must do, in this order

1. Reload the unpacked extension at `chrome://extensions` from the directory carrying `postArmEpoch` / `postArmUsable`.
   This is what releases the launcher lock and installs the epoch binding; nothing in this repository can do either.
2. Say so; the launcher is then replaced (`4197B358…`), a `relay.txt` is written, the service and sidecar are started on
   production paths, the audit is re-run for `GO`, and one arm snapshot is written — the sequence in the runbook §4.

Nothing is claimed about page delivery: no message has been sent to any page this round, `pageDelivery` remains
`unknown`, and a host ACK is not delivery.

## 7. Rollback

```powershell
$backup = "$env:USERPROFILE\..\chatgpt_handoff\217-backup-20261103-153213"
Copy-Item "$backup\host.py" "$env:HOST\host.py" -Force
Copy-Item "$backup\protocol.py" "$env:HOST\protocol.py" -Force
Copy-Item "$backup\terminal_source.py" "$env:HOST\terminal_source.py" -Force
Copy-Item "$backup\run_origin.py" "$env:HOST\run_origin.py" -Force
Copy-Item "$backup\host_launcher.exe" "$env:HOST\host_launcher.exe" -Force   # only once the lock is gone
Remove-Item "$env:HOST\relay_merge.py" -Force
```

Then `readiness_audit.py --audit` must report the same `blocking_failed` as the "before" column of §5. State is kept:
deleting it would replay history.
