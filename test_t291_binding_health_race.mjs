// Hermetic regressions: real controller/probe/policy, cloned in-memory Chrome APIs.
// No browser, network, native host, production state, terminal event or send call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetBindingController, TARGET_BINDING_SESSION_KEY as KEY }
  from './extension/lib/target_binding_controller.js';
import { createBindingRecord, bindingConfirmation, bindingClearConfirmation }
  from './extension/lib/target_binding.js';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
// Parser fixture only; this address is never contacted.
const TARGET_URL = 'https://chatgpt.com/c/' + CONVERSATION;
const OLD = 'document-instance-synthetic-old';
const NEW = 'document-instance-synthetic-new';
const copy = value => structuredClone(value);
function gate() {
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { entered, enter, wait, release };
}
function fixture() {
  let clock = 1000, documentId = OLD, token = 0;
  let nextProbe = null, nextRead = null, nextWrite = null;
  const snapshot = () => ({ status: 'background_observable', tabId: 7, windowId: 2,
    url: TARGET_URL, conversationId: CONVERSATION, documentInstanceId: documentId,
    discarded: false, frozen: false, frozenStateKnown: true, active: false,
    visibilityState: 'hidden', hasFocus: false, composerPresent: true,
    pageLoaded: true, routeStable: true, observedAt: clock });
  let state = { version: 1, revision: 1, candidates: [], candidateScannedAt: null,
    binding: createBindingRecord(snapshot(), clock, 1).binding };
  const calls = { sets: 0, probes: 0 };
  const tab = () => ({ id: 7, windowId: 2, url: TARGET_URL,
    active: false, discarded: false, frozen: false });
  const api = {
    session: {
      get: async defaults => {
        assert.deepEqual(Object.keys(defaults), [KEY]);
        const result = { [KEY]: copy(state) };
        if (nextRead) {
          const held = nextRead; nextRead = null;
          held.enter(); await held.wait;
        }
        return result;
      },
      set: async values => {
        assert.deepEqual(Object.keys(values), [KEY]);
        calls.sets++;
        if (nextWrite) {
          const held = nextWrite; nextWrite = null;
          held.enter(); await held.wait;
        }
        state = copy(values[KEY]);
      },
    },
    tabs: {
      query: async () => [tab()],
      get: async id => { assert.equal(id, 7); return tab(); },
      sendMessage: async (id, request) => {
        assert.equal(id, 7); assert.equal(request.type, 'readonly-probe');
        calls.probes++;
        const reply = { ...snapshot(), type: 'readonly-probe-response',
          requestId: request.requestId };
        if (nextProbe) {
          const held = nextProbe; nextProbe = null;
          Object.assign(reply, held.overrides);
          held.enter(); await held.wait;
        }
        return reply;
      },
    },
  };
  const controller = createTargetBindingController(api, {
    now: () => clock, makeToken: () => 'synthetic-candidate-' + (++token),
  });
  return { controller, calls, raw: () => copy(state),
    tick: value => { clock = value; }, document: value => { documentId = value; },
    holdProbe: (overrides = {}) => {
      const held = { ...gate(), overrides }; nextProbe = held; return held;
    },
    holdRead: () => { const held = gate(); nextRead = held; return held; },
    holdWrite: () => { const held = gate(); nextWrite = held; return held; },
  };
}
async function scan(f) {
  const result = await f.controller.scan();
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}
async function bind(f, candidate = null) {
  candidate ??= await scan(f);
  const result = await f.controller.bind(candidate.token,
    bindingConfirmation(f.raw().binding, candidate));
  assert.equal(result.status, 'bound_saved');
  return result.binding;
}
async function clear(f) {
  const result = await f.controller.clear(bindingClearConfirmation(f.raw().binding));
  assert.equal(result.status, 'binding_cleared');
}
async function unchangedAfter(f, pending, held, expected = 'binding_changed_during_health_check') {
  const before = f.raw(), sets = f.calls.sets;
  held.release();
  const result = await pending;
  assert.equal(result.status, expected);
  assert.equal(result.sendEligible, false);
  assert.deepEqual(f.raw(), before, 'stale health must not alter binding or candidates');
  assert.equal(f.calls.sets, sets, 'stale health must not write');
  return result;
}

test('stale health after loading and rebind leaves new binding and candidates intact', async () => {
  const f = fixture(), held = f.holdProbe();
  const pending = f.controller.health(); await held.entered;
  f.tick(1100); await f.controller.onUpdated(7, { status: 'loading' });
  f.document(NEW); f.tick(1200);
  assert.equal((await bind(f)).revision, 2);
  assert.equal((await f.controller.health()).status, 'bound_healthy');
  const candidate = await scan(f);
  f.tick(1300); await unchangedAfter(f, pending, held);
  // Successful bind also proves the rejected stale check did not advance the epoch.
  assert.equal((await bind(f, candidate)).revision, 3);
});

test('navigation without rebind preserves first invalidation reason and time', async () => {
  const f = fixture(), held = f.holdProbe();
  const pending = f.controller.health(); await held.entered;
  f.tick(1100); await f.controller.onUpdated(7, { status: 'loading' });
  f.tick(1200); await f.controller.onRemoved(7);
  held.release(); const result = await pending;
  assert.equal(result.status, 'binding_invalidated');
  assert.equal(result.reason, 'navigation_or_redirect');
  assert.equal(f.raw().binding.invalidatedAt, 1100);
});

for (const overrides of [{}, { routeStable: false }]) {
  test('rebind without epoch rejects stale ' + (overrides.routeStable === false ? 'bad' : 'healthy') + ' probe', async () => {
    const f = fixture(), held = f.holdProbe(overrides);
    const pending = f.controller.health(); await held.entered;
    f.tick(1100); await bind(f);
    await unchangedAfter(f, pending, held);
  });
}

for (const mode of ['new_document', 'new_time', 'same_millisecond']) {
  test('clear and bind revision ABA rejected: ' + mode, async () => {
    const f = fixture(), held = f.holdProbe();
    const original = f.raw().binding;
    const pending = f.controller.health(); await held.entered;
    await clear(f);
    if (mode === 'new_document') f.document(NEW);
    if (mode === 'new_time') f.tick(1100);
    const rebound = await bind(f);
    assert.equal(rebound.revision, original.revision);
    if (mode === 'same_millisecond') assert.deepEqual(rebound, original);
    await unchangedAfter(f, pending, held);
  });
}

test('stale health after clear does not erase fresh unbound candidates or advance epoch', async () => {
  const f = fixture(), held = f.holdProbe();
  const pending = f.controller.health(); await held.entered;
  await f.controller.onUpdated(7, { status: 'loading' });
  await clear(f); f.document(NEW); f.tick(1100);
  const candidate = await scan(f);
  await unchangedAfter(f, pending, held);
  await bind(f, candidate);
});

test('rebind between post-probe read and invalidation decision cannot be overwritten', async () => {
  const f = fixture();
  const held = f.holdProbe({ routeStable: false });
  const pending = f.controller.health(); await held.entered;
  const candidate = await scan(f);
  f.tick(1100);
  // The new bind already passed every guard and owns the write queue, but its
  // storage write is held. Old health can read the old state; its subsequent
  // decision must wait for this write and compare the latest binding atomically.
  const writing = f.holdWrite();
  const replacement = bind(f, candidate);
  await writing.entered;
  held.release();
  // Drain finite microtasks while the real binding write remains blocked.
  await new Promise(resolve => setImmediate(resolve));
  writing.release();
  await replacement;
  assert.equal((await pending).status, 'binding_changed_during_health_check');
  assert.equal(f.raw().binding.revision, 2);
  assert.equal(f.raw().binding.invalidatedReason, null);
  assert.equal((await f.controller.health()).status, 'bound_healthy');
});

test('health start read overlapped by clear and same-ms bind is stale', async () => {
  const f = fixture(), reading = f.holdRead();
  const pending = f.controller.health(); await reading.entered;
  await clear(f); await bind(f);
  await unchangedAfter(f, pending, reading);
});

test('unchanged bad probe still invalidates and removes stale candidates', async () => {
  const f = fixture(); await scan(f);
  const held = f.holdProbe({ routeStable: false });
  const pending = f.controller.health(); await held.entered;
  f.tick(1100); held.release();
  const result = await pending;
  assert.equal(result.status, 'binding_invalidated');
  assert.equal(result.reason, 'route_changed_during_probe');
  assert.equal(f.raw().binding.invalidatedAt, 1100);
  assert.equal(f.raw().candidates.length, 0);
});

test('later concurrent health preserves the first probe invalidation', async () => {
  const f = fixture(), first = f.holdProbe({ routeStable: false });
  const pendingFirst = f.controller.health(); await first.entered;
  const second = f.holdProbe();
  const pendingSecond = f.controller.health(); await second.entered;
  f.tick(1100); first.release();
  assert.equal((await pendingFirst).reason, 'route_changed_during_probe');
  f.tick(1200);
  const result = await unchangedAfter(f, pendingSecond, second, 'binding_invalidated');
  assert.equal(result.reason, 'route_changed_during_probe');
  assert.equal(f.raw().binding.invalidatedAt, 1100);
});

test('navigation queued while health finalization reads is still fail closed', async () => {
  const f = fixture(), probe = f.holdProbe();
  const pending = f.controller.health(); await probe.entered;
  const reading = f.holdRead(); probe.release(); await reading.entered;
  const navigation = f.controller.onUpdated(7, { status: 'loading' });
  reading.release();
  const result = await pending; await navigation;
  assert.equal(result.status, 'binding_invalidated');
  assert.equal(f.raw().binding.invalidatedReason, 'navigation_during_health_check');
});

test('unchanged hidden document remains healthy without writes', async () => {
  const f = fixture(), before = f.raw();
  const result = await f.controller.health();
  assert.equal(result.status, 'bound_healthy');
  assert.equal(result.sendEligible, false);
  assert.deepEqual(f.raw(), before); assert.equal(f.calls.sets, 0);
});

for (const [event, reason] of [
  [c => c.onUpdated(7, { status: 'loading' }), 'navigation_or_redirect'],
  [c => c.onUpdated(7, { url: TARGET_URL }), 'navigation_or_redirect'],
  [c => c.onRemoved(7), 'tab_closed'],
  [c => c.onReplaced(8, 7), 'tab_replaced'],
  [c => c.onDetached(7), 'window_detached'],
  [c => c.onAttached(7), 'window_attached'],
]) {
  test('real event policy remains sticky: ' + reason, async () => {
    const f = fixture(); f.tick(1100); await event(f.controller);
    const result = await f.controller.health();
    assert.equal(result.status, 'binding_invalidated'); assert.equal(result.reason, reason);
    f.tick(1200); await f.controller.onRemoved(7);
    assert.equal(f.raw().binding.invalidatedReason, reason);
    assert.equal(f.raw().binding.invalidatedAt, 1100);
  });
}
