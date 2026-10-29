"""T067: which channel dispatched a run -- Bridge (A) or DSH Desktop itself (B).

The two channels need different consent rules, so the host has to answer "who
started this run" from something that cannot be wrong about it. That answer is
not a heuristic on timing, title or session:

    bridge_service_dsh_task_bindings.request_id

is written by the bridge service at dispatch time -- before the run exists -- and
holds exactly the run ids the bridge itself created. A run present in the ledger
with no row there was therefore *not* dispatched by the bridge: a person started
it in DSH Desktop's own window. That is channel B.

Why the bindings table and not `bridge_service_tasks`: the task row is also
created at dispatch, but its `provider_run_id` column is filled in only when the
run completes, so mid-run it is NULL and a live task would be unclassifiable --
exactly the run a person most wants to be told about.

Three properties this module is built around:

  * **read-only, always.** The database is opened `mode=ro` with
    `query_only`; nothing here can write to the bridge's store, and a sample that
    only wanted to classify a run cannot damage the ledger it is reading.
  * **a stale answer may not guess.** The last successful read is cached beside
    the sampler state. When a later read fails, ids in the cache are still
    provably bridge runs, but an id *missing* from a stale cache is not proof of
    anything -- it may simply postdate the cache. That case answers `unknown`,
    and `terminal_source` refuses to hand such a run out. Guessing `direct` would
    silently mute channel A; guessing `bridge` would auto-send channel B.
  * **no cache of content.** Only run ids and a timestamp are stored, in their
    own file with its own version, so a newer host file stays readable by an
    older host -- the same reason `terminal-arm.json` is separate from the
    sampler state.
"""
import json
import os
import sqlite3
import time

try:
    from urllib.parse import quote
except ImportError:                                     # pragma: no cover
    from urllib import quote                            # type: ignore

# The Bridge's own SQLite database. Derived from the environment rather than written out:
# a hard-coded absolute path containing the operator's user name silently means "this
# works only on the machine it was written on", and it embeds that name in anything
# published. An override through `DSH_BRIDGE_DB` keeps it testable without editing source.
def _default_db():
    override = os.environ.get('DSH_BRIDGE_DB')
    if override:
        return override
    base = (os.environ.get('LOCALAPPDATA')
            or os.path.join(os.path.expanduser('~'), 'AppData', 'Local'))
    return os.path.join(base, 'CodexBridgeService', 'service.sqlite')


DEFAULT_DB = _default_db()
CACHE_NAME = 'terminal-origin.json'
CACHE_VERSION = 1

# The bindings table grows by one row per dispatched task -- a few dozen a day on
# this machine. 5000 is two orders of magnitude of headroom, and the bound is not
# silent: an evicted id would look `direct` on a stale cache, so `dropped` is
# reported and the caller can say so.
MAX_CACHE_IDS = 5000

BINDINGS = 'bridge_service_dsh_task_bindings'
TASKS = 'bridge_service_tasks'

# Ordered newest first so the bound above drops the oldest ids, never the ones a
# running task is about to need.
READ_SQL = (
    'select b.request_id as rid, '
    '       coalesce(t.created_at, 0) as at '
    'from %s b left join %s t on t.task_id = b.task_id' % (BINDINGS, TASKS))

BUSY_TIMEOUT_MS = 250
ATTEMPTS = 3
RETRY_SLEEP = 0.05

# What the Bridge says each task actually did. This is the authority for the status
# a notice announces, because the ledger's own status describes the desktop event
# stream: 9a9f4d17 is `cancelled` there while the Bridge records `failed` with
# `failure_code=desktop_event_invalid`. `running` is included so the caller can tell
# "not terminal yet" from "no opinion" instead of treating a live task as finished.
FACTS_SQL = (
    'select provider_run_id as rid, status as status, '
    '       failure_code as failure_code '
    'from %s where provider_run_id is not null and provider_run_id <> \'\''
    % 'bridge_service_tasks')


class OriginUnavailable(Exception):
    """The dispatch origin could not be determined and no cache covers it."""


def cache_path(state_dir):
    return os.path.join(state_dir, CACHE_NAME)


def _uri(path):
    """A `file:` URI for a read-only open.

    `quote` matters on Windows: the path is `C:\\Users\\...` and an unescaped
    backslash-separated URI makes sqlite open a *different* (empty) database
    rather than fail, which would read as "no bindings" -- i.e. every bridge run
    would be classified as direct. That is the one wrong answer this module must
    never produce.
    """
    return 'file:%s?mode=ro' % quote(os.path.abspath(path).replace('\\', '/'))


def read_bindings(db_path=None, attempts=ATTEMPTS):
    """Every run id the bridge dispatched, newest first.

    Returns `(ids, dropped, error)`. `ids is None` means the question could not be
    asked at all; the caller must then fall back to the cache or refuse.
    """
    path = db_path if db_path is not None else DEFAULT_DB
    if not isinstance(path, str) or not path:
        return None, 0, 'no bridge database path configured'
    if not os.path.isfile(path):
        return None, 0, 'bridge database %s is not a file' % path

    last = None
    for attempt in range(max(1, attempts)):
        conn = None
        try:
            conn = sqlite3.connect(_uri(path), uri=True, timeout=1.0)
            # Belt and braces: the URI already asks for read-only, and this makes a
            # stray write fail loudly instead of touching the bridge's store.
            conn.execute('pragma query_only = 1')
            conn.execute('pragma busy_timeout = %d' % BUSY_TIMEOUT_MS)
            if not _has_table(conn, BINDINGS):
                return None, 0, ('%s has no %s table; refusing to classify every '
                                 'run as direct' % (path, BINDINGS))
            rows = conn.execute(READ_SQL).fetchall()
            break
        except sqlite3.Error as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
            rows = None
            if attempt + 1 < max(1, attempts):
                time.sleep(RETRY_SLEEP)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
    else:
        return None, 0, 'bridge database unreadable after %d attempts (%s)' % (
            attempts, last)

    if rows is None:
        return None, 0, 'bridge database unreadable (%s)' % last

    seen = {}
    for row in rows:
        run_id, at = row[0], row[1]
        if not isinstance(run_id, str) or not run_id:
            continue
        if not isinstance(at, (int, float)):
            at = 0
        # A dispatch has one binding row; if a duplicate ever appeared, the newest
        # timestamp is the one that keeps the id inside the bound.
        if run_id not in seen or at > seen[run_id]:
            seen[run_id] = at
    ordered = sorted(seen.items(), key=lambda item: item[1], reverse=True)
    ids = [run_id for run_id, _at in ordered[:MAX_CACHE_IDS]]
    return ids, len(ordered) - len(ids), None


def _has_table(conn, name):
    row = conn.execute(
        "select count(*) from sqlite_master where type = 'table' and name = ?",
        (name,)).fetchone()
    return bool(row and row[0])


def read_run_facts(db_path=None, attempts=ATTEMPTS):
    """`{runId: {'status', 'failureCode'}}` from the Bridge's own task table.

    Returns `(facts, error)`. An unreadable database yields `({}, reason)`, which
    makes the caller fall back to the ledger's status -- the behaviour that shipped
    before this existed. That fallback is not silently equivalent: the report says
    which source answered, so "we could not check" never looks like "the ledger is
    right".
    """
    path = db_path or DEFAULT_DB
    if not os.path.isfile(path):
        return {}, 'bridge database %s is not a file' % path

    last = None
    rows = None
    for attempt in range(max(1, attempts)):
        conn = None
        try:
            conn = sqlite3.connect(_uri(path), uri=True, timeout=1.0)
            conn.execute('pragma query_only = 1')
            conn.execute('pragma busy_timeout = %d' % BUSY_TIMEOUT_MS)
            if not _has_table(conn, 'bridge_service_tasks'):
                return {}, ('%s has no bridge_service_tasks table; statuses come '
                            'from the ledger alone' % path)
            rows = conn.execute(FACTS_SQL).fetchall()
            break
        except sqlite3.Error as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
            if attempt + 1 < max(1, attempts):
                time.sleep(RETRY_SLEEP)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
    if rows is None:
        return {}, 'bridge database unreadable after %d attempts (%s)' % (
            attempts, last)

    facts = {}
    for run_id, status, failure_code in rows:
        if not isinstance(run_id, str) or not run_id:
            continue
        facts[run_id] = {
            'status': status if isinstance(status, str) else None,
            'failureCode': failure_code if isinstance(failure_code, str) else None,
        }
    return facts, None


def load_cache(state_dir):
    """The last successful read, or None. Strict: a foreign file is refused."""
    path = cache_path(state_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get('version') != CACHE_VERSION:
        return None
    ids = doc.get('ids')
    if not isinstance(ids, list) or any(not isinstance(i, str) or not i
                                        for i in ids):
        return None
    return doc


def save_cache(state_dir, ids, read_at):
    """Remember one successful read. Never raises: a cache that cannot be written
    only costs a fallback later, and must not fail a sample that succeeded."""
    path = cache_path(state_dir)
    tmp = path + '.tmp'
    doc = {'version': CACHE_VERSION, 'readAt': read_at,
           'source': 'bridge-sqlite', 'ids': ids[:MAX_CACHE_IDS]}
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def classify(state_dir, run_ids=None, db_path=None, now=None):
    """Decide the origin question once for a whole sample.

    Returns a dict; `ok: false` carries a named `code` and the caller must offer
    nothing at all. The fields are deliberately small enough to ship to Chrome:

        ok            bool   -- may any origin be claimed for this sample
        code          str    -- named failure, or None
        bridge        set    -- run ids the bridge is known to have dispatched
        stale         bool   -- `bridge` is a cache, so absence is not proof
        source        str    -- 'bridge-sqlite' | 'bridge-cache'
        readAt        int|None
        count, dropped, error
    """
    stamp = int(time.time() if now is None else now)
    ids, dropped, error = read_bindings(db_path)
    if ids is not None:
        save_cache(state_dir, ids, stamp)
        return {'ok': True, 'code': None, 'bridge': set(ids), 'stale': False,
                'source': 'bridge-sqlite', 'readAt': stamp,
                'count': len(ids), 'dropped': dropped, 'error': None}
    cached = load_cache(state_dir)
    if cached is not None:
        return {'ok': True, 'code': None, 'bridge': set(cached['ids']),
                'stale': True, 'source': 'bridge-cache',
                'readAt': cached.get('readAt'), 'count': len(cached['ids']),
                'dropped': 0, 'error': error}
    return {'ok': False, 'code': 'origin_source_unavailable', 'bridge': set(),
            'stale': True, 'source': None, 'readAt': None, 'count': 0,
            'dropped': 0, 'error': error}


def classify_fixture(fixture, run_ids=None, now=None):
    """Test-only: a static manifest standing in for the bridge's own table.

    The end-to-end suites drive the real host against a temporary ledger, which
    means they also have to play the bridge's part and record what "it" dispatched.
    They cannot: their run ids are generated inside the test, long after the
    process starts. So this mode says, at the level of the whole fixture, which
    runs count as bridge-dispatched -- `{"bridge": "*"}` for "this suite is
    exercising channel A", or an explicit id list for a suite that needs both
    channels at once.

    It is reachable only through `--bridge-db-fixture`, which the production launch
    command does not pass and the launcher has no way to add. Nothing is cached
    from a fixture, so a fixture can never become an answer for a real machine.
    """
    stamp = int(time.time() if now is None else now)
    blank = {'ok': False, 'code': 'origin_fixture_invalid', 'bridge': set(),
             'stale': True, 'source': None, 'readAt': None, 'count': 0,
             'dropped': 0, 'error': None}
    if not isinstance(fixture, dict) or fixture.get('version') != CACHE_VERSION:
        return dict(blank, error='fixture is not a version %d document'
                    % CACHE_VERSION)
    spec = fixture.get('bridge')
    if spec == '*':
        ids = [run_id for run_id in (run_ids or []) if isinstance(run_id, str)]
    elif isinstance(spec, list):
        ids = [run_id for run_id in spec if isinstance(run_id, str) and run_id]
    else:
        return dict(blank, error='fixture "bridge" must be "*" or a list of ids')
    return {'ok': True, 'code': None, 'bridge': set(ids), 'stale': False,
            'source': 'fixture', 'readAt': stamp, 'count': len(ids),
            'dropped': 0, 'error': None}


def origin_for(run_id, info):
    """This run's channel, from a `classify()` answer.

    Three outcomes, never two: a run missing from a *stale* cache is `unknown`.
    Collapsing that into `direct` is the failure this function exists to prevent.
    """
    if not isinstance(info, dict) or info.get('ok') is not True:
        return 'unknown'
    if not isinstance(run_id, str) or not run_id:
        return 'unknown'
    if run_id in info['bridge']:
        return 'bridge'
    return 'unknown' if info.get('stale') else 'direct'
