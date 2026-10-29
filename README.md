# agent-relay

A Chrome MV3 extension plus a local Python native-messaging host that turns **DSH task
completions** into notices inside a ChatGPT tab — and, crucially, refuses to do so unless
a person's consent was recorded *before* the task ended.

The interesting part of this repository is not the delivery. It is the set of rules that
decide **whether a notice is allowed to exist at all**, and the tests that pin them.

## The two channels

| Channel | What runs | Who is told | Default |
|---|---|---|---|
| **A** — Bridge-dispatched | a task the Bridge dispatched on someone's behalf | automatic | **on** |
| **B** — started directly in DSH | a task a person started in the desktop app | only if that person opted in, per task | **off** |

Channel A is excluded from channel B by joining on `(sessionID, turn)` against the
Bridge's own ledger — never by prompt text, file timestamps or any other guess. One run
can only ever produce one notice, no matter which channel offered it.

## The rule this repository exists for

A notice for a task that already finished must not be authorised by a click made
**after** it finished. That sounds obvious. It is easy to get wrong:

1. DSH records a turn's end with **millisecond** precision.
2. The host floored it to whole seconds when putting it in a candidate.
3. The extension compared the click against `(endedAt + 1) * 1000` — the **end of the
   truncated second**.

So a task ending at `.100` and a click at `.900` of the same second looked like the click
came first. Measured against that code: **2 of 3** consent cases were wrong.

The fix carries the millisecond value (`endedAtMs`) end to end and compares strictly:

```js
if (endedAtMs === null) return { ok: false, code: 'terminal_time_unknown' };
if (entry.armedAt >= endedAtMs) return { ok: false, code: 'opt_in_after_terminal' };
```

* strict — a click in the same millisecond is refused, because there is no ordering to
  prove at one instant;
* `null` is refused rather than reconstructed — deriving milliseconds from a floored
  second is exactly the guess being removed;
* the old `endedAt` field is still emitted for older builds, but the rule never reads it.

`tests/test_t069_terminal_precision.mjs` states the four cases in the order that matters:
same second before → admitted, same second after → refused, same millisecond → refused,
no instant → refused.

## Layout

The tree is flat on purpose. The JS suites resolve `./extension/...` relative to their own
file and the Python suites `import terminal_source` from the working directory, so any
nesting would require rewriting every suite — and then "the tests pass in a clean clone"
would be a claim nobody could check.

```
host.py protocol.py terminal_source.py native_turns.py run_origin.py   the native host
extension/                                                            the MV3 extension
launcher/                                                             source for host_launcher.exe
test_*.py test_*.mjs                                                  the suites
docs/                                                                 design notes
```

## Running the tests

```powershell
# 1. the one runtime dependency, which is not optional
python -m pip install -r requirements.txt

# 2. Python: 278 tests.
python -B -W ignore::ResourceWarning -m unittest discover -s . -p 'test_*.py'

# 3. JS: 46 suites / 2426 assertions on Node 22.15+ (see below). No packages to install.
$env:PYTHON = (Get-Command python).Source    # the e2e suites spawn the real host
Get-ChildItem -Filter 'test_*.mjs' | ForEach-Object { node $_.FullName }

# 4. or all of it, with the publish checks, as one verdict
python -B tools/release_gate.py
```

`zstandard` is **required, not optional**. The session log is `session.v4.jsonl.zstd`;
without the module `native_turns` reports `zstandard_missing` and reads zero turns, so
the notify chain has nothing to offer and the popup says nothing is running — which looks
identical to a machine where no task ever ended. It was undeclared for a long time and
the omission was invisible on the machine it was written on.

Node **22.15+** is required for `zlib.zstdCompressSync`, which the suites use to build
those compressed fixtures. On Node 20 they either skip or fail, depending on how each one
asked; `tools/release_gate.py` checks both dependencies before it runs anything.

Expected on a fresh clone: **Python `OK (skipped=11)`** and **JS 0 failures**. The skips
are `host_launcher.exe` and `host_manifest.json`, which are local build/config artefacts —
see below. With both present the Python run is `OK` with no skips.

## Building the launcher and registering the host

`host_launcher.exe` is a build artefact and is **not** in this repository; its source is.
Network and delivery tests do not need it.

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build_launcher.ps1
Copy-Item host_manifest.example.json host_manifest.json
# then edit host_manifest.json: absolute path to the exe, and your extension's id
```

Register it for Chrome (per-user, no admin):

```powershell
$m = (Resolve-Path .\host_manifest.json).Path
New-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.notify' `
  -Name '(default)' -Value $m
```

`t045_diagnose.py` audits this chain **read-only** — registry, manifest, launcher hash,
and whether a host process is running with which modules loaded:

```powershell
python -B t045_diagnose.py
```

### Finding the host directory rather than assuming it

The registry entry's default value names a manifest; that manifest's `path` names the
launcher; the launcher's **own directory** is where the host modules are imported from.
Do not assume a location — derive it, as `t045_diagnose.py` does. Copying modules to a
plausible-looking directory that the registration does not point at produces a symptom
("the new build did not take") that looks like a code failure and is not.

A running host keeps the modules it imported **at launch**. Editing files on disk does
not change the behaviour of a host process that is already alive; it must be restarted
(browsers kill it when they close) and the extension reloaded.

## What this deliberately does not do

* no synthetic `turn/end`, no replay of historical completions, no back-fill;
* no `chrome.debugger`, no CDP, no UI automation, no keystroke injection;
* no widening of the popup-only message guard to a content script;
* no pre-arming of consent by editing storage by hand — an entry's `armedAt` is what
  proves the decision predates the end;
* nothing is sent unless **all** of: the trigger armed, the grant bound, a page probe
  passing, the pacing interval elapsed, and the hourly ceiling not reached.

## Status

Prototype. Read-only detection and bounded delivery are implemented and tested; the
extension never types or submits anything by itself. Docs in `docs/` describe the
mechanisms, not a promise of fitness for any particular use.
