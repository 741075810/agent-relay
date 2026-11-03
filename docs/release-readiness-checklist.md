# Release check list (T216)

Short enough to run in one sitting, in order. Any unchecked box is a NO-GO; the last box is the only thing that
authorises the switch. Nothing on this list is run by an agent.

## Before anything

- [ ] Operator awake and present; Chrome available for a reload.
- [ ] `audit-before.json` written: `python -B REPO\tools\rollout\readiness_audit.py --audit --installed-root HOST_INSTALL --manifest HOST_INSTALL\host_manifest.json --bridge-db BRIDGE_DB --state-dir STATE --json`
      → record `decision` and `blocking_failed` (expected today: `NO-GO`; `installed_host_reads_relay`,
      `installed_host_arm_ms`, `installed_ext_epoch_bound`, `launcher_passes_relay`).
- [ ] Shadow run done, with `productionWrites: 0`: `python -B REPO\tools\rollout\shadow_observe.py --enable --repo-root REPO --bridge-db BRIDGE_DB --ledger-root LEDGER`
      → `deferred` count matches the runs with no terminal event (112 of 235 measured 2026-11-03).
- [ ] Backup directory created with `SHA256SUMS.txt` covering `host.py`, `host_launcher.exe`, `host_manifest.json`,
      `python_path.txt` (if present), `extension\`, `state\`, `relay\`, `nmh.reg`.
- [ ] No `host_mirror`/`relay_service` process running.

## The two steps that cannot be skipped

- [ ] **Launcher rebuilt** from `launcher\HostLauncher.cs` so it forwards `--relay-url` and `--relay-token-file`;
      pinned hash updated. Verify: `readiness_audit.py` reports `launcher.forwards_relay_flag: true`.
      *Why:* the shipped launcher passes only `--state-dir <dir>\state` and `--manifest <dir>\host_manifest.json`, so a
      new `host.py` beside it cannot reach a relay service at all.
- [ ] **Extension reloaded** from the build whose `lib\terminal_trigger.js` exports `postArmUsable` and whose
      `background.js` stores `postArmEpoch`. Verify before reload, read-only:
      `$env:T150_EXT_ROOT=EXT_INSTALL; node REPO\test_t095b150_postarm_epoch.mjs` → 6/6 pass (the current install fails
      3 of 6, which is exactly why the extension must be replaced).

## The switch

- [ ] New host installed into `HOST_INSTALL-next`; old directory untouched.
- [ ] `host_manifest.json` `path` points at the new launcher; `nmh.reg` unchanged.
- [ ] Relay service started on `RELAY_DIR`; sidecar started against it (no `--once`).
- [ ] **Audit says GO**: `blocking_failed` empty, `launcher.forwards_relay_flag: true`.
- [ ] Arm snapshot written once, five required flags:
      `python -B REPO\tools\service\arm_with_relay.py --state-dir STATE --ledger-root LEDGER --relay-url http://127.0.0.1:PORT --relay-token-file RELAY_DIR\service.token --epoch EPOCH --json`
      → `"ok": true`, `sources` contains both `bridge_ledger` and `relay`, `terminal-arm.json` has `armTakenAtMs`.

## Acceptance (any failure ⇒ rollback, not debugging)

- [ ] A1 audit GO — done above.
- [ ] A2 every candidate carries `completedAtSource: bridge.task_events.*` or `unknown`.
- [ ] A3 nothing finished before `armTakenAtMs` is offered; the counters account for what was withheld.
- [ ] A4 one post-arm completion offered exactly once (`postArmEvidence: relay_completed_at`).
- [ ] A5 bare run-id ACK suppresses the next offer.
- [ ] A6 service/host restart keeps ACKed runs gone and deferred runs deferred.
- [ ] A7 service stopped ⇒ `relayCode: relay_unavailable`, no candidate invented.
- [ ] A8 `pageDelivery` still `unknown`; a host ACK is not reported as page delivery.

## Rollback (if any acceptance item fails)

- [ ] Stop `host_mirror` and `relay_service`.
- [ ] `reg import nmh.reg`; restore `host_manifest.json`, `python_path.txt`, `host.py`, `host_launcher.exe`.
- [ ] Restore `extension\` only if it was replaced.
- [ ] Keep `state\` and `relay\` — they record what was announced; deleting them replays history.
- [ ] `audit-after.json` `blocking_failed` equals `audit-before.json`'s, and `forwards_relay_flag` is back to `false`.

## Current status

**NO-GO.** Two items above are unchecked and cannot be done unattended: the launcher rebuild and the extension reload.
Until both are done with the operator present, the verdict stays NO-GO, `relayUpstreamComplete` stays unreachable, and
the 112 eventless runs stay `deferred` by design. Nothing in this repository claims otherwise.
