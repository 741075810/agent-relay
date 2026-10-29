// T095B75: a reload must not leave the terminal trigger asleep.
//
// The failure this locks down, diagnosed twice from file mtimes: pressing reload on
// chrome://extensions fires `onInstalled` and nothing else. `onStartup` is reserved for a
// real browser start. So the alarm table came back empty while `terminalTrigger.enabled`
// was still `true` -- the trigger never ticked, sent nothing, logged nothing, and the
// popup went on reporting the period it *would* have used.
//
// What is asserted here is not only "the alarm comes back". It is that restoring it is
// narrow: it never enables a disabled trigger, never re-arms, never writes consent,
// candidates, the journal or the binding, never contacts the host, never sends, and does
// not reset a timer that is already correct.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

const POLL = 'dsh-notify-poll';
const TERMINAL = 'dsh-terminal-trigger';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function section(title) { console.log('== ' + title); }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// A listener registry that actually keeps the callbacks. Every other suite in this
// repository discards them, which is why the reload path was never executed by a test.
function registry() {
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

function createChrome(options) {
  const opts = options || {};
  const stores = { local: new Map(), session: new Map() };
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = map.has(k) ? clone(map.get(k)) : v;
      }
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
  let getDelayTicks = 0;
  const onInstalled = registry();
  const onStartup = registry();
  const onMessage = registry();
  const onAlarm = registry();

  const delay = async () => {
    if (!getDelayTicks) return;
    for (let i = 0; i < getDelayTicks; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  const api = {
    runtime: {
      id: 't095b75-extension',
      getURL: (p) => 'chrome-extension://t095b75-extension/' + p,
      // Recording rather than stub-living: the whole point of this suite is that the
      // restore path is host-free, so any contact is a failure and has to be visible.
      connectNative(name) {
        hostCalls.push(name);
        throw new Error('the restore path must not connect to the native host');
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
        if (opts.alarmGetThrowsFor && name === opts.alarmGetThrowsFor) {
          throw new Error('alarms.get failed for ' + name);
        }
        await delay();
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
  };

  return {
    api, stores, alarmTable, createCalls, clearCalls, hostCalls, tabMessages,
    onInstalled, onStartup, onMessage, onAlarm,
    setAlarmGetDelay(ticks) { getDelayTicks = ticks; },
    terminalAlarm() { return alarmTable.get(TERMINAL); },
    terminalCreates() { return createCalls.filter((c) => c.name === TERMINAL); },
    // The real listener returns `true` and calls `sendResponse` from an async IIFE, so
    // awaiting its return value would resolve before the reply exists. Wait for the
    // callback itself, with a timeout that reports rather than hangs.
    dispatch(msg) {
      return new Promise((resolve) => {
        const listeners = onMessage.listeners;
        if (!listeners.length) { resolve(undefined); return; }
        let settled = false;
        const finish = (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(reply);
        };
        const timer = setTimeout(() => finish(undefined), 10000);
        const ret = listeners[listeners.length - 1](msg, {
          id: 't095b75-extension',
          url: 'chrome-extension://t095b75-extension/popup.html',
        }, finish);
        if (ret !== true) finish(undefined);
      });
    },
  };
}

// Let queued microtasks and timers settle, for the paths that are deliberately not
// awaited (onStartup is a plain listener and cannot be).
async function flush(times) {
  const n = times || 3;
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function loadBackground(tag) {
  const dir = mkdtempSync(join(tmpdir(), 't095b75-' + tag + '-'));
  const chromeMock = createChrome();
  globalThis.chrome = chromeMock.api;
  const bg = await mod('./extension/background.js?reload=' + tag);
  return { chromeMock, bg, dir };
}

// A trigger record matching what a live install actually holds: enabled, armed, with a
// real epoch, a pre-arm snapshot, a journal and deferrals. Every field matters -- the
// test asserts they survive untouched.
function seededTrigger(overrides) {
  return Object.assign({
    version: 1,
    enabled: true,
    armedAt: 1793281377962,
    minIntervalMs: 30000,
    maxPerHour: 100,
    windowStartedAt: 1793281377962,
    windowCount: 0,
    seen: {
      'c0ffee00-1000-4000-8000-000000000160|completed': {
        runId: 'c0ffee00-1000-4000-8000-000000000160',
        status: 'completed', state: 'sent', consent: 'running_opt_in',
        origin: 'direct', reason: null,
        attemptedAt: 1793285000000, settledAt: 1793285001000,
      },
    },
    deferred: {
      '631a454d-6cdc-4f60-8a7d-000000000001|completed': {
        reason: 'target_not_visible_and_focused',
        retryAt: 1793000000000, attempts: 2,
      },
    },
    preArmCandidateKeys: ['aaaa0000-4000-8001-8001-000000000001|completed'],
    armEpoch: '6fb833d4-3430-4a05-a467-1d4fafa62083',
    armSnapshotAt: 1793281378,
    armSnapshotCount: 200,
    lastSentAt: 1793280755136,
    disabledAt: 1793098909775,
  }, overrides || {});
}

function seededCandidates() {
  return [{
    runId: 'c0ffee00-1000-4000-8000-000000000160', status: 'completed',
    origin: 'direct', nativeSession: 'session-11111111-1111-4111-8111-111111111111',
    nativeTurn: 160, startedAt: 1793284599, endedAtMs: 1793285836408,
    endedAt: 1793285836, postArm: true,
  }];
}

function seededOptIns() {
  return {
    version: 1,
    entries: {
      'session-11111111-1111-4111-8111-111111111111|160': {
        sessionId: 'session-11111111-1111-4111-8111-111111111111', turn: 160,
        armedAt: 1793284624555, consumedAt: null, settledAs: null, source: 'popup',
      },
    },
  };
}

function seededAutosend() {
  return {
    version: 1, enabled: true, armedAt: 1793281373994, expiresAt: 1793886173994,
    conversationId: 'c0ffee00-2000-4000-8000-000000000053',
    documentInstanceId: '6279d93a-d538-46d8-8b57-c316e555af42',
    bindingRevision: 1, deliveryMode: 'background', maxSends: 1000, sentCount: 0,
    journal: {}, lastError: null,
  };
}

function seedFullWorld(chromeMock) {
  chromeMock.stores.local.set('terminalTrigger', seededTrigger());
  chromeMock.stores.local.set('terminalCandidates', seededCandidates());
  chromeMock.stores.local.set('terminalOptIns', seededOptIns());
  chromeMock.stores.local.set('autosend', seededAutosend());
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: 1,
    binding: {
      conversationId: 'c0ffee00-2000-4000-8000-000000000053',
      documentInstanceId: '6279d93a-d538-46d8-8b57-c316e555af42',
      manuallyConfirmed: true, tabId: 7, windowId: 3,
    },
    candidates: [], candidateScannedAt: null,
  });
}

function snapshotStores(chromeMock) {
  const dump = {};
  for (const [name, map] of Object.entries(chromeMock.stores)) {
    const out = {};
    for (const [k, v] of map.entries()) out[k] = clone(v);
    dump[name] = out;
  }
  return dump;
}

function diffStores(before, after) {
  const changed = [];
  for (const areaName of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[areaName] || {};
    const b = after[areaName] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        changed.push(areaName + '.' + key);
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------- tests
section('T095B75/A  a reload restores the terminal alarm, before the hook returns');
{
  const { chromeMock } = await loadBackground('a');
  seedFullWorld(chromeMock);
  chromeMock.setAlarmGetDelay(4);          // the await has to actually be awaited
  check(chromeMock.terminalAlarm() === undefined, 'the alarm table starts empty');

  await chromeMock.onInstalled.fire({ reason: 'update' });

  const term = chromeMock.terminalAlarm();
  check(Boolean(term), 'the terminal alarm exists the moment the hook resolves');
  check(term && term.periodInMinutes === 0.5,
    'with the configured 30s period, not a hardcoded one ('
    + JSON.stringify(term && term.periodInMinutes) + ')');
  check(Boolean(chromeMock.alarmTable.get(POLL)), 'and the queue poller is scheduled too');
  check(chromeMock.terminalCreates().length === 1,
    'the terminal alarm was created exactly once ('
    + chromeMock.terminalCreates().length + ')');
}

section('T095B75/B  a browser start restores it too');
{
  const { chromeMock } = await loadBackground('b');
  seedFullWorld(chromeMock);
  await chromeMock.onStartup.fire();
  await flush(4);
  const term = chromeMock.terminalAlarm();
  check(Boolean(term), 'onStartup also schedules the terminal alarm');
  check(term && term.periodInMinutes === 0.5, 'at 0.5 minutes');
}

section('T095B75/C  no authorization means no alarm, and no throw');
{
  const { chromeMock } = await loadBackground('c');
  // Nothing seeded: this is a fresh profile that has never armed anything.
  let threw = null;
  try {
    await chromeMock.onInstalled.fire({ reason: 'install' });
  } catch (err) { threw = err; }
  check(threw === null, 'the install hook completes without throwing ('
    + (threw && threw.message) + ')');
  check(chromeMock.terminalAlarm() === undefined,
    'no terminal alarm is created without an authorization');
  check(Boolean(chromeMock.alarmTable.get(POLL)),
    'the queue poller is still scheduled, as before the fix');
  check(chromeMock.terminalCreates().length === 0,
    'and the trigger alarm was never even attempted');
}

section('T095B75/D  a disabled trigger is never switched back on');
{
  const { chromeMock } = await loadBackground('d');
  const disabled = seededTrigger({ enabled: false, disabledAt: 1793098909775 });
  chromeMock.stores.local.set('terminalTrigger', disabled);
  chromeMock.stores.local.set('terminalCandidates', seededCandidates());

  await chromeMock.onInstalled.fire({ reason: 'update' });
  await chromeMock.onInstalled.fire({ reason: 'update' });

  const after = chromeMock.stores.local.get('terminalTrigger');
  check(after.enabled === false, 'enabled is still false after two restores');
  check(after.disabledAt === disabled.disabledAt,
    'and disabledAt is untouched (' + after.disabledAt + ')');
  check(chromeMock.terminalAlarm() === undefined,
    'no alarm was scheduled for a disabled trigger');
  check(chromeMock.terminalCreates().length === 0,
    'and none was attempted');
  check(JSON.stringify(after) === JSON.stringify(disabled),
    'the whole trigger record is byte-identical');
}

section('T095B75/E  repeated initialization is idempotent');
{
  const { chromeMock } = await loadBackground('e');
  seedFullWorld(chromeMock);
  await chromeMock.onInstalled.fire({ reason: 'update' });
  const firstPeriod = chromeMock.terminalAlarm()
    && chromeMock.terminalAlarm().periodInMinutes;

  await chromeMock.onInstalled.fire({ reason: 'update' });
  await chromeMock.onInstalled.fire({ reason: 'update' });
  await chromeMock.onStartup.fire();
  await flush(4);

  check(chromeMock.terminalCreates().length === 1,
    'four wake-ups produce exactly one create (' + chromeMock.terminalCreates().length
    + ') -- re-creating would reset the timer and starve the tick');
  check(chromeMock.terminalAlarm() && chromeMock.terminalAlarm().periodInMinutes
    === firstPeriod,
    'and the period never drifts (' + (chromeMock.terminalAlarm()
      && chromeMock.terminalAlarm().periodInMinutes) + ')');
}

section('T095B75/F  a correct timer already in the table is left alone');
{
  const { chromeMock } = await loadBackground('f');
  seedFullWorld(chromeMock);
  chromeMock.alarmTable.set(TERMINAL, { periodInMinutes: 0.5 });
  await chromeMock.onInstalled.fire({ reason: 'update' });
  check(chromeMock.terminalCreates().length === 0,
    'nothing was re-created for an alarm that already matched ('
    + chromeMock.terminalCreates().length + ')');
  check(chromeMock.terminalAlarm() && chromeMock.terminalAlarm().periodInMinutes === 0.5,
    'and it still runs every 0.5');
}

section('T095B75/G  the restored period follows the stored interval');
{
  const { chromeMock } = await loadBackground('g');
  seedFullWorld(chromeMock);
  chromeMock.stores.local.set('terminalTrigger',
    seededTrigger({ minIntervalMs: 120000 }));
  await chromeMock.onInstalled.fire({ reason: 'update' });
  const term = chromeMock.terminalAlarm();
  check(term && term.periodInMinutes === 2,
    'a two-minute interval restores a two-minute alarm ('
    + JSON.stringify(term && term.periodInMinutes) + ')');
}

section('T095B75/H  the restore writes nothing but its own note');
{
  const { chromeMock } = await loadBackground('h');
  seedFullWorld(chromeMock);
  const before = snapshotStores(chromeMock);
  await chromeMock.onInstalled.fire({ reason: 'update' });
  const after = snapshotStores(chromeMock);
  const changed = diffStores(before, after);

  check(changed.length === 1 && changed[0] === 'local.notes',
    'the only storage key that changes is `notes` (' + JSON.stringify(changed) + ')');

  const trigger = chromeMock.stores.local.get('terminalTrigger');
  check(JSON.stringify(trigger) === JSON.stringify(before.local.terminalTrigger),
    'the trigger record -- armedAt, armEpoch, preArmCandidateKeys, seen, deferred -- '
    + 'is byte-identical');
  check(trigger.enabled === true && trigger.armedAt === 1793281377962,
    'authorization is neither refreshed nor re-armed');
  check(JSON.stringify(chromeMock.stores.local.get('terminalCandidates'))
    === JSON.stringify(before.local.terminalCandidates),
    'the candidate list is byte-identical: nothing evicted, nothing consumed');
  check(JSON.stringify(chromeMock.stores.local.get('terminalOptIns'))
    === JSON.stringify(before.local.terminalOptIns),
    'the consent store is byte-identical: no opt-in spent or created');
  check(JSON.stringify(chromeMock.stores.local.get('autosend'))
    === JSON.stringify(before.local.autosend),
    'the T058/T059 grant is byte-identical');
  check(JSON.stringify(chromeMock.stores.session.get('t053TargetBindingState'))
    === JSON.stringify(before.session.t053TargetBindingState),
    'the T053 binding is byte-identical');

  const notes = chromeMock.stores.local.get('notes');
  check(notes.length === 1 && notes[0].kind === 'installed',
    'and the one new note is the ordinary install marker ('
    + JSON.stringify(notes.map((n) => n.kind)) + ')');
}

section('T095B75/I  the restore never contacts the host and never sends');
{
  const { chromeMock } = await loadBackground('i');
  seedFullWorld(chromeMock);
  await chromeMock.onInstalled.fire({ reason: 'update' });
  await chromeMock.onStartup.fire();
  await flush(4);
  check(chromeMock.hostCalls.length === 0,
    'connectNative was never called (' + JSON.stringify(chromeMock.hostCalls) + ')'
    + ' -- restoring a timer must not need the native host');
  check(chromeMock.tabMessages.length === 0,
    'no tab was messaged (' + chromeMock.tabMessages.length + ')');
  const notes = chromeMock.stores.local.get('notes') || [];
  check(!notes.some((n) => n.kind === 'terminal-alarm-restore-failed'),
    'and no restore failure was recorded');
}

section('T095B75/J  a restore failure is recorded, not silently swallowed');
{
  const { chromeMock } = await loadBackground('j');
  seedFullWorld(chromeMock);
  // The queue poller is unaffected: only the trigger's own table read fails.
  const broken = createChrome({ alarmGetThrowsFor: TERMINAL });
  globalThis.chrome = broken.api;
  const bg = await mod('./extension/background.js?reload=j2');
  broken.stores.local.set('terminalTrigger', seededTrigger());
  let threw = null;
  try {
    await broken.onInstalled.fire({ reason: 'update' });
  } catch (err) { threw = err; }
  check(threw === null, 'the install hook still completes (' + (threw && threw.message) + ')');
  const notes = broken.stores.local.get('notes') || [];
  check(notes.some((n) => n.kind === 'terminal-alarm-restore-failed'),
    'a `terminal-alarm-restore-failed` note is written ('
    + JSON.stringify(notes.map((n) => n.kind)) + ')');
  check(notes.some((n) => n.kind === 'installed'),
    'and the ordinary install marker is still written');
  check(Boolean(broken.alarmTable.get(POLL)),
    'the queue poller is still scheduled despite the trigger failing');
  check(bg && typeof bg.syncTerminalAlarm === 'function', 'the module loaded');
}

section('T095B75/K  the popup can tell a real timer from an intended one');
{
  const { chromeMock } = await loadBackground('k');
  seedFullWorld(chromeMock);

  // (i) armed, but nothing scheduled -- the state a reload used to leave behind.
  const dormant = await chromeMock.dispatch({ type: 't059-trigger-state' });
  check(dormant && dormant.ok === true, 'the state request answers');
  check(dormant.alarm === null,
    'the reported alarm is null, not the intended period (' + dormant.alarm + ')');
  check(dormant.alarmExpected === 0.5,
    'and the intended period is reported separately (' + dormant.alarmExpected + ')');

  // (ii) actually scheduled.
  chromeMock.alarmTable.set(TERMINAL, { periodInMinutes: 0.5 });
  const live = await chromeMock.dispatch({ type: 't059-trigger-state' });
  check(live.alarm === 0.5, 'with a real timer it reports the observed 0.5 (' + live.alarm + ')');
  check(live.alarmExpected === 0.5, 'and still names the intent');

  // (iii) disabled: there is no intended period to report either.
  chromeMock.stores.local.set('terminalTrigger', seededTrigger({ enabled: false }));
  const off = await chromeMock.dispatch({ type: 't059-trigger-state' });
  check(off.alarmExpected === null,
    'a disabled trigger reports no intended period (' + off.alarmExpected + ')');

  // (iv) the source distinguishes the states in words a person can act on.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('./extension/popup.js', ROOT), 'utf8'));
  check(/定时器状态：未调度/.test(src), 'the popup names the dormant state');
  check(/调度周期：每 ' \+ alarm \+ ' 分钟检查一次/.test(src),
    'and still shows the real period when there is one');
  check(/无法读取/.test(src), 'and separates "cannot read" from "not there"');
}

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);


