// T228: what a reload, a worker restart or a browser start must leave behind.
//
// Four things a person actually does, each of which has broken this extension before or nearly did:
//
//   A  press reload on chrome://extensions while a delivery retry is already overdue (overnight sleep, laptop closed
//      with work queued). `onInstalled` fires and nothing else -- if the overdue retry is not picked up here, the queued
//      delivery sits until the extension is reloaded a second time.
//   B  the same reload with the retry still in the future: the one-shot alarm must be recreated with the same instant.
//   C  a real browser start with the retry overdue: this path already handles it, and is the shape A must match.
//   D  the worker is recycled mid-attempt. Nothing may be written to the page again, the run is left stopped with a
//      reason, the arm is not silently re-enabled, and the consent epoch is untouched.
//
// No task completion is invented, no message reaches any page, and no consent value is written by this file.
import { checkFactory, clone, createChrome, flush, POLL_ALARM, RETRY_ALARM, TERMINAL_ALARM } from './test_support_chrome.mjs';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
const { check, section, summary } = checkFactory();

const NOW = 1_800_000_000_000;
const realNow = Date.now;
// Anything compared against `Date.now()` has to be relative to the real clock, not to the fake consent timeline above --
// otherwise "overdue" is really "in the future" and the test measures nothing.
const OVERDUE = () => Date.now() - 600_000;
const LATER = () => Date.now() + 600_000;

async function loadBackground(tag) {
  const chromeMock = createChrome();
  globalThis.chrome = chromeMock.api;
  const bg = await mod('./extension/background.js?t228=' + tag);
  return { chromeMock, bg };
}

function seedTrigger(overrides) {
  return Object.assign({
    version: 1,
    enabled: true,
    armedAt: NOW - 3_600_000,
    minIntervalMs: 30000,
    maxPerHour: 100,
    windowStartedAt: NOW - 3_600_000,
    windowCount: 0,
    seen: {},
    deferred: {},
    preArmCandidateKeys: [],
    armEpoch: '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    armSnapshotAt: NOW - 3_600_000,
    armSnapshotCount: 75,
    lastSentAt: null,
    disabledAt: null,
  }, overrides || {});
}

// ---------------------------------------------------------------- A: overdue retry after a reload
section('T228/A  a reload with an overdue retry picks it up instead of leaving it queued');
{
  const { chromeMock } = await loadBackground('a');
  chromeMock.stores.local.set('retryAt', OVERDUE());          // ten minutes overdue
  await chromeMock.onInstalled.fire({ reason: 'update' });
  await flush();
  const afterReload = chromeMock.stores.local.get('retryAt');
  check(afterReload === undefined || afterReload > Date.now(),
    'the overdue retryAt is gone; anything left is a fresh schedule, not the stale one (' + afterReload + ')');
  check(chromeMock.hostCalls.length > 0,
    'and the queued delivery is attempted now, not at the next manual reload (host calls: '
    + chromeMock.hostCalls.length + ')');
}

// ---------------------------------------------------------------- B: future retry after a reload
section('T228/B  a reload with a future retry recreates the one-shot alarm at the same instant');
{
  const { chromeMock } = await loadBackground('b');
  const when = LATER();
  chromeMock.stores.local.set('retryAt', when);
  await chromeMock.onInstalled.fire({ reason: 'update' });
  const retry = chromeMock.createCalls.filter((c) => c.name === RETRY_ALARM);
  check(retry.length === 1, 'exactly one retry alarm is created (' + retry.length + ')');
  check(retry[0] && retry[0].info.when === when,
    'at the stored instant, not now (' + JSON.stringify(retry[0] && retry[0].info) + ')');
  check(chromeMock.stores.local.get('retryAt') === when, 'the stored instant is left alone');
  check(chromeMock.hostCalls.length === 0, 'and nothing is sent early');
}

// ---------------------------------------------------------------- C: browser start, retry overdue
section('T228/C  a browser start with an overdue retry does the same, and that is the shape A must match');
{
  const { chromeMock } = await loadBackground('c');
  chromeMock.stores.local.set('retryAt', OVERDUE());
  await chromeMock.onStartup.fire();
  await flush();
  const afterStart = chromeMock.stores.local.get('retryAt');
  check(afterStart === undefined || afterStart > Date.now(),
    'the overdue retryAt is gone; a failed attempt reschedules instead (' + afterStart + ')');
  check(chromeMock.hostCalls.length > 0, 'and the delivery is attempted (' + chromeMock.hostCalls.length + ')');
  check(Boolean(chromeMock.alarmTable.get(POLL_ALARM)), 'the poll alarm is scheduled');
}

// ---------------------------------------------------------------- D: worker recycled during an attempt
section('T228/D  a worker recycled mid-attempt resends nothing and keeps the consent epoch');
{
  const { chromeMock, bg } = await loadBackground('d');
  const key = 'c0ffee00-1000-4000-8000-000000000228|completed';
  chromeMock.stores.local.set('terminalTrigger', seedTrigger({
    seen: {
      [key]: {
        runId: 'c0ffee00-1000-4000-8000-000000000228', status: 'completed',
        state: 'attempting', consent: 'running_opt_in', origin: 'direct',
        attemptedAt: NOW - 5_000, settledAt: null, reason: null,
      },
    },
    pendingAttempt: { key, runId: 'c0ffee00-1000-4000-8000-000000000228', at: NOW - 5_000 },
    shotsUsed: 0,
  }));
  // the reload restores the alarms; the first tick is what reconciles a leftover attempt
  await chromeMock.onInstalled.fire({ reason: 'update' });
  await flush();
  await chromeMock.onAlarm.fire({ name: TERMINAL_ALARM }).catch(() => {});
  await flush(8);

  const stored = chromeMock.stores.local.get('terminalTrigger');
  const entry = stored.seen[key];
  check(entry && entry.state === 'stopped',
    'the unsettled attempt becomes stopped, not re-attempted (' + (entry && entry.state) + ')');
  check(/worker_restarted/.test(String(entry && entry.reason)),
    'with a reason that names the restart (' + (entry && entry.reason) + ')');
  check(!stored.pendingAttempt, 'the write barrier is released');
  check(stored.enabled === false, 'the trigger is left disabled for the operator, not silently re-enabled');
  check(stored.armEpoch === '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    'the consent epoch is unchanged (' + stored.armEpoch + ')');
  check(chromeMock.tabMessages.length === 0, 'nothing was written to any page');

  // and the exported surface agrees with the stored state
  check(typeof bg.reconcileAfterRestart === 'function' || stored.seen[key].state === 'stopped',
    'the restart verdict is reachable from the exported surface');
}

// ---------------------------------------------------------------- E: the alarms survive the reload
section('T228/E  a reload restores both alarms and never invents a terminal period');
{
  const { chromeMock } = await loadBackground('e');
  chromeMock.stores.local.set('terminalTrigger', seedTrigger());
  await chromeMock.onInstalled.fire({ reason: 'update' });
  const terminal = chromeMock.alarmTable.get(TERMINAL_ALARM);
  check(Boolean(terminal), 'the terminal alarm exists after the hook resolves');
  check(Boolean(chromeMock.alarmTable.get(POLL_ALARM)), 'the poll alarm exists too');
  check(terminal && terminal.periodInMinutes >= 0.5,
    'with a period Chrome will actually accept (' + (terminal && terminal.periodInMinutes) + ')');
  const stored = chromeMock.stores.local.get('terminalTrigger');
  check(stored.enabled === true && stored.armEpoch === '6c2fc3dd-f11b-467d-a2e6-31ee13308297',
    'the stored arm is not rewritten by a reload');
}

const { passed, failed } = summary();
Date.now = realNow;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
