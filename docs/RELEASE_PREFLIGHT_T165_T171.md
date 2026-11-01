# Release preflight for the T165-T171 extension build (read-only)

Scope: this document is the evidence package for deciding whether to attempt **one controlled manual
upgrade** of the unpacked extension. Nothing here was executed against the running extension, the Host,
the Bridge, the queue, the ACK list, the grant or the page.

## 1. Which copy is loaded in production: unknown from this repository

`release/` contains no deployed copy, and the repository never records the path Chrome loads. Guessing a
path would be reading the operator's machine, so it is marked **unknown**.

Minimal manual location (read-only, operator-only):

1. open `chrome://extensions`, enable 开发者模式;
2. on the "DSH Notify Bridge" card read **已加载的扩展程序 / Loaded from**, copy that absolute path;
3. from the repository run: `python -B tools/extension_stamp.py --check --root "<that path>"`.

Exit code 0 means the loaded copy is byte-identical to some build; the printed stamp names which. If it
differs, the loaded copy is older than the commit you are reading.

## 2. Offline consistency checks (executed)

| Check | Result |
|---|---|
| `manifest.json` | Manifest V3, `version 0.1.1` |
| background | `service_worker: background.js`, `type: module` |
| content script | `content.js` on `https://chatgpt.com/*`, `https://chat.openai.com/*` |
| web-accessible | `lib/send_adapter.js`, `lib/send_gate.js` only |
| popup resources present on disk | all real refs exist; the only "missing" entries are in-page anchors (`#sec-t053` … `#sec-t058`) |
| popup script order | `build_stamp.js`, `queue_error_view.js`, `single_shot_view.js`, **`readiness_queue_view.js`**, `popup.js` -- the T171 view loads before the script that calls it |
| no manifest change needed for T171 | the popup's own scripts are not web-accessible resources; `popup.html` referencing them is enough |

### New modules and who actually loads them

| Module | Loaded by |
|---|---|
| `lib/readiness_queue_view.js` (T171) | `popup.html` -- real |
| `lib/diagnostic_record.js` (T166) | **nothing in the shipped extension** (Node tests only) |
| `lib/terminal_events.js` (T167) | **nothing in the shipped extension** (Node tests only) |

The last two are inert: they cannot break a running extension because no shipped entry imports them, and
`docs/DIAGNOSTIC_RECORD.md` should be read as "usable from a Node harness", not "importable from the page
console" -- they are not web-accessible resources. That is a documentation gap, not a runtime risk.

## 3. Regression evidence for the path that currently works

Run before any upgrade decision; all green in this repository (clean clone):

| Suite | Result |
|---|---|
| `test_t053_frozen_compat.mjs` | 37 passed, 0 failed |
| `test_t053_popup_diagnostics.mjs` | 23 passed, 0 failed |
| `test_t069_terminal_precision.mjs` | 16 passed, 0 failed (the `armedAt < endedAtMs` rule) |
| `test_t069_live_canary.mjs` | 89 passed, 0 failed |
| `test_t071_delivery_receipt.mjs` | 51 passed, 0 failed |
| `test_t079_send_button_readiness.mjs` | 85 passed, 0 failed |
| `test_t081_dynamic_send_control.mjs` | 80 passed, 0 failed |
| `test_t084_receipt_bubble.mjs` | 58 passed, 0 failed |
| `test_t095b171_readiness_queue_view.mjs` | 8 passed, 0 failed |

T058/T059 grant coverage lives on the Python side (`test_t059_terminal_wire.py` and the trigger suites) and
runs green inside the full suite (`OK`, 22 skips). Legacy pending/ack compatibility is covered by
`test_t095b168_notice_queue.py` + `test_t095b169_queue_wiring.py`: a scanner-written `pendingIds` row is not
duplicated, an ACK moves it once, and a re-scan reports `alreadyAcked` instead of requeuing.

## 4. Upgrade sequence (one copy at a time)

1. **Record the old stamp**: `python -B tools/extension_stamp.py --check --root "<loaded path>"`; save the
   output. This is the rollback baseline.
2. **Keep the old directory untouched** where it is. Do not edit it in place.
3. In `chrome://extensions`, **disable** the old unpacked card (do not remove it -- rollback depends on it).
4. Load `E:\ApkTest\agent-relay\extension` (or a copy of it) as a new unpacked extension.
5. Confirm exactly **one** enabled copy whose source is the repository tree; two enabled copies means two
   content scripts on the same tab.
6. Reload the ChatGPT tab once. The content script only injects on load, so an already-open tab keeps the
   old script until reload.
7. Open the popup and read the readiness panel: the T171 line must appear (`notifications: …`). If it does
   not, the popup is still the old build -- stop and roll back.

## 5. What an upgrade may force on the operator (state it plainly)

* **Tab reload is required** for the new content script; without it the page keeps the old one.
* **Re-binding / re-arming may be required**: readiness compares binding, grant revision, conversation id
  and document instance; a reloaded tab is a new document instance, and the readiness row
  (`addBindingGrantMatch`) is exactly what reports that mismatch. If it shows `unknown` or blocked after a
  reload, the correct action is to rebind *before* arming, not to re-arm over a stale binding.
* **The grant is not widened** by reloading; a spent or expired grant stays spent or expired.

## 6. Rollback sequence

1. Disable the new unpacked card.
2. Re-enable the old card (same directory as step 1's stamp).
3. Reload the ChatGPT tab.
4. `python -B tools/extension_stamp.py --check --root "<old path>"` -- the stamp must match the baseline
   recorded in step 1. A mismatch means the rollback did not take effect.

## 7. What an upgrade does *not* prove

Three links stay separate, and no test here closes the third:

1. **page send** -- the adapter writes and clicks, receipts are verified in fake-DOM suites;
2. **Host pipeline** -- `running_report` / `candidates_from` / `acknowledge` own the queue, verified in
   isolated-directory Python tests;
3. **ChatGPT actually consumed it** -- no mechanism in this repository can observe that. Recent successes
   (T168-T171 arriving) are evidence about the *running* build, not about the new one.

## 8. Recommendation

The offline evidence supports **one controlled manual upgrade attempt**, with the old directory intact and
the stamp recorded first, and with the tab reload followed by a readiness-panel check before any task is
expected to notify. It does **not** support claiming that automatic notification is fixed: the third link
(pages consuming what was written) is unobservable here, and the new build's only user-visible change is
one read-only readiness line.
