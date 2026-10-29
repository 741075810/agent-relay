// Import the actual MV3 worker with a fake API. Never start a real browser/Host.
import assert from 'node:assert/strict';
const listeners = {};
const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
let writes = 0;
let hostCalls = 0;
let probes = 0;
globalThis.chrome = {
  runtime: { id: 'fixture', getURL: (path) => 'chrome-extension://fixture/' + path,
    onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
    connectNative() { hostCalls++; throw Error('Host forbidden'); } },
  tabs: { onUpdated: event('updated'), onRemoved: event('removed'),
    onReplaced: event('replaced'), onDetached: event('detached'), onAttached: event('attached'),
    onActivated: event('activated'),
    async get() { probes++; throw Error('no binding'); },
    async sendMessage() { probes++; throw Error('no binding'); } },
  windows: { onFocusChanged: event('focus') },
  alarms: { onAlarm: event('alarm'), create() { throw Error('alarm forbidden'); } },
  storage: {
    local: { async get(defaults) { return { ...defaults, received: [] }; },
      async set() { writes++; throw Error('write forbidden'); } },
    session: { async get(defaults) { return defaults; },
      async set() { writes++; throw Error('write forbidden'); } },
  },
};
await import('./extension/background.js');
assert.equal(hostCalls, 0); assert.equal(probes, 0); assert.equal(writes, 0);
const sender = { id: 'fixture', url: chrome.runtime.getURL('popup.html') };
async function request(msg, from = sender) {
  let count = 0;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('async response missing')), 1000);
    const kept = listeners.message[0](msg, from, (value) => {
      count++; clearTimeout(timer); resolve(value);
    });
    assert.equal(kept, true);
  });
  assert.equal(count, 1); return reply.result;
}
let passed = 0;
for (const [msg, from, reason] of [
  [{ type: 't055-list' }, sender, null],
  [{ type: 't055-list', source: 'verified' }, sender, 'request_fields_not_allowed'],
  [{ type: 't055-review', token: 'fake', runId: 'custom' }, sender, 'request_fields_not_allowed'],
  [{ type: 't055-review', token: 'fake' }, sender, 'selection_missing_consumed_or_worker_restarted'],
  [{ type: 't055-list' }, { ...sender, tab: { id: 7 } }, 'extension_popup_required'],
  [{ type: 't055-list' }, { ...sender, url: 'https://chatgpt.com/' }, 'extension_popup_required'],
  [{ type: 't055-unknown' }, sender, 'unknown_t055_request'],
]) {
  const r = await request(msg, from);
  if (reason) assert.ok(r.reasons.includes(reason)); else assert.deepEqual(r.items, []);
  assert.equal(r.sendEligible, false); passed++;
}
for (const name of ['activated', 'focus', 'removed', 'replaced', 'detached', 'attached']) {
  // The last listener is T053 for lifecycle events; exercise only T055's first.
  listeners[name][0](7); passed++;
}
assert.equal(hostCalls, 0); assert.equal(writes, 0); assert.equal(probes, 0);
console.log('RESULT: ' + passed + ' passed, 0 failed');
