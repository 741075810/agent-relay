"""T205: a Relay-backed stand-in for the Native Host's candidate answer.

The extension acquires terminal candidates by asking its Native Host for `terminal-list` and storing the answer under
`terminalCandidates`; the send gate then reads that list. This process speaks the *same* framed stdio protocol
(`protocol.py`) and answers `terminal-list` from the AgentRelay service, so the existing acquisition path can be
exercised against Relay data without installing, upgrading or restarting anything.

Default off: nothing starts it, and the production host is untouched. It is read-only by construction -- `terminal-ack`
is refused with `ack_not_supported`, because an ACK here would mean pretending to consume a candidate the real host
still owns, and a host ACK is not delivery anyway.
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request

# `protocol.py` lives at the repository root, two levels above `tools/service/`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import protocol as P

SOURCE = 'agentrelay.mirror'


def _service(base, token_file, path):
    with open(token_file, encoding='utf-8') as handle:
        token = handle.read().strip()
    request = urllib.request.Request(base.rstrip('/') + path,
                                     headers={'authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))


def terminal_list(base, token_file):
    """The answer the extension expects, filled from the Relay mirror.

    `requiresAck` is false: the Relay side has no pending list to consume, so the extension must not try to ACK
    through this path. `confirmed` stays false and `pageDelivery` unknown -- nothing here wrote a page.
    """
    try:
        payload = _service(base, token_file, '/extension/terminal-candidates')
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # Fail closed and say which way: "the relay is unreachable" is not "nothing finished".
        return {'ok': False, 'code': 'relay_unavailable', 'error': str(exc),
                'candidates': [], 'requiresAck': False, 'confirmed': False,
                'deliverable': False, 'source': SOURCE, 'pageDelivery': 'unknown'}
    candidates = []
    for item in payload.get('candidates') or []:
        candidates.append({
            'runId': item.get('runId'),
            'status': item.get('status'),
            'startedAt': item.get('startedAt'),
            'origin': item.get('origin') or 'unknown',
            'postArm': None,
            'source': item.get('source') or SOURCE,
            'hostAck': item.get('hostAck') or 'unseen',
            'pageDelivery': 'unknown',
        })
    return {'ok': True, 'code': None, 'candidates': candidates, 'requiresAck': False,
            'confirmed': False, 'deliverable': False, 'source': SOURCE, 'pageDelivery': 'unknown',
            'baselineEstablished': bool(candidates),
            'counts': {'candidates': len(candidates)}}


def handle(request, base, token_file):
    op = request.get('op')
    ident = request.get('id')
    if op in ('terminal-list', 'terminal-mirror'):
        return P.ok_response(ident, terminal_list(base, token_file))
    if op == 'terminal-ack':
        return P.error_response(ident, 'ack_not_supported',
                                'this relay path has no pending list; nothing may be acknowledged through it')
    return P.error_response(ident, P.E_UNKNOWN_OP, 'unhandled op %r' % op)


def serve(stdin, stdout, base, token_file):
    while True:
        try:
            message = P.read_message(stdin)
        except P.ProtocolError:
            return
        if message is None:
            return
        reply = handle(message, base, token_file)
        stdout.write(P.encode(reply))
        stdout.flush()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    def value(flag):
        return argv[argv.index(flag) + 1] if flag in argv else None
    base = value('--service-url')
    token_file = value('--service-token-file')
    if not base or not token_file:
        sys.stderr.write('usage: relay_terminal_host.py --service-url <url> --service-token-file <file>\n')
        return 2
    serve(io.BufferedReader(io.FileIO(0, 'rb', closefd=False)),
          io.BufferedWriter(io.FileIO(1, 'wb', closefd=False)), base, token_file)
    return 0


if __name__ == '__main__':
    sys.exit(main())
