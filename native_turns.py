"""Read terminal *turns* from DSH's own session log (T067R).

Why this file exists
--------------------
The Bridge ledger (`endpoint.json.runs.json`) only ever contains runs the Bridge
dispatched. A task a person starts directly in DSH Desktop is never written there,
so no amount of reading that ledger can discover it -- which is exactly the defect
this module removes. DSH itself, however, records every turn of every session:

    {"type":"turn/start","seq":51682,"time":1793265389975,"data":{"turn":153}}
    {"type":"turn/end","seq":52435,"time":1793267054093,
     "data":{"turn":153,"reason":{"kind":"aborted","reason":{"kind":"user"}}}}
    {"type":"turn/end","seq":51290,"time":1793262166137,
     "data":{"turn":151,"reason":{"kind":"completed"}}}
    {"type":"turn/end","seq":4242,"time":1793262166137,
     "data":{"turn":142,"reason":{"kind":"error","error":{...,"code":"INVALID_REQUEST"}}}}

That record is written by the harness regardless of who started the turn, so it is
the independent observation channel B needs. `turn/end` also distinguishes a real
provider error (`reason.kind == 'error'`) from a person stopping the turn
(`reason.kind == 'aborted'` with `reason.reason.kind == 'user'`) -- a distinction
the ledger does not carry, and whose absence used to surface as a false
"cancelled" notice for a failed run.

What this module does NOT do
----------------------------
* It does not decide whether a turn came through the Bridge. That is a join, done
  by the caller against the ledger's own `sessionID` + `turn` columns.
* It does not decompress whole session logs. Only the tail is read: a live session
  is tens of megabytes and the host serves this on every poll.
* It never raises. An unreadable log is reported as `ok: False` with a code, so the
  caller can keep serving channel A and say plainly that B is unavailable -- the
  same three-valued discipline the origin classifier uses.
"""
import json
import os
import re
import time

# python-zstandard is present in the deployed interpreter, but the host must still
# start on a machine where it is not: an import error here would take down the
# whole native host, i.e. break channel A to add channel B.
try:
    import zstandard as _zstd
except Exception:                                    # pragma: no cover
    _zstd = None

ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'
DEFAULT_ROOT = os.path.join(os.environ.get('USERPROFILE', ''), '.dsh', 'sessions')
LOG_NAME = 'session.v4.jsonl.zstd'
# A live session log grows by megabytes; the host serves this on every poll, so the
# tail stays small. 2 MiB is far more than one turn writes, which is all that is
# needed: `turn/end` for a turn is written *after* that turn's chatter, so the newest
# terminal records are always in the last block.
MAX_TAIL_BYTES = 2 * 1024 * 1024
MAX_FRAME_RETRIES = 4
# A session log untouched for longer than the horizon cannot contain a turn inside
# it, so it is never opened. Without this filter a poll decompressed 33 logs and took
# 84 seconds; with it, one or two files are read.
MTIME_SLACK_MS = 5 * 60 * 1000
# Decoded results are memoised per (path, size, mtime). The host is long-lived, so a
# poll that changes nothing costs one stat per file instead of a decompression.
_TAIL_CACHE = {}
_TAIL_CACHE_MAX = 64
# Only terminal turns this recent are offered as channel-B candidates. Older ones
# are history: the operator already saw those turns end, and listing them would turn
# the popup into a 150-row backlog nobody reads.
HORIZON_MS = 24 * 60 * 60 * 1000
MAX_TURNS = 50
# T068: a turn still in flight, so the operator can decide *before* it ends. Bounded
# on the reporting side as well, because a log that stopped mid-turn (host killed
# without writing `turn/end`) would otherwise be reported as "running" forever.
MAX_RUNNING = 20
# The same day-long horizon the terminal side uses, applied here to the *record's*
# own timestamp rather than to the file's mtime. That distinction is the point: a
# fresh mtime proves only that *something* was appended, and a log whose newest turn
# evidence is older than a day cannot be evidence of a turn running now.
RUNNING_MAX_AGE_MS = HORIZON_MS
# Record types that name a turn and are written *during* it. This is what keeps a
# multi-hour turn observable: `turn/start` is written once and a busy turn pushes it
# out of the tail window, but `step/*`, `tool/*` and `assistant/*` keep arriving.
# Measured on the live log: turn 153 wrote 733 such records across 9 types.
IN_TURN_TYPES = ('step/start', 'step/end', 'tool/call', 'tool/result',
                 'assistant/message', 'assistant/attempt', 'workspace/changes',
                 'deliverables/presented')
SESSION_DIR = re.compile(r'^session-[0-9a-f-]{36}$')
MIN_SESSION_EPOCH = 1600000000000          # ms; ignores obviously bogus timestamps


def _decode_tail(blob):
    """Decode concatenated zstd frames from `blob`, tolerating a cut first frame."""
    if not blob or _zstd is None:
        return ''
    dctx = _zstd.ZstdDecompressor()
    offset = 0
    for _ in range(MAX_FRAME_RETRIES):
        at = blob.find(ZSTD_MAGIC, offset)
        if at < 0:
            return ''
        try:
            try:
                reader = dctx.decompressobj(read_across_frames=True)
            except TypeError:                        # older python-zstandard
                return ''
            return reader.decompress(blob[at:]).decode('utf-8', 'replace')
        except Exception:
            # The first frame in the window is very likely cut; step to the next.
            offset = at + 4
    return ''


def _read_tail(path, limit=MAX_TAIL_BYTES):
    size = os.path.getsize(path)
    with open(path, 'rb') as handle:
        if size > limit:
            handle.seek(size - limit)
        return handle.read(limit)


def status_of(reason):
    """Map DSH's `turn/end` reason to one of the three statuses a notice may carry.

    Three outcomes and no more, because the notice text is a fixed template and a
    fourth value would be silently coerced somewhere downstream:

      completed  the turn reached its own end
      failed     the provider or the harness ended it for a reason that is not a
                 person's decision. `kind: error` carries the message; anything
                 unrecognised is also a failure, never a success.
      cancelled  a person stopped this specific turn (`aborted` + `reason: user`)

    `aborted` without a `user` reason is *not* a cancellation: nothing was cancelled
    by the operator, the run merely stopped happening. Calling that "cancelled" is
    the exact false statement this mapping exists to prevent.
    """
    if not isinstance(reason, dict):
        return None
    kind = reason.get('kind')
    if kind == 'completed':
        return 'completed'
    if kind == 'error':
        return 'failed'
    if kind == 'aborted':
        inner = reason.get('reason')
        if isinstance(inner, dict) and inner.get('kind') == 'user':
            return 'cancelled'
        return 'failed'
    return 'failed' if kind else None


def parse_log(text):
    """Everything one session log says about turns: `{'turns', 'running'}`.

    `turns` are turns with a `turn/end` inside the window -- provably terminal.
    `running` is the single newest turn, when it has records but no `turn/end`.

    Why "newest, and no end" is the right test rather than "no end anywhere":
    the window is the last 2 MiB of an append-only file, so a turn whose `turn/end`
    fell outside it must have ended *before* the window -- which means a later turn
    is inside it too. Therefore "no `turn/end` for the highest turn number present"
    can only mean that turn has not ended yet. A turn that is not the highest cannot
    be running: something later started.

    The one residual race is a window boundary that falls between a turn's last
    in-turn record and its `turn/end`. Then a just-finished turn is reported as
    running for one poll. It cannot produce a false notification: the extension only
    accepts an opt-in whose `armedAt` is strictly before the turn's own `endedAt`,
    so an opt-in made in that window is refused once the end is visible.
    """
    starts = {}
    ends = {}
    activity = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            doc = json.loads(line)
        except ValueError:
            continue
        kind = doc.get('type')
        data = doc.get('data')
        if not isinstance(data, dict):
            continue
        turn = data.get('turn')
        if not isinstance(turn, int) or isinstance(turn, bool):
            continue
        stamp = doc.get('time')
        if not isinstance(stamp, int):
            continue
        if kind == 'turn/start':
            prior = starts.get(turn)
            if prior is None or stamp < prior:
                starts[turn] = stamp
        elif kind == 'turn/end':
            prior = ends.get(turn)
            if prior is None or stamp > prior['time']:
                ends[turn] = {'time': stamp, 'reason': data.get('reason')}
        elif kind in IN_TURN_TYPES:
            entry = activity.get(turn)
            if entry is None:
                activity[turn] = {'first': stamp, 'last': stamp, 'count': 1}
            else:
                entry['first'] = min(entry['first'], stamp)
                entry['last'] = max(entry['last'], stamp)
                entry['count'] += 1

    turns = []
    for turn, end in ends.items():
        turns.append({
            'turn': turn,
            'startedAt': starts.get(turn),
            'endedAt': end['time'],
            'status': status_of(end.get('reason')),
            'reasonKind': (end.get('reason') or {}).get('kind')
            if isinstance(end.get('reason'), dict) else None,
        })
    turns.sort(key=lambda item: item['endedAt'])

    running = []
    seen_turns = set(starts) | set(ends) | set(activity)
    # The newest turn overall, not the newest *unfinished* one. An older turn with no
    # visible `turn/end` is not running -- something later started, so it ended
    # before the window. Taking `max(unfinished)` instead would report that old turn
    # as in flight on every poll, forever.
    if seen_turns:
        newest = max(seen_turns)
        if newest not in ends:
            act = activity.get(newest, {'first': None, 'last': None, 'count': 0})
            running.append({
                'turn': newest,
                # `None` when the start record scrolled out of the window. Reported
                # as unknown rather than back-dated to the first visible record: the
                # popup must not claim a task began earlier than it can prove.
                'startedAt': starts.get(newest),
                'observedSince': act['first'],
                'lastActivityAt': act['last'],
                'activityCount': act['count'],
                'evidence': ('turn_start' if newest in starts else 'activity_only'),
            })
    return {'turns': turns, 'running': running}


def parse_turns(text):
    """Terminal turns only. Kept because the T067 suite asserts on this shape."""
    return parse_log(text)['turns']


def _decode_file(path):
    """Decode a session log's tail, memoised on (path, size, mtime)."""
    try:
        info = os.stat(path)
    except OSError:
        return ''
    key = (path, info.st_size, int(info.st_mtime * 1000))
    if key in _TAIL_CACHE:
        return _TAIL_CACHE[key]
    try:
        text = _decode_tail(_read_tail(path))
    except OSError:
        text = ''
    if len(_TAIL_CACHE) >= _TAIL_CACHE_MAX:
        _TAIL_CACHE.clear()
    _TAIL_CACHE[key] = text
    return text


def _session_dirs(root, since_ms=None):
    found = []
    try:
        names = os.listdir(root)
    except OSError:
        return found
    for workspace in names:
        workspace_path = os.path.join(root, workspace)
        if not os.path.isdir(workspace_path):
            continue
        try:
            inner = os.listdir(workspace_path)
        except OSError:
            continue
        for name in inner:
            if not SESSION_DIR.match(name) and not name.startswith('session-'):
                continue
            path = os.path.join(workspace_path, name, LOG_NAME)
            if not os.path.isfile(path):
                continue
            if since_ms is not None:
                try:
                    if os.path.getmtime(path) * 1000 + MTIME_SLACK_MS < since_ms:
                        continue
                except OSError:
                    continue
            found.append((name, path))
    return found


def sample(root=None, now=None, horizon_ms=HORIZON_MS, limit=MAX_TURNS):
    """Terminal turns from every session log under `root`.

    Returns `{'ok', 'code', 'turns', 'sessions', 'files', 'error', 'source'}`.
    `ok: False` with a code means the native source could not be read; the caller
    must not read that as "there are no channel-B runs".
    """
    stamp = int(time.time() * 1000) if now is None else int(now)
    root = root or DEFAULT_ROOT
    report = {'ok': False, 'code': None, 'turns': [], 'running': [],
              'runningStale': 0, 'sessions': 0, 'files': 0,
              'error': None, 'source': 'dsh-session-log', 'root': root}
    if _zstd is None:
        report.update(code='zstandard_missing',
                      error='python-zstandard is not importable in this interpreter')
        return report
    if not os.path.isdir(root):
        report.update(code='native_root_missing', error='%s is not a directory' % root)
        return report

    files = _session_dirs(root, since_ms=stamp - horizon_ms)
    report['files'] = len(files)
    if not files:
        report.update(code='native_log_missing',
                      error='no %s modified within the horizon under %s'
                            % (LOG_NAME, root))
        return report

    read_errors = []
    turns = []
    running = []
    stale = 0
    sessions = 0
    for name, path in files:
        try:
            text = _decode_file(path)
        except OSError as exc:
            read_errors.append('%s: %s' % (name, exc))
            continue
        if not text:
            read_errors.append('%s: no decodable frames in the tail' % name)
            continue
        sessions += 1
        parsed = parse_log(text)
        for item in parsed['turns']:
            if item['status'] is None or item['endedAt'] < MIN_SESSION_EPOCH:
                continue
            if stamp - item['endedAt'] > horizon_ms:
                continue
            turns.append(dict(item, sessionId=name))
        for item in parsed['running']:
            # Age is measured from the earliest moment this turn is *observed* to
            # exist, never from a start time we may not have. A log that stopped
            # mid-turn (host killed before writing `turn/end`) stops being reported
            # once that anchor is older than RUNNING_MAX_AGE_MS.
            anchor = item['observedSince'] or item['lastActivityAt'] or item['startedAt']
            if anchor is None or anchor < MIN_SESSION_EPOCH:
                continue
            if stamp - anchor > RUNNING_MAX_AGE_MS:
                stale += 1
                continue
            running.append(dict(item, sessionId=name, ageAnchor=anchor))

    report['sessions'] = sessions
    report['runningStale'] = stale
    turns.sort(key=lambda item: item['endedAt'])
    seen = {}
    for item in turns:
        seen[(item['sessionId'], item['turn'])] = item
    ordered = [seen[key] for key in sorted(seen, key=lambda k: seen[k]['endedAt'])]
    if len(ordered) > limit:
        ordered = ordered[-limit:]
    report['turns'] = ordered
    # Newest first: the popup lists these, and the one most likely to need a
    # decision is the one that started last.
    running.sort(key=lambda item: item.get('lastActivityAt') or item['ageAnchor'],
                 reverse=True)
    report['running'] = running[:MAX_RUNNING]
    if not sessions:
        report.update(code='native_unreadable',
                      error='; '.join(read_errors[:3]) or 'no session log could be read')
        return report
    report.update(ok=True, code=None,
                  error=('; '.join(read_errors[:3]) if read_errors else None))
    return report
