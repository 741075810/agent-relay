# AGENTS.md

Instructions for anyone — human or agent — changing this repository.

## The one rule that must not regress

**A notice may only be authorised by consent recorded strictly before the run ended.**

Every other property here is negotiable. This one is not, because breaking it produces a
notice about a task its recipient already watched finish, which is worse than no notice.

Concretely, in `extension/lib/terminal_trigger.js`:

* compare against `endedAtMs`, never `endedAt`;
* the comparison is `entry.armedAt >= endedAtMs` → refuse (strict; same millisecond is
  refused);
* `endedAtMs === null` → refuse with `terminal_time_unknown`. Do not reconstruct a value
  from the floored second, from `startedAt`, from the file mtime, or from the wall clock;
* do not reintroduce a "fuzzy" comparison such as `(endedAt + 1) * 1000`.

If you change this rule, change `test_t069_terminal_precision.mjs` and
`test_t069_terminal_precision.py` in the same commit, and say in the message which
behaviour is now correct that was not before.

## Never infer identity from a guess

Channel A is excluded from channel B by joining `(sessionID, turn)` against the Bridge's
ledger. Do not substitute prompt text, timing, file modification times, or "it looks
like the same task". A wrong join here means either a duplicate notice or a missed one,
and both are silent.

## Fail closed, and say which way you failed

"Could not read the source" and "the source says nothing is there" are different facts
and must never collapse into one message. The popup distinguishes:

| message | meaning |
|---|---|
| `DSH 会话日志不可读` | nothing was looked at |
| `Bridge 台账不可读` | channel A cannot be excluded, so nothing is offered |
| `当前没有正在运行的直发任务。` | the source *was* read; nothing is running |

When adding a failure path, give it a `code` and let it reach the caller. A refusal that
renders as `direct_not_opted_in` when the truth is `opt_in_after_terminal` sends someone
looking for a button they already pressed.

## Testing expectations

* **Python**: `python -B -W ignore::ResourceWarning -m unittest discover -s . -p 'test_*.py'`
  → `OK`. With `host_launcher.exe` and `host_manifest.json` absent it must be
  `OK (skipped=11)`, never a failure.
* **JS**: `$env:PYTHON` set, then every `test_*.mjs` → 0 failures. The e2e suites spawn
  the **real** host subprocess and load the **real** `background.js`; only Chrome is
  mocked. Keep it that way — a mock of your own module proves nothing.
* **Hermetic**: any suite that can read a production path must be given an empty
  temporary one. The e2e suites pass `--native-root <temp dir>` for exactly this reason.
  A test that silently reads the operator's real session logs fails intermittently when
  that operator is working, which is how the first version of this was found.
* **New field, new test**: a field added to a candidate must be asserted at the host, at
  intake, and at the point of use. This repository has already lost a field in transit
  once (`endedAtMs`), and the symptom was a feature that looked broken.

## Working on Windows

* Do **not** round-trip source files through PowerShell `Get-Content`/`Set-Content`.
  It mangles UTF-8 (CJK becomes U+FFFD) and once destroyed a test file mid-suite.
* Write files with an editor/`write`, and run Node from a file rather than inline
  `node -e` with quoting and `${}` interpolation.
* `.NET` static calls (`[System.IO.File]::...`) resolve paths against the **process**
  working directory, not the shell's `cd`. Verify the resolved absolute path before
  writing or deleting.

## Publishing

This repository is a **snapshot of source, tests and docs**. It must never contain:

* runtime state — `state/`, `*.runs.json`, consent stores, arm snapshots, queues;
* machine configuration — the real `host_manifest.json`, a real extension id, absolute
  paths containing a user name;
* build artefacts — `host_launcher.exe`;
* personal output — session logs, reports from a specific engagement, `inbox_*` scratch.

Before any push:

```powershell
# 1. the suites must be green in a clean clone, not just in your working tree
python -B -m unittest discover -s . -p 'test_*.py'
$env:PYTHON = (Get-Command python).Source
Get-ChildItem -Filter 'test_*.mjs' | ForEach-Object { node $_.FullName }

# 2. nothing sensitive, nothing untracked by intent
git status --short
git grep --cached -nIE 'Administrator|[A-Z]:\\Users|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY' -- `
  '*.py' '*.mjs' '*.js' '*.json' '*.html' '*.cs' '*.ps1'

# 3. every extension id that appears must be synthetic
git grep --cached -nIoE 'chrome-extension://[a-p]{32}' -- '*.py' '*.mjs' '*.js' '*.json' '*.html' '*.cs' '*.ps1'
```

Command 2 must print nothing. Command 3 must print **only** ids you can justify as
synthetic — and "synthetic" means self-evidently so: a single repeated letter, or a
sequence. A real unpacked id looks random precisely because it is a hash of the load path,
so anything random-looking is a leak.

Why an allowlist by inspection rather than a pattern: Chrome ids are base16 mapped onto
`a`–`p`, so *every* valid id matches `[a-p]{32}`, real and fake alike. A regex that rejects
real ids must reject the synthetic ones too, which makes it useless. The check therefore
prints candidates and a human judges them.

Both patterns exist because both were real leaks in this repository: absolute paths with a
user name in two host modules, and a genuine unpacked-extension id in
`test_t059_terminal_wire.py` — which shipped in the first published commit despite a
report claiming it had been replaced. The report was wrong because the scan it cited did not
look for ids at all. That is the failure this section is written to prevent: a gate you
believe in but never actually ran.

The extension list is restricted to source and config on purpose: documentation
legitimately *describes* the patterns being avoided (this file does), and a gate that fires
on its own text gets ignored.

Publish with a normal fast-forward push. **Never force-push** and never rewrite a shared
branch — this repository's history is the record of which rule was wrong and when.

## Standing prohibitions

* no synthetic terminal events, no replay of historical completions, no back-fill;
* no `chrome.debugger`, CDP, UI automation, or keystroke injection;
* no widening the popup-only message guard to a content script;
* no replacing `host_launcher.exe` silently — its hash is pinned by the preflight;
* no hand-editing of stored consent to "pre-arm" a task.
