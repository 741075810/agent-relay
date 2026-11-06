"""Read-only terminal-candidate reader for the auto-notify path (T059).

Reuse, not re-invention: the ledger location, the terminal-status mapping and the
strict shape check come from the Bridge reader already used elsewhere in this
handoff (`inbox/bridge_runs_source.py`). What is deliberately *not* reused is its
output shape -- that one produces display events with project paths and session
ids, and this path must carry the least information that can still identify a
task.

So the contract here is narrow on purpose:

  * identifiers are limited to `runId`, `status`, `startedAt`;
  * no project path, no session id, no message, no title, no turn, no exit code;
  * nothing is written to the notification queue, and no event is produced at
    all -- this returns candidates, and `deliverable:false` stays untouched.

Baseline semantics ("first sample only establishes a baseline"):

A watermark on `createdAt` would be wrong. A run that started yesterday and
finished a minute ago has an old `createdAt`, so a watermark would drop exactly
the long-running task a person most wants to hear about. Instead the first
sample records every run id it saw; afterwards a candidate is "new" when its id
was not in that baseline and has not been reported since. Completion order stops
mattering.
"""
import json
import hashlib
import os
import time

import native_turns
import relay_merge
import run_origin

# The status a candidate may carry. T067R: `interrupted` used to map to
# `cancelled`, and that was a false statement about the run.
#
# Evidence from the live machine: of the 17 ledger runs whose status is
# `cancelled`, every one the Bridge database also knows about is `failed` or
# `interrupted` there -- e.g. 9a9f4d17 is `cancelled` in the ledger while the
# Bridge records `failed` with `failure_code=desktop_event_invalid`. The ledger's
# `cancelled` is the *transport* verdict ("the desktop event stream ended without a
# terminal event"), not the task's outcome, and the notice text asserted it as fact.
# An interruption is not a decision by the operator, so it is reported as a
# failure. Only an explicit user abort is announced as `cancelled`; that verdict
# comes from DSH's own `turn/end` reason (`aborted` + `reason: user`).
TERMINAL = {
    'completed': 'completed',
    'failed': 'failed',
    'cancelled': 'cancelled',
    'interrupted': 'failed',
}

# Which source is authoritative for a run's status. The Bridge database records
# what the task actually did; the ledger records what the desktop event stream
# managed to deliver. The former wins whenever it has an opinion.
FACT_TO_STATUS = {
    'completed': 'completed',
    'failed': 'failed',
    'interrupted': 'failed',
}

# Where the Bridge writes its run ledger. Derived from the environment: a hard-coded
# absolute path containing the operator's user name only works on one machine and
# embeds that name in anything published. `DSH_BRIDGE_LEDGER` overrides it for tests
# and unusual installs.
def _default_ledger():
    override = os.environ.get('DSH_BRIDGE_LEDGER')
    if override:
        return override
    base = (os.environ.get('LOCALAPPDATA')
            or os.path.join(os.path.expanduser('~'), 'AppData', 'Local'))
    return os.path.join(base, 'CodexBridgeService', 'AgentState', 'DSHDesktop')


DEFAULT_LEDGER = _default_ledger()
LEDGER_SUFFIX = '.runs.json'
STATE_NAME = 'terminal-source.json'
# T091: the arm snapshot lives beside the sampler state, not inside it. The
# sampler's own document has a `version` that is checked strictly on load, so
# adding a key there would make a newer file unreadable by an older host; a
# separate file keeps the two upgrades independent.
ARM_NAME = 'terminal-arm.json'
ARM_VERSION = 1
STATE_VERSION = 1
MAX_STATE_IDS = 5000
# Deferrals are a work list, not a history: they are re-decided from the candidate's own instant on every sample, so a
# bound loses only the record of what was seen.
MAX_DEFERRED_IDS = 2000
# The arm snapshot is an id set, so it has the same shape of bound as the
# baseline. Exceeding it is *not* absorbed: see `arm_snapshot`.
MAX_SNAPSHOT_IDS = 5000
MAX_CANDIDATES = 20
MAX_LEDGER_BYTES = 256 * 1024 * 1024


class SourceError(Exception):
    """The ledger could not be read or did not have the expected shape."""


def ledger_paths(root=None):
    """Every `*.runs.json` ledger under the AgentState root.

    Same discovery rule as the Bridge reader this module reuses: the ledger does
    not sit at the root -- it lives one hash-named directory down
    (`<root>/<sha256>/endpoint.json.runs.json`) -- so a fixed join to the root
    finds nothing and reports "source unavailable" while the file is right there.
    A `root` that is itself a ledger file is accepted, which is what tests use.
    """
    root = root or DEFAULT_LEDGER
    if os.path.isfile(root):
        return [root] if root.endswith(LEDGER_SUFFIX) else []
    if not os.path.isdir(root):
        raise SourceError('ledger root %s is not a directory' % root)
    found = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(LEDGER_SUFFIX):
                found.append(os.path.join(base, name))
    return sorted(found)


def ledger_path(root=None):
    """The one ledger to read.

    "One" is enforced, not assumed: two ledgers would mean two answers to "what
    finished", and picking either silently would make the notification depend on
    directory ordering. Refusing is the only honest outcome until someone says
    which source is authoritative.
    """
    paths = ledger_paths(root)
    if not paths:
        raise SourceError('no *%s ledger under %s'
                          % (LEDGER_SUFFIX, root or DEFAULT_LEDGER))
    if len(paths) > 1:
        raise SourceError('%d *%s ledgers under %s; refusing to guess which is '
                          'authoritative' % (len(paths), LEDGER_SUFFIX,
                                             root or DEFAULT_LEDGER))
    path = paths[0]
    size = os.path.getsize(path)
    if size > MAX_LEDGER_BYTES:
        raise SourceError('%s is %d bytes, beyond the %d byte ceiling'
                          % (path, size, MAX_LEDGER_BYTES))
    return path


def read_runs(path):
    """Validated runs. Strict: a changed shape is refused, never guessed at."""
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            runs = json.load(handle)
    except (OSError, ValueError) as exc:
        raise SourceError('cannot read %s: %s' % (path, exc))
    if not isinstance(runs, list):
        raise SourceError('%s does not hold a list of runs' % path)
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            raise SourceError('%s run %d is not an object' % (path, index))
        request = run.get('requestID')
        if not isinstance(request, str) or not request:
            raise SourceError('%s run %d has no requestID' % (path, index))
        created = run.get('createdAt')
        if not isinstance(created, (int, float)) or isinstance(created, bool):
            raise SourceError('%s run %s has no numeric createdAt'
                              % (path, request))
    return runs


def _state_path(state_dir):
    return os.path.join(state_dir, STATE_NAME)


def _arm_path(state_dir):
    return os.path.join(state_dir, ARM_NAME)


def load_arm(state_dir):
    """The arm snapshot, or None. Strict: an unreadable one is refused, not ignored.

    Returning None for a corrupt file would be indistinguishable from "never
    armed", and the caller would then treat every candidate as unproven -- which is
    the safe direction but hides the real cause. So a corrupt file raises, and the
    host turns that into a named failure.
    """
    path = _arm_path(state_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
    except (OSError, ValueError) as exc:
        raise SourceError('cannot read %s: %s' % (path, exc))
    if not isinstance(doc, dict) or doc.get('version') != ARM_VERSION:
        raise SourceError('%s is not a version %d arm snapshot'
                          % (path, ARM_VERSION))
    epoch = doc.get('epoch')
    if not isinstance(epoch, str) or not epoch:
        raise SourceError('%s has no epoch' % path)
    ids = doc.get('ids')
    if not isinstance(ids, list) or any(not isinstance(i, str) or not i
                                        for i in ids):
        raise SourceError('%s has no id list' % path)
    if doc.get('truncated') is not False:
        # A truncated snapshot must never be treated as a complete one: the ids it
        # dropped would look new. Refuse the whole document.
        raise SourceError('%s is not a complete snapshot' % path)
    if not isinstance(doc.get('takenAt'), (int, float)):
        raise SourceError('%s has no numeric takenAt' % path)
    precision = doc.get('armTakenAtMs')
    if precision is not None:
        if isinstance(precision, bool) or not isinstance(precision, int) or precision <= 0:
            raise SourceError('%s has a malformed armTakenAtMs' % path)
        # A millisecond field that disagrees with its own second field is not a boundary anyone can trust.
        if precision // 1000 != int(doc['takenAt']):
            raise SourceError('%s has armTakenAtMs and takenAt in different seconds' % path)
    return doc


def save_arm(state_dir, doc):
    _atomic_write(_arm_path(state_dir), doc)


def arm_snapshot(state_dir, root=None, epoch=None, relay_source=None):
    """Record which runs were already terminal at this instant (T091).

    This is the boundary T086 could not draw. `startedAt` only proves "completion
    is at or after creation", so a task created before the operator armed but
    finished afterwards was indistinguishable from the backlog and had to be
    refused. Here the host answers, from its own fresh read of the ledger, the
    exact question "which runs are terminal *now*". Anything absent from that set
    was not terminal at snapshot time, so it completed afterwards -- provable, in
    both directions, without inventing a completion timestamp the ledger does not
    carry.

    Two rules make it safe rather than merely convenient:

      * the snapshot is *complete* or the arm fails. A bounded snapshot would drop
        its oldest ids, and the dropped ones would look new -- the exact failure
        this exists to prevent;
      * the snapshot is bound to an `epoch` the caller chooses, and every later
        sample echoes the epoch that is on disk. A mismatch means the two sides
        are talking about different arm rounds, and nothing can be proven.

    The id list is not returned: the caller only needs the count and the epoch, and
    a run id is the one identifier this path is allowed to carry, so it keeps
    carrying it only where it must.
    """
    if not isinstance(epoch, str) or not epoch or len(epoch) > 128:
        return {'ok': False, 'code': 'bad_epoch', 'epoch': None,
                'error': 'epoch must be a non-empty string of at most 128 chars'}
    try:
        runs = read_runs(ledger_path(root))
    except SourceError as exc:
        # A source we cannot read is not an empty source: refusing the arm is the
        # only answer that cannot be wrong.
        return {'ok': False, 'code': 'source_unavailable', 'epoch': None,
                'error': str(exc)}
    ids = []
    for run in runs:
        if TERMINAL.get(run.get('status')):
            ids.append(run['requestID'])
    # T210: an arm snapshot is a statement about *the sources it read*. The Bridge ledger knows nothing about runs that
    # only the relay saw, so a snapshot built without the relay cannot authorise a relay candidate by its absence --
    # that was the cross-source gap: every relay-only run looked "not in the arm", hence "finished after consent".
    relay_covered = False
    relay_count = 0
    if relay_source:
        relay_candidates, relay_code = relay_merge.fetch(relay_source)
        if relay_code is not None:
            # Arming with a source we cannot read would produce a snapshot that silently omits it. Refuse instead.
            return {'ok': False, 'code': 'relay_source_unavailable_for_arm', 'epoch': None,
                    'error': relay_code}
        relay_covered = True
        for item in relay_candidates:
            ids.append(item['runId'])
            relay_count += 1

    if len(ids) > MAX_SNAPSHOT_IDS:
        return {'ok': False, 'code': 'snapshot_truncated', 'epoch': None,
                'count': len(ids), 'limit': MAX_SNAPSHOT_IDS,
                'error': ('%d terminal runs exceed the %d id snapshot bound; '
                          'refusing to arm on a partial snapshot'
                          % (len(ids), MAX_SNAPSHOT_IDS))}
    now_ms = int(time.time() * 1000)
    doc = {
        'version': ARM_VERSION,
        'epoch': epoch,
        # `takenAt` stays whole seconds because older extension builds read it. It is *not* used for the consent
        # boundary any more: truncating 12:00:00.900 to 12:00:00 made a task that finished at 12:00:00.500 -- before the
        # operator consented -- look as though it finished after.
        'takenAt': now_ms // 1000,
        # The instant this snapshot was taken, to the millisecond. This is the boundary.
        'armTakenAtMs': now_ms,
        'ids': sorted(set(ids)),
        'truncated': False,
        # What this snapshot actually covers. `relayCovered: false` is not a defect -- it is the honest statement that
        # relay consent must then be decided per run from completion evidence.
        'sources': sorted(['bridge_ledger'] + (['relay'] if relay_covered else [])),
        # `relayCovered` means "the relay service was read", nothing more. The service is a cache filled by an
        # asynchronous sidecar, so an empty read is not a complete picture of the original ledger.
        'relayCovered': relay_covered,
        'relayCount': relay_count,
        'relaySource': 'service-cache' if relay_covered else None,
        # No writer can produce this today: it would need a watermark from the original terminal source, not a cache.
        # Written explicitly so a reader of the file cannot mistake `relayCovered` for it.
        'relayUpstreamComplete': False,
    }
    try:
        save_arm(state_dir, doc)
    except OSError as exc:
        return {'ok': False, 'code': 'snapshot_not_persisted', 'epoch': None,
                'error': str(exc)}
    return {'ok': True, 'code': None, 'epoch': epoch,
            'takenAt': doc['takenAt'], 'count': len(doc['ids']),
            'truncated': False, 'source': 'codex-bridge-ledger',
            'sources': doc['sources'], 'relayCovered': relay_covered, 'relayCount': relay_count,
            'relaySource': doc['relaySource'], 'relayUpstreamComplete': False}


def _arm_boundary(arm, activated_at):
    """The instant consent begins, and how precisely it is known.

    A snapshot written before `armTakenAtMs` existed records only the second. The operator armed somewhere inside that
    second, so every candidate finishing *within* it is uncertain, and uncertainty here must not be rounded towards
    sending: the boundary becomes the end of that second, and a run must complete strictly after it. That costs at most
    one second of notifications and cannot produce a notice about work that had already finished.
    """
    if arm is None:
        return activated_at, 'activation'
    precise = arm.get('armTakenAtMs')
    if isinstance(precise, int) and not isinstance(precise, bool) and precise > 0:
        return precise, 'ms'
    return (int(arm['takenAt']) + 1) * 1000 - 1, 'second'


def load_state(state_dir):
    path = _state_path(state_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
    except (OSError, ValueError) as exc:
        raise SourceError('cannot read %s: %s' % (path, exc))
    if not isinstance(doc, dict) or doc.get('version') != STATE_VERSION:
        raise SourceError('%s is not a version %d state file'
                          % (path, STATE_VERSION))
    if not isinstance(doc.get('baselineIds'), list) or \
            not isinstance(doc.get('ackedIds', []), list) or \
            not isinstance(doc.get('pendingIds', []), list):
        raise SourceError('%s is missing its id lists' % path)
    # T268: the status-scoped journals. A malformed one is refused rather than treated as empty, because
    # "no forms" makes every historical ACK suppress all of a run's statuses again -- which is safe -- but
    # silently accepting a damaged list would hide that the file needs looking at.
    for key in ('pendingForms', 'ackedForms'):
        value = doc.get(key)
        if value is None:
            continue
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            raise SourceError('%s has a damaged %s list' % (path, key))
    return doc


def _atomic_write(path, doc):
    """Write a JSON document so a crash can only leave the old one or the new one.

    Three properties, each of which was missing from the two callers below:

      * the temporary carries the writer's pid, so two host processes cannot interleave
        their bytes into one file and publish the mixture. `host.save_queue` already did
        this; these two shared a fixed `.tmp`;
      * the bytes are flushed and fsynced before the rename, because the rename is atomic
        but the *contents* are not: publishing a file the kernel has not written out can
        leave a short document that reads as damaged state;
      * the temporary is removed if the write fails, so a full disk does not leave debris
        behind on every retry.
    """
    tmp = '%s.tmp-%d' % (path, os.getpid())
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    try:
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def save_state(state_dir, doc):
    _atomic_write(_state_path(state_dir), doc)


def _bounded_newest_first(ids_with_time):
    """Keep the newest `MAX_STATE_IDS`, and say whether anything was dropped."""
    ordered = sorted(ids_with_time, key=lambda item: item[1], reverse=True)
    kept = ordered[:MAX_STATE_IDS]
    return [item[0] for item in kept], len(ordered) - len(kept)


def _override_count(runs, facts):
    """How many runs this sample would have announced wrongly if the ledger ruled.

    Counted over the whole sample rather than only over what is being offered: the
    correction is a property of the two sources, and a poll that offers nothing must
    still be able to report that its own status vocabulary was wrong.
    """
    total = 0
    for run in runs:
        announced = resolve_status(run.get('status'),
                                   (facts or {}).get(run.get('requestID')))
        ledger_view = TERMINAL.get(run.get('status'))
        if announced and ledger_view and announced != ledger_view:
            total += 1
    return total


def resolve_status(ledger_status, fact):
    """The status to announce, given both accounts of the same run.

    `fact` is what the Bridge database says about the run (or None when it has no
    row). The order matters and is not a preference: a `failed` task announced as
    `cancelled` tells the operator they stopped something they never touched, which
    is the defect this function closes.
    """
    from_fact = FACT_TO_STATUS.get((fact or {}).get('status'))
    if from_fact:
        return from_fact
    return TERMINAL.get(ledger_status)


def native_run_id(session_id, turn):
    """A stable id for a turn DSH started on its own.

    Same shape as a Bridge run id, because the notice template and the Chrome-side
    run-id check are shared and neither should grow a second syntax. Derived, not
    random: the same turn must produce the same id on every poll and across a host
    restart, or the `seen` journal would stop recognising it and the operator's
    single click could be spent twice.
    """
    digest = bytearray(hashlib.md5(
        ('%s|%s' % (session_id, turn)).encode('utf-8')).digest())
    digest[6] = (digest[6] & 0x0f) | 0x80        # version nibble 8
    digest[8] = (digest[8] & 0x3f) | 0x80        # variant 8..b
    hexed = digest.hex()
    return '%s-%s-%s-%s-%s' % (hexed[0:8], hexed[8:12], hexed[12:16],
                               hexed[16:20], hexed[20:32])


def _ledger_turn_index(runs):
    """(sessionID, turn) for every run the ledger knows -- i.e. channel A.

    This is the exact A/B separator. The ledger only ever holds runs the Bridge
    dispatched, and each one carries the DSH session and turn number it became, so a
    native turn that appears here is already channel A's business. No timestamp
    window, no prompt matching, nothing that could drift.
    """
    index = set()
    for run in runs:
        session = run.get('sessionID')
        turn = run.get('turn')
        if isinstance(session, str) and session and isinstance(turn, int):
            index.add((session, turn))
    return index


def native_candidates(native_report, ledger_index, now=None):
    """Channel B: turns DSH ran that the Bridge never recorded.

    `origin: 'direct'` is a *proven* verdict here, not a default: the turn exists in
    DSH's own log and has no matching ledger run, so nobody dispatched it. The
    extension still requires a per-task opt-in before it may write anything.
    """
    if not native_report or native_report.get('ok') is not True:
        return []
    stamp = int(time.time()) if now is None else int(now)
    out = []
    for turn in native_report.get('turns', []):
        session = turn.get('sessionId')
        number = turn.get('turn')
        if not isinstance(session, str) or not isinstance(number, int):
            continue
        if (session, number) in ledger_index:
            continue                     # already channel A; never offered twice
        status = TERMINAL.get(turn.get('status'))
        if not status:
            continue
        ended_at = turn.get('endedAt')
        started = turn.get('startedAt')
        # T069: the terminal instant at the precision DSH actually recorded.
        #
        # `native_turns` carries `turn/end`'s `time` field, which is an epoch in
        # *milliseconds*. The old shape floored it to seconds and threw the rest away,
        # so two tasks that ended 800 ms apart inside the same second were
        # indistinguishable -- and a click made after the task ended could be mistaken
        # for one made before it. Nothing downstream can recover that precision, so it
        # is carried here or not at all.
        #
        # `None` means "we do not know when this ended". That is a real state (a
        # candidate synthesised from an incomplete log) and the consumer must refuse
        # rather than assume.
        ended_ms = ended_at if isinstance(ended_at, int) and ended_at > 0 else None
        out.append({
            'runId': native_run_id(session, number),
            'status': status,
            'startedAt': int(((started if isinstance(started, int) else ended_at)
                              or stamp * 1000) // 1000),
            'origin': 'direct',
            # Kept out of the notice (the template is fixed) and used only by the
            # popup, so the operator can tell which task they are opting in to.
            'nativeSession': session,
            'nativeTurn': number,
            # T069: authoritative, millisecond-precision end of the turn. The consent
            # rule compares against this and refuses when it is null.
            'endedAtMs': ended_ms,
            # T069: retained for compatibility -- older extension builds and the popup
            # label read this, and a stored candidate written before T069 has only
            # this field. It is *not* used to decide whether a click came first.
            'endedAt': int((ended_at or 0) // 1000),
        })
    out.sort(key=lambda item: item['startedAt'])
    return out


def running_report(state_dir, root=None, bridge_db=None, native_root=None,
                   now=None):
    """Turns DSH is running *right now* that the Bridge did not dispatch (T068).

    Read-only by construction: it reads the ledger and the session logs and writes
    nothing -- no state file, no pending list, no ACK. That matters because the popup
    calls it on open, and opening the popup must not be able to change what gets
    sent, consume a candidate, or move any bookkeeping forward.

    Fail closed, and say why. Two facts must both hold before a turn is offered:

      * the ledger is readable -- it is the only record of which (session, turn) the
        Bridge dispatched, so without it channel A cannot be excluded, and a running
        turn might be an A task the operator never asked to be asked about;
      * DSH's log is readable and shows a newest turn with no `turn/end`.

    Either failing yields `ok: False` with a code and an empty list. An empty list
    with `ok: True` is a different statement -- "nothing is running" -- and the callers
    must never let the two look alike.
    """
    stamp = int(time.time() * 1000) if now is None else int(now)
    report = {'ok': False, 'code': None, 'error': None, 'running': [],
              'runningCount': 0, 'bridgeRunning': 0, 'stale': 0,
              'nativeOk': False, 'nativeCode': None, 'ledgerOk': False,
              'ledgerError': None, 'source': 'dsh-session-log+bridge-ledger'}
    try:
        runs = read_runs(ledger_path(root))
    except SourceError as exc:
        report.update(code='ledger_unavailable', ledgerError=str(exc),
                      error='cannot exclude channel A without the ledger: %s' % exc)
        return report
    report['ledgerOk'] = True

    native = native_turns.sample(native_root, now=stamp)
    report['nativeOk'] = native.get('ok') is True
    report['nativeCode'] = native.get('code')
    report['stale'] = native.get('runningStale') or 0
    if not report['nativeOk']:
        report.update(code=native.get('code') or 'native_unavailable',
                      error=native.get('error'))
        return report

    index = _ledger_turn_index(runs)
    out = []
    bridge_running = 0
    for item in native.get('running') or []:
        session = item.get('sessionId')
        number = item.get('turn')
        if not isinstance(session, str) or not isinstance(number, int):
            continue
        if (session, number) in index:
            # The Bridge dispatched this turn: it is channel A, notified on its own
            # when it ends, and must never be offered as something to opt in to.
            bridge_running += 1
            continue
        out.append({
            'runId': native_run_id(session, number),
            'sessionId': session,
            'turn': number,
            'origin': 'direct',
            # Seconds, like every other timestamp the candidates carry; `None` when
            # the start record has scrolled out of the read window, because claiming
            # a start time we cannot see is exactly the kind of guess this release
            # removes.
            'startedAt': (int(item['startedAt'] // 1000)
                          if isinstance(item.get('startedAt'), int) else None),
            'observedSince': (int(item['ageAnchor'] // 1000)
                              if isinstance(item.get('ageAnchor'), int) else None),
            'lastActivityAt': (int(item['lastActivityAt'] // 1000)
                               if isinstance(item.get('lastActivityAt'), int)
                               else None),
            'activityCount': item.get('activityCount') or 0,
            # How running was established, so the popup can be specific instead of
            # saying "running" about a turn it only inferred.
            'evidence': item.get('evidence'),
        })
    out.sort(key=lambda item: item.get('lastActivityAt') or 0, reverse=True)
    report.update(ok=True, code=None, error=None, running=out,
                  runningCount=len(out), bridgeRunning=bridge_running)
    return report


def status_key(run_id, status):
    """The identity of one *fact* about a run: which run, announced as what.

    T268: this is the same key Chrome's trigger journal and dedupe use, and it is what an ACK has to be able to
    name. A run id alone says "something about this task was consumed", which is true of the failure but not of a
    later completion.
    """
    return '%s|%s' % (run_id, status)


def candidates_from(runs, state, arm_ids=None, origin=None, facts=None,
                    native=None):
    """Split validated runs into (candidates due now, next state).

    Two-phase on purpose. The earlier version recorded a run as delivered before
    the caller had stored it, so a Chrome disconnect between the answer and the
    save lost that completion permanently -- a notification that never fires and
    leaves no trace. Now a candidate moves to `pendingIds` when handed out and is
    excluded only when `ack` names it, so an unacknowledged candidate is offered
    again. Delivery is at-least-once; the duplicate suppression lives on the
    Chrome side (candidate key + trigger journal), which is the side that can
    actually tell whether a notice was written.

    `state is None` means this is the first sample: nothing is a candidate, the
    baseline is recorded, and the caller reports "baseline established". That is
    the whole point -- the first run must not fire a notification for every task
    that completed in the last month.
    """
    terminal = []
    # One run, one entry. A ledger can hold the same `requestID` twice: a resume that
    # appended instead of replacing, a retry, a writer that never truncated. Two entries
    # here become two candidates for one finished task, and therefore two notices -- the
    # exact failure this feature exists to prevent. The greatest `createdAt` wins, because
    # a re-write is the source's latest word about that run; a copy appearing later in the
    # file only wins when the timestamps tie. Found by T095B80's duplicate-record fault;
    # every earlier wire suite used distinct runs and never saw it.
    _chosen = {}
    for _run in runs:
        _run_id = _run.get('requestID')
        _kept = _chosen.get(_run_id)
        if _kept is None or (int(_run.get('createdAt') or 0)
                             >= int(_kept.get('createdAt') or 0)):
            _chosen[_run_id] = _run
    for run in _chosen.values():
        # T067R: the announced status is resolved from both accounts, not taken from
        # the ledger alone. A `failed` task that the ledger calls `cancelled` would
        # otherwise be reported to the operator as something they cancelled.
        status = resolve_status(run.get('status'),
                                (facts or {}).get(run.get('requestID')))
        if not status:
            continue
        item = {
            'runId': run['requestID'],
            'status': status,
            'startedAt': int(run['createdAt'] // 1000),
        }
        # T067: the channel this run came through travels with the candidate, not
        # in a second answer. Two answers could be read at different moments and
        # then disagree, and "which channel was this" is exactly the field a
        # duplicate notice would be built on. One value, decided once per sample:
        # `bridge` (auto-notified), `direct` (needs a per-task opt-in), or
        # `unknown` (cannot be proven, so it needs the same opt-in as `direct`).
        item['origin'] = run_origin.origin_for(item['runId'], origin)
        terminal.append(item)

    # T067R: channel B. Everything DSH ran on its own, minus every turn the ledger
    # already accounts for. Appended here so both channels go through one dedup
    # journal, one pacing budget and one armed-grant gate below -- a run can only be
    # admitted once no matter which source produced it.
    ledger_index = _ledger_turn_index(runs)
    for item in native_candidates(native, ledger_index):
        terminal.append(item)
    # The ledger's own account of a run outranks channel B's for the same run id, and a
    # run can only appear once. Ledger entries were appended first, so this keeps them.
    _seen_runs = set()
    _unique = []
    for item in terminal:
        if item['runId'] in _seen_runs:
            continue
        _seen_runs.add(item['runId'])
        _unique.append(item)
    terminal = _unique
    terminal.sort(key=lambda item: item['startedAt'])

    baseline, dropped = _bounded_newest_first(
        [(item['runId'], item['startedAt']) for item in terminal])

    if state is None:
        if arm_ids is None:
            # No snapshot to read the boundary from: the first sample can only
            # record everything terminal as history and offer nothing. Unchanged
            # from before T091 -- a run that finished between the arm and this
            # moment is absorbed, which is why arming now takes the snapshot first.
            return [], {
                'version': STATE_VERSION,
                'baselineIds': baseline,
                'pendingIds': [],
                'pendingForms': [],
                'ackedIds': [],
                'ackedForms': [],
                'baselineDropped': dropped,
                'baselineCount': len(terminal),
            }, {'baselineEstablished': True, 'existingTerminalRuns': len(terminal),
                'droppedFromBaseline': dropped, 'redelivered': 0}
        # With a snapshot, "terminal now" splits in two: what the host already saw
        # is history, and the rest provably finished after it. Offering that rest
        # here is what stops the very first sample of a fresh install from
        # swallowing a completion that arrived between the arm and this read.
        history = [item for item in terminal if item['runId'] in arm_ids]
        after = [item for item in terminal if item['runId'] not in arm_ids]
        history_ids, history_dropped = _bounded_newest_first(
            [(item['runId'], item['startedAt']) for item in history])
        if history_dropped > 0:
            # Would mean the arm snapshot is larger than the state bound, so the
            # dropped ids would be re-offered as new. Refuse rather than guess.
            raise SourceError('arm snapshot does not fit the baseline bound')
        after.sort(key=lambda item: item['startedAt'])
        offered = after[:MAX_CANDIDATES]
        return offered, {
            'version': STATE_VERSION,
            'baselineIds': history_ids,
            'pendingIds': [item['runId'] for item in offered],
            # T268: which *fact* each offer is. The ACK from Chrome names only a run id, so this is the only
            # record of what the page was actually shown; without it an ACK could only consume the whole run.
            'pendingForms': [status_key(item['runId'], item['status']) for item in offered],
            'ackedIds': [],
            'ackedForms': [],
            'baselineDropped': 0,
            'baselineCount': len(history),
        }, {'baselineEstablished': True, 'existingTerminalRuns': len(terminal),
            'droppedFromBaseline': 0, 'redelivered': 0}

    baseline_set = set(state['baselineIds'])
    acked = set(state['ackedIds'])
    pending = list(state.get('pendingIds') or [])
    # T268: an ACK consumes the *fact* the page was given, not the run. Chrome's `terminal-ack` carries run ids
    # only, so `ackedForms` records which status was actually on the page when it agreed. A run that was reported
    # `failed` and then really completed is a different fact, and refusing to ever mention it again loses the one
    # thing the operator needed to know.
    acked_forms = set(state.get('ackedForms') or [])
    # A bare id with no recorded fact is a state file from before this record existed (or an ACK for a run whose
    # offer predates it). It keeps its old, wider meaning -- "this run is done" -- because re-opening history after
    # an upgrade would re-announce every task the operator has already seen.
    suppress_whole_run = acked - {form.split('|', 1)[0] for form in acked_forms if '|' in form}

    def consumed(run_id, status):
        return run_id in suppress_whole_run or status_key(run_id, status) in acked_forms

    # Anything still pending is re-offered: the previous answer may never have
    # reached storage.
    terminal_by_id = {}
    for item in terminal:
        terminal_by_id[item['runId']] = item
    due = []
    for run_id in pending:
        item = terminal_by_id.get(run_id)
        if item is not None:
            due.append(item)
    redelivered = len(due)

    fresh = [item for item in terminal
             if item['runId'] not in baseline_set
             and not consumed(item['runId'], item['status'])
             and item['runId'] not in set(pending)]
    fresh.sort(key=lambda item: item['startedAt'])
    room = max(0, MAX_CANDIDATES - len(due))
    fresh = fresh[:room]

    handed_out = due + fresh
    pending_out = list(dict.fromkeys(
        [item['runId'] for item in handed_out] + pending))[-MAX_STATE_IDS:]
    # The forms follow the offers: a run re-offered after its status moved is offered as the fact it now is.
    pending_forms_out = list(dict.fromkeys(
        [status_key(item['runId'], item['status']) for item in handed_out]))[-MAX_STATE_IDS:]
    carried = {key: value for key, value in state.items()
               if key not in ('pendingIds', 'pendingForms', 'ackedIds', 'ackedForms', 'baselineIds',
                              'baselineDropped', 'baselineCount', 'version')}
    return handed_out, dict(carried, **{
        'version': STATE_VERSION,
        # The baseline is fixed at the first sample and must never be recomputed.
        # This used to return the freshly calculated `baseline`, which is the id set
        # of *every* terminal run currently in the ledger -- so the second sample
        # re-anchored the baseline onto the runs it had just handed out, and every
        # run that did not fit into that one answer (MAX_CANDIDATES is 20) was
        # absorbed forever. Symptoms: at most 20 notices per session, and any task
        # finishing while another was still pending never notified at all.
        'baselineIds': state['baselineIds'],
        'pendingIds': pending_out,
        'pendingForms': pending_forms_out,
        'ackedIds': list(state['ackedIds'])[-MAX_STATE_IDS:],
        'ackedForms': list(state.get('ackedForms') or [])[-MAX_STATE_IDS:],
        'baselineDropped': dropped,
        'baselineCount': state.get('baselineCount'),
    }), {'baselineEstablished': False, 'existingTerminalRuns': len(terminal),
         'droppedFromBaseline': dropped, 'redelivered': redelivered}


def acknowledge_relay(state, run_ids):
    """Record ACKs for relay-only candidates in their own journal, and return what was newly journalled.

    These runs were never in `pendingIds`, so an ACK for one must not be able to move a native candidate; the separate
    list also stops the re-push an ACK would otherwise cause, because `sample` refuses anything already in it.
    """
    journal = list(state.get('relayAckedIds') or [])
    offered = set(state.get('relayOfferedIds') or [])
    known = set(journal)
    # Only ids the native queue does not own. A native run acknowledged here would otherwise be journalled as if it came
    # from the relay, and the two namespaces would stop being distinguishable.
    native_owned = set(state.get('pendingIds') or []) | set(state.get('ackedIds') or [])
    added = []
    for item in run_ids or []:
        if not isinstance(item, str) or not item:
            continue
        forms = [item]
        if '|' in item:
            forms.append(item.split('|', 1)[0])
        if all(form in native_owned for form in forms):
            continue
        # Refusing what was never handed out is the whole point: journalling an unoffered id would silently cancel the
        # notice for a run that has not finished yet.
        if not any(relay_merge.was_offered(offered, form) for form in forms if '|' not in form) \
                and not any(form in offered for form in forms):
            continue
        for form in forms:
            if form in known:
                continue
            known.add(form)
            journal.append(form)
            added.append(form)
    state['relayAckedIds'] = journal
    return added


def acknowledge(state_dir, run_ids):
    """Mark candidates consumed. Called only after Chrome reports it persisted.

    Idempotent: acknowledging twice, or acknowledging something never handed out,
    changes nothing. The wire form is a bare run id -- that is what `background.js`
    sends -- so what an ACK *means* is decided here, from the offers this host
    actually made: every pending fact for that run is consumed, and only that fact.

    T268: the older reading was "a run has exactly one terminal status, so a bare id
    may consume the run". A run reported `failed` and later really completed is two
    facts about one run, and collapsing them meant the corrected outcome could never
    reach the page. A bare id with no recorded offer keeps the wide meaning, which is
    what an upgraded state file needs.
    """
    if not isinstance(run_ids, list):
        raise SourceError('ack needs a list of run ids')
    wanted = set()
    for value in run_ids:
        if not isinstance(value, str) or not value:
            raise SourceError('ack needs non-empty string run ids')
        wanted.add(value)
    state = load_state(state_dir)
    if state is None:
        return {'acked': 0, 'reason': 'no_sampler_state'}
    acked = list(state['ackedIds'])
    known = set(acked)
    pending = [r for r in (state.get('pendingIds') or [])]
    pending_forms = list(state.get('pendingForms') or [])
    acked_forms = list(state.get('ackedForms') or [])
    known_forms = set(acked_forms)
    moved = 0
    for run_id in wanted:
        if run_id not in pending:
            # Never handed out: refusing to consume what was not delivered.
            continue
        # The facts this run was offered as. A state file from before `pendingForms`
        # existed has none, and its ACK then falls back to the wide meaning below.
        forms = [item for item in pending_forms if item.split('|', 1)[0] == run_id and '|' in item]
        new_forms = [form for form in forms if form not in known_forms]
        if not new_forms and run_id in known:
            # This run, in the shape it was offered, has already been consumed. Saying
            # so again changes nothing -- that is the idempotence the caller relies on.
            continue
        for form in new_forms:
            known_forms.add(form)
            acked_forms.append(form)
        if run_id not in known:
            known.add(run_id)
            acked.append(run_id)
        moved += 1
    next_state = dict(state)
    next_state.update({
        'version': STATE_VERSION,
        'baselineIds': state['baselineIds'],
        'pendingIds': [r for r in pending if r not in known],
        'pendingForms': [item for item in pending_forms if item.split('|', 1)[0] not in known],
        'ackedIds': acked[-MAX_STATE_IDS:],
        'ackedForms': acked_forms[-MAX_STATE_IDS:],
        'baselineDropped': state.get('baselineDropped', 0),
        'baselineCount': state.get('baselineCount'),
    })
    save_state(state_dir, next_state)
    return {'acked': moved, 'pending': len(next_state['pendingIds'])}


def sample(state_dir, root=None, bridge_db=None, origin_fixture=None,
           native_root=None, now=None, relay_source=None):
    """One read-only sample. Returns candidates plus a small, honest report.

    Never raises for a missing ledger: a missing source is reported as a gap with
    a name, because "the source is not there" and "there is nothing new" must not
    look the same to the caller.
    """
    try:
        path = ledger_path(root)
        runs = read_runs(path)
    except SourceError as exc:
        return {'ok': False, 'code': 'source_unavailable',
                'error': str(exc), 'candidates': [], 'baselineEstablished': False}
    # T067: which channel dispatched each run. Read before anything is decided, so
    # a candidate can never be handed out without its channel attached -- there is
    # no second look-up that could disagree with the first.
    #
    # A failure here does *not* refuse the sample. Every candidate is then marked
    # `unknown`, which the extension must treat exactly like `direct`: manual,
    # per-task consent. That keeps channel B working (it is manual anyway) and
    # degrades channel A to the same manual path instead of silencing it. The one
    # thing it must never do is call an unknown run `bridge`, because that is the
    # only route to an unnotified-and-unattended write.
    origin = run_origin.classify(state_dir, db_path=bridge_db)
    if origin_fixture is not None:
        # Test-only stand-in for the bridge's own table; see `classify_fixture`.
        origin = run_origin.classify_fixture(
            origin_fixture, [run['requestID'] for run in runs])
    try:
        state = load_state(state_dir)
    except SourceError as exc:
        # A damaged sampler state is not "nothing new", and it is not repairable here.
        # The file is where `pendingIds` lives, so synthesising a fresh one would absorb
        # whatever completion was waiting in it -- the loss would be silent, and the
        # report would call the silence correct. Refusing is the only honest answer:
        # nothing is written, the damaged file survives for the operator to inspect, and
        # the caller is told which way this failed. Letting the exception escape instead
        # left Chrome with no answer at all, and every later poll repeated it.
        return {'ok': False, 'code': 'state_unreadable', 'error': str(exc),
                'candidates': [], 'requiresAck': False, 'confirmed': False,
                'deliverable': False, 'provenance': 'unverified',
                'baselineEstablished': False, 'redelivered': 0}
    # T067R: what the Bridge says each run actually did. Read once per sample and
    # used to overrule the ledger's own status, which reports the desktop event
    # stream rather than the task (see `resolve_status`).
    facts, facts_error = run_origin.read_run_facts(bridge_db)
    # T067R: channel B's only possible source. Failure here is reported and never
    # fatal: channel A must keep working when DSH's log cannot be read, and the
    # caller must not read "no native turns" out of "could not look".
    # T068: `now` is a test seam only -- production callers pass nothing and the
    # native reader uses the wall clock. It exists because the in-flight window is
    # decided by time (24 h horizon, one-week stale cut-off), and no honest test can
    # spend a week of wall time to check the stale cut-off.
    native = native_turns.sample(native_root, now=now)
    try:
        arm = load_arm(state_dir)
    except SourceError as exc:
        # A corrupt arm snapshot is reported, never silently downgraded to
        # "unproven": the caller would then have to guess why nothing is sendable.
        return {'ok': False, 'code': 'arm_snapshot_unreadable',
                'error': str(exc), 'candidates': [], 'baselineEstablished': False}
    try:
        due, next_state, info = candidates_from(
            runs, state, arm_ids=set(arm['ids']) if arm is not None else None,
            origin=origin, facts=facts, native=native)
    except SourceError as exc:
        # The one way this can happen is a snapshot larger than the state bound,
        # which would silently re-offer history. Name it instead of raising, so the
        # caller sees a refusal rather than a dropped connection.
        return {'ok': False, 'code': 'arm_snapshot_too_large',
                'error': str(exc), 'candidates': [], 'baselineEstablished': False}
    save_state(state_dir, next_state)
    # T091: mark each offer against the arm snapshot. `postArm is True` means the
    # run was not terminal when the operator armed, so it finished afterwards;
    # `False` means it was already terminal and is history; `None` means there is
    # no snapshot to compare with, and the caller must fall back to its own proof.
    if arm is not None:
        known = set(arm['ids'])
        for candidate in due:
            candidate['postArm'] = candidate['runId'] not in known
    else:
        for candidate in due:
            candidate['postArm'] = None
    # T066: freshness of the source itself. A frozen ledger is indistinguishable
    # from a quiet afternoon by every other field in this answer -- `ok: true`,
    # `candidates: []`, `baselineEstablished: false` all stay the same -- so the
    # one thing the caller cannot derive is how old the source is. That is exactly
    # how a 90-minute stop in run recording looked like a healthy chain: every
    # poll succeeded, nothing was offered, and no field said "the source has not
    # moved". Reported, never judged: the caller decides, and nothing here can
    # change a candidate's fate.
    newest = None
    for run in runs:
        if not TERMINAL.get(run.get('status')):
            continue
        if newest is None or run['createdAt'] > newest['createdAt']:
            newest = run
    try:
        ledger_mtime = int(os.path.getmtime(path))
    except OSError:
        ledger_mtime = None
    # T206: the relay's verified terminal candidates, in the same answer and format. The native bookkeeping above is
    # already decided and written at this point, so merging here cannot move the baseline or the native pending list;
    # the relay's ACKs live in their own journal (see `relay_merge` and `acknowledge`).
    relay_candidates, relay_code = relay_merge.fetch(relay_source)
    relay_absorbed = 0
    relay_unverified = 0
    relay_implausible = 0
    # Kept in the report, permanently zero: absence from a snapshot has no evidentiary value for this source.
    relay_snapshot_authorised = 0
    relay_absence_refused = 0
    relay_deferred = 0
    relay_deferred_dropped = 0
    relay_source_untrusted = 0
    arm_precision = 'activation'
    relay_activation = next_state.get('relayActivation')
    if relay_source:
        # The relay is an optional source that can arrive long after the native one, so it keeps an activation of its
        # own: an instant, recorded once, plus the ids proven to be older than it. Borrowing the native
        # `baselineEstablished` moment meant a relay enabled months later announced everything it could see.
        if relay_code is not None:
            # A failure says nothing about the relay's contents. Leave the activation untouched, so a later successful
            # read still gets to absorb history rather than finding an "initialised" empty one.
            relay_activation = relay_activation or 'unknown'
        elif relay_activation == 'stalled':
            relay_code = 'relay_history_overflow'
        else:
            activated_at = next_state.get('relayActivatedAt')
            if activated_at is None:
                activated_at = int(time.time() * 1000)
            arm_ids_now = set(arm['ids']) if arm is not None else None
            # The boundary is the consent instant when a snapshot exists, and the moment this source first became
            # readable when it does not. Either way the only usable proof is a *completion* time: creation time says
            # completion is at or after it, which is the wrong direction for a decision about consent.
            boundary_ms, arm_precision = _arm_boundary(arm, activated_at)
            now_ms = int(time.time() * 1000)
            # T212: a snapshot may never authorise by absence. `relayCovered` only records that the relay *service*
            # was read, and that service is filled asynchronously by the `host_mirror.mjs` sidecar -- so an empty read
            # proves nothing about the original ledger. A run that finished long ago and had not been mirrored yet
            # would be absent from a "complete" snapshot and would then arrive as if it finished after consent.
            #
            # Authorisation therefore needs positive evidence about *this* run: a credible completion instant. The
            # snapshot keeps its other job, which needs no such trust -- what it did contain is history.
            snapshot_proves_absence = False
            existing = list(next_state.get('relayBaselineIds') or [])
            deferred_before = set(next_state.get('relayDeferredIds') or [])
            # T213: three outcomes, not two. `history` is proven to predate consent and is permanent. `deferred` is
            # *unknown*, not history: the run is terminal but nothing yet proves when, and the Bridge writes its
            # terminal event in a separate transaction that can land after the first mirroring. Recording those as
            # history is how a legitimate notice was lost for good, because `relay_merge.history()` then answered for
            # it forever.
            history_ids = []
            deferred_ids = []
            announce = set()
            for item in relay_candidates:
                if arm_ids_now is not None and item['runId'] in arm_ids_now:
                    history_ids.append(item['runId'])
                    continue
                evidence = relay_merge.completed_ms(item)
                if evidence is not None and not relay_merge.completion_source_ok(item):
                    # A number without a matching provenance: refused by name, kept recoverable.
                    deferred_ids.append(item['runId'])
                    relay_source_untrusted += 1
                    continue
                if evidence is None:
                    # Terminal, but when is unknown. Not sent, not absorbed: deferred with the reason kept.
                    deferred_ids.append(item['runId'])
                    relay_unverified += 1
                    if arm is not None:
                        relay_absence_refused += 1
                    continue
                if not relay_merge.plausible(evidence, now_ms):
                    # Implausible: also unknown rather than false. A clock can be fixed; a baseline cannot be undone.
                    deferred_ids.append(item['runId'])
                    relay_implausible += 1
                    continue
                if evidence <= boundary_ms:
                    # Proven to have finished before consent: permanent, as before.
                    history_ids.append(item['runId'])
                    continue
                item['postArm'] = True if arm is not None else None
                item['postArmEvidence'] = 'relay_completed_at'
                # Where the instant came from, so a reader can tell a Bridge event from anything else.
                item['postArmSource'] = item.get('completedAtSource') or 'unknown'
                announce.add(item['runId'])
            # A run that was deferred and now has proof leaves the deferred set: either it is announced (and becomes
            # ACK/journal territory) or it is proven history.
            settled = set(history_ids) | set(announce)
            deferred_after = [run_id for run_id in dict.fromkeys(deferred_ids + list(deferred_before))
                              if run_id not in settled]
            merged_history = list(dict.fromkeys(existing + history_ids))
            if len(merged_history) > MAX_STATE_IDS:
                # Never keep a truncated baseline: the remainder would be offered on a later sample, which is exactly
                # the false notice this is here to prevent. Named, and it stays refused.
                relay_activation = 'stalled'
                relay_code = 'relay_history_overflow'
            else:
                relay_activation = 'active'
                relay_absorbed = len([run_id for run_id in history_ids if run_id not in existing])
                next_state['relayBaselineIds'] = merged_history
                # Bounded, and bounded is safe here: the decision is made per sample from the candidate's own instant,
                # so dropping the oldest deferral loses only the record, never the chance to announce it later.
                if len(deferred_after) > MAX_DEFERRED_IDS:
                    relay_deferred_dropped = len(deferred_after) - MAX_DEFERRED_IDS
                    deferred_after = deferred_after[-MAX_DEFERRED_IDS:]
                next_state['relayDeferredIds'] = deferred_after
                relay_deferred = len(deferred_after)
                next_state['relayActivatedAt'] = activated_at
                # `allow`: only the runs this sample proved. A deferred candidate is neither history nor announceable,
                # so it must be excluded by an explicit set rather than by being mislabelled as history.
                due = relay_merge.merge(due, relay_candidates, next_state, allow=announce)
                # The consent fact travels with the candidate, or the extension cannot tell a run that finished after
                # the arm from one that was already terminal when the operator consented.
                for item in due:
                    if item.get('source') != relay_merge.RELAY_SOURCE:
                        continue
                    if 'postArm' not in item:
                        # Only the evidence loop above can set it. This branch is a guard: nothing reaches `due`
                        # without having passed that decision.
                        item['postArm'] = None
                # What was actually offered is what a later ACK may name: journalling an unoffered id would let an ACK
                # swallow a run nobody has seen yet, and its real completion would never be announced.
                offered = list(next_state.get('relayOfferedIds') or [])
                for item in due:
                    if item.get('source') == relay_merge.RELAY_SOURCE:
                        key = item['runId'] + '|' + item['status']
                        if key not in offered:
                            offered.append(key)
                next_state['relayOfferedIds'] = offered[-MAX_STATE_IDS:]
        if relay_activation != next_state.get('relayActivation'):
            next_state['relayActivation'] = relay_activation
        save_state(state_dir, next_state)

    return {
        'ok': True,
        'code': None,
        # Returned candidates are *offers*, not deliveries: they stay pending
        # until `acknowledge()` names them. `confirmed: false` says so out loud
        # so no caller can mistake this list for "already handed over safely".
        'candidates': due,
        # Distinct from an unreachable source: candidates may have been read, and none of them was provable as new.
        'relayCode': relay_code or ('relay_completion_unknown'
                                    if (relay_unverified or relay_implausible) else None),
        'relayCandidates': len(relay_candidates),
        # Counted, not listed: "the relay had history at the moment this was enabled" and "the relay had nothing" must
        # not look the same, and the ids themselves are already in the state file.
        'relayAbsorbed': relay_absorbed,
        # `unknown` -- never successfully read; `active` -- history absorbed once, new runs announceable;
        # `stalled` -- too much history to absorb safely, so nothing from this source is announced and the reason is
        # `relayCode`. A caller must not read `stalled` as "nothing finished".
        'relayActivation': relay_activation,
        # Candidates the relay reported without a usable start time and no arm snapshot to compare against. They are
        # absorbed rather than announced, and counted here so the refusal has a reason attached to it.
        'relayUnverified': relay_unverified,
        # Candidates whose completion stamp was not credible (far future, impossibly old). Counted apart from "no stamp
        # at all": a clock problem and a missing field are different facts.
        'relayImplausible': relay_implausible,
        # Whether the arm snapshot on disk was built with this source included. `False` means relay consent is decided
        # per run from completion evidence, never from absence in the snapshot.
        'armRelayCovered': bool(arm is not None and arm.get('relayCovered') is True),
        # How many candidates an arm snapshot's completeness authorised. Always zero: the relay is a service cache fed
        # asynchronously by a sidecar, so absence from it is not evidence about the original ledger. Kept in the report
        # so the refusal is visible rather than implied.
        'relaySnapshotAuthorised': relay_snapshot_authorised,
        # Candidates refused *specifically* because an arm existed and the run had no completion instant: the case
        # where a cache-reading snapshot used to be mistaken for proof.
        'relayAbsenceRefused': relay_absence_refused,
        # Candidates that are terminal but not yet provable: not sent, and deliberately *not* in the history baseline,
        # so a Bridge terminal event that lands later can still authorise them.
        'relayDeferred': relay_deferred,
        'relayDeferredDropped': relay_deferred_dropped,
        # Candidates carrying a numeric instant whose stated source is missing or does not match its status. Counted
        # apart from "no instant at all", because the two say different things about the reporting host.
        'relaySourceUntrusted': relay_source_untrusted,
        # Whether the snapshot on disk claims an upstream-complete read. No writer produces such a proof today, and
        # nothing authorises on it.
        'armRelayProof': bool(arm is not None and arm.get('relayUpstreamComplete') is True),
        # `ms` -- the snapshot recorded its own instant; `second` -- an old snapshot, where the whole recorded second is
        # treated as before consent; `activation` -- no snapshot, so consent begins at first successful read.
        'armPrecision': arm_precision,
        'confirmed': False,
        'requiresAck': True,
        'redelivered': info['redelivered'],
        'baselineEstablished': info['baselineEstablished'],
        'existingTerminalRuns': info['existingTerminalRuns'],
        'droppedFromBaseline': info['droppedFromBaseline'],
        # The arm round this sample belongs to. `None` when no snapshot exists --
        # which the extension must treat as "unproven", not as "everything is new".
        'armEpoch': arm['epoch'] if arm is not None else None,
        'armTakenAt': arm['takenAt'] if arm is not None else None,
        'armCount': len(arm['ids']) if arm is not None else None,
        # T066 freshness: what the source itself last knew, and how old the file is.
        'ledgerMtime': ledger_mtime,
        'newestRunId': newest['requestID'] if newest is not None else None,
        'newestStartedAt': int(newest['createdAt'] // 1000) if newest is not None
        else None,
        # T067: where the channel answer came from, and whether it is a live read.
        # `originSource: null` means the bridge database could not be read and no
        # cache covered it, so every candidate in this answer is `unknown`. The
        # extension must show that instead of treating the chain as healthy.
        'originSource': origin.get('source'),
        'originStale': origin.get('stale') is True,
        'originReadAt': origin.get('readAt'),
        'originBridgeIds': origin.get('count') if origin.get('ok') else None,
        'originError': origin.get('error'),
        # T067R: the second source. `nativeOk: false` with `nativeCode` means DSH's
        # own log could not be read, so channel B is *unavailable* -- which is a
        # different fact from "no channel-B turns exist", and the only reason this
        # is reported separately rather than folded into the candidate list.
        'nativeOk': native.get('ok') is True,
        'nativeCode': native.get('code'),
        'nativeError': native.get('error'),
        'nativeFiles': native.get('files'),
        'nativeSessions': native.get('sessions'),
        'nativeTurns': len(native.get('turns') or []),
        # T068: how many tasks are running right now, and how many of those are the
        # Bridge's own. The full list is served by `running_report` (a separate,
        # read-only op); this sample only reports the counts, because a poll that is
        # about to be discarded must not carry a growing array.
        'nativeRunning': len(native.get('running') or []),
        'nativeRunningStale': native.get('runningStale') or 0,
        'nativeOffered': len([c for c in due if c.get('origin') == 'direct'
                             and c.get('nativeTurn') is not None]),
        # How many announced statuses were corrected by the Bridge's own record.
        # Counted, not just applied: "the ledger said cancelled, the Bridge said
        # failed" is the defect this release closes, and it should be visible.
        'statusOverrides': _override_count(runs, facts),
        'factsError': facts_error,
        'source': 'codex-bridge-ledger+dsh-session-log',
        'provenance': 'unverified',
        'deliverable': False,
    }

MIRROR_SOURCE = 'native_host.terminal-mirror'


def ack_forms_by_run(acked_forms, pending_forms):
    """Which facts the sampler journal holds per run: `{runId: {status, ...}}`.

    T270: `ackedIds` cannot answer "was *this* announcement consumed", because a run that was
    announced `failed`, acknowledged, and later really completed has one bare id and two
    facts. `ackedForms`/`pendingForms` are the journal that can, and any run present there is
    answered from it alone.
    """
    seen = {}
    for form in list(acked_forms or []) + list(pending_forms or []):
        if not isinstance(form, str) or '|' not in form:
            continue
        run_id, status = form.split('|', 1)
        seen.setdefault(run_id, set()).add(status)
    return seen


def ack_label(run_id, status, acked, pending, acked_forms, pending_forms):
    """The host's own label for one *fact* (`acked` / `pending` / `unseen`).

    T270: a confirmation belongs to the announcement it confirmed. A run whose `failed`
    announcement was acknowledged and which has since completed must be reported `unseen` for
    the completion -- otherwise the corrected outcome goes out already marked as consumed and
    the service stores a completion nobody has been told about as `completed` + `acked`.

    A run with no journal entry at all falls back to the bare id sets: that is a state file
    from before the per-fact journal, and its single bare ack is the only record there is.
    Anything else would turn an upgraded install's genuine ACK into `unseen`.
    """
    if status_key(run_id, status) in set(acked_forms or ()):
        return 'acked'
    if status_key(run_id, status) in set(pending_forms or ()):
        return 'pending'
    if run_id in ack_forms_by_run(acked_forms, pending_forms):
        # Journalled per fact, and this fact is not among them: whatever was consumed belongs
        # to a different announcement about this run.
        return 'unseen'
    if run_id in acked:
        return 'acked'
    if run_id in pending:
        return 'pending'
    return 'unseen'


def mirror(state_dir, root=None, bridge_db=None, origin_fixture=None):
    """T203: read-only mirror of the terminal candidates, with the status the host resolved.

    `sample` is the *send* path: it records `pendingIds` and is consumed by `terminal-ack`, so
    calling it from an observer would move bookkeeping the real chain depends on. This function
    writes nothing at all -- no state, no pending list, no ACK -- which is the only way a mirror
    can be attached without changing what gets sent.

    The status here is the one the host announced: `resolve_status` of the ledger's own record and
    the Bridge's account of the same run (`completed`/`failed`/`interrupted`). An entry also carries
    whether the host has ACKed it, and that flag is explicitly *not* delivery: `pageDelivery` is
    always `unknown`, because an ACK means the host stored a candidate, not that a page received it.
    """
    report = {'ok': False, 'code': None, 'error': None, 'readOnly': True,
              'source': MIRROR_SOURCE, 'candidates': [], 'counts': {}, 'pageDelivery': 'unknown'}
    try:
        runs = read_runs(ledger_path(root))
    except SourceError as exc:
        report['code'] = 'source_unavailable'
        report['error'] = str(exc)
        return report
    try:
        state = load_state(state_dir)
    except SourceError as exc:
        # Same rule as `sample`: a damaged sampler state is not "nothing finished".
        report['code'] = 'state_unreadable'
        report['error'] = str(exc)
        return report
    if not isinstance(state, dict):
        # No sampler state at all is normal for a read-only observer: nothing has been offered, so nothing is acked.
        state = {'pendingIds': [], 'ackedIds': []}
    origin = run_origin.classify(state_dir, db_path=bridge_db)
    if origin_fixture is not None:
        # Same test seam as `terminal-list`: a suite must be able to say which runs count as channel A without
        # pretending the real Bridge table was read. Production passes nothing here.
        origin = run_origin.classify_fixture(origin_fixture, [run.get('requestID') for run in runs])
    facts, facts_error = run_origin.read_run_facts(bridge_db)
    # T211: the completion instant, from the Bridge's own terminal events. This is the field the relay's consent rule
    # needs and that this mirror never carried, which is why every real Host->Service->Host candidate was held.
    times, times_error = run_origin.read_terminal_times(bridge_db)
    acked = set(state.get('ackedIds') or [])
    pending = set(state.get('pendingIds') or [])
    acked_forms = list(state.get('ackedForms') or [])
    pending_forms = list(state.get('pendingForms') or [])
    chosen = {}
    for run in runs:
        run_id = run.get('requestID')
        if not run_id:
            continue
        kept = chosen.get(run_id)
        if kept is None or int(run.get('createdAt') or 0) >= int(kept.get('createdAt') or 0):
            chosen[run_id] = run
    for run_id, run in chosen.items():
        fact = (facts or {}).get(run_id)
        status = resolve_status(run.get('status'), fact)
        if not status:
            continue  # not terminal yet; the mirror reports finished runs only
        completed_ms, completed_kind = run_origin.completion_evidence(run_id, status, times)
        report['candidates'].append({
            'runId': run_id,
            'status': status,
            'startedAt': int(run.get('createdAt') or 0) // 1000,
            'origin': run_origin.origin_for(run_id, origin),
            'hostAck': ack_label(run_id, status, acked, pending, acked_forms, pending_forms),
            'statusSource': 'bridge.run_facts.status' if fact else 'bridge_ledger.status',
            # `None` is a statement, not a gap: this run has no terminal event, so when it finished is unknown and
            # nothing downstream may compute it from `startedAt`.
            'completedAt': completed_ms,
            # T267: the provenance is the event the instant came from, not a fixed one per status. A run that was
            # interrupted and later completed carries both kinds, and only the agreeing one may name the instant.
            'completedAtSource': ('bridge.task_events.%s' % completed_kind
                                  if completed_ms is not None and completed_kind else 'unknown'),
            'pageDelivery': 'unknown',
        })
    report['ok'] = True
    report['counts'] = {
        'runs': len(runs),
        'candidates': len(report['candidates']),
        'completed': sum(1 for c in report['candidates'] if c['status'] == 'completed'),
        'failed': sum(1 for c in report['candidates'] if c['status'] == 'failed'),
        'interrupted': sum(1 for c in report['candidates'] if c['status'] == 'interrupted'),
        'acked': sum(1 for c in report['candidates'] if c['hostAck'] == 'acked'),
    }
    report['factsError'] = facts_error
    # "no terminal event" and "could not read the events table" are different facts and must stay distinguishable.
    report['completionError'] = times_error
    report['counts']['completedAtKnown'] = sum(
        1 for c in report['candidates'] if c.get('completedAt') is not None)
    report['counts']['completedAtUnknown'] = sum(
        1 for c in report['candidates'] if c.get('completedAt') is None)
    return report
