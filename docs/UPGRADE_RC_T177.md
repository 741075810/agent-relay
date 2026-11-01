# Upgrade to rc-t177 (operator-only, reversible)

Supersedes `docs/UPGRADE_RC_T176.md`. That document quoted the stamp `T112-218c75ca`, which was stale: the
builder of the time printed the first line of `extension_stamp.py --check` and ignored its exit code, so a
stale tree still produced a PASS. The stamp for this tree is **`T112-f6be7696`** and it is checked, not
quoted.

## 0. Build and verify it yourself (the only candidate this document vouches for)

```powershell
cd E:\ApkTest\agent-relay
python -B tools/extension_stamp.py --check --root extension     # verdict must be "matches the tree"
python -B tools/build_extension_rc.py --out dist/rc-t177         # refuses on a stale source
python -B tools/build_extension_rc.py --verify dist/rc-t177 --check-parse
```

The build refuses unless the source stamp is fresh, then copies `extension/`, hashes every shipped file into
`dist/rc-t177/RC_MANIFEST.json`, and re-checks: bytes identical to `extension/`, nothing missing, nothing
extra, MV3 manifest with every referenced entry present, `popup.html` loading its six classic scripts in
order, and each `.js` either parseable by `node --check` or loadable as a module. `docs/RC_MANIFEST_T177.json`
in the repository is the manifest of the candidate built at this commit; compare it with yours.

## 1. What is installed right now: unknown until you look

1. `chrome://extensions` -> 开发者模式 -> read **已加载的扩展程序** on the "DSH Notify Bridge" card;
2. `python -B tools/extension_stamp.py --check --root "<that path>"` -- record the verdict. If it prints
   `STALE`, that installed copy is older than its own files and the stamp is meaningless for it.

## 2. Upgrade

1. Leave the old directory in place; do not edit it.
2. `chrome://extensions` -> **disable** the old unpacked card (do not remove it).
3. **Load unpacked** -> `E:\ApkTest\agent-relay\dist\rc-t177`.
4. Exactly one enabled copy must exist. Two copies means two content scripts on the same tab.
5. Reload the ChatGPT tab once (the content script only injects on page load).
6. Open the popup: the readiness block must end with a `notifications: ...` line and the panel must show
   `last notice: ...`. If either is missing you are still on the old build -- roll back.

## 3. Acceptance order

1. Readiness reads `ready` with your restored grant. If it shows `blocked:` or `unknown:`, rebind **before**
   arming -- a reloaded tab is a new document instance.
2. Arm, then let exactly **one** real terminal completion produce a notice.
3. Confirm the notice arrived in ChatGPT, then read the panel: it must name that outcome, and `delivered`
   must say `no` unless an acknowledgement was observed. `submitted` with `delivered: no` is correct.
4. The panel must contain no notice text, no conversation body, no token.

## 4. Rollback

1. Disable the `rc-t177` card.
2. Re-enable the old card.
3. Reload the ChatGPT tab.
4. `python -B tools/extension_stamp.py --check --root "<old path>"` must reproduce the verdict recorded in
   step 1.
5. If readiness now demands a rebind, rebind there rather than re-arming over a stale binding.

## 5. Cost of a reload

A rebind may be required (new document instance). A reload never extends a grant. A notice being typed when
the tab reloads becomes `written_not_clicked` or `clicked_unknown`, and neither is retried automatically.

## 6. What this cannot show

CI success is not lock-screen wake-up and not proof that a page consumed a notice. Page send, the host
pipeline and ChatGPT consumption are three separate links; only the first two are observable here. The
`last notice` panel is a best-effort view (worker restart, quota failure or a second profile can leave it
stale or empty); delivery is decided by the host ledger's `acked` state alone.
