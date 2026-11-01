"""T168: put the scanner's own candidates into the queue that already exists.

The chain used to work, so the question is not "does the design lack a queue" -- it has one:
`state/...` holds `pendingIds` and `ackedIds` (`terminal_source.STATE_VERSION`), and `acknowledge()`
removes an id only after Chrome reports it persisted. What was missing is a step that takes what
`running_report()` / `candidates_from()` actually produced and puts it there, with a stable identity and
a record of every candidate that was *not* queued and why.

Everything here reads and writes that same state document through `terminal_source.load_state` /
`save_state`. No new store, no daemon, no second source of truth.

States are deliberately the same six names the extension ledger uses (T167), so one event has one
vocabulary on both sides of the language boundary:

    queued -> attempted -> written_not_clicked / clicked_unknown / submitted -> acked

`submitted` is not delivered. Only `acked` is, and `acknowledge()` is the only thing that produces it.
"""

import time

import terminal_source

NOTICE_STATES = ('queued', 'attempted', 'written_not_clicked', 'clicked_unknown',
                 'submitted', 'acked')

#: States a retry must never leave: the notice may already be in the page.
NO_RETRY_STATES = ('written_not_clicked', 'clicked_unknown')


class QueueError(Exception):
    """The queue could not be read or written."""


def _blank_state():
    return {'version': terminal_source.STATE_VERSION, 'baselineIds': [], 'ackedIds': [],
            'pendingIds': [], 'noticeStates': {}, 'noticeDrops': []}


def load(state_dir):
    """The existing state doc, or a blank one. Same reader as the scanner: one format, one owner."""
    doc = terminal_source.load_state(state_dir)
    if doc is None:
        return _blank_state()
    doc.setdefault('noticeStates', {})
    doc.setdefault('noticeDrops', [])
    return doc


def save(state_dir, doc):
    terminal_source.save_state(state_dir, doc)


def queue_key(candidate):
    """One ending, one key -- the same shape the extension uses (T167 `terminalEventId`).

    Built from identifiers only. A candidate that cannot name its session, its task and its turn has no
    key, and is reported as a drop rather than queued under a made-up one.
    """
    if not isinstance(candidate, dict):
        return None, 'candidate_not_a_dict'
    source = candidate.get('origin') or candidate.get('source') or 'unknown'
    session = candidate.get('sessionId') or candidate.get('session_id')
    task = candidate.get('runId') or candidate.get('run_id') or candidate.get('taskId')
    if not session:
        return None, 'session_missing'
    if not task:
        return None, 'task_missing'
    turn = candidate.get('turn')
    kind = candidate.get('status') or candidate.get('kind') or 'completed'
    return '%s:%s:%s:%s:%s' % (source, session, task, '-' if turn is None else turn, kind), None


def enqueue(state_dir, candidates, now=None):
    """Merge candidates into `pendingIds` without ever duplicating one.

    Returns a report, not a boolean, because "how many were dropped and why" is the evidence a failed
    notification needs. Idempotent: running it twice on the same candidates changes nothing.
    """
    doc = load(state_dir)
    pending = list(doc.get('pendingIds') or [])
    acked = set(doc.get('ackedIds') or [])
    states = dict(doc.get('noticeStates') or {})
    drops = list(doc.get('noticeDrops') or [])
    added, duplicates, already_acked = [], [], []
    clock = now if isinstance(now, int) else int(time.time() * 1000)

    for candidate in candidates or []:
        key, why = queue_key(candidate)
        if key is None:
            drops.append({'reason': why, 'at': clock,
                          'raw': sorted(k for k in candidate if isinstance(k, str))
                          if isinstance(candidate, dict) else None})
            continue
        if key in acked:
            already_acked.append(key)
            continue
        if key in pending:
            duplicates.append(key)
            continue
        pending.append(key)
        states[key] = {'state': 'queued', 'queuedAt': clock, 'attempts': 0, 'lastReason': None}
        added.append(key)

    if added or drops != list(doc.get('noticeDrops') or []):
        doc['pendingIds'] = pending
        doc['noticeStates'] = states
        doc['noticeDrops'] = drops[-200:]
        save(state_dir, doc)
    return {'added': added, 'duplicates': duplicates, 'alreadyAcked': already_acked,
            'drops': [d['reason'] for d in drops], 'pending': len(pending)}


def mark(state_dir, key, state, reason=None, now=None):
    """Move one queued notice. `acked` is refused here: only `acknowledge()` may claim delivery."""
    if state not in NOTICE_STATES:
        raise QueueError('unknown notice state %r' % (state,))
    if state == 'acked':
        raise QueueError('acked is produced by terminal_source.acknowledge, not by mark()')
    doc = load(state_dir)
    entry = (doc.get('noticeStates') or {}).get(key)
    if not isinstance(entry, dict):
        raise QueueError('%s is not queued' % key)
    if entry.get('state') in NO_RETRY_STATES:
        raise QueueError('%s is %s: retrying could duplicate the notice'
                         % (key, entry['state']))
    entry['state'] = state
    entry['lastReason'] = reason
    entry['updatedAt'] = now if isinstance(now, int) else int(time.time() * 1000)
    if state == 'attempted':
        entry['attempts'] = int(entry.get('attempts') or 0) + 1
    doc['noticeStates'][key] = entry
    save(state_dir, doc)
    return entry


def pending(state_dir):
    """Everything not yet acknowledged, with its state. Pending is visible work, never a silent drop."""
    doc = load(state_dir)
    states = doc.get('noticeStates') or {}
    out = []
    for key in doc.get('pendingIds') or []:
        entry = states.get(key) or {}
        out.append({'key': key, 'state': entry.get('state', 'queued'),
                    'attempts': entry.get('attempts', 0),
                    'lastReason': entry.get('lastReason')})
    return out


def diagnose(state_dir):
    """One dict a reviewer can read: what is pending, in which state, and what was dropped why."""
    doc = load(state_dir)
    rows = pending(state_dir)
    counts = {}
    for row in rows:
        counts[row['state']] = counts.get(row['state'], 0) + 1
    return {'pending': len(rows), 'byState': counts, 'rows': rows,
            'drops': doc.get('noticeDrops') or [], 'acked': len(doc.get('ackedIds') or [])}
