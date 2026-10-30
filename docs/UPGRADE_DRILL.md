# Upgrading and rolling back the native host

This is the handover sheet. It assumes a maintenance window: someone is at the machine, the
old host is stopped by a person, and nobody is watching a chat window. Nothing here is
automatic, and nothing here is safe to run against a directory you are guessing about.

## What the tool can and cannot tell you

`tools/upgrade_preflight.py` is read-only and fail-closed. It reports:

| verdict | exit | meaning |
|---|---|---|
| `safe_to_start` | 0 | the lock, the queue and the debris all look startable |
| `needs_operator_confirmation` | 2 | something needs a human; the reasons name it |
| `legacy_lock_remove_by_hand` | 2 | a pre-T088 empty lock; the two protocols cannot exclude each other |
| `unknown_lock_content` | 2 | the lock holds something this code does not recognise |
| `queue_damaged` | 2 | the queue will not load; do not start a host against it |
| `interrupted_save_detected` | 2 | a half-written save was left behind |

Two limits are permanent:

* **It cannot prove no process is running.** It can now *ask*: it takes the queue lock
  without blocking and gives it straight back. `held_by_a_process: true` means a host is
  running right now, and the verdict is not `safe_to_start` whatever `--host-stopped` says.
  `null` means the question could not be answered, which is also not a yes.
* **A redirected path is not approved on its own.** If the state path resolves through a
  symlink or junction, the verdict describes the resolved directory and stays manual until
  you pass `--accept-realpath <the directory you meant>`.

## The drill

```powershell
python -B tools/upgrade_drill.py --attest-stopped            # full sequence, JSON on stdout
python -B tools/upgrade_drill.py --report drill.json         # without an attestation it stops
                                                             # after the read-only stages
```

It builds a legacy fixture (a real-format queue written by the current code, then an empty
lock file), walks the sequence, and prints every verdict. It never takes a path from you: a
drill that could be pointed at a real state directory is one accident away from being an
upgrade. Stages, in order:

| stage | what it records |
|---|---|
| `prepared` | the fixture's files, queue version, legacy lock size |
| `preflight-with-legacy-lock` | `legacy_lock_remove_by_hand` |
| `preflight-legacy-with-attestation` | still `legacy_lock_remove_by_hand` — an attestation does not make a legacy lock safe |
| `stopped` | `attested: true` — your statement, not something the drill verified |
| `preflight-after-removal` | `safe_to_start` |
| `start` | the fresh `os_v1` lock and whether anything holds it |
| `verify` | which events each consumer sees, ack counts, generation, no event lost |
| `rollback-view` | the verdict a rollback would see |
| `summary` | which files changed |

Plus two refusals, each of which must leave the fixture **byte-identical** (sha256 per file):
an unknown lock and a damaged queue.

## The window, step by step

1. Tell people the relay is down. Nothing here is silent.
2. Stop the old host yourself. Confirm in its own log that it exited.
3. `python -B tools/upgrade_preflight.py --state <dir> --host-stopped`
   * `legacy_lock_remove_by_hand` → delete `queue.lock` by hand, re-run until `safe_to_start`;
   * `unknown_lock_content` → **stop**. Do not delete a lock you cannot identify;
   * `queue_damaged` / `interrupted_save_detected` → **stop**, keep the directory as it is,
     and restore from a copy you took at step 2.
4. Start the new host. It writes its own `os_v1` lock; the marker holds a per-run token.
5. Verify: the queue loads, `pending_events` returns what the page expects, and the ack you
   take is visible in `consumer_acks`. **A host ACK is not a visible page.** Delivery is a
   later, separate layer; do not report a notice as seen because the queue says `acked`.
6. Keep the copy from step 2 until the new host has run through one full cycle.

## Rollback

1. Stop the **new** host first. Its lock is an OS lock: the file is not deleted, the OS
   releases it when the process dies.
2. `python -B tools/upgrade_preflight.py --state <dir> --host-stopped` — if it reports a
   held lock, a host is still alive.
3. Remove `queue.lock` by hand only if the preflight names it, then start the old build.
4. The old build does not understand the `os_v1` marker. If it refuses, that is the
   documented incompatibility, not a bug: the two protocols cannot exclude each other.
5. The queue format is shared by both builds, so the data survives a rollback; a rollback
   that needs data restored is a restore-from-copy, not a rollback.

## What the drill does not cover

* the real host process — the drill exercises the queue protocol, not a bound port;
* the extension side — no popup, no consent store, no Chrome storage is touched;
* processes that leave the session or the job on purpose (`setsid`,
  `CREATE_BREAKAWAY_FROM_JOB`) are outside any kill guarantee, here as in the gate;
* the window between "preflight said safe" and "the new host took the lock" cannot be closed
  in user space. That is what the maintenance window is for.
## What the lock probe does and does not establish

`held_by_a_process: true` means a process was **holding the lock at that moment**, and it
stops the verdict from being `safe_to_start` even with `--host-stopped`. `false` means nobody
was holding it right then — the host takes its lock per operation, so an idle host holds
nothing, and `false` is *not* evidence that no host is running. `null` means the question
could not be asked, which is not a yes either.

Proven, with a real second process and a ready-file handshake (T098): a holder in another
process is seen on Windows through its byte-range lock, and the verdict stays manual with and
without `--host-stopped`. A killed holder releases the lock through the operating system
(T097, real host subprocess).

Recorded limitation: on POSIX a lock file can be replaced while the holder keeps the *old*
inode locked, so the probe then describes the new file. Windows refuses the swap because the
held file is open, which is why the swap case is a Windows assertion and a POSIX note.

How to read it in a maintenance window: the probe is one more signal in the direction of "do
not start yet". It has never been, and must not become, the evidence that a host is stopped.
That statement is still yours to make.