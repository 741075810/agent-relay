"""T245 hermetic passive observation tests. Fixtures never contact production."""
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
import uuid

from tools import passive_sources as S
from tools import passive_observer as O
from tools import passive_launcher as L


class PassiveObservation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.tid='tsk-'+str(uuid.uuid4()); self.rid=str(uuid.uuid4())
        self.db=self.root/'bridge.sqlite'
        with closing(sqlite3.connect(self.db)) as c:
            c.executescript('''CREATE TABLE bridge_service_tasks(task_id TEXT PRIMARY KEY,
                provider_run_id TEXT,status TEXT,created_at REAL,prompt TEXT);
                CREATE TABLE bridge_service_dsh_task_bindings(task_id TEXT,request_id TEXT);
                CREATE TABLE bridge_service_task_events(event_id INTEGER PRIMARY KEY,
                task_id TEXT,kind TEXT,created_at REAL,summary TEXT);''')
            c.execute('INSERT INTO bridge_service_tasks VALUES(?,?,?,?,?)',(self.tid,self.rid,'running',10,'PRIVATE_BODY'))
            c.execute('INSERT INTO bridge_service_dsh_task_bindings VALUES(?,?)',(self.tid,self.rid))
            c.commit()
        self.native=self.root/'native'; self.native.mkdir()
        (self.native/'terminal-source.json').write_text(json.dumps({'version':1,'ackedIds':[self.rid],'pendingIds':[],
                                                               'message':'PRIVATE_BODY'}))
        self.ext=self.root/'ext.json'
        self.ext.write_text(json.dumps({'terminalTrigger':{'seen':{self.rid+'|completed':{'state':'sent',
            'status':'completed','body':'PRIVATE_BODY','settledAt':120000}}},
            'autosend':{'armedAt':123,'conversationId':'PRIVATE_BODY','documentInstanceId':'PRIVATE_BODY',
              'journal':{self.rid+'|completed':{'state':'sent','settledAt':120000,'message':'PRIVATE_BODY'}}}}))
        self.config={'bridge_db':str(self.db),'native_state':str(self.native),'extension_json':str(self.ext)}
    def task(self,status='running',tid=None,rid=None):
        return {'task_id':tid or self.tid,'run_id':rid or self.rid,'binding_run_id':rid or self.rid,
                'status':status,'created_at':10}
    def snap(self,events=(),tasks=None):
        return {'bridge':{'tasks':tasks or [self.task()], 'events':list(events),
                          'file_identity':[1,2],'max_event_id':max([e['event_id'] for e in events] or [0])},
                'native':{},'extension':{},'errors':[]}
    def event(self,i=1,at=110,tid=None):
        return {'event_id':i,'task_id':tid or self.tid,'kind':'task.completed','completed_at':at}
    def state(self,status='running'):
        return O.new_state(self.snap(tasks=[self.task(status)]),100)
    def test_readonly_projection_and_no_bodies(self):
        before=hashlib.sha256(self.db.read_bytes()).hexdigest()
        doc=S.snapshot(self.config,0,[self.rid])
        text=json.dumps(doc)
        self.assertNotIn('PRIVATE_BODY',text)
        self.assertNotIn('conversationId',text)
        self.assertTrue(doc['bridge']['query_only'])
        self.assertEqual(before,hashlib.sha256(self.db.read_bytes()).hexdigest())
    def test_mode_ro_handle_rejects_write_fixture_only(self):
        with closing(sqlite3.connect(self.db.as_uri()+'?mode=ro',uri=True)) as c:
            with self.assertRaises(sqlite3.OperationalError): c.execute('CREATE TABLE invalid(x)')
    def test_native_ack_is_not_offered(self):
        doc=S.native(self.native,[self.rid])[self.rid]
        self.assertEqual(doc['native_acked'],'PRESENT')
        self.assertEqual(doc['native_offered'],'UNKNOWN')
        self.assertIsNone(doc['native_ack_actual_at'])
    def test_native_malformed_never_present(self):
        (self.native/'terminal-source.json').write_text(json.dumps({'version':2,'ackedIds':[self.rid],'pendingIds':[]}))
        with self.assertRaises(ValueError): S.native(self.native,[self.rid])
    def test_t058_no_invented_epoch_or_binding(self):
        doc=S.extension(self.config,[self.rid])
        self.assertEqual(doc['epochs']['t058_epoch'],'UNKNOWN')
        self.assertNotIn('PRIVATE_BODY',json.dumps(doc))
    def test_binding_fanout_refused(self):
        with closing(sqlite3.connect(self.db)) as c:
            c.execute('INSERT INTO bridge_service_dsh_task_bindings VALUES(?,?)',(self.tid,self.rid))
            c.commit()
        with self.assertRaises(ValueError): S.bridge(self.db,0)
    def test_historical_completed_not_new(self):
        state=self.state('completed')
        O.reduce(state,self.snap([self.event()], [self.task('completed')]),115,200)
        self.assertEqual(len(state['runs']),0)
        self.assertEqual(state['historical_or_duplicate_events'],1)
    def test_end_exclusive_and_start_inclusive(self):
        state=self.state(); O.reduce(state,self.snap([self.event(at=200)]),200,200)
        self.assertFalse(state['runs'])
        state=self.state(); O.reduce(state,self.snap([self.event(at=100)]),115,200)
        self.assertEqual(len(state['runs']),1)
    def test_duplicate_events_unique_transition(self):
        state=self.state(); O.reduce(state,self.snap([self.event(),self.event(2,111)]),115,200)
        self.assertEqual(state['raw_completed_events'],2)
        self.assertEqual(len(state['runs']),1)
        self.assertEqual(state['historical_or_duplicate_events'],1)
    def test_delayed_event_after_missing_status_is_counted(self):
        state=self.state(); O.reduce(state,self.snap(tasks=[self.task('completed')]),115,200)
        self.assertEqual(state['missing_event_transitions'],1)
        O.reduce(state,self.snap([self.event()], [self.task('completed')]),120,200)
        self.assertEqual(len(state['runs']),1)
    def test_run_task_conflict_quarantined(self):
        state=self.state(); other='tsk-'+str(uuid.uuid4())
        O.reduce(state,self.snap([self.event(),self.event(2,111,other)],
                                [self.task(),self.task(tid=other)]),115,200)
        self.assertEqual(state['runs'][self.rid]['identity_evidence'],'CONFLICT')
    def test_unknown_clock_no_completion(self):
        state=self.state(); O.reduce(state,self.snap([self.event(at=None)]),115,200)
        self.assertFalse(state['runs']); self.assertEqual(state['identity_conflicts'],1)
    def test_initial_source_errors_retained(self):
        doc=self.snap(); doc['errors']=['EXTENSION_UNAVAILABLE']
        self.assertEqual(O.new_state(doc,100)['source_error_cycles'],1)
    def test_atomic_idempotent_and_conflict(self):
        p=self.root/'data.json'; O.atomic(p,{'x':1},True); O.atomic(p,{'x':1},True)
        with self.assertRaises(ValueError): O.atomic(p,{'x':2},True)
    def test_atomic_failure_cleans_temp(self):
        with mock.patch.object(O.os,'replace',side_effect=OSError('fixture_failure')):
            with self.assertRaises(OSError): O.atomic(self.root/'data.json',{'x':1})
        self.assertEqual(list(self.root.glob('.meta-*')),[])
    def test_failed_start_only_prepared(self):
        out=self.root/'out'
        with mock.patch.object(O,'sample',return_value={'errors':['BRIDGE_UNAVAILABLE']}):
            self.assertEqual(O.observe({},out,1,1),2)
        self.assertEqual(json.loads((out/'stopped.json').read_text())['status'],'ONLY_PREPARED')
        self.assertFalse((out/'T0.json').exists())
    def test_reused_root_refused(self):
        out=self.root/'out'; out.mkdir(); (out/'owner.lock').write_bytes(b'')
        with self.assertRaises(FileExistsError): O.observe({},out,1,1)
    def test_reducer_failure_cannot_mutate_committed(self):
        original=self.state(); candidate=copy.deepcopy(original)
        with mock.patch.object(O,'MAX_RUNS',0):
            with self.assertRaises(ValueError): O.reduce(candidate,self.snap([self.event()]),115,200)
        self.assertEqual(original['cursor'],0); self.assertFalse(original['runs'])
    def test_bad_parser_hash_never_imports(self):
        p=self.root/'parser.py'; p.write_text('raise RuntimeError("must_not_execute")')
        with self.assertRaises(ValueError): S.extension({'extension_reader':str(p),'extension_reader_sha256':'bad'},[])
    def test_finite_real_launcher_final_snapshot_and_exit_witness(self):
        out=self.root/'out'; cfg=self.root/'config.json'; cfg.write_text(json.dumps(self.config))
        before=hashlib.sha256(self.db.read_bytes()).hexdigest()
        self.assertEqual(L.main(['--config',str(cfg),'--out',str(out),'--seconds','2','--interval','1']),0)
        self.assertTrue((out/'T0.json').is_file()); self.assertTrue((out/'exit-witness.json').is_file())
        cycles=[json.loads(p.read_text()) for p in out.glob('cycles-*/*.json')]
        self.assertTrue(cycles[-1]['final_sample'])
        self.assertEqual(before,hashlib.sha256(self.db.read_bytes()).hexdigest())
        self.assertNotIn('PRIVATE_BODY',''.join(p.read_text() for p in out.rglob('*.json')))
    def test_sources_no_network_host_or_page_api(self):
        import ast
        tree=ast.parse(Path(S.__file__).read_text())
        imports=[n for n in ast.walk(tree) if isinstance(n,(ast.Import,ast.ImportFrom))]
        text=' '.join(ast.unparse(n) for n in imports)
        for forbidden in ('socket','requests','host','terminal_source','playwright'):
            self.assertNotIn(forbidden,text)
    def test_checkpoint_failure_preserves_committed_cursor(self):
        import time
        out=self.root/'out'; original=self.snap()
        later=self.snap([self.event(at=time.time()+0.2)])
        actual=O.atomic; failed=[False]
        def guarded(path,doc,immutable=False):
            if path.name=='state.json' and doc.get('seq')==1 and not failed[0]:
                failed[0]=True; raise OSError('fixture_checkpoint_failure')
            return actual(path,doc,immutable)
        with mock.patch.object(O,'sample',side_effect=[original,later]),mock.patch.object(O,'atomic',side_effect=guarded):
            self.assertEqual(O.observe({},out,1,1),2)
        state=json.loads((out/'state.json').read_text())
        self.assertEqual(state['cursor'],0); self.assertTrue(state['commit_uncertain'])
        self.assertEqual(state['uncommitted_cycle_seq'],1)
    def test_block_hash_checked_before_primary_execution(self):
        p=self.root/'reader.py'; p.write_text('raise RuntimeError("must_not_execute")')
        block=self.root/'block.py'; block.write_text('raise RuntimeError("must_not_execute")')
        cfg={'extension_reader':str(p),'extension_reader_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
             'block_reader':str(block),'block_reader_sha256':'bad'}
        with self.assertRaises(ValueError): S.extension(cfg,[])
    def test_closed_reason_and_state_whitelist(self):
        doc=S.record({'state':'PRIVATE_BODY','reason':'PRIVATE_BODY','message':'PRIVATE_BODY'})
        self.assertNotIn('PRIVATE_BODY',json.dumps(doc))
    def test_worker_timeout_kills_only_owned_child(self):
        proc=mock.Mock(); proc.communicate.side_effect=[O.subprocess.TimeoutExpired('fixture',2),(b'',b'')]
        with mock.patch.object(O.subprocess,'Popen',return_value=proc):
            self.assertEqual(O.sample({},0,[])['errors'],['SOURCE_WORKER_TIMEOUT'])
        proc.kill.assert_called_once()


if __name__=='__main__': unittest.main()
