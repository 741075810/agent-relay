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
    return doc


def save_arm(state_dir, doc):
    _atomic_write(_arm_path(state_dir), doc)


def arm_snapshot(state_dir, root=None, epoch=None):
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
    if len(ids) > MAX_SNAPSHOT_IDS:
        return {'ok': False, 'code': 'snapshot_truncated', 'epoch': None,
                'count': len(ids), 'limit': MAX_SNAPSHOT_IDS,
                'error': ('%d terminal runs exceed the %d id snapshot bound; '
                          'refusing to arm on a partial snapshot'
                          % (len(ids), MAX_SNAPSHOT_IDS))}
    doc = {
        'version': ARM_VERSION,
        'epoch': epoch,
        'takenAt': int(time.time()),
        'ids': sorted(set(ids)),
        'truncated': False,
    }
    try:
        save_arm(state_dir, doc)
    except OSError as exc:
        return {'ok': False, 'code': 'snapshot_not_persisted', 'epoch': None,
                'error': str(exc)}
    return {'ok': True, 'code': None, 'epoch': epoch,
            'takenAt': doc['takenAt'], 'count': len(doc['ids']),
            'truncated': False, 'source': 'codex-bridge-ledger'}


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
                'ackedIds': [],
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
            'ackedIds': [],
            'baselineDropped': 0,
            'baselineCount': len(history),
        }, {'baselineEstablished': True, 'existingTerminalRuns': len(terminal),
            'droppedFromBaseline': 0, 'redelivered': 0}

    baseline_set = set(state['baselineIds'])
    acked = set(state['ackedIds'])
    pending = list(state.get('pendingIds') or [])

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
             and item['runId'] not in acked
             and item['runId'] not in set(pending)]
    fresh.sort(key=lambda item: item['startedAt'])
    room = max(0, MAX_CANDIDATES - len(due))
    fresh = fresh[:room]

    handed_out = due + fresh
    pending_out = list(dict.fromkeys(
        [item['runId'] for item in handed_out] + pending))[-MAX_STATE_IDS:]
    return handed_out, {
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
        'ackedIds': list(state['ackedIds'])[-MAX_STATE_IDS:],
        'baselineDropped': dropped,
        'baselineCount': state.get('baselineCount'),
    }, {'baselineEstablished': False, 'existingTerminalRuns': len(terminal),
         'droppedFromBaseline': dropped, 'redelivered': redelivered}


def acknowledge(state_dir, run_ids):
    """Mark candidates consumed. Called only after Chrome reports it persisted.

    Idempotent: acknowledging twice, or acknowledging something never handed out,
    changes nothing. A run id is the whole identity here -- the trigger keys on
    `runId|status`, and a run has exactly one terminal status.
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
    moved = 0
    for run_id in wanted:
        if run_id in known:
            continue
        if run_id not in pending:
            # Never handed out: refusing to consume what was not delivered.
            continue
        known.add(run_id)
        acked.append(run_id)
        moved += 1
    next_state = {
        'version': STATE_VERSION,
        'baselineIds': state['baselineIds'],
        'pendingIds': [r for r in pending if r not in known],
        'ackedIds': acked[-MAX_STATE_IDS:],
        'baselineDropped': state.get('baselineDropped', 0),
        'baselineCount': state.get('baselineCount'),
    }
    save_state(state_dir, next_state)
    return {'acked': moved, 'pending': len(next_state['pendingIds'])}


def sample(state_dir, root=None, bridge_db=None, origin_fixture=None,
           native_root=None, now=None):
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
    return {
        'ok': True,
        'code': None,
        # Returned candidates are *offers*, not deliveries: they stay pending
        # until `acknowledge()` names them. `confirmed: false` says so out loud
        # so no caller can mistake this list for "already handed over safely".
        'candidates': due,
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
