"""T044 protocol: framing and validation for the Chrome native-messaging host.

Chrome's native messaging transport is deliberately dumb: each message is a
4-byte length prefix (unsigned, native byte order) followed by UTF-8 JSON. There
is no heartbeat, no session, no ordering guarantee beyond the pipe, and no way
for the host to signal the extension. Everything that makes this usable --
versioning, request correlation, cursor-based delivery, idempotency -- has to be
built on top of that, here.

Two limits from Chrome's documentation are enforced rather than trusted:

    host -> Chrome : at most 1 MB per message
    Chrome -> host : at most 4 GB per message (effectively unbounded)

The 1 MB limit matters. An event carrying a long message would otherwise be
written, silently dropped by Chrome, and look like a bug in the notifier.

This module is pure: no I/O, no globals, no clock. That is what makes the
30-odd protocol assertions in the test file meaningful instead of ornamental.

Run: python -B -c "import protocol; print(protocol.PROTOCOL_VERSION)"
"""
import json
import struct

# Bumped only for a breaking change. The extension sends this in `hello` and the
# host refuses a mismatch instead of guessing, because a half-understood protocol
# that silently drops a field is how a notification gets lost without a trace.
PROTOCOL_VERSION = 1

HOST_VERSION = '0.2.2-t069-terminal-ms'

# Chrome rejects host->browser messages larger than this without telling anyone.
MAX_TO_HOST_BYTES = 1 * 1024 * 1024

# Every operation the host will answer. Anything else is refused by name, so a
# future extension version cannot accidentally reach unimplemented behaviour.
OPS = ('hello', 'poll', 'ack', 'status', 'simulate', 'terminal-list',
       'terminal-ack', 'terminal-arm-snapshot', 'terminal-running')

# The prototype's hard gate. `deliver` is what a hypothetical real-send path
# would need; it is false and there is no code path that sets it true. The
# extension reads this and refuses to pretend otherwise.
CAPABILITIES = {
    'deliver': False,      # never types into a page
    'detect': True,        # read-only inspection only
    'simulate': True,      # synthetic events for testing
}

# Error codes are strings, not numbers, so a new one cannot collide with a
# future HTTP-style assignment.
E_BAD_FRAME = 'bad_frame'
E_BAD_JSON = 'bad_json'
E_BAD_REQUEST = 'bad_request'
E_UNKNOWN_OP = 'unknown_op'
E_VERSION_MISMATCH = 'version_mismatch'
E_NOT_ALLOWED = 'not_allowed'
E_TOO_LARGE = 'too_large'
E_INTERNAL = 'internal'


class ProtocolError(Exception):
    """A refusal the host turns into an error response, then keeps serving."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# -- framing -----------------------------------------------------------
def encode(message):
    """One JSON message as Chrome expects it on stdout.

    `ensure_ascii=True` keeps the byte count predictable for the 1 MB check: a
    message of N non-ASCII characters would otherwise be 3N bytes and pass a
    character-based limit while being rejected by Chrome.
    """
    body = json.dumps(message, ensure_ascii=True, separators=(',', ':'))
    raw = body.encode('utf-8')
    if len(raw) > MAX_TO_HOST_BYTES:
        raise ProtocolError(
            E_TOO_LARGE,
            'encoded message is %d bytes; Chrome drops anything over %d'
            % (len(raw), MAX_TO_HOST_BYTES))
    return struct.pack('=I', len(raw)) + raw


def decode_frame(prefix):
    """Length from a 4-byte prefix. Rejects absurd sizes early."""
    if len(prefix) != 4:
        raise ProtocolError(E_BAD_FRAME,
                            'length prefix must be 4 bytes, got %d' % len(prefix))
    (size,) = struct.unpack('=I', prefix)
    if size == 0:
        raise ProtocolError(E_BAD_FRAME, 'length prefix is zero')
    if size > MAX_TO_HOST_BYTES:
        # The host never reads a message this big; refusing keeps a corrupt
        # pipe from turning into a 4 GB allocation.
        raise ProtocolError(
            E_TOO_LARGE,
            'message claims %d bytes, over the %d the host will read'
            % (size, MAX_TO_HOST_BYTES))
    return size


def read_message(stream):
    """Read exactly one framed message. Returns None on a clean EOF.

    A truncated frame is an error rather than a None: the difference between
    "Chrome closed the port" and "the pipe broke mid-message" is the difference
    between an idle extension and a corrupt one.
    """
    prefix = stream.read(4)
    if prefix == b'':
        return None
    if len(prefix) < 4:
        raise ProtocolError(E_BAD_FRAME,
                            'stream ended inside a length prefix (%d of 4 bytes)'
                            % len(prefix))
    size = decode_frame(prefix)
    body = stream.read(size)
    if len(body) < size:
        raise ProtocolError(
            E_BAD_FRAME,
            'stream ended inside the body (%d of %d bytes)' % (len(body), size))
    try:
        return json.loads(body.decode('utf-8'))
    except UnicodeDecodeError as exc:
        raise ProtocolError(E_BAD_JSON, 'body is not UTF-8: %s' % exc)
    except ValueError as exc:
        raise ProtocolError(E_BAD_JSON, 'body is not JSON: %s' % exc)


# -- request validation -------------------------------------------------
def validate_request(doc):
    """Check one request and return `(op, args)`.

    Deliberately strict about the two fields that make correlation possible.
    `id` is echoed back, so a response cannot be matched to a request without
    it; `v` is the only thing standing between a stale extension and a host
    that reads its fields as something else.
    """
    if not isinstance(doc, dict):
        raise ProtocolError(E_BAD_REQUEST,
                            'request must be a JSON object, got %s'
                            % type(doc).__name__)

    version = doc.get('v')
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            E_VERSION_MISMATCH,
            'protocol version %r is not %r; the extension and the host must be '
            'installed together' % (version, PROTOCOL_VERSION))

    ident = doc.get('id')
    if not isinstance(ident, str) or not ident:
        raise ProtocolError(E_BAD_REQUEST,
                            'request needs a non-empty string "id" to correlate '
                            'the response with')

    op = doc.get('op')
    if not isinstance(op, str) or not op:
        raise ProtocolError(E_BAD_REQUEST, 'request needs a string "op"')
    if op not in OPS:
        raise ProtocolError(
            E_UNKNOWN_OP,
            'unknown op %r; this host implements %s' % (op, ', '.join(OPS)))

    args = doc.get('args') or {}
    if not isinstance(args, dict):
        raise ProtocolError(E_BAD_REQUEST,
                            '"args" must be an object when present')
    return op, args


def ok_response(ident, result):
    return {'v': PROTOCOL_VERSION, 'id': ident, 'ok': True, 'result': result}


def error_response(ident, code, message):
    return {'v': PROTOCOL_VERSION, 'id': ident, 'ok': False,
            'error': {'code': code, 'message': message}}


# -- delivered events ---------------------------------------------------
def validate_event(event):
    """Structural check on one event leaving the host.

    The host only ever ships events it built itself, so this is a last-line
    assertion rather than input validation. It exists because the extension
    trusts `eventId` for dedup: an event without one would be re-delivered
    forever, and one with a duplicate would be silently swallowed.
    """
    if not isinstance(event, dict):
        raise ProtocolError(E_BAD_REQUEST, 'event must be an object')
    for field in ('eventId', 'name', 'runId', 'message'):
        value = event.get(field)
        if not isinstance(value, str) or not value:
            raise ProtocolError(E_BAD_REQUEST,
                                'event needs a non-empty string %r' % field)
    if event.get('deliverable') is not False:
        # Every event the prototype emits is explicitly not deliverable. An
        # event without this field would be ambiguous, and ambiguity in the one
        # field that guards a real send is not acceptable.
        raise ProtocolError(
            E_NOT_ALLOWED,
            'event %r is not marked deliverable:false; this prototype cannot '
            'carry delivery instructions' % event.get('eventId'))
    return event


def make_event(event_id, name, run_id, status, created_at, message,
               replay=False):
    """Build one event in the shape the extension expects."""
    return validate_event({
        'eventId': event_id,
        'name': name,
        'runId': run_id,
        'status': status,
        'createdAt': created_at,
        'message': message,
        'replay': bool(replay),
        'deliverable': False,
    })
