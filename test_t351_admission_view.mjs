// T351: the read-only admission contract.
//
// Each case builds a real ledger on disk and asks one question about one request. The
// assertions are about evidence, not convenience: only a row that recorded its reservation
// before the first prompt may be called unsent, and "no row" is asserted to come back
// ambiguous rather than empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, promptSha } from './tools/dsh-direct/store.mjs';
import { DirectServer } from './tools/dsh-direct/mcp_server.mjs';
import { CLASSIFICATIONS, classifyAdmission, readAdmission } from './tools/dsh-direct/admission_view.mjs';
import { openCampaign } from './tools/dsh-direct/productive_state.mjs';

const SID = 'session-11111111-2222-4333-8444-555566667777';
const RID = 't351-fixture-request';
const OTHER = 't351-other-request';
const PROMPT = 'fixture prompt';
const CLI = fileURLToPath(new URL('./tools/dsh-direct/productive_owner.mjs', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 't351-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded(t) {
  const stateDir = scratch(t);
  const store = new TaskStore(stateDir);
  const accepted = store.accept({ requestId: RID, sessionId: SID, projectId: '/fixture', prompt: PROMPT });
  return { stateDir, store, accepted };
}

function bytes(path) { return readFileSync(path); }

test('T351 a reservation written before the prompt is the only PROVEN_UNSENT', async t => {
  const { stateDir, accepted } = seeded(t);
  const view = readAdmission(stateDir, { requestId: RID, sessionId: SID, promptSha256: promptSha(PROMPT) });
  assert.equal(view.classification, CLASSIFICATIONS.PROVEN_UNSENT);
  assert.equal(view.taskId, accepted.task.taskId);
  assert.equal(view.promptSha256, promptSha(PROMPT));
  assert.equal(view.promptAttempted, false);
  assert.equal(view.readOnly, true);
  assert.equal(view.ledger, 'read');
});

test('T351 once a prompt call was attempted the answer is uncertain, not unsent', async t => {
  const { stateDir, store, accepted } = seeded(t);
  store.stage(accepted.task.taskId, 'host_prompt_sent', { sessionId: SID, requestId: RID });
  const view = readAdmission(stateDir, { requestId: RID });
  assert.equal(view.classification, CLASSIFICATIONS.SENT_OR_UNCERTAIN);
  assert.equal(view.promptAttempted, true);
  assert.equal(view.reason, 'state_accepted_after_prompt_call');
});

test('T351 only a succeeded row with a turn is EXACT_COMPLETED', async t => {
  const { stateDir, store, accepted } = seeded(t);
  store.transition(accepted.task.taskId, 'succeeded', { turnId: 'turn-9', result: { polls: 2, admission: { seq: 7 } } });
  const view = readAdmission(stateDir, { requestId: RID });
  assert.equal(view.classification, CLASSIFICATIONS.EXACT_COMPLETED);
  assert.deepEqual(view.terminalEvidence,
    { turnId: 'turn-9', state: 'succeeded', admissionSeq: 7, collectedPolls: 2 });
  // A row claiming success without the transition that records it is not proof of completion:
  // `accepted` + `succeeded` with no `state_succeeded` stage is exactly what a hand-edited or
  // partially written ledger looks like.
  const forged = classifyAdmission({ taskId: 'dshd-2222222222222222', requestId: RID, sessionId: SID,
    promptSha256: promptSha(PROMPT), state: 'succeeded', turnId: 'turn-9',
    stages: [{ at: 1, stage: 'accepted' }] }, { requestId: RID });
  assert.equal(forged.classification, CLASSIFICATIONS.SENT_OR_UNCERTAIN);
});

test('T351 a row recovered as unknown stays uncertain', async t => {
  const { stateDir, store, accepted } = seeded(t);
  store.stage(accepted.task.taskId, 'host_prompt_sent', { sessionId: SID, requestId: RID });
  // The restart conversion the store performs on load.
  store.transition(accepted.task.taskId, 'unknown', { unknownReason: 'process_restart' });
  const view = readAdmission(stateDir, { requestId: RID });
  assert.equal(view.classification, CLASSIFICATIONS.SENT_OR_UNCERTAIN);
  assert.equal(view.state, 'unknown');
});

test('T351 a row too old to carry the reservation marker fails closed', async t => {
  const stateDir = scratch(t);
  const legacy = { taskId: 'dshd-1111111111111111', requestId: RID, sessionId: SID, projectId: '/fixture',
    promptSha256: promptSha(PROMPT), promptChars: PROMPT.length, state: 'accepted',
    stages: [{ at: 1, stage: 'accepted', detail: null }], createdAt: 1, updatedAt: 1,
    turnId: null, result: null, error: null };
  writeFileSync(join(stateDir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [legacy],
    requestIds: { [RID]: legacy.taskId } }));
  const view = readAdmission(stateDir, { requestId: RID, sessionId: SID });
  assert.equal(view.classification, CLASSIFICATIONS.SENT_OR_UNCERTAIN);
  assert.equal(view.reservationProtocol, null);
  assert.equal(view.promptAttempted, false, 'no prompt stage, and still not called unsent');
});

test('T351 no row is ambiguous, and an absent ledger is not an empty one', async t => {
  const missing = readAdmission(join(scratch(t), 'nothing-here'), { requestId: RID });
  assert.equal(missing.classification, CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS);
  assert.equal(missing.present, false);
  assert.equal(missing.ledger, 'absent');
  assert.equal(missing.code, 'ledger_file_absent');
  assert.match(missing.note, /not_evidence/);

  const { stateDir } = seeded(t);
  const unknownRequest = readAdmission(stateDir, { requestId: OTHER });
  assert.equal(unknownRequest.classification, CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS);
  assert.equal(unknownRequest.reason, 'no_ledger_row_for_request');
  assert.equal(unknownRequest.ledger, 'read');

  const broken = scratch(t);
  writeFileSync(join(broken, 'tasks.json'), '{ nope');
  const invalid = readAdmission(broken, { requestId: RID });
  assert.equal(invalid.ledger, 'invalid');
  assert.equal(invalid.classification, CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS);
});

test('T351 a mismatched digest or session is ambiguous, never unsent', async t => {
  const { stateDir } = seeded(t);
  const wrongDigest = readAdmission(stateDir, { requestId: RID, sessionId: SID, promptSha256: promptSha('other') });
  assert.equal(wrongDigest.classification, CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS);
  assert.equal(wrongDigest.reason, 'prompt_digest_mismatch');

  const wrongSession = readAdmission(stateDir, { requestId: RID,
    sessionId: 'session-99999999-8888-4777-8666-555544443333' });
  assert.equal(wrongSession.classification, CLASSIFICATIONS.NO_RECORD_LEGACY_AMBIGUOUS);
  assert.equal(wrongSession.reason, 'request_belongs_to_another_session');
});

test('T351 inspection writes nothing and creates no lock', async t => {
  const { stateDir } = seeded(t);
  const ledger = join(stateDir, 'tasks.json');
  const before = bytes(ledger);
  const listing = readdirSync(stateDir).sort();
  for (const requestId of [RID, OTHER, RID]) {
    readAdmission(stateDir, { requestId, sessionId: SID });
  }
  assert.deepEqual(bytes(ledger), before);
  assert.deepEqual(readdirSync(stateDir).sort(), listing);
});

test('T351 inspection never talks to the Host', async t => {
  const { stateDir, store } = seeded(t);
  const calls = { prompt: 0, listSessions: 0, getEvents: 0 };
  const client = { kind: 'fixture', protocol: 'rc.2',
    async listSessions() { calls.listSessions += 1; return []; },
    async prompt() { calls.prompt += 1; return { accepted: true, turnId: 'turn-1' }; },
    async getEvents() { calls.getEvents += 1; return { cursor: null, events: [] }; } };
  const server = new DirectServer({ stateDir, boundSessionIds: [SID], boundCwds: [], boundProjectIds: [],
    worktreeRoot: null, allowDirtyWorktree: false, maxPolls: 1 },
  { client, store, worktree: async () => ({ clean: true }) });
  const view = readAdmission(stateDir, { requestId: RID, sessionId: SID });
  assert.equal(view.classification, CLASSIFICATIONS.PROVEN_UNSENT);
  assert.deepEqual(calls, { prompt: 0, listSessions: 0, getEvents: 0 });
  assert.equal(server.store.tasks[0].state, 'accepted', 'the row is untouched by inspection');
});

test('T351 the owner status reports the classification without acting on it', async t => {
  // The campaign journal only accepts the immutable identity shape it was built for.
  const planned = 'productive-' + 'a'.repeat(64);
  const dir = join(scratch(t), 'campaign');
  const journal = openCampaign(dir, { campaignId: 'fixture', sessionId: 'session-fixture',
    jobs: [{ index: 0, requestId: planned }, { index: 1, requestId: OTHER }] });
  journal.record({ stage: 'activation' });
  journal.record({ stage: 'admissible', requestId: planned });
  journal.record({ stage: 'dispatch_reserved', requestId: planned });
  journal.close();
  const stateDir = scratch(t);
  const store = new TaskStore(stateDir);
  const accepted = store.accept({ requestId: planned, sessionId: SID, projectId: '/fixture', prompt: PROMPT });
  const ledgerBefore = bytes(join(stateDir, 'tasks.json'));
  const journalBefore = bytes(join(dir, 'events.jsonl'));

  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, '--status', dir, '--state-dir', stateDir],
      { encoding: 'utf8', timeout: 30000 });
  } catch (error) { stdout = String(error.stdout ?? ''); status = error.status; }
  const view = JSON.parse(stdout.trim());
  assert.equal(status, 2, 'a reserved dispatch is still not a healthy exit');
  assert.equal(view.code, 'reservation_unsettled');
  assert.equal(view.dispatchAllowed, false);
  assert.equal(view.blocked.admission.classification, CLASSIFICATIONS.PROVEN_UNSENT);
  assert.equal(view.blocked.admission.taskId, accepted.task.taskId);
  assert.deepEqual(bytes(join(stateDir, 'tasks.json')), ledgerBefore);
  assert.deepEqual(bytes(join(dir, 'events.jsonl')), journalBefore);
  assert.equal(/"submitted":\s*[1-9]/.test(stdout), false, stdout);
});
