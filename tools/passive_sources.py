"""Passive metadata sources. No host/protocol/network/browser/queue calls or raw copies.

The optional extension adapter reuses the previously audited parser's pure block,
WAL and JSON functions, never its read_store/read_db/copy wrappers. Live reads are
non-atomic and MANIFEST/checksums are not attested: that limitation is data.
"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sqlite3
import struct
import time

MAX_TASKS = 5000
MAX_EVENTS = 512
MAX_JSON = 4 * 1024 * 1024
MAX_STORE = 16 * 1024 * 1024
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
TASK = re.compile(r'^tsk-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
STATES = {'running', 'queued', 'received', 'waiting_approval', 'completed', 'failed',
          'interrupted', 'sent', 'blocked', 'ambiguous', 'stopped', 'pending'}
REASONS = {'binding_changed', 'binding_invalidated', 'probe_unavailable',
           'delivery_not_confirmed', 'target_not_visible_and_focused',
           'terminal_time_unknown', 'unverified_candidate', 'rate_limited',
           'min_interval', 'quota_exhausted', 'grant_expired'}


def number(v):
    return v if type(v) in (int, float) and math.isfinite(v) and v >= 0 else None


def uuid(v):
    return v if isinstance(v, str) and UUID.fullmatch(v) else None


def bounded_json(path):
    p = Path(path)
    before = p.stat()
    with p.open('rb') as f:
        raw = f.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise ValueError('input_limit')
    after = p.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('changed_during_read')
    result = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(result, dict):
        raise ValueError('invalid_object')
    return result


def bridge(path, cursor):
    p = Path(path).resolve(strict=True)
    stat = p.stat()
    conn = sqlite3.connect(p.as_uri() + '?mode=ro', uri=True, timeout=0)
    conn.row_factory = sqlite3.Row
    deadline = time.monotonic() + 0.1
    conn.set_progress_handler(lambda: time.monotonic() > deadline, 200)
    try:
        conn.execute('PRAGMA query_only=1')
        conn.execute('PRAGMA busy_timeout=0')
        conn.execute('BEGIN')
        tasks = []
        sql = '''SELECT t.task_id,t.provider_run_id,t.status,t.created_at,b.request_id
                 FROM bridge_service_tasks t LEFT JOIN bridge_service_dsh_task_bindings b
                 ON b.task_id=t.task_id LIMIT ?'''
        raw_tasks = conn.execute(sql, (MAX_TASKS + 1,)).fetchall()
        if len(raw_tasks) > MAX_TASKS:
            raise ValueError('task_limit')
        for row in raw_tasks:
            tid = row['task_id']
            if not isinstance(tid, str) or not TASK.fullmatch(tid):
                raise ValueError('task_identity')
            tasks.append({'task_id': tid, 'run_id': uuid(row['provider_run_id']),
                          'binding_run_id': uuid(row['request_id']),
                          'status': row['status'] if row['status'] in STATES else 'UNKNOWN',
                          'created_at': number(row['created_at'])})
        if len(tasks)!=len({t['task_id'] for t in tasks}):
            raise ValueError('binding_cardinality')
        maximum = conn.execute('SELECT MAX(event_id) FROM bridge_service_task_events').fetchone()[0] or 0
        events = []
        if cursor is not None:
            for row in conn.execute('''SELECT event_id,task_id,kind,created_at
                    FROM bridge_service_task_events WHERE event_id>? ORDER BY event_id LIMIT ?''',
                                    (cursor, MAX_EVENTS + 1)):
                tid = row['task_id']
                if not isinstance(tid, str) or not TASK.fullmatch(tid):
                    raise ValueError('event_identity')
                # Unknown kinds are counted but never echoed (free-form kind could contain data).
                events.append({'event_id': row['event_id'], 'task_id': tid,
                    'kind': row['kind'] if row['kind'] in {'task.completed','task.failed','task.interrupted'} else 'OTHER',
                    'completed_at': number(row['created_at'])})
            if len(events) > MAX_EVENTS:
                raise ValueError('event_limit')
        conn.rollback()
    finally:
        conn.close()
    return {'tasks': tasks, 'events': events, 'max_event_id': maximum,
            'file_identity': [stat.st_dev, stat.st_ino], 'query_only': True}


def native(root, run_ids):
    doc = bounded_json(Path(root) / 'terminal-source.json')
    if doc.get('version')!=1 or any(not isinstance(doc.get(k),list) or len(doc[k])>5000 or
          any(not isinstance(v,str) or len(v)>160 for v in doc[k]) for k in ('ackedIds','pendingIds')):
        raise ValueError('native_schema')
    ack = set(doc['ackedIds'])
    pending = set(doc['pendingIds'])
    result = {}
    for rid in run_ids:
        has_ack = rid in ack or rid+'|completed' in ack
        result[rid] = {'native_acked': 'PRESENT' if has_ack else 'UNKNOWN',
                       'native_pending': 'PRESENT' if rid in pending else 'UNKNOWN',
                       'native_offered': 'UNKNOWN',
                       'prior_offer_protocol_inferred': has_ack,
                       'native_ack_actual_at': None}
    return result


def record(doc):
    doc = doc if isinstance(doc, dict) else {}
    return {'state': doc.get('state') if doc.get('state') in STATES else 'UNKNOWN',
            'status': doc.get('status') if doc.get('status') in STATES else 'UNKNOWN',
            'attempted_at_ms': number(doc.get('attemptedAt')),
            'settled_at_ms': number(doc.get('settledAt')),
            'run_epoch': uuid(doc.get('armEpoch', doc.get('postArmEpoch'))),
            'reason': doc.get('reason') if doc.get('reason') in REASONS else 'UNKNOWN'}


def project_extension(trigger, auto, run_ids):
    trigger = trigger if isinstance(trigger, dict) else {}
    auto = auto if isinstance(auto, dict) else {}
    result = {}
    for rid in run_ids:
        key = rid+'|completed'
        seen = trigger.get('seen', {})
        journal = auto.get('journal', {})
        result[rid] = {'seen': record(seen.get(key) if isinstance(seen, dict) else None),
                       'journal': record(journal.get(key) if isinstance(journal, dict) else None)}
    epochs = {'t058_epoch': 'UNKNOWN', 't058_armed_at_ms': number(auto.get('armedAt')),
              't059_epoch': uuid(trigger.get('armEpoch')),
              't059_armed_at_ms': number(trigger.get('armedAt'))}
    return result, epochs


def extension(config, run_ids):
    if config.get('extension_json'):
        doc = bounded_json(config['extension_json'])
        rows, epochs = project_extension(doc.get('terminalTrigger'), doc.get('autosend'), run_ids)
        return {'rows': rows, 'epochs': epochs, 'integrity': 'FILTERED_OFFLINE_INPUT'}
    path = Path(config['extension_reader']).resolve(strict=True)
    if hashlib.sha256(path.read_bytes()).hexdigest() != config['extension_reader_sha256']:
        raise ValueError('reader_changed')
    block_path = Path(config['block_reader']).resolve(strict=True)
    if hashlib.sha256(block_path.read_bytes()).hexdigest() != config['block_reader_sha256']:
        raise ValueError('block_reader_changed')
    spec = importlib.util.spec_from_file_location('passive_existing_reader', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    L = module.L
    if Path(L.__file__).resolve()!=block_path:
        raise ValueError('block_reader_path')
    class BoundedBytes(bytearray):
        def append(self, value):
            if len(self) >= MAX_JSON:
                raise ValueError('decoded_limit')
            return super().append(value)
        def __iadd__(self, value):
            if len(self) + len(value) > MAX_JSON:
                raise ValueError('decoded_limit')
            return super().__iadd__(value)
    # Reuse the decoder, bounding its allocation rather than designing another codec.
    L.__dict__['bytearray'] = BoundedBytes
    root = Path(L.ROOT)
    names = sorted(p for p in root.iterdir() if p.suffix in ('.ldb','.sst','.log'))
    if len(names) > 16 or sum(p.stat().st_size for p in names) > MAX_STORE:
        raise ValueError('store_limit')
    store = {}
    def merge(key, seq, value):
        if key not in (b'terminalTrigger', b'autosend'):
            return
        if value is not None and len(value) > MAX_JSON:
            raise ValueError('value_limit')
        old = store.get(key)
        if old is None or seq > old[0]:
            store[key] = (seq, value)
        elif seq == old[0] and value != old[1]:
            raise ValueError('sequence_conflict')
    for p in names:
        before = p.stat()
        with p.open('rb') as f:
            blob = f.read(MAX_STORE + 1)
        after = p.stat()
        if len(blob)>MAX_STORE or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):
            raise ValueError('unstable_store')
        if not blob:
            continue
        if p.suffix in ('.ldb','.sst'):
            if len(blob)<48 or struct.unpack('<Q',blob[-8:])[0]!=L.MAGIC:
                raise ValueError('footer')
            footer=blob[-48:]; _, pos=L.read_varint(footer,0); _, pos=L.read_varint(footer,pos)
            off,pos=L.read_varint(footer,pos); size,pos=L.read_varint(footer,pos)
            for _, handle in L.block_entries(L.read_block(blob,off,size)):
                off,pos=L.read_varint(handle,0); size,pos=L.read_varint(handle,pos)
                if size>MAX_JSON:
                    raise ValueError('block_limit')
                for key,value in L.block_entries(L.read_block(blob,off,size)):
                    if len(key)<8:
                        raise ValueError('internal_key')
                    trailer=struct.unpack('<Q',key[-8:])[0]; kind=trailer & 255
                    if kind not in (0,1):
                        raise ValueError('tombstone')
                    merge(key[:-8],trailer>>8,value if kind else None)
        else:
            # Reuse pure WAL parser; explicitly reject unstable physical tails first.
            pos=0; pending=False
            while pos+7<=len(blob):
                if pos % module.BLOCK+7>module.BLOCK:
                    pos=(pos//module.BLOCK+1)*module.BLOCK; continue
                _,length,kind=struct.unpack('<IHB',blob[pos:pos+7])
                if kind==0 or length==0:
                    pos=(pos//module.BLOCK+1)*module.BLOCK; continue
                if kind not in (1,2,3,4) or pos+7+length>len(blob):
                    raise ValueError('wal_tail')
                if kind==2: pending=True
                if kind in (1,4): pending=False
                pos+=7+length
            if pending or (pos<len(blob) and any(blob[pos:])):
                raise ValueError('wal_tail')
            for seq,key,value in module.wal_batches(blob):
                merge(key,seq,value)
    docs={}
    for name in ('terminalTrigger','autosend'):
        entry=store.get(name.encode())
        docs[name]=module.doc({name:entry},name) if entry else None
    rows,epochs=project_extension(docs['terminalTrigger'],docs['autosend'],run_ids)
    for row in rows.values():
        row['latest_state_evidence']='UNKNOWN'
    epochs['latest_epoch_evidence']='UNKNOWN'
    return {'rows':rows,'epochs':epochs,'key_sequences':{k.decode():v[0] for k,v in store.items()},
            'integrity':'NONATOMIC_MANIFEST_CHECKSUM_UNVERIFIED','raw_bytes_written':0}


def snapshot(config, cursor, run_ids):
    result={'errors':[],'read_brackets':{}}
    for name, func in (('bridge',lambda:bridge(config['bridge_db'],cursor)),
                       ('native',lambda:native(config['native_state'],run_ids)),
                       ('extension',lambda:extension(config,run_ids))):
        result['read_brackets'][name]={'started_seconds':time.time()}
        try:
            result[name]=func()
            if name == 'bridge':
                tids={e['task_id'] for e in result[name]['events'] if e['kind']=='task.completed'}
                new={t['run_id'] for t in result[name]['tasks'] if t['task_id'] in tids and
                     t['run_id'] and t['run_id']==t['binding_run_id']}
                run_ids=sorted(set(run_ids)|new)
        except Exception: result['errors'].append(name.upper()+'_UNAVAILABLE')
        finally: result['read_brackets'][name]['finished_seconds']=time.time()
    return result
