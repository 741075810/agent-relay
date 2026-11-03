# The switch itself (T219)

T217 got the modules in and stopped at the extension reload. T218 put the extension files in the directory Chrome loads.
The operator then pressed Reload. This is what happened next, in order, with the numbers.

## 1. The reload did happen, and it re-took the launcher

Chrome starts a native messaging host per connection, so the reload shows up as a new `host_launcher.exe`:

| | before the reload | after |
|---|---|---|
| `host_launcher.exe` | PID 16228, created 15:32 | **PID 11964, created 19:13:55** |
| live host | PID 1896 | **PID 38928, created 19:13:55** |
| `state\terminal-source.json` | last write 15:3x | 19:14:55 — the extension is talking to the new host |

The reload therefore released the old lock and immediately took a new one on the same file, because the binary on disk was
still the old one. That is the trap: "replace the launcher in the reload window" only works if the replacement happens
*inside* that window, and by the time the operator reports back, the window has closed again.

## 2. Replacing a locked executable without killing its process

A running image cannot be overwritten or deleted on Windows, but its **name** is a directory entry:

```powershell
Move-Item $INST\host_launcher.exe $INST\host_launcher.pre-t219.exe   # the live image keeps running from this name
Copy-Item $REPO\host_launcher.exe $INST\host_launcher.exe           # 4197B3581AC45CFD… 7,680 B
```

PID 11964 kept serving from the renamed file, so the port the extension is using never dropped; the *next* spawn gets the
new binary. No process was killed, no Chrome was restarted, nothing was asked of the operator for this step.

## 3. Service and sidecar on production paths

```
$INST\relay\                    relay.json, service.token (48 hex), writer.lock, both logs
$INST\relay.txt                 line 1 http://127.0.0.1:53066, line 2 …\relay\service.token
```

* The directory ACL was reset (`/inheritance:r /grant:r "<account>:(OI)(CI)F"`) so the token is not inherited from the
  install tree; the token itself is 48 characters and is never printed, never on a command line, and never in `relay.txt`
  — the launcher forwards a *path*.
* The service listens on **127.0.0.1:53066 only**; `GET /health` without the bearer token answers **401**.
* Both processes are started through `Win32_Process.Create`, not `Start-Process`. The first attempt used `Start-Process`,
  the shell that started it inherited the tool's pipes, and the job kill that ended that shell took the service down with
  it — the service was gone by the time the sidecar tried to post. Detached from this shell's handles, they survive:
  service PID 18664, sidecar PID 25716.

## 4. The sidecar mirrors the Bridge, and says where every instant came from

```
{"ok":true,"status":200,"candidates":74,
 "counts":{"runs":75,"candidates":74,"completed":69,"failed":5,"interrupted":0,"acked":74,
           "completedAtKnown":73,"completedAtUnknown":1},"accepted":74,"rejected":[]}
```

`completedAtSource` across those 74: `bridge.task_events.task.completed` 69, `bridge.task_events.task.failed` 4,
`unknown` 1 — never a bare number. `statusSource` is `bridge.run_facts.status` for all 74, `hostSource`
`native_host.terminal-mirror`, and `pageDelivery` is `unknown` for every one. The Bridge database is opened read-only by
the host's own reader; nothing here writes it.

## 5. Audit: GO, and the exit criterion was the audit

```
decision             : GO
blocking_failed      : (empty)
launcher.forwards_relay_flag : true
checks               : 12 of 12 ok
```

Including `installed_ext_epoch_bound` and `installed_modules_coherent` and `launcher_passes_relay`, all three of which were
the blockers in T217.

## 6. The probe wrote to the live state, and now cannot

`tools/rollout/installed_chain_probe.py` promised in its docstring that it "writes nothing to the state directory it is
given". It did: the host it starts samples with `--state-dir <dir>\state`, and that sample writes `terminal-source.json`
(and so `relayActivatedAt` / `relayBaselineIds` appeared in the live file at 19:32:55). The effect is conservative — an
earlier activation instant defers *more* candidates — but the promise was false and the write went to production.

Fixed: the probe copies the install directory to a temporary one and runs the copy (`"ranIn": "copy"`), verified by hash
before/after on the live `terminal-source.json` (`live state unchanged: True`). `--no-copy-state` exists for a caller who
wants the real directory and accepts the writes. It also now reports `not_executable` instead of dying with a traceback
when the file named `host_launcher.exe` is not runnable.

## 7. What is live, and what is not

| | state |
|---|---|
| host modules | new generation, coherent, serving |
| extension files | new build, 6/6 against the loaded directory |
| launcher on disk | **new** (`4197B358…`), forwards `--relay-url` when `relay.txt` exists |
| `relay.txt` | present |
| service + sidecar | running on loopback, Bridge read-only |
| live extension session | still served by **PID 11964**, started before the replacement, so this one session runs the pre-relay launcher until Chrome spawns a host again |
| arm snapshot | **untouched** — epoch `cd06078d-…`, `armPrecision: second`, `relayCovered: false` |

The relay is therefore deployed and proven — the probe through the new launcher answers `"relayActivation": "active"` — but
the *currently open* extension→host session is the old one. A host respawn (Chrome does it when the service worker's port
closes, or on another Reload) is what puts the new launcher in that path.

## 8. Why no arm snapshot was written

Arming is consent, and consent is the operator's. `arm_with_relay.py` will happily take an `--epoch` from whoever runs it,
which is exactly why an agent must not run it on its own initiative: a snapshot written now would authorise notices for
work the operator never agreed to be interrupted about. The two things left are both clicks:

1. **Reload once more** at `chrome://extensions` — puts the new launcher into the live path (and is harmless if the port
   has already been released).
2. **Press Arm in the popup** — writes the snapshot with `armTakenAtMs` and `relayCovered: true`. Arming is necessary
   but it is *not* sufficient, which this file said wrongly until T224: a relay candidate is announced only if it also
   carries a trustworthy post-arm completion instant (`relay_merge.completion_source_ok`), is not already in the host's
   journals (`relay_merge.history`), and is not already in the native answer for the same sample
   (`relay_merge.merge`, whose `taken` set drops a run the native path is offering).

## 9. Acceptance items

| # | item | result |
|---|---|---|
| A1 | audit GO on the switched install | **pass** — `decision: GO`, `blocking_failed` empty, `forwards_relay_flag: true` |
| A2 | candidates carry provenance | **pass** — 73 of 74 named a `bridge.task_events.*` source, 1 `unknown`, none bare |
| A3 | nothing from before the arm is offered | **pending the arm** — `armRelayCovered: false`, so relay-only ids are deferred by construction |
| A4 | a post-arm run is offered once | **pending the arm** |
| A5 | ACK idempotency | **pass** — `test_t095b207_ack_identity.py` 9 tests |
| A6 | restart keeps the ACK | **pass** — `test_t095b213_deferred_recovery.py` 10 tests |
| A7 | disconnect is named, nothing invented | **pass** — `test_t095b209_relay_activation.py` 8, `test_t095b217_launcher_relay.py` (unreachable relay → `relay_unavailable`) |
| A8 | page delivery | **unknown** — no message was sent to any page, and a host ACK is not delivery |

## 10. Rollback

| layer | command |
|---|---|
| extension | restore the 15 files from the T217 backup; `manifest.json` needs nothing |
| launcher | `Move-Item host_launcher.exe host_launcher.t219.exe; Move-Item host_launcher.pre-t219.exe host_launcher.exe` |
| relay | delete `relay.txt`, stop the two node PIDs, `$INST\relay` can stay (it is state, not configuration) |
| host modules | copy the six modules back from the T217 backup |
| arm snapshot | untouched this round, nothing to undo |

Backups: `217-backup-20261103-153213` (43 entries, pre-upgrade) and `219-backup-20261103-191632` (48 entries, post-reload,
restore rehearsed: 0 problems).

## 11. T224: what the relay has actually delivered (read-only, 2026-11-04 00:52)

Four sources, no writes, no test message:

| source | observation |
|---|---|
| relay service record | 79 runs, every `completedAtSource` a `bridge.task_events.*` row; `hostAck` acked 4 / unseen 4 in the last eight; `pageDelivery` `unknown` on all 79 |
| host sample state | `relayActivatedAt` 1793705573054, `relayActivation: active`, `relayBaselineIds` 75, **`relayOfferedIds` 0**, `relayDeferredIds` 0, `ackedIds` 513 |
| extension journal | `"origin":"bridge"` 4 953 times, **`"origin":"relay"` 0**, `relayOffered` 0 |
| Bridge | terminal events 22:08:38 (T220), 23:08:56 (T221), 00:00:29 (T222), 00:48:54 (T223) — all native |

Conclusion: **no relay-only candidate has ever been consumed.** Every notice so far came down the native ledger path,
including the four natural completions after the relay went live. The relay has functioned as a mirror and a redundancy
check, not as a second delivery channel.

Why: both sides read the same Bridge ledger. The host computes the native answer first from it, and `merge()` drops a
relay candidate whose run id the native answer already carries, so the native path wins the race by construction. A
relay-only notice needs the relay to see a run the host's native sample did not — same database, sub-second window, or a
native read failure — and in the latter case the host reports the ledger as unreadable instead of falling back.

What a single human acceptance step can establish, and what it cannot:

* **Can**: leave the existing arm and auto-send opt-in as they are (valid until 2026-11-10 21:57:10) and let one more
  natural task finish; afterwards the extension journal answers the question directly — a `"source":"relay"` entry with
  `postArmEvidence: relay_completed_at` and the operator having seen the notice.
* **Cannot**: force the race from outside. Making the native sample miss a run means editing the Bridge database or
  injecting an event, both prohibited (synthetic completion), and racing two samplers is not deterministic. So the
  attribution stays `unknown` until it happens on its own.
