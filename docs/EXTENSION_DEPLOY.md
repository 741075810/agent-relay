# Extension deployment preflight (T241)

A Git commit, a correct source stamp and green CI establish **publishable source**, not a
browser upgrade. The unpacked install directory may still contain old files. Even byte-identical
install files do not prove that Chrome reloaded them; the runtime generation remains `UNKNOWN`.
This preflight never queries Chrome, its private Profile, stored consent, bindings or queues.

## Explicit opt-in, no path discovery

The existing T218 installed-tree assertions are partial, environment-gated tests; T240 supplies a
standalone comparison/backup tool. Neither was a mandatory release-gate status before T241.
The release gate now reuses T240's file/stamp helpers through its read-only preflight mode.

Configuration precedence:

1. Standalone `--preflight --target "<INSTALL_DIR>"` overrides environment values.
2. `DSH_EXTENSION_INSTALL`, if nonblank.
3. Existing `T218_INSTALLED_EXT`, if nonblank (compatibility with the old opt-in).
4. No configured value: **UNCHECKED**, never disk agreement.

A present but invalid primary value is reported as invalid; it does not silently fall back.
No path is guessed from Chrome's private Profile, process arguments or runtime state. Use the
unpacked extension directory you explicitly selected in Chrome, not a browser user-data directory.
Only ordinary directories/files are accepted: symlinks and Windows reparse points, including
ancestors, are rejected. Source and install directories must not overlap. Manifest/read errors
remain `UNCHECKED` with a machine-readable reason code.

The examples set process-local configuration only. Do not commit a machine path or add it to a
shared workflow, and do not run `setx` or alter service environments as part of a development round.

```powershell
# Windows: in the developer shell, after replacing the placeholder with your known install directory.
$env:DSH_EXTENSION_INSTALL = '<INSTALL_DIR>'
python -B tools/extension_deploy_sync.py --preflight --json
python -B tools/release_gate.py --clean-clone
```

```sh
# POSIX: scoped to this invocation, not a persistent environment edit.
DSH_EXTENSION_INSTALL='<INSTALL_DIR>' python -B tools/release_gate.py --clean-clone
```

For a one-off status without setting any environment variable:

```powershell
python -B tools/extension_deploy_sync.py --preflight --target '<INSTALL_DIR>' --json
```

## Reports and exit codes

| Install condition | Preflight result / exit | Default release gate | `--require-install` |
|---|---|---|---|
| No configuration | `unchecked`, `missing_config` / 2 | `SKIP`: installed files NOT compared | `FAIL` |
| Configured but absent, unsafe, unreadable or malformed | `unchecked`, specific error code / 2 | `FAIL`: no verified comparison | `FAIL` |
| Same relative path set and raw SHA256 bytes | `in_sync` / 0 | `PASS`: disk files only | `PASS` |
| Different bytes, missing or extra files | `drift` / 1 | `WARN`: publishability is separate | `FAIL` |

Drift always carries this exact marker:

```text
source updated, installed outdated; needs explicit sync + human Chrome Reload
```

This is the required operational label for mismatched trees, **not proof of modification-time
ordering**: the install may be different/newer rather than strictly older. Inspect `differences`
before choosing a direction. No implicit sync or reload follows `WARN` or `FAIL`.

Preflight is strict raw-byte equality, including `lib/build_stamp.js`. A CRLF-only mismatch is
reported as byte drift rather than byte identity. T240's ordinary check still classifies CRLF-only
text differences as equivalent and can exit 0; use **preflight** for strict deployment acceptance.
Stamp equality is supplementary: the stamp digest excludes its declaration file, so equal stamps
alone do not establish deployment equality. Full 64-character SHA256 values are in `differences`.
Two inventories notice ordinary concurrent file updates, but this is not an atomic filesystem snapshot.

`release_gate.py --json` preserves `mark`, `detail.state`, `detail.checked`, `detail.code`,
`detail.loaded_runtime`, `detail.source_head`, `detail.source_matches_head` and `detail.source_reference`.
Clean extension files may be labelled `HEAD`; dirty/untracked extension files are explicitly
`working_tree`, not verified HEAD bytes. A normal gate also requires a clean whole worktree before push.
GitHub emits an unchecked notice or drift warning independently of the green code verdict,
without publishing the configured private path. CI without a local install still passes the code gate.

## Development handoff

The standard `python -B tools/release_gate.py --clean-clone` command includes this install stage.
Every handoff should quote its actual row plus the committed HEAD:

- `SKIP / UNCHECKED`: no installed-file comparison; do not claim Chrome upgraded.
- `WARN / DRIFT`: include the exact marker above; source can be committed/pushed while deployment is pending.
- `PASS / IN_SYNC`: configured disk bytes agree; Chrome runtime is still `UNKNOWN`.

Before claiming a change is live, obtain a separate **human** Reload/runtime observation. T241 does
not add notification hooks, schedulers, background file copies, browser automation or recurring tasks.
Install configuration is stripped from gate test/clone children (including legacy T218 live-tree
tests), so an opted-in local gate does not make its test suite inspect production files.

## Explicit maintenance only, never invoked by preflight

Review the ordinary T240 diff first. During a separately requested maintenance action:

```powershell
python -B tools/extension_deploy_sync.py --target '<INSTALL_DIR>'
# Only after reviewing the diff and explicitly deciding to sync:
python -B tools/extension_deploy_sync.py --target '<INSTALL_DIR>' --apply
# Recheck independently; skipped manifest/non-static/extra-file drift may remain after --apply.
python -B tools/extension_deploy_sync.py --preflight --target '<INSTALL_DIR>' --json
```

The existing apply path backs up changed files and verifies its written set; it is not an atomic
whole-tree switch and is not proof all skipped files match. The install manifest stays untouched
without `--sync-manifest`, and changed permissions refuse synchronization. Human Chrome Reload is a
separate action at `chrome://extensions`. A passing preflight never invokes the apply path; combining
`--preflight` with `--apply`, `--sync-manifest` or `--backup-dir` is rejected.

## Tests and rollback

`test_t095b241_install_preflight.py` uses only temporary directories, including CJK/spaced paths and
cp1252 CLI output. It covers missing-config/in-sync/drift, strict byte hashes, stamp-only changes,
filesystem refusal/error handling, CLI JSON, text/GitHub reports, HEAD attribution and environment
isolation. Both Windows full gate and Ubuntu tooling CI execute it and the existing T240 suite.

T241 makes no changes to extension JS/HTML/manifest or production files. To undo T241, use a normal
`git revert <T241_COMMIT>` and run the gate, then fast-forward push both maintained branches. The
T240 tool remains available; no Chrome/service rollback is needed because none were changed.
