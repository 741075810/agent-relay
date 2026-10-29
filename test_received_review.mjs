import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReceivedReview, handleReceivedReviewMessage, SELECTION_TTL_MS,
  RECORD_MAX_AGE_MS } from './extension/lib/received_review.js';
import { createTargetBindingController, TARGET_BINDING_SESSION_KEY } from './extension/lib/target_binding_controller.js';
import { createBoundDryRunController, DRY_RUN_HISTORY_KEY } from './extension/lib/bound_dry_run_controller.js';

const RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV = '11111111-1111-4111-8111-111111111111';
const URL = 'https://chatgpt.com/c/' + CONV;
const NOW = 2000000000000;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function fixture() {
  const f = { time: NOW, writes: 0, probes: 0, gets: [], reads: 0, seq: 0 };
  f.binding = { version: 1, revision: 1, boundAt: NOW - 1000, tabId: 7,
    windowId: 2, url: URL, conversationId: CONV,
    documentInstanceId: 'document-instance-test-055', manuallyConfirmed: true,
    accountVerified: false, accountIdentity: 'unverified', invalidatedReason: null, invalidatedAt: null };
  f.records = [{ eventId: 'a'.repeat(64), name: 'task.completed', runId: RUN,
    status: 'completed', createdAt: new Date(NOW - 864000000).toISOString(),
    receivedAt: new Date(NOW - 1000).toISOString(), replay: true, message: 'SECRET BODY' }];
  f.history = [];
  f.session = {
    async get(defaults) {
      if (f.failSession) throw Error('offline');
      return { ...defaults, [TARGET_BINDING_SESSION_KEY]: {
        version: 1, revision: 1, binding: structuredClone(f.binding),
        candidates: [], candidateScannedAt: null },
      [DRY_RUN_HISTORY_KEY]: structuredClone(f.history) };
    },
    async set() { f.writes++; throw Error('WRITE FORBIDDEN'); },
  };
  f.tab = { id: 7, windowId: 2, url: URL, active: false, discarded: false, frozen: false };
  f.tabs = {
    async get(id) { f.gets.push(id); if (f.noTab) throw Error('missing'); return { ...f.tab }; },
    async sendMessage(id, msg) {
      f.probes++; assert.equal(id, 7); assert.equal(msg.type, 'readonly-probe');
      if (f.noContent) throw Error('no receiver');
      if (f.timeout) return new Promise(() => {});
      if (f.duringProbe) await f.duringProbe();
      return { requestId: msg.requestId, url: f.tab.url, conversationId: CONV,
        observedAt: f.time - (f.stale ? 6000 : 0), documentInstanceId: f.document || f.binding.documentInstanceId,
        visibilityState: 'hidden', hasFocus: false, composerPresent: true,
        pageLoaded: true, routeStable: true };
    },
  };
  const target = createTargetBindingController({ session: f.session, tabs: f.tabs }, { now: () => f.time });
  const dry = createBoundDryRunController({}, { session: f.session, targetBinding: target, now: () => f.time });
  f.options = { readReceived: async () => { f.reads++; if (f.failRead) throw Error('missing');
    if (f.onRead) f.onRead(); return structuredClone(f.records); },
    getBindingState: () => target.getState(), readDryRunState: () => dry.state(),
    tabs: f.tabs, now: () => f.time, timeoutMs: 5, makeToken: () => 'token-' + (++f.seq) };
  f.c = createReceivedReview(f.options);
  f.select = async () => (await f.c.list()).items[0].token;
  f.run = async () => f.c.review(await f.select());
  return f;
}
function blocked(r, reason) {
  assert.equal(r.reviewAllowed, false); assert.equal(r.blocked, true);
  assert.equal(r.sendEligible, false); assert.equal(r.wouldSend, false);
  assert.equal(r.pageWriteEligible, false); assert.equal(r.provenance, 'unverified');
  assert.equal(r.historyRecorded, false);
  if (reason) assert.ok(r.reasons.includes(reason), JSON.stringify(r));
}
await test('construction and listing never probe or write', async () => {
  const f = fixture(); assert.equal(f.reads, 0);
  const r = await f.c.list(); assert.equal(r.items.length, 1);
  assert.equal(f.probes, 0); assert.equal(f.writes, 0);
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.ok(!('message' in r.items[0]));
});
await test('healthy exact target is still provenance-blocked; no history or binding writes', async () => {
  const f = fixture(); const before = structuredClone(f.binding); const r = await f.run();
  blocked(r, 'provenance_unverified'); assert.equal(r.targetConsistent, true);
  assert.equal(r.bindingStatus, 'bound_healthy'); assert.equal(r.target.tabId, 7);
  assert.equal(r.proposal, null); assert.equal(f.writes, 0); assert.deepEqual(f.binding, before);
  assert.deepEqual(f.history, []); assert.ok(f.gets.every((id) => id === 7));
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.ok(!r.reasons.includes('record_expired'));
});
await test('a tab API without frozen is consistent once the content script answers', async () => {
  // Chrome builds that omit `tabs.Tab.frozen` used to make every such target
  // unusable. The live answer is the evidence; the property is only a shortcut.
  const f = fixture(); delete f.tab.frozen;
  const r = await f.run();
  blocked(r, 'provenance_unverified');
  assert.equal(r.targetConsistent, true);
  assert.equal(r.bindingStatus, 'bound_healthy');
  assert.equal(r.sendEligible, false); assert.equal(r.wouldSend, false);
  assert.equal(r.pageWriteEligible, false);
  assert.equal(f.writes, 0);
});
for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'running']) {
  await test('status preserved: ' + status, async () => {
    const f = fixture(); Object.assign(f.records[0], { status, name: 'task.' + status });
    const r = await f.run(); blocked(r, 'provenance_unverified'); assert.equal(r.record.status, status);
    if (status === 'interrupted') blocked(r, 'original_terminal_status_lost');
    if (['interrupted', 'running'].includes(status)) assert.equal(f.probes, 0);
  });
}
for (const patch of [{ replay: false }, { message: '[DSH preview] real trusted completed' },
  { source: 'codex-bridge-ledger', provenance: 'verified' }]) {
  await test('labels and claims cannot establish provenance: ' + Object.keys(patch), async () => {
    const f = fixture(); Object.assign(f.records[0], patch); blocked(await f.run(), 'provenance_unverified');
  });
}
for (const [name, change, reason] of [
  ['missing', (f) => { f.records = []; }, 'record_missing'],
  ['changed', (f) => { f.records[0].runId = CONV; }, 'record_changed'],
  ['duplicate ID', (f) => { f.records.push({ ...f.records[0] }); }, 'record_id_ambiguous'],
  ['old', (f) => { f.time += RECORD_MAX_AGE_MS + 1; }, 'record_expired'],
  ['future', (f) => { f.records[0].receivedAt = new Date(NOW + 9999).toISOString(); }, 'record_timestamp_invalid'],
  ['token expiry', (f) => { f.time += SELECTION_TTL_MS + 1; }, 'selection_expired'],
  ['tab switch', (f) => f.c.invalidate(), 'target_context_changed'],
  ['binding replacement', (f) => { f.binding.revision++; }, 'binding_changed'],
  ['binding cleared', (f) => { f.binding = null; }, 'binding_changed'],
]) {
  await test(name + ' after selection fails closed', async () => {
    const f = fixture(); const token = await f.select(); change(f);
    blocked(await f.c.review(token), reason); assert.equal(f.writes, 0);
  });
}
for (const [name, change] of [
  ['wrong window', (f) => { f.tab.windowId = 3; }],
  ['wrong tab', (f) => { f.tab.id = 8; }],
  ['wrong URL', (f) => { f.tab.url = 'https://chatgpt.com/c/' + RUN; }],
  ['reloaded document', (f) => { f.document = 'different-document-instance'; }],
  ['discarded', (f) => { f.tab.discarded = true; }],
  ['frozen', (f) => { f.tab.frozen = true; }],
  // `frozen` absent is no longer a refusal on its own: a successful live probe
  // is positive evidence the document is not frozen. It only stays a refusal
  // when the probe did not answer, which is the next case.
  ['unknown frozen with no answer', (f) => { delete f.tab.frozen; f.noContent = true; }],
  ['content unavailable', (f) => { f.noContent = true; }],
  ['probe timeout', (f) => { f.timeout = true; }],
  ['stale probe', (f) => { f.stale = true; }],
  ['closed tab', (f) => { f.noTab = true; }],
]) {
  await test(name + ' keeps target inconsistent and binding untouched', async () => {
    const f = fixture(); change(f); const before = structuredClone(f.binding);
    const r = await f.run(); blocked(r); assert.equal(r.targetConsistent, false);
    assert.deepEqual(f.binding, before); assert.equal(f.writes, 0);
  });
}
for (const [name, change, reason] of [
  ['navigation', (f) => f.c.invalidate(), 'target_context_changed'],
  ['record eviction', (f) => { f.records = []; }, 'record_missing'],
  ['rebind', (f) => { f.binding.revision++; }, 'binding_changed'],
  ['history arrival', (f) => { f.history.push({ kind: 't054-dry-run', runId: RUN,
    status: 'completed', proposalId: 'old', at: NOW }); }, 'duplicate_event'],
]) {
  await test(name + ' during probe is detected', async () => {
    const f = fixture(); f.duringProbe = () => change(f); blocked(await f.run(), reason);
  });
}
await test('concurrent selection replay consumes token before await', async () => {
  const f = fixture(); const token = await f.select();
  const out = await Promise.all([f.c.review(token), f.c.review(token)]);
  assert.equal(out.filter((r) => r.ok).length, 1); assert.equal(f.probes, 1);
  blocked(out[1], 'selection_missing_consumed_or_worker_restarted');
});
await test('worker restart and popup list refresh invalidate tokens', async () => {
  const f = fixture(); const token = await f.select();
  blocked(await createReceivedReview(f.options).review(token), 'selection_missing_consumed_or_worker_restarted');
  await f.c.list(); blocked(await f.c.review(token), 'selection_missing_consumed_or_worker_restarted');
});
await test('in-flight review is invalidated by a newer list', async () => {
  const f = fixture(); f.duringProbe = () => f.c.list(); blocked(await f.run(), 'selection_superseded');
});
for (const kind of ['failRead', 'failSession']) {
  await test(kind + ' fails closed', async () => {
    const f = fixture(); const token = await f.select(); f[kind] = true;
    blocked(await f.c.review(token)); assert.equal(f.writes, 0);
  });
}
await test('corrupt T054 history is not repaired or ignored', async () => {
  const f = fixture(); f.history = ['corrupt']; blocked(await f.run(), 'review_history_unavailable');
  assert.equal(f.writes, 0);
});
await test('strict popup sender and request whitelist reject caller events', async () => {
  const f = fixture(); const runtime = { id: 'extension', getURL: () => 'chrome-extension://extension/popup.html' };
  const sender = { id: runtime.id, url: runtime.getURL() };
  for (const bad of [{}, { ...sender, tab: {} }, { ...sender, id: 'other' }, { ...sender, url: 'https://chatgpt.com/' }]) {
    blocked(await handleReceivedReviewMessage(f.c, { type: 't055-list' }, bad, runtime), 'extension_popup_required');
  }
  for (const extra of ['runId', 'status', 'message', 'source', 'provenance', 'proposalId']) {
    blocked(await handleReceivedReviewMessage(f.c, { type: 't055-review', token: 'x', [extra]: 'trusted' }, sender, runtime), 'request_fields_not_allowed');
  }
  const list = await handleReceivedReviewMessage(f.c, { type: 't055-list' }, sender, runtime);
  blocked(await handleReceivedReviewMessage(f.c, { type: 't055-review', token: list.items[0].token }, sender, runtime), 'provenance_unverified');
});
await test('free text in metadata is redacted without touching message body', async () => {
  const f = fixture(); f.records[0].runId = 'SECRET credential';
  const list = await f.c.list(); assert.ok(!JSON.stringify(list).includes('SECRET'));
  const r = await f.c.review(list.items[0].token); blocked(r, 'record_metadata_invalid');
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.equal(f.probes, 0);
});
for (const boundAt of [undefined, NOW + 1, NOW - RECORD_MAX_AGE_MS - 1]) {
  await test('invalid or expired binding timestamp: ' + boundAt, async () => {
    const f = fixture(); f.binding.boundAt = boundAt;
    blocked(await f.run(), boundAt < NOW ? 'binding_expired' : 'binding_timestamp_invalid');
    assert.equal(f.probes, 0);
  });
}
await test('slow final reads make the probe stale', async () => {
  const f = fixture(); f.options.readDryRunState = async () => {
    f.time += 6000; return { ok: true, history: [] };
  }; f.c = createReceivedReview(f.options);
  const r = await f.run(); blocked(r); assert.equal(r.targetConsistent, false);
});
await test('metadata body is never read by review module', async () => {
  const f = fixture(); const row = { ...f.records[0] };
  Object.defineProperty(row, 'message', { enumerable: true, get() { throw Error('body read'); } });
  f.options.readReceived = async () => [row]; f.c = createReceivedReview(f.options);
  blocked(await f.run(), 'provenance_unverified');
});
await test('integration source keeps T055 off all existing automatic paths', () => {
  const bg = readFileSync('extension/background.js', 'utf8');
  const popup = readFileSync('extension/popup.js', 'utf8');
  const source = readFileSync('extension/lib/received_review.js', 'utf8');
  assert.ok(bg.includes('handleReceivedReviewMessage(')); assert.ok(bg.includes('return true;'));
  assert.ok(!bg.slice(bg.indexOf('chrome.alarms.onAlarm'), bg.indexOf('// Messages from')).includes('receivedReview'));
  for (const bad of ['session.set(', 'local.set(', '.health(', '.run(', 'fetch(', 'connectNative', 'executeScript', 'innerHTML']) assert.ok(!source.includes(bad), bad);
  assert.ok(popup.includes("ask({ type: 't055-review', token })"));
  assert.ok(popup.includes("reviewList.addEventListener('click'"));
});
console.log('RESULT: ' + passed + ' passed, 0 failed');
