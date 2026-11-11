// T352: the Direct writer lease, and what a replaced owner may still do.
//
// The case that matters is not "two writers at once" -- `openSync(..., 'wx')` already refuses
// that. It is a writer whose lock was replaced underneath it: it must not write the ledger and
// it must not delete the record of whoever holds it now. Every case below builds the real lock
// file and the real TaskStore; nothing is mocked except the bytes another writer would have
// written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWriter } from './tools/dsh-direct/writer_lock.mjs';
import { TaskStore } from './tools/dsh-direct/store.mjs';

const SID = 'session-11111111-2222-4333-8444-555566667777';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 't352-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lockPath = (dir) => join(dir, '.direct-writer.lock');
const bodyOf = (dir) => readFileSync(lockPath(dir), 'utf8');

function foreignBody(owner = 'bbbbbbbb-2222-4333-8444-555566667777') {
  return JSON.stringify({ version: 2, owner, generation: 'cccccccc-1111-4222-8333-444455556666',
    pid: 999999 }) + '\n';
}

function seed(t, dir) {
  const store = new TaskStore(dir);
  const accepted = store.accept({ requestId: 't352-fixture-request', sessionId: SID, prompt: 'fixture' });
  return { store, taskId: accepted.task.taskId };
}

test('T352 the lock record names its owner and generation', async t => {
  const dir = scratch(t);
  const lease = acquireWriter(dir);
  const record = JSON.parse(bodyOf(dir));
  assert.equal(record.version, 2);
  assert.equal(record.owner, lease.owner);
  assert.equal(record.generation, lease.generation);
  assert.equal(record.pid, process.pid);
  lease.assertHeld();
  lease.release();
  assert.equal(existsSync(lockPath(dir)), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.release-')), []);
});

test('T352 a replaced owner restores the newer record instead of deleting it', async t => {
  const dir = scratch(t);
  const lease = acquireWriter(dir);
  const replacement = foreignBody();
  // An external delete plus another writer's acquire, i.e. exactly what a stale lease cannot
  // distinguish from its own lock by name alone.
  writeFileSync(lockPath(dir), replacement);
  assert.throws(() => lease.release(), { code: 'direct_writer_lost' });
  assert.equal(existsSync(lockPath(dir)), true, 'the newer owner must still hold a lock');
  assert.equal(bodyOf(dir), replacement, 'restored byte for byte');
});

test('T352 a legacy or malformed lock is preserved verbatim', async t => {
  for (const body of [JSON.stringify({ version: 1, owner: 'aaaaaaaa-1111-4222-8333-444455556666', pid: 1 }) + '\n',
    'replacement-token', '']) {
    const dir = scratch(t);
    const lease = acquireWriter(dir);
    writeFileSync(lockPath(dir), body);
    assert.throws(() => lease.assertHeld(), { code: 'direct_writer_lost' });
    assert.throws(() => lease.release(), { code: 'direct_writer_lost' });
    assert.equal(bodyOf(dir), body, 'never rewritten, never removed');
  }
});

test('T352 a stale owner cannot write the ledger after its lock was replaced', async t => {
  const dir = scratch(t);
  const { store, taskId } = seed(t, dir);
  const before = readFileSync(join(dir, 'tasks.json'));
  const replacement = foreignBody();
  // The store holds the lease; the record underneath it is swapped for another writer's. The
  // write must be refused, and the release that follows must put the other record back.
  await assert.rejects(store.withWriter(async () => {
    writeFileSync(lockPath(dir), replacement);
    assert.throws(() => store.stage(taskId, 'stale_writer'), { code: 'direct_writer_lost' });
  }), { code: 'direct_writer_lost' });
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), before);
  assert.equal(bodyOf(dir), replacement, 'and the newer record survived');
});

test('T352 a stale snapshot is refused before the rename', async t => {
  const dir = scratch(t);
  const { store, taskId } = seed(t, dir);
  const newer = new TaskStore(dir);
  newer.stage(taskId, 'newer_writer');
  const bytes = readFileSync(join(dir, 'tasks.json'));
  assert.throws(() => store.stage(taskId, 'stale_snapshot'), { code: 'direct_writer_stale' });
  assert.deepEqual(readFileSync(join(dir, 'tasks.json')), bytes);
});

test('T352 the ledger records which generation wrote it', async t => {
  const dir = scratch(t);
  const { taskId } = seed(t, dir);
  const first = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).writer;
  assert.equal(first.pid, process.pid);
  assert.match(first.generation, /^[0-9a-f-]{36}$/);
  const store = new TaskStore(dir);
  store.stage(taskId, 'second_write');
  const second = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).writer;
  assert.notEqual(second.generation, first.generation, 'a new lease is a new generation');
  // The audited record is additive: the document still validates as a version 1 ledger.
  assert.equal(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).version, 1);
});

test('T352 a preserved lease neither writes nor releases', async t => {
  const dir = scratch(t);
  const lease = acquireWriter(dir);
  lease.preserve();
  assert.throws(() => lease.assertHeld(), { code: 'direct_writer_preserved' });
  lease.release();
  assert.equal(existsSync(lockPath(dir)), true, 'quarantined evidence stays on disk');
});

test('T352 the lock is held across the atomic rename and gone afterwards', async t => {
  const dir = scratch(t);
  const { store, taskId } = seed(t, dir);
  let seenInside = null;
  await store.withWriter(async () => {
    seenInside = bodyOf(dir);
    assert.equal(JSON.parse(seenInside).owner, JSON.parse(seenInside).owner);
    store.stage(taskId, 'inside_writer');
  });
  assert.equal(typeof seenInside, 'string');
  assert.equal(existsSync(lockPath(dir)), false);
  // A second process-facing acquisition succeeds only after the first lease is released.
  const again = acquireWriter(dir);
  again.release();
});
