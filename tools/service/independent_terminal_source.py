"""A place to plug in a terminal-record source that is genuinely independent of the Bridge.

Why this file exists rather than a patch to `run_origin.py`: today every notice -- native or relay -- is derived from one
table, `bridge_service_task_events` in the Bridge's own SQLite file. The relay mirrors that same table, so it is a second
*transport* of one *source*. Calling it a fallback path would be wrong in a way that matters: if the Bridge stops writing
the terminal event, both paths go quiet together, and the operator is told nothing by two systems that look like two.

What an independent source has to be, and what this module refuses:

  * produced by a process that is not the Bridge, and not by anything reading the Bridge's database;
  * carrying the *same* run identity the extension already dedupes on, so no cross-source join is invented. Joining on
    timing, prompt text or "it looks like the same task" is what AGENTS.md forbids, and it is how a duplicate or a missed
    notice is produced silently;
  * carrying a terminal instant with its own provenance, never reconstructed from a floored second, a start time, an
    mtime or the wall clock;
  * append-only and monotonic, with a cursor, so a restart cannot replay history;
  * readable when the Bridge is not: that is the entire point.

Nothing here is wired into the launcher, the supervisor or the host. `PRODUCTION_SOURCES = ()` is asserted empty by the
tests: an independent source must be named, configured and reviewed before it can reach a candidate list, and it cannot
be switched on by accident. The admit() rules are imported from `relay_merge` rather than reimplemented, because two
copies of a consent rule is how the two copies start disagreeing.

Transport probes done before writing this (read-only, 2026-11-04):

  * the Bridge listens on 127.0.0.1:49183; `GET /`, `/health`, `/api/tasks`, `/tasks` all answer 404, so there is no
    published task API to fall back to even as a second transport;
  * its own log shows the tunnel client polling `api.openai.com/v1/tunnels/<id>/poll` -- the upstream of the ledger, and
    the only candidate that would be a different source rather than a different read of the same rows. Reaching it needs
    the tunnel identity and credentials the Bridge holds internally, so it is not available to this code.

Conclusion recorded in docs/independent-terminal-source.md: there is no provable independent source today, so no adapter
is bound; this module is the interface and the refusals, ready for one.
"""

import json
import os
import sys
import time

# Run as a script (`python -B tools/service/independent_terminal_source.py ...`) the repository root is not on the path,
# and `relay_merge` lives there -- it is shared with the host, and this module deliberately reuses its consent rules
# rather than copying them. Add the root when started as a file; when imported as part of a package this is a no-op.
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import relay_merge

# Nothing is bound. A tuple, not a dict, so adding a source is a code review rather than a config edit.
PRODUCTION_SOURCES = ()

# Provenance that would mean "this is the Bridge again". A source claiming one of these is refused by name.
BRIDGE_PROVENANCE = ('bridge.task_events.task.completed', 'bridge.task_events.task.failed',
                     'bridge.task_events.task.interrupted', 'bridge')

REQUIRED_EVENT_FIELDS = ('run_id', 'status', 'ended_at_ms', 'ended_at_source', 'produced_by')

MAX_EVENTS = 2000


class SourceError(Exception):
    """Raised by a source implementation; the caller turns it into a refusal code, never into 'nothing finished'."""

    def __init__(self, code, detail=''):
        super().__init__('%s: %s' % (code, detail))
        self.code = code
        self.detail = detail


def is_independent(produced_by, ended_at_source):
    """A source is independent only if neither its producer nor its provenance is the Bridge's."""
    producer = (produced_by or '').strip().lower()
    provenance = (ended_at_source or '').strip().lower()
    if not producer or producer.startswith('bridge') or producer.startswith('codex-bridge'):
        return False, 'producer is the bridge (%r)' % produced_by
    if provenance in BRIDGE_PROVENANCE or provenance.startswith('bridge.'):
        return False, 'provenance is the bridge ledger (%r)' % ended_at_source
    return True, ''


def validate(events):
    """Shape check first: a malformed event is a refusal, not a candidate with holes in it."""
    if not isinstance(events, list):
        raise SourceError('independent_source_malformed', 'expected a list of events')
    if len(events) > MAX_EVENTS:
        raise SourceError('independent_source_malformed', 'more than %d events in one fetch' % MAX_EVENTS)
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise SourceError('independent_source_malformed', 'event %d is not an object' % index)
        missing = [name for name in REQUIRED_EVENT_FIELDS if name not in event]
        if missing:
            raise SourceError('independent_source_malformed', 'event %d lacks %s' % (index, ', '.join(missing)))
        if event['status'] not in ('completed', 'failed', 'interrupted'):
            raise SourceError('independent_source_malformed', 'event %d has status %r' % (index, event['status']))
        if not isinstance(event['run_id'], str) or not event['run_id'].strip():
            raise SourceError('independent_source_malformed', 'event %d has no run id' % index)
    return events


def to_candidate(event):
    """The same shape the extension already receives, with `source` naming this path and the origin preserved."""
    return {
        'runId': event['run_id'],
        'status': event['status'],
        'completedAtMs': event['ended_at_ms'],
        'completedAtSource': event['ended_at_source'],
        'origin': event.get('origin') if event.get('origin') in ('bridge', 'direct', 'unknown') else 'unknown',
        'source': 'independent',
        'relaySource': event['produced_by'],
        'pageDelivery': 'unknown',
    }


def fetch(source, cursor, timeout=10):
    """Ask a bound source for events after `cursor`. A failure is a code, never an empty success."""
    if source is None:
        return [], cursor, 'independent_source_unconfigured'
    try:
        result = source.fetch(cursor, timeout=timeout)
    except SourceError as exc:
        return [], cursor, exc.code
    except Exception as exc:                                        # noqa: BLE001 - any source failure is a refusal
        return [], cursor, 'independent_source_unavailable'
    if not isinstance(result, tuple) or len(result) != 2:
        return [], cursor, 'independent_source_malformed'
    events, new_cursor = result
    try:
        events = validate(events)
    except SourceError as exc:
        return [], cursor, exc.code
    if not isinstance(new_cursor, int) or new_cursor < cursor:
        # A cursor that goes backwards means the source rewrote history; replay is the failure this prevents.
        return [], cursor, 'independent_source_replay'
    return events, new_cursor, None


def admit(events, state, arm, now_ms, cursor):
    """Turn independent events into candidates, applying the same consent rules the rest of the system uses.

    Returns `(candidates, next_state, report)` where `report` names what happened to everything that did not become a
    candidate: absorbed as history, deferred for want of a trustworthy instant, refused for not being independent.
    """
    candidates = []
    history_ids = list(state.get('independentBaselineIds') or [])
    deferred_ids = list(state.get('independentDeferredIds') or [])
    offered = list(state.get('independentOfferedIds') or [])
    known = relay_merge.history(state)
    journal = set(state.get('relayAckedIds') or [])
    # One notice per run, whatever status it arrives with: the journal stores the id with and without a status suffix,
    # and either spelling means this run has already been announced once.
    announced = {form.split('|')[0] for form in journal} | set(offered) | set(history_ids)
    report = {'history': 0, 'deferred': 0, 'refused': 0, 'offered': 0, 'duplicate': 0}

    arm_ids = None
    if arm and isinstance(arm.get('runIds'), list):
        arm_ids = set(arm['runIds'])
    boundary_ms = arm.get('armedAtMs') if arm else None

    for event in events:
        run_id = event['run_id']
        independent, why = is_independent(event.get('produced_by'), event.get('ended_at_source'))
        if not independent:
            report['refused'] += 1
            deferred_ids.append(run_id)
            continue
        if arm_ids is not None and run_id in arm_ids:
            history_ids.append(run_id)
            report['history'] += 1
            continue
        evidence = event.get('ended_at_ms')
        if evidence is None:
            # Terminal but undated: unknown, not history, and not announceable.
            deferred_ids.append(run_id)
            report['deferred'] += 1
            continue
        if not relay_merge.plausible(evidence, now_ms):
            deferred_ids.append(run_id)
            report['deferred'] += 1
            continue
        if boundary_ms is not None and evidence <= boundary_ms:
            history_ids.append(run_id)
            report['history'] += 1
            continue
        if run_id in known or run_id in announced:
            report['duplicate'] += 1
            continue
        if any(item['runId'] == run_id for item in candidates):
            report['duplicate'] += 1
            continue
        candidate = to_candidate(event)
        if arm is not None:
            candidate['postArm'] = True
            candidate['postArmEvidence'] = 'independent_terminal_instant'
            candidate['postArmSource'] = event['ended_at_source']
        candidates.append(candidate)
        offered.append(run_id)
        announced.add(run_id)

    next_state = dict(state)
    next_state['independentBaselineIds'] = history_ids[-MAX_EVENTS:]
    next_state['independentDeferredIds'] = deferred_ids[-MAX_EVENTS:]
    next_state['independentOfferedIds'] = offered[-MAX_EVENTS:]
    next_state['independentCursor'] = cursor
    next_state['independentAt'] = time.time()
    report['offered'] = len(candidates)
    return candidates, next_state, report


def load_state(state_dir):
    path = os.path.join(state_dir, 'independent-source.json')
    if not os.path.isfile(path):
        return {'independentCursor': 0}
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def save_state(state_dir, state):
    path = os.path.join(state_dir, 'independent-source.json')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description='Probe a bound independent source. Nothing is bound by default.')
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--now-ms', type=float, default=None)
    args = parser.parse_args(argv)
    if not PRODUCTION_SOURCES:
        print(json.dumps({'code': 'independent_source_unconfigured',
                          'detail': 'no source is bound; see docs/independent-terminal-source.md'}, ensure_ascii=False))
        return 0
    raise SystemExit('a source is bound: this CLI has no reviewed call path for it yet')


if __name__ == '__main__':
    raise SystemExit(main())
