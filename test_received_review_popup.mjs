import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('extension/popup.html', 'utf8');
const source = readFileSync('extension/popup.js', 'utf8');
class Element {
  constructor() { this.textContent = ''; this.value = ''; this.disabled = false; this.handlers = {}; this.children = []; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  replaceChildren(...items) { this.children = items; this.value = ''; }
  appendChild(item) { this.children.push(item); }
  add(item) { this.children.push(item); }
}
const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
const calls = [];
let listFailure = false;
const item = { token: 'opaque-server-token', eventId: 'event-1', runId: 'stored-run',
  status: 'interrupted', origin: 'bridge', createdAt: '2026-01-01T00:00:00Z', receivedAt: '2026-01-02T00:00:00Z',
  reasons: ['provenance_unverified', 'original_terminal_status_lost'] };
const context = {
  document: { getElementById(id) { assert.ok(elements.has(id), 'missing HTML id ' + id); return elements.get(id); },
    createElement() { return new Element(); } },
  Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
  chrome: { storage: { local: { async get(defaults) { return defaults; } } },
    runtime: { sendMessage(msg, done) {
      calls.push(msg);
      if (msg.type === 't053-binding-state') return done({ ok: true, result: { ok: true, binding: null } });
      if (msg.type === 't054-state') return done({ ok: true, result: { ok: true, history: [] } });
      // T058/T059: the popup reads these at startup. Both report "not armed",
      // which is the default, so this fixture changes nothing about the T055
      // assertions below.
      if (msg.type === 't058-state') return done({ ok: true, result: null });
      if (msg.type === 't059-trigger-state') return done({ ok: true, result: null, candidates: 0 });
      // T067: the popup also reads the per-task opt-in surface at startup. This
      // fixture answers "no channel source, nothing waiting" -- the state a machine
      // with no bridge database produces -- and it changes nothing about the T055
      // assertions below, which are about received-review, not about what a
      // terminal run gets sent.
      if (msg.type === 't067-direct-state') return done({ ok: true, result: {
        originSource: null, originStale: false, ttlMs: 1800000,
        counts: { total: 0, bridge: 0, waiting: 0, armed: 0, expired: 0,
          missingOrigin: 0 }, direct: [] } });
      // T068: the popup now asks the host what is running as soon as it opens, so the
      // operator can decide before the task ends. Answer it here with "nothing is
      // running" -- this suite is about received-review, and the running panel must
      // not be the thing it accidentally measures.
      if (msg.type === 't068-running-state') return done({ ok: true, result: {
        ok: true, code: null, error: null, nothingRunning: true, ledgerOk: true,
        nativeOk: true, bridgeRunning: 0, stale: 0, triggerEnabled: false,
        rows: [], counts: { running: 0, optedIn: 0 } } });
      if (msg.type === 't055-list') return done(listFailure ? { ok: false, error: 'offline' }
        : { ok: true, result: { ok: true, items: [item] } });      if (msg.type === 't055-review') return done({ ok: true, result: { ok: true,
        provenance: 'unverified', reasons: item.reasons, sendEligible: false,
        wouldSend: false, pageWriteEligible: false, historyRecorded: false,
        accountIdentity: 'unverified', deliveryReceipt: 'unsupported', targetConsistent: false } });
      throw Error('unexpected message ' + msg.type);
    } } },
};
vm.runInNewContext(source, context);
await new Promise((resolve) => setImmediate(resolve));
assert.ok(calls.every((msg) => !msg.type.startsWith('t055')));
const get = (id) => elements.get('receivedReview' + id);
await get('List').handlers.click();
assert.equal(calls.at(-1).type, 't055-list');
assert.equal(get('Evaluate').disabled, true);
get('Choice').value = item.token;
get('Choice').handlers.change();
assert.equal(get('Evaluate').disabled, false);
assert.ok(get('Metadata').textContent.includes('interrupted'));
assert.ok(get('Metadata').textContent.includes('非结束'));
assert.ok(get('Metadata').textContent.includes('provenance=unverified'));
await get('Evaluate').handlers.click();
assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({ type: 't055-review', token: item.token }));
assert.ok(get('Result').textContent.includes('可信真实提案: 已阻止'));
assert.ok(get('Result').textContent.includes('wouldSend=false'));
assert.equal(get('Evaluate').disabled, true);
const count = calls.length;
await get('Evaluate').handlers.click();
assert.equal(calls.length, count);
listFailure = true;
await get('List').handlers.click();
assert.ok(get('Metadata').textContent.includes('offline'));
assert.equal(get('Evaluate').disabled, true);
assert.equal(get('Choice').disabled, true);
console.log('RESULT: popup startup/list/select/token-only/replay/failure flow passed');
