"""T206: the Relay terminal candidates, fused into the *real* host's `terminal-list`.

The extension calls `terminal-list` and always acknowledges what it accepted. So a second source can only be added
inside that same answer, with an ACK path that cannot touch the native queue:

  * relay candidates are marked `source: 'relay'` and carry their own `origin`, so the extension's existing channel
    gate sees `bridge` / `direct` exactly as the relay recorded it -- nothing is upgraded to channel A here;
  * their identities are journalled in `relayAckedIds`, never in `pendingIds` / `ackedIds`. `acknowledge()` therefore
    moves a relay candidate only in that separate list, and the native pending list it was never part of cannot be
    consumed by an ACK meant for Relay;
  * a relay candidate already in that journal is not offered again, so an ACK no longer causes a re-push loop;
  * any failure of the relay source is reported (`relayCode`) and contributes zero candidates: the native answer is
    untouched, and "the relay could not be read" is never rendered as "nothing finished".

Default off: `relay_source=None` leaves every existing path exactly as it was, and the production launcher passes
neither `--relay-url` nor `--relay-token-file`.
"""

import json
import os
import urllib.error
import urllib.request

RELAY_SOURCE = 'relay'
RELAY_JOURNAL_KEY = 'relayAckedIds'
RELAY_ALLOWED = ('completed', 'failed', 'cancelled')


def _read(endpoint, token_file, timeout):
    with open(token_file, encoding='utf-8') as handle:
        token = handle.read().strip()
    request = urllib.request.Request(endpoint.rstrip('/') + '/extension/terminal-candidates',
                                     headers={'authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch(relay_source, timeout=10):
    """Read the relay's candidates. Returns `(candidates, code)`; a failure yields no candidates and its own code."""
    if not relay_source:
        return [], None
    endpoint = relay_source.get('url') or ''
    token_file = relay_source.get('token_file') or ''
    if not endpoint or not token_file or not os.path.isfile(token_file):
        # A configured source that cannot be read is a failure, not an empty answer.
        return [], 'relay_source_unconfigured'
    try:
        payload = _read(endpoint, token_file, timeout)
    except (urllib.error.URLError, OSError, ValueError):
        return [], 'relay_unavailable'
    if not isinstance(payload, dict) or payload.get('ok') is not True:
        return [], 'relay_unavailable'
    candidates = []
    for item in payload.get('candidates') or []:
        if not isinstance(item, dict):
            continue
        run_id = item.get('runId')
        status = item.get('status')
        if not isinstance(run_id, str) or status not in RELAY_ALLOWED:
            # The relay's own service refuses these; repeating the check here means a hand-written HTTP answer cannot
            # smuggle a status the extension would refuse anyway.
            continue
        candidates.append({
            'runId': run_id,
            'status': status,
            'startedAt': item.get('startedAt'),
            'origin': item.get('origin') if item.get('origin') in ('bridge', 'direct', 'unknown') else 'unknown',
            'source': RELAY_SOURCE,
            'relaySource': item.get('source'),
            'pageDelivery': 'unknown',
        })
    return candidates, None


def ack_forms(run_id, status=None):
    """The identities an ACK for this candidate may be written as.

    The extension acknowledges with a bare run id; the trigger journal inside it keys on `runId|status`. Both spellings
    name the same candidate, so both have to suppress it -- checking only one of them is what made an acknowledged relay
    candidate come back on the next sample.
    """
    forms = [run_id]
    if status is not None:
        forms.append(run_id + '|' + status)
    return forms


def was_offered(offered, run_id, status=None):
    """Whether this identity names something the host actually handed out.

    Offers are recorded as `runId|status`; the extension acknowledges with a bare run id. Both name the same run, so
    either spelling counts -- but only for a run that was really offered.
    """
    if not offered:
        return False
    if run_id in offered:
        return True
    if status is not None and run_id + '|' + status in offered:
        return True
    prefix = run_id + '|'
    return any(isinstance(item, str) and item.startswith(prefix) for item in offered)


def is_journalled(journal, run_id, status=None):
    return any(form in journal for form in ack_forms(run_id, status))


def history(state):
    """Every identity that must never be announced: native baseline, absorbed relay history, and what was consumed."""
    return (set(state.get('baselineIds') or [])
            | set(state.get('relayBaselineIds') or [])
            | set(state.get('pendingIds') or [])
            | set(state.get('ackedIds') or [])
            | set(state.get('relayAckedIds') or []))


def absorb(candidates, limit):
    """The ids a first sample records as history instead of announcing.

    Turning the relay on for the first time must not replay whatever had already finished: the native side absorbs its
    existing terminal runs at the first sample, and this is the same rule for the second source. Newest last, bounded so
    a long history cannot grow the state file without limit.
    """
    ids = [item['runId'] for item in candidates if isinstance(item.get('runId'), str)]
    return list(dict.fromkeys(ids))[-limit:]


def merge(due, relay_candidates, state):
    """Append the relay candidates that are new to both the native lists and the relay journal."""
    known_native = history(state)
    journal = set(state.get('relayAckedIds') or [])
    merged = list(due)
    taken = {item.get('runId') for item in merged}
    for candidate in relay_candidates:
        run_id = candidate['runId']
        if run_id in known_native or run_id in taken:
            continue
        # One notice per run: a run acknowledged as `completed` is not announced again as `failed` either.
        if is_journalled(journal, run_id, candidate['status']):
            continue
        taken.add(run_id)
        merged.append(candidate)
    return merged
