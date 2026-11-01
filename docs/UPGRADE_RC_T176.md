# Upgrading to the T176 release candidate (operator-only, reversible)

This document is for one controlled manual upgrade. Nothing here is executed by any automation, and the
candidate lives beside your installed copy rather than replacing it.

## 0. What the candidate is

* built by `python -B tools/build_extension_rc.py --out dist/rc-t176`, which copies `extension/` verbatim and
  records every shipped file with its sha256 in `dist/rc-t176/RC_MANIFEST.json` (31 files, stamp
  `T112-218c75ca` at the time of writing);
* verified by the same script: bytes match `extension/`, nothing missing, nothing extra, `manifest.json`
  parses as MV3, every `background`/`content_scripts`/`web_accessible_resources`/`default_popup` entry
  exists, `popup.html` loads its six classic scripts in the intended order, and every `.js` either parses
  with `node --check` or loads as an ES module;
* re-verifiable at any time: `python -B tools/build_extension_rc.py --verify dist/rc-t176 --check-parse`.

Nothing in it changes the send path, the grant rules, the host queue or the ACK. The user-visible additions
are one readiness line (T171) and one "last notice" block (T173-T176).

## 1. Find out what is installed now

`unknown` until you look. Two read-only steps:

1. `chrome://extensions` -> enable 开发者模式 -> on the "DSH Notify Bridge" card read **已加载的扩展程序**;
2. `python -B tools/extension_stamp.py --check --root "<that path>"` -- the printed stamp is the baseline.
   Write it down; rollback is judged against it.

## 2. Upgrade

1. Keep the old directory exactly where it is. Do not edit it.
2. In `chrome://extensions`, **disable** the old unpacked card (do not remove it).
3. **Load unpacked** -> `E:\ApkTest\agent-relay\dist\rc-t176`.
4. Confirm exactly one enabled copy whose path is the candidate. Two enabled copies means two content
   scripts on the same tab.
5. Reload the ChatGPT tab once (the content script only injects on load).
6. Open the popup: the readiness block must now end with a `notifications: ...` line, and the panel must
   show `last notice: ...`. If either is missing, you are still on the old build -- roll back.

## 3. Acceptance (in this order, do not skip)

1. Readiness shows `ready` with the grant you restored. If it shows `blocked:` or `unknown:`, rebind
   **before** arming; a reloaded tab is a new document instance and readiness is exactly what reports that.
2. Arm as usual, then let **one** real terminal completion happen. Confirm the notice arrives in ChatGPT.
3. Back in the popup, confirm `last notice:` now names that outcome and that `delivered` says `no` unless an
   acknowledgement was observed. **`delivered: no` with `submitted` is correct** -- page acceptance is not
   consumption.
4. Nothing in the panel may contain the notice text, a conversation body, or a token.

## 4. Rollback

1. Disable the candidate card.
2. Re-enable the old card.
3. Reload the ChatGPT tab.
4. `python -B tools/extension_stamp.py --check --root "<old path>"` must match the baseline from step 1.
5. If a rebind is now required, the old build reports it in the same readiness panel; rebind there rather
   than re-arming over a stale binding.

## 5. What a reload can cost you

* **A rebind may be required**: reloading replaces the document instance, and readiness compares binding,
  grant revision, conversation id and document instance on every send.
* **A reload never extends a grant.** A spent or one-shot grant stays spent.
* **In-flight writes are lost**: a notice being typed when the tab reloads ends as
  `written_not_clicked` or `clicked_unknown`, and neither is retried automatically. That is deliberate.

## 6. What this cannot show

CI success is not evidence that a locked screen wakes ChatGPT, and it is not evidence that a page consumed
a notice. Page send (adapter, tested in fake DOM), host pipeline (`running_report` / `acknowledge`, tested in
isolated directories) and ChatGPT consumption (unobservable here) are three separate links. The diagnostic
record is a **best-effort** convenience view -- a service-worker restart, a storage quota failure or a
second profile can leave it stale or empty; delivery is decided by the host ledger's `acked` state only.
