// A chrome.* stand-in that keeps its listeners, so the hooks a real Chrome fires can actually be fired by a test.
//
// Copied from test_t095b75_reload_alarm.mjs rather than shared with it: that suite is passing and its assertions are
// about the terminal alarm only, and rewriting a passing suite to serve a second one is how a green test starts testing
// the wrong thing. What is reused here is the *behaviour* of the mock, not the file.
//
// `connectNative` records the call and then throws: every suite that uses this mock is asserting that a path either
// does contact the host (recorded) or must not (the throw is the failure signal), so recording beats pretending to be a
// port.

export const POLL_ALARM = 'dsh-notify-poll';
export const RETRY_ALARM = 'dsh-notify-retry';
export const TERMINAL_ALARM = 'dsh-terminal-trigger';

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function registry() {
  const listeners = [];
  return {
    listeners,
    api: {
      addListener(fn) { listeners.push(fn); },
      removeListener() {},
      hasListener() { return listeners.length > 0; },
    },
    async fire(...args) {
      const results = [];
      for (const fn of listeners) results.push(await fn(...args));
      return results;
    },
  };
}

export function createChrome(options) {
  const opts = options || {};
  const stores = { local: new Map(), session: new Map() };
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) out[k] = map.has(k) ? clone(map.get(k)) : v;
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v));
    },
    async remove(key) { map.delete(key); },
  });

  const alarmTable = new Map();
  const createCalls = [];
  const clearCalls = [];
  const hostCalls = [];
  const tabMessages = [];
  const onInstalled = registry();
  const onStartup = registry();
  const onMessage = registry();
  const onAlarm = registry();

  const api = {
    runtime: {
      id: 'chrome-mock-extension',
      getURL: (p) => 'chrome-extension://chrome-mock-extension/' + p,
      connectNative(name) {
        hostCalls.push(name);
        throw new Error('connectNative: this mock records the call and does not provide a port');
      },
      lastError: undefined,
      onInstalled: onInstalled.api,
      onStartup: onStartup.api,
      onMessage: onMessage.api,
      onSuspend: registry().api,
    },
    storage: { local: area(stores.local), session: area(stores.session) },
    alarms: {
      onAlarm: onAlarm.api,
      async get(name) {
        const found = alarmTable.get(name);
        return found ? Object.assign({ name }, clone(found)) : undefined;
      },
      create(name, info) {
        createCalls.push({ name, info: clone(info) });
        alarmTable.set(name, clone(info));
      },
      async clear(name) {
        clearCalls.push(name);
        return alarmTable.delete(name);
      },
    },
    tabs: {
      async get() { return undefined; },
      async query() { return []; },
      async sendMessage(tabId, msg) { tabMessages.push({ tabId, msg }); },
      onActivated: registry().api, onUpdated: registry().api,
      onRemoved: registry().api, onReplaced: registry().api,
      onDetached: registry().api, onAttached: registry().api,
    },
    windows: { onFocusChanged: registry().api },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { async contains() { return false; } },
    scripting: { async executeScript() { return []; } },
  };

  return {
    api, stores, alarmTable, createCalls, clearCalls, hostCalls, tabMessages,
    onInstalled, onStartup, onMessage, onAlarm,
  };
}

export async function flush(times) {
  const n = times || 4;
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

export function checkFactory() {
  let passed = 0;
  let failed = 0;
  return {
    check(cond, label) {
      if (cond) { passed += 1; console.log('  PASS  ' + label); } else { failed += 1; console.log('  FAIL  ' + label); }
    },
    section(title) { console.log('== ' + title); },
    summary() { return { passed, failed }; },
  };
}
