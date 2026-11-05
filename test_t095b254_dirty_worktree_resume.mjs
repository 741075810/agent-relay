// T254: a failed round must not cost the operator the work that was already on disk.
//
// The fact under test, stated before the code: T248 and T249 both died upstream (a 403 quota pre-charge and a
// connection error) while a round was in progress, and T250 resumed the *same* DSH session and carried on.
// That only works if nothing in the continuation path touches the worktree. This suite builds a throwaway git
// repository -- never the real one -- puts uncommitted work in it, drives the recorded failure paths
// (`complete(failed)` and a crash that `recover` escalates) plus the handoff builder, and asserts the tree,
// HEAD, the stash and the untracked file are all exactly as they were.
//
// It also pins the negative: the generated handoff text must not contain a git command that could discard or
// overwrite uncommitted work. A future round adding `git checkout .` to the prompt would fail here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.T254_DIR || path.join(HERE, 'tools', 'continuation');
const CS = await import(pathToFileURL(path.join(DIR, 'continuation_state.mjs')).href
  + '?r=t254' + Math.random().toString(36).slice(2));
const N = await import(pathToFileURL(path.join(DIR, 'dsh_native.mjs')).href
  + '?r=t254' + Math.random().toString(36).slice(2));

const PLAN = {
  objective: 'finish the approved list without losing in-flight work',
  approvedBy: 'operator',
  approvedAt: 1793450000000,
  maxRounds: 4,
  tasks: [
    { id: 't1', title: 'first', scope: 'repo:agent-relay', acceptance: 'suite green' },
    { id: 't2', title: 'second', scope: 'repo:agent-relay', acceptance: 'gate green' },
  ],
};

function git(cwd, ...args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, 'git ' + args.join(' ') + ' -> ' + (out.stderr || ''));
  return (out.stdout || '').trim();
}

/** A throwaway repository with one commit, one uncommitted edit and one untracked file. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 't254-git-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't254@example.invalid');
  git(root, 'config', 'user.name', 'T254');
  writeFileSync(path.join(root, 'work.txt'), 'baseline\n', 'utf8');
  writeFileSync(path.join(root, 'keep.txt'), 'tracked\n', 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  // The in-flight work a failed round must not lose.
  writeFileSync(path.join(root, 'work.txt'), 'baseline\nuncommitted fix\n', 'utf8');
  writeFileSync(path.join(root, 'scratch.txt'), 'untracked note\n', 'utf8');
  return root;
}

function observe(root) {
  return {
    status: git(root, 'status', '--porcelain'),
    head: git(root, 'rev-parse', 'HEAD'),
    commits: git(root, 'rev-list', '--count', 'HEAD'),
    stash: git(root, 'stash', 'list'),
    work: readFileSync(path.join(root, 'work.txt'), 'utf8'),
    scratch: existsSync(path.join(root, 'scratch.txt')) ? readFileSync(path.join(root, 'scratch.txt'), 'utf8') : null,
  };
}

const EVENT = {
  runId: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  epoch: 'epoch-t254',
  sessionId: 'session-22222222-2222-4222-8222-222222222222',
  bridgeUp: true,
  authorisation: { mode: 'standing', epoch: 'epoch-t254', armedAt: 1793450000000,
    expiresAt: 1793453600000, sessionId: 'session-22222222-2222-4222-8222-222222222222' },
};

test('T254: a failed round leaves the uncommitted worktree byte-identical', () => {
  const root = fixture();
  try {
    const before = observe(root);
    assert.match(before.status, /M work\.txt/);
    assert.match(before.status, /\?\? scratch\.txt/);

    // The round is admitted, leased, and then dies upstream: exactly the T249 shape.
    const admitted = CS.admit(CS.createStore({ epoch: 'epoch-t254' }), { ...EVENT, now: 1793450001000 });
    assert.equal(admitted.code, null);
    const leased = CS.lease(admitted.store, admitted.key, 1793450002000, 60000);
    assert.equal(leased.code, null);
    const failed = CS.complete(leased.store, admitted.key,
      { outcome: 'failed', code: 'dsh_connection_error', at: 1793450003000 });
    assert.equal(failed.code, 'retry_scheduled');
    assert.equal(failed.store.jobs[admitted.key].state, 'failed');
    assert.equal(failed.store.jobs[admitted.key].nextRetryAt, 1793450033000,
      'the retry is scheduled 30 s out, not attempted immediately');

    // Nothing may be dispatchable before that instant: no unconditional re-request.
    assert.deepEqual(CS.dispatchable(failed.store, 1793450032999), []);
    assert.deepEqual(CS.dispatchable(failed.store, 1793450033000), [admitted.key]);

    const after = observe(root);
    assert.deepEqual(after, before, 'a failed round must not modify, commit, stash or delete anything');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T254: a crash mid-handoff is escalated, never retried, and still touches no file', () => {
  const root = fixture();
  try {
    const before = observe(root);
    const admitted = CS.admit(CS.createStore({ epoch: 'epoch-t254' }), { ...EVENT, now: 1793450001000 });
    const leased = CS.lease(admitted.store, admitted.key, 1793450002000, 60000);
    // The hand-off died with the process: nobody recorded the outcome. Retrying would guess.
    const recovered = CS.recover(leased.store, 1793450062001);
    assert.deepEqual(recovered.escalated, [admitted.key]);
    assert.equal(recovered.store.jobs[admitted.key].state, 'escalated');
    assert.equal(recovered.store.jobs[admitted.key].lastError, 'unknown_outcome');
    assert.deepEqual(CS.dispatchable(recovered.store, 1793450062001), []);

    assert.deepEqual(observe(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T254: the resumed handoff carries no verb that could discard uncommitted work', () => {
  const root = fixture();
  try {
    const before = observe(root);
    const handoff = N.buildGoalHandoff(PLAN, { sessionId: EVENT.sessionId, now: 1793450010000 });
    assert.equal(handoff.code, null);
    const text = JSON.stringify(handoff);
    assert.equal(/\bgit\s+(reset|checkout|clean|stash)\b|--hard\b/.test(text), false,
      'a resumed round is allowed to read git state, never to discard it');
    assert.match(handoff.objective, new RegExp('Fixed session: ' + EVENT.sessionId),
      'the resumed round is pinned to the same DSH session, not a fresh one');
    assert.deepEqual(observe(root), before, 'building the handoff is pure data and writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
