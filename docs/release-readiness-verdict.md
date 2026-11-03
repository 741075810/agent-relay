# Release readiness: verdict and evidence (T215)

Status: **NO-GO for "switch Relay on without touching the Chrome extension"**. GO for the reversible rollout in
`release-readiness-runbook.md`, which is the smaller, honest alternative: one supervised host-side swap while the
operator is present, with a one-command rollback.

Everything below is a read-only observation of the machine as it stands, or a property proven by the test suite. Where
something has only been proven offline, it says so.

## 1. What is actually installed (read-only survey)

| Component | Production right now | Used only by isolated tests |
|---|---|---|
| Chrome extension | v0.1.1 "DSH Notify Bridge (prototype)", loaded unpacked, `background.js` sha256 `9905CD44…`, **0 references to `relay`** | every repo suite mocks Chrome and loads the repo copy |
| Native messaging manifest | registered as `com.dsh.notify`, one origin (`<EXT_ID>`), path → `host_launcher.exe` | repo uses `host_manifest.example.json` + temp manifests |
| Launcher | `host_launcher.exe`, 7,680 B, sha256 `34CFE482D518C690…` | `launcher/` sources only |
| Host | an **older copy** of `host.py`, 51,134 B, sha256 `4A68DF24…`; **no `--relay-url`, no `armTakenAtMs`** | repo `host.py`, 53,303 B, has both |
| Bridge database | `%LOCALAPPDATA%\CodexBridgeService\service.sqlite`, live: 235 terminal runs, **112 with no terminal event**, 4 with repeated terminal events | every T203–T214 suite builds its own schema in a temp dir |
| Relay service | **not running**, no `service.token` anywhere in the install | started per test on an ephemeral port |
| Sidecar (`host_mirror.mjs`) | never run in production | per test, `--once` |
| Relay arm snapshot | **absent** | per test |

Two consequences follow immediately, and both are load-bearing:

* the installed host cannot even reach a Relay service — it has no `--relay-url`. Relay delivery needs a host-side
  replacement, not a configuration change;
* the installed extension *does* honour `postArm === true` (`background.js` line ~1701), but it has **no
  `postArmEpoch`** and no `postArmUsable`. The repo added exactly that binding in T150 because a `postArm` verdict
  carries no expiry: it belongs to the arm snapshot it was computed against, and once that snapshot is replaced the
  verdict is stale. An old extension would therefore admit a candidate authorised under a *previous* arm — the
  double-notice failure this repository has spent releases eliminating.

So "keep the extension, only swap the host" is **not safe**: the relay path's authorisation is a host-computed
`postArm` verdict, and the installed consumer trusts that verdict without binding it to an epoch. The extension must be
reloaded from a build that contains the epoch binding — which is a manual, operator-present action (T112 line), and out
of scope for an unattended run.

This is not an inference from reading a hash. The existing epoch suite takes its extension root from the environment
(`T150_EXT_ROOT`), so it can be pointed at the installed build with no modification and no side effects:

```powershell
$env:T150_EXT_ROOT = $EXT_INSTALL ; node test_t095b150_postarm_epoch.mjs
```

Observed 2026-11-03 against the installed tree: **3 of 6 fail**, including
"a verdict from the previous epoch cannot authorise a run under the new one" and
"an entry written before the stamp existed falls back to the strict gate". The same suite is 6/6 green against the
repo's extension. That is the measured difference between GO and NO-GO, and it is why the runbook's step 4.3 is a
supervised extension reload rather than a host-only swap.

The repo's own arming path is consistent end to end, which is worth recording because it is the thing a host-only patch
would leave behind: the extension mints an epoch, calls `terminal-arm-snapshot` with it (`requestArmSnapshot(epoch)`,
`background.js` line 643), stores the same epoch in its trigger state, and the host echoes it in every sample — so
`postArmUsable` compares one epoch against itself. The migration entry `tools/service/arm_with_relay.py` calls
`terminal_source.arm_snapshot`, so it inherits `armTakenAtMs` and the millisecond boundary without a second code path.

## 2. Why the chain is still worth deploying, and what it will and will not do

* A relay candidate is announced **only** when the Bridge's own terminal event supplies a completion instant that is
  later than the recorded consent boundary, with a matching event kind. No instant, no notice — `deferred`, with a
  reason, and recoverable if the event lands later (T213).
* The consent boundary is millisecond-accurate for new snapshots and conservative (whole second refused) for old ones
  (T214).
* **112 of 235 terminal runs have no terminal event.** Those can never be authorised by Relay, by design. They are
  announced today by the existing native path, which uses the ledger's own `endedAtMs`.
* `pageDelivery` stays `unknown` everywhere. A host ACK means *the host handed the candidate over*, not that ChatGPT
  received a message. Nothing in this chain upgrades that word, and the audit output repeats it.

## 3. Risk matrix

| # | Risk | Where it would bite | Current control | Residual |
|---|---|---|---|---|
| R1 | Notice for a run that finished before consent | the one rule in `AGENTS.md` | ms boundary + Bridge-event-only evidence + `postArmEpoch` binding | **installed extension lacks the binding** → blocking |
| R2 | Missed notice that looks like idleness | Relay runs with no terminal event | `deferred` + `relayDeferred` / `relaySourceUntrusted` counters | 112/235 runs permanently deferred by design |
| R3 | Double notice after a re-arm | candidate re-offered under a new epoch | epoch binding (repo) | blocking for the old extension (R1) |
| R4 | Host ACK read as page delivery | reporting, not transport | `pageDelivery: 'unknown'`, never written true | none — but it must not be reported otherwise by hand |
| R5 | Service cache emptiness read as "nothing finished" | the T212 defect | `snapshot_proves_absence = False`, `relayUpstreamComplete` unreachable | none in code; a future watermark must not be faked |
| R6 | State file written by a newer/older version | rollback to a previous host | state is JSON with `version`; unknown keys preserved | a rollback must keep the state dir, not replace it |
| R7 | Token leakage in reports | any paste of audit output | audit prints `present` + length only; ids replaced | none observed |
| R8 | Sidecar mirrors a foreign ledger | misattributed candidates | `--ledger-root` explicit, `hostSource` recorded per candidate | operator must not point it at another account's ledger |

## 4. What this round ships

* `tools/rollout/readiness_audit.py` — default **off** (`--audit` required). Read-only by construction: files opened
  `'r'`, SQLite opened `mode=ro` with `query_only=1`, and the tool proves that handle refuses writes. Prints a GO/NO-GO
  verdict with the blocking checks named.
* `tools/rollout/shadow_observe.py` — default **off** (`--enable` required). Copies the Bridge database into a temp
  directory, runs the shipping `host.py` against the copy with a temp state dir, and prints what *would* be offered,
  classified as `evidence-ok` / `would-announce` / `history (before consent)` / `deferred`. It starts no service, posts
  nothing, and touches no page.
* `test_t095b215_readiness_audit.py` — 13 tests: default-off for both tools, the read-only proof at the SQLite layer,
  mtime-and-size equality of every file the audit touched, the shadow's copy semantics on a frozen database, redaction
  of both the extension id and a token value, and the verdict flipping to NO-GO when capabilities are missing.
* `docs/release-readiness-runbook.md` — the reversible rollout, with commands, success criteria and rollback.
* `docs/release-readiness-matrix.md` — the acceptance matrix over completed/failed/interrupted, consent channels,
  suppression, dedupe, ACK isolation, restart and disconnect.

## 5. What would make it GO

1. Operator present, Chrome available for a reload of the extension build that carries `postArmEpoch`.
2. `readiness_audit.py --audit` against the new install reporting `GO` with no `blocking_failed`.
3. A shadow run over the live Bridge database and ledger showing every candidate classified, and the count of
   `deferred` matching the 112 runs that have no terminal event.
4. One supervised one-shot switch, then the acceptance matrix run in order, then either acceptance or the rollback in
   §6 of the runbook.

Until step 1 happens, none of the above can be reached by an unattended run, and this document stays NO-GO.
