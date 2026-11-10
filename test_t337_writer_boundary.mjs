import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { TaskStore } from './tools/dsh-direct/store.mjs';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { acquireWriter } from './tools/dsh-direct/writer_lock.mjs';

const SID = 'session-11111111-2222-4333-8444-555566667777';
const TID = 'dshd-1111111122222222';
const ENTRY = fileURLToPath(new URL('./tools/dsh-direct/test_writer_child.mjs', import.meta.url));
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 't337-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function seed(dir, state = 'running') {
  const task = { taskId: TID, requestId: 't337-known-request', sessionId: SID, projectId: '/fixture',
    state, promptSha256: 'a'.repeat(64), stages: [], turnId: null, requiresReconcile: false };
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [task], requestIds: { [task.requestId]: TID } }));
}
function child(t, mode, dir) {
  const proc = fork(ENTRY, [mode, dir], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] });
  const messages = [], waiters = [];
  proc.on('message', m => { if (waiters.length) waiters.shift()(m); else messages.push(m); });
  const ended = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); await ended; });
  return { proc, ended, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)) };
}

test('T337 real competing processes: all updated mutators reject while one admission is in flight', { timeout: 10000 }, async t => {
  const dir = directory(t), owner = child(t, 'owner', dir);
  const entered = await owner.next();
  assert.equal(entered.phase, 'host_entered', JSON.stringify(entered));
  const before = readFileSync(join(dir, 'tasks.json'));
  assert.equal(JSON.parse(before).tasks.length, 1);
  const contender = child(t, 'contender', dir);
  const result = await contender.next();
  assert.equal(result.hostCalls, 0);
  assert.deepEqual(result.codes, Object.fromEntries(['submit', 'reconcile', 'getResult', 'accept', 'stage', 'transition']
    .map(name => [name, 'direct_writer_held'])));
  assert.equal((await contender.ended).code, 0);
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), before);
  owner.proc.send('finish');
  const done = await owner.next();
  assert.equal(done.state, 'succeeded'); assert.equal((await owner.ended).code, 0);
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), false);
  const ledger = JSON.parse(readFileSync(join(dir, 'tasks.json')));
  assert.equal(ledger.tasks.length, 1); assert.equal(ledger.tasks[0].taskId, done.taskId);
  assert.equal(ledger.tasks[0].stages.filter(s => s.stage === 'host_prompt_sent').length, 1);
});

test('T337 process death preserves the reservation and known task; no automatic reclaim', { timeout: 10000 }, async t => {
  const dir = directory(t); seed(dir);
  const crashing = child(t, 'crash', dir);
  assert.equal((await crashing.next()).phase, 'crash_ready');
  const before = readFileSync(join(dir, 'tasks.json'));
  crashing.proc.kill(); await crashing.ended;
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), true);
  const contender = child(t, 'contender', dir), result = await contender.next();
  assert.equal(result.hostCalls, 0);
  assert.ok(Object.values(result.codes).every(code => code === 'direct_writer_held'));
  assert.equal((await contender.ended).code, 0);
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), before);
  assert.equal(JSON.parse(before).tasks[0].taskId, TID);
  assert.equal(JSON.parse(before).tasks[0].state, 'unknown');
});

test('T337 pre-write validation and serialization rollback leave the ledger unchanged', async t => {
  const dir = directory(t); seed(dir, 'succeeded');
  const store = new TaskStore(dir), before = readFileSync(join(dir, 'tasks.json'));
  assert.throws(() => store.transition(TID, 'invented'), { code: 'internal' });
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), false);
  // An impossible JSON value is a deterministic pre-rename failure, not a fabricated OS fault.
  const circular = {}; circular.self = circular;
  assert.throws(() => store.transition(TID, 'failed', { error: circular }), /circular/i);
  assert.equal(store.find(TID).state, 'succeeded');
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), before);
  // Serialization occurred before writing: no temporary data or uncertain disk commit exists.
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), false);
  assert.equal(readdirSync(dir).filter(n => n.includes('.tmp-')).length, 0);
  const lease = acquireWriter(dir);
  try { assert.throws(() => store.stage(TID, 'unfenced'), { code: 'direct_writer_held' }); }
  finally { lease.release(); }
});

test('T337 real Windows rename denial preserves disk, temp and reservation; later writers stay blocked', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const dir = directory(t); seed(dir, 'succeeded');
  const file = join(dir, 'tasks.json'), store = new TaskStore(dir), before = readFileSync(file);
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Open the fixture with read/write sharing but WITHOUT delete sharing: real Windows rename denial.
  const script = '$f=[IO.File]::Open($env:T337_FIXTURE_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine("ready"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }';
  const holder = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, T337_FIXTURE_FILE: file } });
  const ended = new Promise(resolve => holder.once('exit', resolve));
  t.after(async () => { if (holder.exitCode === null) holder.kill(); await ended; });
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /ready/);
  assert.throws(() => store.transition(TID, 'failed'), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
  assert.equal(store.find(TID).state, 'succeeded');
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), true);
  assert.equal(readdirSync(dir).filter(n => n.includes('.tmp-')).length, 1);
  holder.stdin.end('\n'); await ended;
  assert.throws(() => new TaskStore(dir).stage(TID, 'retry'), { code: 'direct_writer_held' });
  assert.deepEqual(readFileSync(file), before);
});

test('T337 stale snapshot and replaced owner token fail closed instead of overwriting or unlinking', async t => {
  const dir = directory(t); seed(dir, 'succeeded');
  const stale = new TaskStore(dir), fresh = new TaskStore(dir);
  fresh.stage(TID, 'newer_writer');
  const newer = readFileSync(join(dir, 'tasks.json'));
  assert.throws(() => stale.stage(TID, 'stale_writer'), { code: 'direct_writer_stale' });
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), newer);
  assert.equal(existsSync(join(dir, '.direct-writer.lock')), true);
  const otherDir = directory(t), lease = acquireWriter(otherDir);
  const lockPath = join(otherDir, '.direct-writer.lock');
  writeFileSync(lockPath, 'replacement-token');
  assert.throws(() => lease.release(), { code: 'direct_writer_lost' });
  assert.equal(readFileSync(lockPath, 'utf8'), 'replacement-token');
});

test('T337 DirectServer rejects unfenced injected stores; released asynchronous contexts never regain ownership', async t => {
  const dir = directory(t);
  assert.throws(() => new DirectServer({ stateDir: dir }, { client: {}, store: {} }), { code: 'direct_writer_required' });
  const store = new TaskStore(dir); let proceed, late;
  await store.withWriter(async () => {
    late = (async () => { await new Promise(resolve => { proceed = resolve; }); return store.accept({ requestId: 'late', sessionId: SID, prompt: 'fixture' }); })();
  });
  proceed();
  await assert.rejects(late, { code: 'direct_writer_lost' });
  assert.equal(existsSync(join(dir, 'tasks.json')), false);
});
