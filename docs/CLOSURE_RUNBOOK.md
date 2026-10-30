# End-to-end closure: what is proven, what is not, and the shortest honest path to proven

Written for T117. It answers one question — *can an unattended loop of DSH Desktop ↔ ChatGPT run
today, and what would prove it?* — and refuses to answer a second one (*is it running in
production right now?*) which nothing in this repository can establish.

Read this alongside `docs/UPGRADE_DRILL.md` (the maintenance window) and `docs/CONSENT_MODEL.md`
(the rule that a notice may only be authorised by consent recorded before the run ended). This
document does not restate them; it sequences them.

## 1. Five versions, and only three of them can be checked from here

| name | what it is | how it is established | state at T117 |
|---|---|---|---|
| **warehouse** | this git repository at a commit | `git rev-parse HEAD` | `fae623a3` |
| **source** | the files the extension is built from | `python -B tools/extension_stamp.py --check` → `T112-6c5f383b` | matches |
| **installed** | the unpacked directory some Chrome profile points at | `python -B tools/extension_stamp.py --root <dir> --check` | **unknown** — needs the directory |
| **loaded** | the code Chrome actually executed | nothing offline; the popup prints its stamp, a human compares | **unknown** |
| **prod host** | the `host_launcher.exe` native host that runs today | protocol shape: a host that predates `generation`/`committed` is pre-T088 | **pre-T088,旧版** |

The stamp proves identity of files, never that a browser loaded them, and never that the native
host was upgraded. A queue with no `generation` key is the only observed evidence that the
running host is old, and it is evidence about the host, not about the extension.

## 2. The chain, link by link, with the record that proves it

`extension/lib/chain_evidence.js` already names the six links and insists each is proven by a
*different* record. This table adds where the evidence lives and whether it exists today.

| # | link | record that proves it | offline evidence | production evidence |
|---|---|---|---|---|
| 1 | ChatGPT creates a DSH task | Bridge ledger turn (sessionID, turn) | ✅ suites drive a real host on a temp state dir | ❌ nothing read-only exists |
| 2 | the task runs locally and finishes | terminal source sample + baseline | ✅ `test_t065_chain_e2e.mjs`, `test_terminal_producer_e2e.mjs` | ❌ |
| 3 | Bridge writes the completion event | host queue: event + `next_seq` | ✅ Python queue suites (incl. T116 upgrade path) | ✅ T102/T103: one pending event on disk |
| 4 | the extension consumes and ACKs it | `terminal-ack` receipt, `terminalCandidates` | ✅ T065 (ACK failure and retry included) | ❌ T103 saw a bound, working extension but no ACK for a *new* event |
| 5 | the page really received and shows it | adapter receipt `submitted` — exactly one exact-template message, empty composer before the write | ✅ `test_t071_delivery_receipt.mjs`, `test_received_review*` with a stub writer | ❌ **no DOM evidence ever collected** |
| 6 | the assistant reads the notice and dispatches the next task | independent observation of the next round | ✅ as `unknown` — the module refuses to guess | ❌ **never observed** |

Two rules follow, and they are the reason this document exists:

* **Host ACK ≠ delivery.** `acknowledgementIsNotDelivery` is exported as a constant precisely so
  that link 3 cannot be read as link 5.
* **A human pasting the completion text into the chat is not link 6.** It is a transcript of a
  human action. Until an observation of the *next* round exists, the loop is open.

## 3. Background, screen lock, reconnect

| condition | what is tested | where |
|---|---|---|
| MV3 worker restart mid-chain | the chain resumes without duplicate sends | `test_t065_chain_e2e.mjs` |
| host offline → reconnect | requests retried, no false "sent" | `test_t065_chain_e2e.mjs`, `test_t048_background_tab_delivery.mjs` |
| tab hidden / document hidden | deferral and resumption rules | `test_t076_focus_defer.mjs`, `test_t051_background_safety.mjs` |
| notification de-duplication | an id delivered twice is one notice | `test_t095b83_extension_dedup.mjs` |
| reload / binding recovery | `binding_mirror` and the reload alarm restore the binding | `test_t095b76_reload_binding.mjs`, `test_t057_refresh_binding.mjs` |
| **screen physically locked** | **nothing** — no suite can lock a screen | — |

So "backgrounded tab" is covered offline; "locked screen" is an *operator observation* in phase 5
below, not a tested property. Saying otherwise would be inventing evidence.

## 4. What the authority question leaves open

`docs/CONSENT_MODEL.md` and `test_t069_terminal_precision` pin the one rule that must not regress:
arm time must be strictly before `endedAtMs`, and an unknown end time refuses. That means a fully
unattended loop needs a consent that is recorded *before* the run ends — which is a human act
today unless a standing authorisation mechanism exists and is authorised. T117 does not widen it.

## 5. Runbook

Five phases. Phase 1 is free and read-only. Phases 2, 3 and 4 each need explicit authorisation
from the operator, and phase 4 needs a human present. **Do not compress phases 2–4 into one
window**: if the notification in phase 4 is wrong, you want the previous host still restorable.

### Phase 1 — read-only, no authorisation needed, run it now

```powershell
cd <repo>
git rev-parse HEAD ; git status --short
python -B tools/extension_stamp.py --check                 # source: must print "matches the tree"
python -B tools/extension_stamp.py --root <extension dir> --check   # installed: prints declared vs tree
python -B tools/upgrade_preflight.py --state <state dir> --json     # no --host-stopped yet
```

Success criteria: `--check` reports the same 8 hex digits for the repo and, separately, for the
installed directory; preflight reports `needs_operator_confirmation` and names the lock state.

Stop if: the two stamps differ (the installed copy is not what the repo describes — find out which
is older before touching anything), the queue is `queue_damaged`, or preflight says
`unknown_lock_content` / `interrupted_save_detected`. A damaged queue is not evidence the host is
stopped; it is evidence you must not write.

Also record, for later comparison: how many events are pending and the ACKed count.

```powershell
python -B tools/upgrade_preflight.py --state <state dir> --json   # read "queue" in the report
```

### Phase 2 — maintenance window (needs authorisation: stopping the old host)

The old and new lock protocols cannot exclude each other (`docs/UPGRADE_DRILL.md`), so this is a
stop-the-old-host operation. The absence of `queue.lock` does **not** prove the process stopped.

1. Stop the old host for real: close every Chrome profile that holds the extension, then confirm no
   `host_launcher.exe` remains (`Get-Process host_launcher -ErrorAction SilentlyContinue`). The
   preflight's lock probe cannot answer this — only the process list can.
2. Back up the whole state directory, and keep the copy off the machine under test:
   `Copy-Item -Recurse <state dir> <backup dir>\state-<timestamp>` then hash it
   (`Get-FileHash` on every file) and write the manifest next to it.
3. Re-run preflight with the attestation: `--state <state dir> --host-stopped`. Success
   criterion: `safe_to_start`. If it says `legacy_lock_remove_by_hand`, remove that empty lock
   **by hand** as it says; do not script it.
4. Install the new host per `docs/HOST_INSTALL.md`, then start it once against the same state dir.
   Success criterion: the first write creates `generation: 1`, `next_seq` does not go backwards,
   every pending event id and every ACKed id from phase 1 is still there, and the `acked_at`
   stamps are unchanged. T114 pins exactly this on a hand-written pre-upgrade queue.
5. If any of that fails: **stop.** Restore the backup rather than rolling the old binary forward —
   an old host writing the document it loaded drops `generation` and the queue becomes
   indistinguishable from one that was never upgraded (T114, `RollbackHazardTest`).

### Phase 3 — extension (needs authorisation: it breaks the current binding)

1. Close the ChatGPT tab's dependency on the old worker: the reload itself is a Chrome UI action
   (`chrome://extensions` → reload). Afterwards the popup must print the stamp that phase 1
   reported for the repo.
2. Re-bind the target tab via the popup. Success criterion: the popup shows the target and
   `binding_mirror` agrees after a worker restart — reload the extension a second time and confirm
   the binding is still there. `test_t095b76_reload_binding.mjs` is the offline analogue.
3. Success criterion for the whole phase: the popup's stamp equals the repo stamp **and** the
   binding survives a reload. The stamp alone proves only the first half.

### Phase 4 — one notice, a human watching (needs authorisation: it sends a message)

1. Arm one task with the standard consent flow, let it finish, and **watch the page**.
2. Record, in this order, with timestamps: host `terminal-ack` for that event id → adapter receipt
   (`submitted`/"written_not_clicked") → what the page shows.
3. Success criterion: exactly one message appears, it matches the fixed template, no second copy
   arrives, and the receipt is `submitted` rather than `written_not_clicked`.
4. Failure handling: `composer_not_empty` / `composer_unavailable` mean the page was not ready —
   the notice was **not** sent; do not resend blindly, read the receipt. A duplicate means the
   de-duplication link is broken; stop and keep the logs.

### Phase 5 — unattended cycle (needs authorisation, and the honesty about what it proves)

1. With the binding confirmed, switch to another window (or minimise) and let one cycle run.
2. Repeat with the screen locked. There is no test for this; it is an observation.
3. Success criterion for **one** cycle: a task started by the previous notice finishes without
   anybody touching the browser, and one message appears.
4. **Not** proven by this: that the assistant read the notice and decided to start the next task.
   That is link 6 and it needs an independent observation of the next round (a new session/turn in
   the Bridge ledger, not the previous one). Until that is recorded, the loop is open, and the
   phrase "unattended closed loop" describes an intention rather than a measurement.

## 6. Failure boundaries, as a list an operator can act on

| symptom | what it means | stop? |
|---|---|---|
| installed stamp ≠ repo stamp | the running code is not this commit | yes |
| preflight `queue_damaged` | the queue cannot be read; writing would risk it | yes |
| preflight `unknown_lock_content` / `interrupted_save_detected` | somebody else may be writing, or a save was cut short | yes |
| new host sees a queue with `generation` but wrong `next_seq` | not our queue, or a rollback happened | yes |
| popup prints a stamp the repo does not have | the loaded code is not this commit | yes |
| receipt `written_not_clicked` | the notice is in the composer, not sent | investigate, no resend |
| two identical messages | de-duplication broke | yes |
| nothing appears while the receipt is `submitted` | delivery is proven, rendering is not — the extension cannot see the page after submit | observe, do not resend |

## 7. What this runbook deliberately does not do

It does not deploy, reload, send, stop, start or upgrade anything. It does not read a production
state directory. Every check in phase 1 is read-only; phases 2–5 are operator actions with a
precondition written down, because the failure mode this repository keeps rediscovering is doing
the write first and calling the preflight afterwards.
