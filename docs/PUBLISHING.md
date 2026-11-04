# Publishing this repository

This repository is a snapshot of source, tests and documentation. It is not a backup:
anything here is public, permanent, and will be read by someone who does not have the
context you have.

`AGENTS.md` states what must never appear. This file is how that is checked.

## One command

```powershell
python -B tools/release_gate.py --clean-clone
```

Checks, one code-publishability verdict (not a browser-upgrade verdict):

| check | what it answers |
|---|---|
| `worktree` | is there anything uncommitted that would be pushed by accident |
| `dependencies` | are the required Python/Node dependencies present |
| `hygiene` | does the tree hold an identifier, path or key that must not be published |
| `stamp` | does the source tree's declared extension stamp describe its own files |
| `install` | configured unpacked install files vs source: `PASS`, `WARN` drift or explicitly `SKIP`/unchecked; Chrome loaded runtime stays UNKNOWN |
| `python suite` | `unittest discover` — the AGENTS.md contract, with its skip count |
| `js suites` | every `test_*.mjs`, each in its own node process |
| `clean clone` | run it again in a checkout of `HEAD`, because a working tree carries things a push does not |

`--clean-clone` is the one that matters before a push. Twice now a suite has passed here
for the wrong reason: T069's precision suite resolved its files through an absolute path
into the working copy, so it verified the live tree rather than the tree under test and
would have failed on any other machine.

Exit code 0 means source may be pushed, **not** that Chrome has upgraded. Anything else
prints which check disagreed and the last few lines of its output.

The `install` stage is read-only and opt-in via `DSH_EXTENSION_INSTALL` (legacy
`T218_INSTALLED_EXT` also accepted), with private repo-local `agentrelay.extensionInstall`
as a persistent fallback for independent developer processes. No configuration is explicit
`SKIP / UNCHECKED`, not
agreement. Drift reports `source updated, installed outdated; needs explicit sync + human
Chrome Reload` as `WARN` by default; `--require-install` fails unless configured install
files match. A configured invalid/unreadable directory fails even without that flag.
Quote this row in the development handoff; disk equality never proves Chrome Reload.
See [Extension deployment preflight](EXTENSION_DEPLOY.md) for configuration, CI behavior,
strict-byte comparison, manual maintenance and rollback. No background copy or Reload runs.

## The hygiene scan

```powershell
python -B tools/hygiene_scan.py --self-test   # prove the rules catch what they claim
python -B tools/hygiene_scan.py --all         # the tree that would be published
python -B tools/hygiene_scan.py --all --json  # for a tool
```

`--all` scans **tracked** files only, restricted to source and config. Documentation is
excluded on purpose: a document explaining which patterns are forbidden has to contain
them, and a gate that fires on its own explanation is a gate people turn off.

### Why prose was not enough

The gate described in `AGENTS.md` was run in full before the T095B77 release and printed
nothing, while the published tree contained:

* a real DSH session id, copied into a test fixture;
* one machine's absolute working path, as a forward-slash drive path;
* one machine's interpreter path, written the way source code stores a separator.

Three reasons, and each is now a rule with a self-test:

1. **Nothing looked for the commonest identifier in this project.** The gate knew
   `ghp_...` and `chrome-extension://`, not `session-<uuid>`, which is what this
   codebase writes on every line.
2. **The path rule could not match the way source stores a path.** It was written as
   one literal separator; source code stores one as two characters. `E:\\program\\...`
   was therefore invisible to a rule that appeared to cover it.
3. **Nothing looked at forward-slash drive paths.** The JavaScript suites spell theirs
   that way, and `[A-Z]:\\Users` does not match `E:/...`.

The lesson is in `AGENTS.md` already, from the first release: a gate you believe in but
never actually ran. The answer is not a better paragraph.

### Readings of the output

| word | meaning | may it ship |
|---|---|---|
| `LEAK` | an identifier, account path or key | no |
| `REVIEW` | a value a human has to judge, e.g. an id or a drive path | only allowlisted |
| `excused` | allowlisted, with a reason, printed on every run | yes |
| `STALE` | an allowlist entry that no longer excuses anything | no — remove or update it |

A stale entry is a failure, not housekeeping. It keeps matching the same rule and path
prefix, so the day a *new* value appears in that file it is excused by a judgement made
about a value that is no longer there.

`.hygiene-allow.txt` requires a reason on every line. `test_publish_hygiene.py` fails
without one, and runs the whole scan as part of the ordinary suite — so the tree cannot
be green while the gate is broken or while an identifier is unexplained.

### What the scan cannot do

It matches shapes, so it finds a value that *looks* like an identifier, not one that
*is*. It cannot know that a fixture is fabricated. That is what the reason column is
for, and why the allowlist is coarse (rule plus path) — a coarse exception with a
written reason is auditable; a clever pattern that silently passes the real thing is not.

It also cannot see what was never in a file: a value pasted into a report, a commit
message, or an issue. Those are checked by reading them.

## Known debt

Recorded here so it does not become furniture in the allowlist.

1. **The launcher bakes in one machine's interpreter path.** `launcher/HostLauncher.cs`
   defaults to a specific `python.exe` and `launcher/build_launcher.ps1` passes it at
   build time. Removing it means rebuilding `host_launcher.exe`, whose hash the preflight
   pins, and restarting the running host — a maintenance window, not a commit. Low
   identifying value (an install path, no account name), still one machine's layout.

## Sensitive by nature: diagnosis output

`t045_diagnose.py` prints the extension id derived from the unpacked extension path — it
is a hash of that path. That is the whole point of it locally, and it means its output is
machine identifying. Do not paste it into a published report or issue without replacing
the id.
