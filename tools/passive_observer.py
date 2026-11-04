"""Finite passive observer. Explicit opt-in, independent output, no delivery operations.

A failed T0 is ONLY_PREPARED, never started. Every sample is atomic and immutable;
there is no service installation, restart/replay, browser action or queue write.
"""
import copy
import tempfile
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

try:
    from tools import passive_sources as sources
except ModuleNotFoundError:
    import passive_sources as sources

MAX_BYTES = 32 * 1024 * 1024
MAX_RUNS = 256
MAX_CYCLE = 2 * 1024 * 1024


def utc(seconds=None):
    return datetime.fromtimestamp(time.time() if seconds is None else seconds, timezone.utc).isoformat()


def encode(doc):
    return (json.dumps(doc, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def atomic(path, doc, immutable=False):
    data=encode(doc)
    if len(data)>MAX_CYCLE:
        raise ValueError('record_limit')
    if immutable and path.exists():
        if path.read_bytes()!=data:
            raise ValueError('append_conflict')
        return
    fd,name=tempfile.mkstemp(prefix='.meta-',dir=path.parent)
    temp=Path(name)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp,path)
    finally:
        temp.unlink(missing_ok=True)


def used(root):
    return sum(p.stat().st_size for p in root.rglob('*') if p.is_file())


def sample(config, cursor, run_ids):
    payload=encode({'config':config,'cursor':cursor,'run_ids':run_ids})
    python=Path(sys.executable)
    if os.name=='nt' and python.name.lower()=='pythonw.exe':
        python=python.with_name('python.exe')
    options={}
    if os.name=='nt':
        options['creationflags']=subprocess.CREATE_NO_WINDOW
        si=subprocess.STARTUPINFO(); si.dwFlags|=subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow=subprocess.SW_HIDE; options['startupinfo']=si
    else:
        options['start_new_session']=True
    proc=subprocess.Popen([str(python),'-B',str(Path(__file__).resolve()),'--worker'],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,**options)
    try:
        raw,_=proc.communicate(payload,timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.communicate()
        return {'errors':['SOURCE_WORKER_TIMEOUT']}
    if proc.returncode or len(raw)>MAX_CYCLE:
        return {'errors':['SOURCE_WORKER_FAILED']}
    try:
        return json.loads(raw)
    except ValueError:
        return {'errors':['SOURCE_WORKER_INVALID']}


def new_state(first, t0):
    b=first['bridge']
    return {'status':'running','t0_utc':utc(t0),'t0_epoch_seconds':t0,
      'cursor':b['max_event_id'],'file_identity':b['file_identity'],
      'baseline':{t['task_id']:t['status'] for t in b['tasks']},
      't0_completed':[t['task_id'] for t in b['tasks'] if t['status']=='completed'],
      'runs':{},'raw_completed_events':0,'historical_or_duplicate_events':0,
      'identity_conflicts':0,'missing_event_transitions':0,'source_error_cycles':int(bool(first.get('errors'))),
      'sampling_gaps':0,'last_sample_utc':utc(t0),'seq':0}


def reduce(state, snap, now, deadline):
    delta={'new_events':[],'notification_changes':[],'errors':list(snap.get('errors',[])),
           'source_read_brackets':snap.get('read_brackets',{})}
    if delta['errors']:
        state['source_error_cycles']+=1
    b=snap.get('bridge')
    if b:
        if b['file_identity']!=state['file_identity'] or b['max_event_id']<state['cursor']:
            raise ValueError('source_reset')
        tasks={t['task_id']:t for t in b['tasks']}
        completed_tids={e['task_id'] for e in b['events'] if e['kind']=='task.completed'}
        for e in b['events']:
            state['cursor']=max(state['cursor'],e['event_id'])
            if e['kind']!='task.completed':
                continue
            state['raw_completed_events']+=1
            stamp=e['completed_at']; t=tasks.get(e['task_id'])
            if stamp is None or t is None or not t['run_id'] or t['run_id']!=t['binding_run_id']:
                state['identity_conflicts']+=1; delta['errors'].append('EVENT_IDENTITY_OR_TIME_UNKNOWN'); continue
            rid=t['run_id']
            if rid in state['runs'] and state['runs'][rid]['task_id']!=t['task_id']:
                state['runs'][rid]['identity_evidence']='CONFLICT'
                state['identity_conflicts']+=1; delta['errors'].append('RUN_TASK_CONFLICT'); continue
            if t['task_id'] in state['t0_completed'] or rid in state['runs']:
                state['historical_or_duplicate_events']+=1; continue
            if stamp<state['t0_epoch_seconds']:
                state['t0_completed'].append(t['task_id']); continue
            if stamp>=deadline:
                continue
            if len(state['runs'])>=MAX_RUNS:
                raise ValueError('run_limit')
            row={'task_id':t['task_id'],'run_id':rid,'source':'bridge.task.completed','identity_evidence':'MATCHED',
                 'event_id':e['event_id'],'completed_at_seconds':stamp,'completed_at_utc':utc(stamp),
                 'session_id':None,'turn':None,'native_turn_mapping':'UNKNOWN_NOT_READ',
                 'outcome':'UNKNOWN','duplicate_notice_evidence':'UNKNOWN',
                 'page_visible':'UNKNOWN','relay_only':'UNKNOWN','model_consumed':'UNKNOWN'}
            state['runs'][rid]=row; delta['new_events'].append(row.copy())
        for t in b['tasks']:
            prior=state['baseline'].get(t['task_id'])
            if prior!='completed' and t['status']=='completed' and t['task_id'] not in completed_tids:
                state['missing_event_transitions']+=1
                delta['errors'].append('OBSERVED_COMPLETED_WITHOUT_EXACT_EVENT')
            state['baseline'][t['task_id']]=t['status']
        if len(state['baseline'])>sources.MAX_TASKS:
            raise ValueError('task_history_limit')
    ext=snap.get('extension',{})
    delta['extension_integrity']=ext.get('integrity','UNKNOWN')
    delta['epochs_current_observed']=ext.get('epochs',{})
    delta['extension_key_sequences']=ext.get('key_sequences',{})
    for rid,row in state['runs'].items():
        evidence={'native':snap.get('native',{}).get(rid,{'native_acked':'UNKNOWN','native_offered':'UNKNOWN'}),
                  'extension':ext.get('rows',{}).get(rid,{})}
        if row.get('evidence')!=evidence:
            row['evidence']=evidence
            row['last_changed_observed_at_utc']=utc(now)
            journal=evidence['extension'].get('journal',{})
            settled=journal.get('settled_at_ms')
            row['ledger_settlement_delay_observed_seconds']=(settled/1000-row['completed_at_seconds']) if settled is not None else None
            row['delay_latest_state_evidence']=evidence['extension'].get('latest_state_evidence','UNKNOWN')
            delta['notification_changes'].append({'run_id':rid,'evidence':evidence,
                'observed_at_utc':utc(now),'ledger_settlement_delay_observed_seconds':row['ledger_settlement_delay_observed_seconds'],
                'delay_latest_state_evidence':row['delay_latest_state_evidence']})
    return delta


def observe(config, root, seconds, interval):
    root.mkdir(parents=True,exist_ok=True)
    # Exclusive ownership; do not reuse a prior observation or reset its deadline.
    fd=os.open(root/'owner.lock',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    if any(p.name!='owner.lock' for p in root.iterdir()):
        raise ValueError('output_already_used')
    reserve=root/'stop-reserve'
    state=None; reason='startup_failed'; candidate_seq=None; origin=time.monotonic()
    paths=(Path(__file__),Path(sources.__file__))
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    try:
        reserve.write_bytes(b'\0'*(MAX_CYCLE+8192))
        if config.get('extension_reader') and (config.get('observer_sha256')!=hashes[paths[0].name] or
                                              config.get('sources_sha256')!=hashes[paths[1].name]):
            reason='prepared_code_changed'; return 2
        started=time.time()
        first=sample(config,None,[])
        if 'bridge' not in first:
            reason='T0_BRIDGE_UNAVAILABLE'; return 2
        t0=time.time(); origin=time.monotonic(); end=t0+seconds
        initial=new_state(first,t0)
        initial.update({'pid':os.getpid(),'expected_end_utc':utc(end),'end_epoch_seconds':end,
                        'interval_seconds':interval,'source_read_initial_started_utc':utc(started)})
        atomic(root/'T0.json',{'state':initial,'snapshot':first,'t0_utc':utc(t0)},True)
        atomic(root/'state.json',initial)
        state=initial; reason='deadline'; last=origin
        while True:
            if (root/'stop.request').exists(): reason='requested'; break
            if any(hashlib.sha256(p.read_bytes()).hexdigest()!=hashes[p.name] for p in paths):
                reason='code_changed'; break
            if abs((time.time()-t0)-(time.monotonic()-origin))>5:
                reason='clock_skew'; break
            wait_end=time.monotonic()+min(interval,max(0,seconds-(time.monotonic()-origin)))
            while time.monotonic()<wait_end:
                if (root/'stop.request').exists(): reason='requested'; break
                time.sleep(max(0,min(1,wait_end-time.monotonic())))
            if reason=='requested': break
            final_sample=time.monotonic()-origin>=seconds
            read_start=time.time(); gap=time.monotonic()-last; last=time.monotonic()
            snap=sample(config,state['cursor'],sorted(state['runs']))
            now=time.time()
            if abs((now-t0)-(time.monotonic()-origin))>5:
                reason='clock_skew'; break
            candidate=copy.deepcopy(state)
            if gap>45: candidate['sampling_gaps']+=1
            delta=reduce(candidate,snap,now,end)
            candidate['seq']+=1; candidate['last_sample_utc']=utc(now)
            delta.update({'seq':candidate['seq'],'observed_started_utc':utc(read_start),
                          'observed_finished_utc':utc(now),'elapsed_gap_seconds':gap,'final_sample':final_sample})
            # Existing files + both simultaneous temp writes; final state space is reserved.
            if used(root)+len(encode(delta))+len(encode(candidate))>MAX_BYTES:
                reason='storage_limit'; break
            bucket=root/('cycles-%03d'%(candidate['seq']//120)); bucket.mkdir(exist_ok=True)
            candidate_seq=candidate['seq']
            atomic(bucket/('%06d.json'%candidate['seq']),delta,True)
            atomic(root/'state.json',candidate)
            state=candidate; candidate_seq=None
            if final_sample: break
    except Exception:
        reason='observer_error'
    finally:
        reserve.unlink(missing_ok=True)
        if state is None:
            atomic(root/'stopped.json',{'status':'ONLY_PREPARED','started':False,'reason':reason,
                   'finalized_at_utc':utc()},True)
        else:
            state.update({'status':'stopped','stop_reason':reason,'finalized_at_utc':utc(),
                          'completed_24h':reason=='deadline' and seconds==86400,
                          'actual_duration_seconds':time.monotonic()-origin,
                          'commit_uncertain':candidate_seq is not None,'uncommitted_cycle_seq':candidate_seq})
            atomic(root/'state.json',state)
            atomic(root/'stopped.json',{'status':'FINALIZED','reason':reason,
                   'finalized_at_utc':state['finalized_at_utc'],'exit_actual_at_utc':'UNKNOWN',
                   'actual_duration_seconds':state['actual_duration_seconds']},True)
    return 0 if reason in ('deadline','requested') else 2


def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--worker',action='store_true'); ap.add_argument('--config')
    ap.add_argument('--out'); ap.add_argument('--enable',action='store_true')
    ap.add_argument('--seconds',type=int,default=86400); ap.add_argument('--interval',type=int,default=30)
    ap.add_argument('--status',action='store_true'); ap.add_argument('--stop',action='store_true')
    args=ap.parse_args(argv)
    if args.worker:
        doc=json.loads(sys.stdin.buffer.read(MAX_CYCLE+1))
        result=sources.snapshot(doc['config'],doc['cursor'],doc['run_ids'])
        sys.stdout.buffer.write(encode(result)); return 0
    if args.status or args.stop:
        root=Path(args.out)
        if args.stop:
            (root/'stop.request').write_bytes(b'stop\n'); return 0
        state=sources.bounded_json(root/'state.json')
        report={k:state.get(k) for k in ('status','t0_utc','expected_end_utc','last_sample_utc','finalized_at_utc',
            'stop_reason','seq','raw_completed_events','historical_or_duplicate_events','identity_conflicts',
            'source_error_cycles','missing_event_transitions','sampling_gaps','commit_uncertain')}
        report['unique_completed_runs']=sum(r.get('identity_evidence')=='MATCHED' for r in state.get('runs',{}).values())
        print(json.dumps(report)); return 0
    if not args.enable:
        return 0
    if not args.out or not args.config or not 1<=args.seconds<=86400 or not 1<=args.interval<=30:
        return 2
    return observe(sources.bounded_json(args.config),Path(args.out),args.seconds,args.interval)


if __name__=='__main__':
    try: code=main()
    except Exception: code=2
    raise SystemExit(code)
