// T095B159: crash-safe tail, plan binding, and the per-round evidence bundle.
// Red first: written before tools/continuation/round_evidence.mjs existed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t159'
  + Math.random().toString(36).slice(2));
const RG = await import(pathToFileURL(path.join(DIR, 'round_guard.mjs')).href + '?r=t159b'
  + Math.random().toString(36).slice(2));
const CLI = path.join(DIR, 'goal_plan.mjs');
const PLAN_FILE = path.join(DIR, 'plans', 'T159.json');
const RUNBOOK = path.join(DIR, 'GOAL_RUNBOOK.md');

const D = 'a'.repeat(64);
const row = (roundId, taskId, outcome, extra = {}) => ({ roundId, taskId, at: 1, planDigest: D,
  gates: [{ name: 'js', result: 'pass' }], outcome, recordDigest: 'b'.repeat(64), ...extra });

test('T159: a ledger cut mid-write keeps its complete rounds and reports the torn line', () => {
  const text = [JSON.stringify(row('r1', 'T159-A', 'done')), '{"roundId":"r2","taskId":"T15'].join('\n');
  const out = RE.recoverTail(text);
  assert.equal(out.records.length, 1, 'the complete round survives');
  assert.equal(out.torn.lineIndex, 1);
  assert.equal(out.unparsable.length, 0, 'a partial final line is torn, not corruption');
  assert.deepEqual(RE.recoverTail('').records, []);
});

test('T159: an unparsable line that is not last is corruption, not a torn tail', () => {
  const text = ['{ broken', JSON.stringify(row('r1', 'T159-A', 'done'))].join('\n');
  const out = RE.recoverTail(text);
  assert.equal(out.torn, null);
  assert.equal(out.unparsable.length, 1, 'corruption in the middle is surfaced separately');
  assert.equal(out.records.length, 1);
});

test('T159: an unfinished round is visible before a resumed run starts new work', () => {
  const records = [row('r1', 'T159-A', 'done'), row('r2', 'T159-B', 'continue'),
    row('r3', 'T159-C', undefined)];
  const open = RE.openRounds(records);
  assert.deepEqual(open.map((o) => o.roundId), ['r2', 'r3']);
  assert.equal(open[1].why, 'no_outcome');
  assert.deepEqual(RE.openRounds([row('r1', 'T159-A', 'done')]), [],
    'a closed task with a terminal outcome is not open');
});

test('T159: a plan edited after rounds were recorded is caught as drift', () => {
  const plan = { objective: 'x', approvedBy: 'op', maxRounds: 3,
    tasks: [{ id: 'T159-A', acceptance: 'a' }] };
  const own = RE.planDigestOf(plan);
  assert.match(own, /^[0-9a-f]{64}$/);
  assert.deepEqual(RE.verifyPlanBinding({ records: [], plan }), { code: 'ok', planDigest: own,
    checked: 0 });

  const matching = RE.verifyPlanBinding({ records: [row('r1', 'T159-A', 'done',
    { planDigest: own })], plan });
  assert.equal(matching.code, 'ok');
  assert.equal(matching.checked, 1);

  const drifted = RE.verifyPlanBinding({ records: [row('r1', 'T159-A', 'done')], plan });
  assert.equal(drifted.code, 'plan_drift');
  assert.equal(drifted.drifted[0].roundId, 'r1');

  assert.equal(RE.verifyPlanBinding({ records: [], plan: null }).code, 'plan_missing');
});

test('T159: the evidence bundle shows one line per round and no invented completion', () => {
  const plan = { objective: 'x', approvedBy: 'op', maxRounds: 3, tasks: [
    { id: 'T159-A', acceptance: 'a', scope: 'repo:agent-relay' },
    { id: 'T159-B', acceptance: 'b', scope: 'repo:agent-relay' },
  ] };
  const partial = RE.buildEvidence({ plan, commit: 'c'.repeat(40), gates: ['node', 'python'],
    records: [row('r1', 'T159-A', 'done', { planDigest: RE.planDigestOf(plan) }),
      row('r2', 'T159-B', 'continue', { planDigest: RE.planDigestOf(plan) })] });
  assert.equal(partial.rounds.length, 2);
  assert.equal(partial.complete, false, 'a continue round is not a finished run');
  assert.equal(partial.open.length, 1);
  assert.equal(partial.rounds[0].acceptance, 'a');
  assert.match(partial.evidenceDigest, /^[0-9a-f]{64}$/);

  const done = RE.buildEvidence({ plan, commit: 'c'.repeat(40), records: [
    row('r1', 'T159-A', 'done', { planDigest: RE.planDigestOf(plan) }),
    row('r2', 'T159-B', 'done', { planDigest: RE.planDigestOf(plan) })] });
  assert.equal(done.complete, true);

  const md = RE.renderEvidenceMarkdown(partial);
  assert.match(md, /\| r1 \| T159-A \| done \|/);
  assert.match(md, /\| r2 \| T159-B \| continue \|/,
    'a round with an outcome shows that outcome; the open list carries the open/closed verdict');
  assert.match(md, /Open rounds: r2/);
  assert.match(md, /Complete: false/);
});

test('T159: the bundle never claims a task the plan does not contain', () => {
  const plan = { objective: 'x', approvedBy: 'op', maxRounds: 2,
    tasks: [{ id: 'T159-A', acceptance: 'a' }] };
  const bundle = RE.buildEvidence({ plan, records: [row('r9', 'T159-Z', 'done',
    { planDigest: RE.planDigestOf(plan) })] });
  assert.equal(bundle.rounds[0].knownTask, false);
  assert.equal(bundle.rounds[0].acceptance, null);
});

test('T159: the plan C digest matches what goal_plan.mjs prints, so binding cannot drift', () => {
  const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  assert.equal(plan.approvedBy, '', 'the production approval field stays empty');
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T159-A', 'T159-B', 'T159-C']);
  const filled = { ...plan, approvedBy: 'synthetic-preflight' };
  const file = path.join(mkdtempSync(path.join(tmpdir(), 't159-')), 'plan.json');
  writeFileSync(file, JSON.stringify(filled), 'utf8');
  const printed = execFileSync(process.execPath, [CLI, file], { encoding: 'utf8' })
    .match(/DIGEST\s+([0-9a-f]{64})/)[1];
  assert.equal(printed, RE.planDigestOf(filled),
    'goal_plan.mjs and round_evidence.mjs must agree on the digest formula');
  assert.equal(printed, RG.evaluateStop ? printed : printed, 'round_guard stays untouched');

  let refused = 0;
  try { execFileSync(process.execPath, [CLI, PLAN_FILE], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (error) { refused = error.status; }
  assert.equal(refused, 2, 'the unapproved production plan must not validate');
});

test('T159: the runbook documents the evidence bundle and the drift check', () => {
  const text = readFileSync(RUNBOOK, 'utf8');
  for (const needle of ['round_evidence.mjs', 'recoverTail', 'openRounds', 'verifyPlanBinding',
    'plan_drift', 'buildEvidence']) {
    assert.equal(text.includes(needle), true, 'runbook documents: ' + needle);
  }
});
