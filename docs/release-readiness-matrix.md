# Acceptance matrix (T215)

One row per behaviour a rollout claims. "Evidence" names the test or the observation; "offline" means proven in this
repository, "live" means it needs the operator-present switch in `release-readiness-runbook.md` §4. Nothing here is
inferred from a green suite: a suite proves the code, not that a page received a message.

## 1. Status mapping

| Input | Rule | Evidence | Level |
|---|---|---|---|
| `completed` + `task.completed` | announced if the instant is after the consent boundary | `test_t095b211_completion_evidence.py`, `test_t095b214_consent_precision.py` | offline |
| `failed` + `task.failed` | same, and the answer carries `status: failed` | `test_a_failed_run_travels_with_its_own_event` | offline |
| `interrupted` + `task.interrupted` | allowed by the allowlist; no fixture asserts a notice end-to-end | `test_t095b214_consent_precision.Units` | offline, partial |
| `completed` + no event | `deferred`, never announced, recoverable when the event lands | `test_t095b213_deferred_recovery.py` | offline |
| `completed` + `task.failed` | refused as a source mismatch (`relaySourceUntrusted`) | `test_a_source_that_contradicts_the_status_is_deferred` | offline |
| status correction between samples | re-decided from the new event, old instant discarded | `test_a_status_correction_is_re_decided_from_the_new_event` | offline |

## 2. Consent channels

| Channel | Boundary | Evidence | Level |
|---|---|---|---|
| `bridge` | arm instant (`armTakenAtMs`, else end of the recorded second) | `test_t095b214_consent_precision.py` | offline |
| `direct` | operator opt-in recorded before the run ended; `opt_in_after_terminal` refuses | `test_t095b161c_optin_boundary.mjs`, `test_send_gate.mjs` | offline |
| `unknown` | no arm, no opt-in → offered only with `postArm: null`, which the consumer refuses | `test_t095b210_arm_integrity.py` | offline |
| first activation (no arm snapshot) | `relayActivatedAt` is the boundary; long runs stay unprovable to the consumer | `test_t095b209_relay_activation.py` | offline |

## 3. Suppression, dedupe, ACK

| Behaviour | Evidence | Level |
|---|---|---|
| a run that finished before the boundary is absorbed permanently | `test_an_event_that_proves_it_finished_before_consent_buries_it` | offline |
| a deferred run is not absorbed, and recovers exactly once | `test_t095b213_deferred_recovery.py` | offline |
| bare run-id ACK suppresses the next offer | `test_t095b207_ack_identity.py` | offline |
| ACK of a native run does not touch the relay journal, and vice versa | `test_a_relay_ack_does_not_touch_the_native_queue` | offline |
| re-reporting a completion never moves the instant later | `test_a_re_post_cannot_move_a_completion_instant_later` | offline |
| service re-report of the same status keeps the earliest instant | `test_t095b212_async_mirror_lag.py` | offline |
| a stale `postArm` verdict is not honoured under a new epoch | `postArmUsable` + `test_t095b150_postarm_epoch.mjs` | offline |

## 4. Restart, disconnect, damaged state

| Situation | Behaviour | Evidence | Level |
|---|---|---|---|
| service restart | deferred stays deferred, ACK stays ACKed | `test_a_deferral_survives_a_restart_and_still_recovers` | offline |
| relay unreachable | `relayCode: relay_unavailable`, nothing invented | `test_a_relay_disconnect_does_not_turn_a_deferral_into_history` | offline |
| old second-only arm snapshot | whole second treated as before consent, `armPrecision: second` | `test_an_old_second_only_snapshot_treats_the_whole_second_as_before_consent` | offline |
| contradictory arm snapshot | refused with `arm_snapshot_unreadable` | `test_an_arm_with_a_contradictory_instant_is_refused_not_guessed` | offline |
| history overflow | `relay_activation: stalled`, never a truncated baseline | `test_t095b210_arm_integrity.py` | offline |
| Windows login / reboot | not exercised: it needs the installed host, which the audit reports as absent | — | **live** |

## 5. Delivery semantics — the part that must not be overclaimed

| Claim | Status |
|---|---|
| host handed a candidate to the extension | proven offline (`terminal-list` answer) |
| the extension accepted it for a send | proven offline (`readCandidates()` in the consumer suites) |
| a message appeared in a ChatGPT page | **unknown**. `pageDelivery` is `'unknown'` on every relay candidate and no code writes it true. Only the operator-present observation in runbook §5/A8 can answer it. |
| a host ACK means the page received it | **false**, and no report may say otherwise |

## 6. Availability, stated plainly

* A Relay notice requires a Bridge terminal event. **112 of 235** terminal runs in the live database have none, so
  Relay can never authorise those; they are announced by the existing native path, which reads `endedAtMs` from the
  ledger.
* A run whose completion lands after the first mirroring is `deferred` until the event exists, then announced — that is
  T213, and it is the only reason a late event is still useful.
* Absence-based authorisation (a "complete" cache proving nothing else exists) is refused permanently: no component
  emits a source-side watermark, so `relayUpstreamComplete` is unreachable and nothing may set it.
* The rollout cannot be completed without a Chrome extension reload, because the installed build lacks the epoch
  binding. That is the single NO-GO item, and it is a manual step by design.
