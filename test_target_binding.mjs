// T053 offline tests: manual target binding and read-only health check.
// No Chrome, no page writes, no sends; fake tabs/session APIs only.
import { readFileSync } from 'node:fs';

const P = await import(new URL('./extension/lib/target_binding.js',
  import.meta.url).href);
const C = await import(new URL('./extension/lib/target_binding_controller.js',
  import.meta.url).href);

let passed = 0;
let failed = 0;
function check(value, label) {
  if (value) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label);
  }
}

const URL1 = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const URL2 = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const CONV1 = '11111111-1111-4111-8111-111111111111';
const CONV2 = '22222222-2222-4222-8222-222222222222';
const DOC1 = 'document-instance-aaaaaaaaaa1';
const DOC2 = 'document-instance-bbbbbbbbbb2';

function snapshot(overrides = {}) {
  return Object.assign({
    ok: true,
    status: 'background_observable',
    backgroundObservable: true,
    sendEligible: false,
    accountIdentity: 'unavailable',
    deliveryReceipt: 'unsupported',
    tabId: 7,
    windowId: 2,
    active: false,
    discarded: false,
    frozen: false,
    frozenStateKnown: true,
    url: URL1,
    conversationId: CONV1,
    documentInstanceId: DOC1,
    observedAt: 1000,
    visibilityState: 'hidden',
    hasFocus: false,
    composerPresent: true,
    pageLoaded: true,
    routeStable: true,
  }, overrides);
}

function tab(overrides = {}) {
  return Object.assign({
    id: 7,
    windowId: 2,
    url: URL1,
    active: false,
    discarded: false,
    frozen: false,
    documentInstanceId: DOC1,
  }, overrides);
}

// -- Pure candidate assessment -----------------------------------------

{
  check(P.assessBindingCandidate(snapshot(), 1000).ok &&
        P.assessBindingCandidate(snapshot(), 1000).status === 'candidate_eligible',
        'fresh background snapshot is an eligible candidate');
  for (const [overrides, expected] of [
    [{ status: 'probe_timeout' }, 'candidate_not_preflighted'],
    [{ tabId: undefined }, 'candidate_identity_missing'],
    [{ url: URL2 }, 'candidate_route_mismatch'],
    [{ discarded: true }, 'candidate_discarded'],
    [{ frozenStateKnown: false }, 'frozen_state_unknown'],
    [{ observedAt: -9000 }, 'candidate_snapshot_stale'],
    [{ documentInstanceId: undefined }, 'document_instance_missing'],
    [{ composerPresent: false }, 'candidate_page_state_incomplete'],
    [{ visibilityState: 'nonsense' }, 'candidate_page_state_incomplete'],
  ]) {
    const got = P.assessBindingCandidate(snapshot(overrides), 1000);
    check(!got.ok && got.status === expected,
          'candidate rejected: ' + expected);
  }
  const eligible = P.assessBindingCandidate(snapshot(), 1000);
  check(eligible.sendEligible === false &&
        eligible.accountIdentity === 'unverified',
        'eligible candidate never claims send or account identity');
}

// -- Confirmation phrases lock the full page identity -------------------

{
  const candidate = { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 };
  check(P.bindingConfirmation(null, candidate) ===
        'BIND tab=7 window=2 url=' + URL1 + ' conversation=' + CONV1,
        'first-bind confirmation locks tab, window, url and conversation');
  const previous = { tabId: 9, windowId: 3, url: URL2, conversationId: CONV2 };
  check(P.bindingConfirmation(previous, candidate) ===
        'REPLACE tab=9 window=3 url=' + URL2 + ' conversation=' + CONV2 +
        ' WITH tab=7 window=2 url=' + URL1 + ' conversation=' + CONV1,
        'replacement confirmation names old and new full identities');
  check(P.bindingClearConfirmation(
    { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 }) ===
    'UNBIND tab=7 window=2 url=' + URL1 + ' conversation=' + CONV1,
    'clear confirmation names the full bound identity');
}

// -- Binding record ------------------------------------------------------

{
  const record = P.createBindingRecord(snapshot(), 1000, 1);
  check(record.ok && record.binding.conversationId === CONV1 &&
        record.binding.documentInstanceId === DOC1 &&
        record.binding.accountVerified === false &&
        record.binding.manuallyConfirmed === true &&
        record.binding.accountIdentity === 'unverified',
        'saved binding records page identity, not account verification');
  check(!P.createBindingRecord(snapshot(), 1000, 0).ok,
        'binding revision must be positive');
  const bad = P.createBindingRecord(snapshot({ frozenStateKnown: false }),
    1000, 1);
  check(!bad.ok, 'unknown frozen state cannot become a binding');
}

// -- Health assessment ----------------------------------------------------

{
  const binding = P.createBindingRecord(snapshot(), 1000, 1).binding;
  const healthy = P.assessBindingHealth(binding, snapshot(), 1500);
  check(healthy.ok && healthy.status === 'bound_healthy' &&
        healthy.sendEligible === false &&
        healthy.accountIdentity === 'unverified' &&
        healthy.visibilityState === 'hidden',
        'matching fresh probe reports healthy without foreground');
  check(P.assessBindingHealth(null, null, 1000).status === 'not_bound',
        'no binding is reported, never invented');
  const invalidating = [
    ['tab_unavailable', { status: 'tab_unavailable' }],
    ['discarded', { status: 'discarded' }],
    ['frozen', { status: 'frozen' }],
    ['route_changed_during_probe', { status: 'route_changed_during_probe' }],
    ['document_instance_missing', { status: 'document_instance_missing' }],
    ['not_an_exact_conversation_url', { status: 'not_an_exact_conversation_url' }],
  ];
  for (const [status, probe] of invalidating) {
    const got = P.assessBindingHealth(binding, probe, 1500);
    check(!got.ok && got.status === 'binding_invalidated' &&
          got.reason === status,
          'structural mismatch invalidates binding: ' + status);
  }
  const transient = [
    ['probe_timeout', { status: 'probe_timeout' }],
    ['content_unavailable', { status: 'content_unavailable' }],
    ['probe_stale', { status: 'probe_stale' }],
  ];
  for (const [status, probe] of transient) {
    const got = P.assessBindingHealth(binding, probe, 1500);
    check(!got.ok && got.status === 'binding_unavailable' &&
          got.reason === status,
          'transient failure stays available-later, not invalidated: ' + status);
  }
  const frozenUnknown = P.assessBindingHealth(binding,
    snapshot({ frozenStateKnown: false }), 1500);
  check(!frozenUnknown.ok &&
        frozenUnknown.status === 'binding_unavailable' &&
        frozenUnknown.reason === 'frozen_state_unknown',
        'unknown frozen lifecycle is unavailable, never healthy');
  for (const [overrides] of [
    [{ tabId: 8 }], [{ windowId: 3 }], [{ url: URL2 }],
    [{ conversationId: CONV2 }], [{ documentInstanceId: DOC2 }],
  ]) {
    const got = P.assessBindingHealth(binding, snapshot(overrides), 1500);
    check(!got.ok && got.status === 'binding_invalidated' &&
          got.reason === 'binding_identity_mismatch',
          'identity mismatch invalidates: ' + JSON.stringify(overrides));
  }
  const stale = P.assessBindingHealth(binding, snapshot({ observedAt: -9000 }),
    1500);
  check(!stale.ok && stale.status === 'binding_unavailable',
        'stale probe is unavailable until a fresh manual check');
  const sticky = P.assessBindingHealth(
    Object.assign({}, binding, { invalidatedReason: 'tab_closed' }),
    snapshot(), 1500);
  check(!sticky.ok && sticky.status === 'binding_invalidated' &&
        sticky.reason === 'tab_closed',
        'invalidated binding stays invalid even if a page looks healthy');
  check(P.assessBindingHealth(
    Object.assign({}, binding, { url: 'https://evil.example/c/' + CONV1 }),
    snapshot(), 1500).status === 'binding_record_invalid',
    'corrupted binding record is refused, never repaired silently');
}

console.log('RESULT: policy ' + passed + ' passed so far, ' + failed + ' failed');

// -- Controller with fake Chrome APIs -------------------------------------

function fakeApi({ tabs = [], failSet = false, failGet = false,
                   failGetSession = false } = {}) {
  const store = new Map();
  const calls = { sendMessage: [], get: [], set: 0 };
  const api = {
    tabs: {
      query: async (query) => query.active
        ? [{ id: 1, windowId: 2, active: true }]
        : tabs,
      sendMessage: async (tabId, message) => {
        calls.sendMessage.push([tabId, message]);
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab || tab.unresponsive) return new Promise(() => {});
        return {
          type: 'readonly-probe-response',
          requestId: message.requestId,
          documentInstanceId: tab.documentInstanceId,
          routeStable: true,
          observedAt: 1000,
          url: tab.url,
          conversationId: (tab.url.match(/c\/([0-9a-f-]{36})/) || [])[1] || null,
          visibilityState: 'hidden',
          hasFocus: false,
          composerPresent: true,
          pageLoaded: true,
        };
      },
      get: async (tabId) => {
        calls.get.push(tabId);
        if (failGet) throw new Error('tab gone');
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) throw new Error('tab not found');
        return tab;
      },
    },
    session: {
      get: async (defaults) => {
        if (failGetSession) throw new Error('session storage down');
        const out = {};
        for (const key of Object.keys(defaults)) {
          out[key] = store.has(key) ? store.get(key) : defaults[key];
        }
        return out;
      },
      set: async (values) => {
        if (failSet) throw new Error('session storage down');
        calls.set += 1;
        for (const key of Object.keys(values)) store.set(key, values[key]);
      },
    },
  };
  return { api, store, calls };
}

async function scannedController({ clock = { now: 1000 }, tabs } = {}) {
  const fake = fakeApi({ tabs });
  const controller = C.createTargetBindingController(fake.api, {
    now: () => clock.now,
    timeoutMs: 5,
    makeToken: (index => () => 'token-' + (++index))(0),
  });
  const scan = await controller.scan();
  return { controller, fake, scan, clock };
}

async function controllerTest() {
  const good = tab();
  const other = tab({ id: 8, windowId: 3, url: URL2, documentInstanceId: DOC2 });

  {
    const { controller, scan, fake } = await scannedController({ tabs: [good] });
    check(scan.candidates.length === 1 &&
          scan.candidates[0].token === 'token-1' &&
          scan.candidates[0].conversationId === CONV1 &&
          scan.candidates[0].sendEligible === false,
          'scan turns fresh snapshots into one candidate per tab');
    check(fake.calls.sendMessage.length === 1,
          'scan probes each candidate tab once, read-only');
    const state = await controller.getState();
    check(state.status === 'not_bound' && state.binding === null &&
          state.candidates.length === 1,
          'scanning alone never creates a binding');
  }

  {
    const sameConversationOtherWindow = tab({
      id: 9, windowId: 4, url: URL1, documentInstanceId: DOC2,
    });
    const { controller, scan } = await scannedController({
      tabs: [good, other, sameConversationOtherWindow],
    });
    const duplicateUuid = scan.candidates.filter((item) =>
      item.conversationId === CONV1);
    check(scan.candidates.length === 3 && duplicateUuid.length === 2 &&
          duplicateUuid[0].tabId !== duplicateUuid[1].tabId &&
          duplicateUuid[0].windowId !== duplicateUuid[1].windowId,
          'same conversation UUID in different windows remains separate pages');
    const wrong = await controller.bind('token-1', 'BIND ' + CONV1);
    check(!wrong.ok && wrong.status === 'binding_confirmation_mismatch' &&
          wrong.expectedConfirmation.startsWith('BIND tab=7 window=2 url='),
          'confirmation must name the full page identity, not just the UUID');
    const unknown = await controller.bind('token-x',
      P.bindingConfirmation(null, { tabId: 7, windowId: 2, url: URL1,
        conversationId: CONV1 }));
    check(!unknown.ok && unknown.status === 'candidate_not_found',
          'unknown or stale tokens cannot bind');
  }

  {
    const { controller, clock, fake } = await scannedController({ tabs: [good] });
    clock.now += C.CANDIDATE_TTL_MS + 1;
    const expired = await controller.bind('token-1',
      P.bindingConfirmation(null, { tabId: 7, windowId: 2, url: URL1,
        conversationId: CONV1 }));
    check(!expired.ok && expired.status === 'candidate_scan_expired',
          'candidates expire; old scans cannot bind');
    check(fake.calls.sendMessage.length === 1,
          'expired candidate causes no extra probe after the initial scan');
  }

  {
    const { controller, fake, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    const bound = await controller.bind('token-1', confirmation);
    check(bound.ok && bound.status === 'bound_saved' &&
          bound.binding.revision === 1 &&
          bound.binding.tabId === 7 && bound.binding.windowId === 2 &&
          bound.binding.url === URL1 &&
          bound.binding.documentInstanceId === DOC1 &&
          bound.binding.accountVerified === false,
          'explicit confirmation binds the exact page for this session');
    check(fake.calls.sendMessage.length === 2 &&
          fake.calls.sendMessage[1][0] === 7,
          'binding re-probes the chosen tab before saving');
    const after = await controller.getState();
    check(after.status === 'bound_saved' && after.candidates.length === 0,
          'candidate list is cleared once a binding is saved');
    clock.now += 1;
    const health = await controller.health();
    check(health.ok && health.status === 'bound_healthy' &&
          health.sendEligible === false &&
          health.accountIdentity === 'unverified',
          'fresh same-document probe reports the binding healthy');
    check(fake.calls.sendMessage.length === 3 &&
          fake.calls.sendMessage.every(([tabId]) => tabId === 7),
          'health check probes only the bound tabId');
    check(fake.calls.get.every((tabId) => tabId === 7),
          'health check never enumerates other tabs');
  }

  {
    const { controller, fake } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    good.documentInstanceId = DOC2;
    const reloaded = await controller.bind('token-1', confirmation);
    check(!reloaded.ok &&
          (reloaded.status === 'candidate_identity_changed' ||
           reloaded.status === 'document_instance_missing'),
          'page reload between scan and confirm refuses to bind');
    const state = await controller.getState();
    check(state.status === 'not_bound',
          'failed confirmation never leaves a partial binding');
    check(fake.calls.set === 1,
          'refused binding wrote nothing beyond the scan');
  }

  {
    const { controller } = await scannedController({ tabs: [good] });
    await controller.onUpdated(7, { status: 'loading' });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    const navigated = await controller.bind('token-1', confirmation);
    check(!navigated.ok && navigated.status === 'candidate_not_found',
          'a navigation event persistently removes the stale candidate token');
  }

  {
    const { controller, fake } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    let release;
    let enteredResolve;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const originalSend = fake.api.tabs.sendMessage;
    fake.api.tabs.sendMessage = async (tabId, message) => {
      const response = await originalSend(tabId, message);
      enteredResolve();
      await gate;
      return response;
    };
    const pending = controller.bind('token-1', confirmation);
    await entered;
    await controller.onUpdated(7, { status: 'loading' });
    release();
    const raced = await pending;
    check(!raced.ok && raced.status === 'navigation_during_binding',
          'navigation during the confirming probe aborts the binding write');
    check((await controller.getState()).status === 'not_bound',
          'raced confirmation leaves no binding');
  }

  {
    const page = tab();
    const fake = fakeApi({ tabs: [page] });
    const controller = C.createTargetBindingController(fake.api, {
      now: () => 1000,
      timeoutMs: 5,
      makeToken: () => 'scan-race-token',
    });
    let release;
    let enteredResolve;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const originalSend = fake.api.tabs.sendMessage;
    fake.api.tabs.sendMessage = async (tabId, message) => {
      const response = await originalSend(tabId, message);
      enteredResolve();
      await gate;
      return response;
    };
    const pendingScan = controller.scan();
    await entered;
    await controller.onUpdated(7, { status: 'loading' });
    release();
    const racedScan = await pendingScan;
    check(racedScan.candidates.length === 0 &&
          (await controller.getState()).candidates.length === 0,
          'navigation during candidate scan produces no selectable candidate');
  }

  {
    const { controller, fake } = await scannedController({ tabs: [good] });
    const scan = await controller.scan();
    await controller.onUpdated(7, { status: 'loading' });
    const restartedWorker = C.createTargetBindingController(fake.api, {
      now: () => 1000,
      timeoutMs: 5,
    });
    const refused = await restartedWorker.bind('token-2',
      P.bindingConfirmation(null, { tabId: 7, windowId: 2,
        url: URL1, conversationId: CONV1 }));
    check(scan.candidates.length === 1 && !refused.ok &&
          refused.status === 'candidate_not_found',
          'navigation removes candidate token persistently across worker restart');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good, other] });
    const first = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', first);
    clock.now += 10;
    const scan = await controller.scan();
    check(scan.candidates.length === 2,
          'a new scan lists candidates without touching the binding');
    const state = await controller.getState();
    check(state.status === 'bound_saved' && state.binding.revision === 1,
          'scanning does not invalidate or replace an existing binding');
    const replace = P.bindingConfirmation(state.binding,
      { tabId: 8, windowId: 3, url: URL2, conversationId: CONV2 });
    const token8 = scan.candidates.find((item) =>
      item.conversationId === CONV2).token;
    const replaced = await controller.bind(token8, replace);
    check(replaced.ok && replaced.binding.revision === 2 &&
          replaced.binding.tabId === 8,
          'rebinding requires the exact replace phrase and bumps revision');
    const wrongReplace = await controller.bind('token-1', first);
    check(!wrongReplace.ok, 'stale first-bind phrase cannot rebind');
  }

  {
    const page = tab();
    const { controller, clock } = await scannedController({ tabs: [page] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    page.documentInstanceId = DOC2;
    clock.now += 10;
    const reloaded = await controller.health();
    check(!reloaded.ok && reloaded.status === 'binding_invalidated' &&
          reloaded.reason === 'binding_identity_mismatch',
          'reload after binding invalidates instead of silently matching');
    const sticky = await controller.getState();
    check(sticky.status === 'binding_invalidated' &&
          sticky.binding.invalidatedReason === 'binding_identity_mismatch',
          'invalidation is persisted and sticky');
    const again = await controller.health();
    check(!again.ok && again.status === 'binding_invalidated',
          'invalidated binding never reports healthy again');
  }

  {
    const page = tab();
    const { controller } = await scannedController({ tabs: [page] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    page.unresponsive = true;
    const bound = await controller.bind('token-1', confirmation);
    check(!bound.ok && bound.status === 'probe_timeout',
          'unresponsive confirmation probe cannot bind');
    const state = await controller.getState();
    check(state.status === 'not_bound' && state.candidates.length === 1,
          'transient timeout keeps candidate for a later manual attempt');
  }

  {
    const fake = fakeApi({ tabs: [good] });
    fake.store.set(C.TARGET_BINDING_SESSION_KEY, {
      version: 1, revision: 'corrupt', binding: null,
      candidates: [], candidateScannedAt: null,
    });
    const corrupt = C.createTargetBindingController(fake.api, {
      now: () => 1000,
      timeoutMs: 5,
    });
    const status = await corrupt.getState();
    const scan = await corrupt.scan();
    check(!status.ok && status.status === 'binding_state_invalid' &&
          scan.error === 'candidate_storage_failed',
          'corrupt session state is unavailable and never auto-reset');
  }

  {
    const fake = fakeApi({ tabs: [good] });
    const restarted = C.createTargetBindingController(fake.api, {
      now: () => 1000,
      timeoutMs: 5,
    });
    const gone = await restarted.health();
    check(!gone.ok && gone.status === 'not_bound',
          'empty session storage after restart means unbound');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    await controller.onRemoved(7);
    const closed = await controller.health();
    check(!closed.ok && closed.status === 'binding_invalidated' &&
          closed.reason === 'tab_closed',
          'closing the bound tab invalidates the binding');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    await controller.onReplaced(8, 7);
    const replaced = await controller.health();
    check(!replaced.ok && replaced.status === 'binding_invalidated' &&
          replaced.reason === 'tab_replaced',
          'tab replacement invalidates the previous binding');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    await controller.onDetached(7);
    const moved = await controller.health();
    check(!moved.ok && moved.status === 'binding_invalidated' &&
          moved.reason === 'window_detached',
          'moving the tab to another window invalidates the binding');
  }

  {
    const page = tab();
    const { controller, clock, fake } = await scannedController({ tabs: [page] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    let release;
    let enteredResolve;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const originalSend = fake.api.tabs.sendMessage;
    fake.api.tabs.sendMessage = async (tabId, message) => {
      const response = await originalSend(tabId, message);
      enteredResolve();
      await gate;
      return response;
    };
    const pendingHealth = controller.health();
    await entered;
    await controller.onUpdated(7, { status: 'loading' });
    release();
    const racedHealth = await pendingHealth;
    check(!racedHealth.ok && racedHealth.status === 'binding_invalidated' &&
          racedHealth.reason === 'navigation_or_redirect',
          'navigation event during health probe beats a matching old response');
  }

  {
    const page = tab();
    const { controller, clock, fake } = await scannedController({ tabs: [page] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    page.windowId = 3;
    const moved = await controller.health();
    check(!moved.ok && moved.status === 'binding_invalidated' &&
          moved.reason === 'window_changed_during_probe',
          'a tab found in a different window invalidates the binding');
    check(fake.calls.sendMessage.every(([tabId]) => tabId === 7),
          'window mismatch is detected before probing any substitute');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    await controller.onUpdated(7, { url: URL2 });
    const redirected = await controller.health();
    check(!redirected.ok && redirected.status === 'binding_invalidated' &&
          redirected.reason === 'navigation_or_redirect',
          'SPA redirect observed in background invalidates without probing');
  }

  {
    const page = tab();
    const { controller, clock } = await scannedController({ tabs: [page] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    page.unresponsive = true;
    const timeout = await controller.health();
    check(!timeout.ok && timeout.status === 'binding_unavailable' &&
          timeout.reason === 'probe_timeout',
          'transient timeout reports unavailable without invalidating');
    const state = await controller.getState();
    check(state.status === 'bound_saved',
          'binding survives a transient timeout for the next manual check');
  }

  {
    const { controller } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    const wrong = await controller.clear('UNBIND ' + CONV1);
    check(!wrong.ok && wrong.status === 'binding_clear_confirmation_mismatch',
          'clear requires the exact full-identity phrase');
    const right = await controller.clear(
      P.bindingClearConfirmation({ tabId: 7, windowId: 2, url: URL1,
        conversationId: CONV1, documentInstanceId: DOC1 }));
    check(right.ok && right.status === 'binding_cleared',
          'exact phrase clears the session binding');
    const state = await controller.getState();
    check(state.status === 'not_bound' && state.candidates.length === 0,
          'cleared state is unbound with no leftover candidates');
  }

  {
    const { controller, clock } = await scannedController({ tabs: [good] });
    const confirmation = P.bindingConfirmation(null,
      { tabId: 7, windowId: 2, url: URL1, conversationId: CONV1 });
    await controller.bind('token-1', confirmation);
    clock.now += 10;
    const other = tab({ id: 8, windowId: 3, url: URL1, documentInstanceId: DOC2 });
    const fake3 = fakeApi({ tabs: [other] });
    const copy = C.createTargetBindingController(fake3.api, {
      now: () => clock.now,
    });
    const health = await copy.health();
    check(!health.ok && health.status === 'not_bound',
          'a lookalike tab in another window is never consulted');
  }

  {
    const fake = fakeApi({ tabs: [good], failSet: true,
      failGetSession: true });
    const controller = C.createTargetBindingController(fake.api, {
      now: () => 1000,
      makeToken: (() => {
        let index = 0;
        return () => 'token-' + (++index);
      })(),
    });
    await controller.scan().catch(() => null);
    const refused = await controller.bind('token-1', 'BIND anything')
      .catch((err) => ({ ok: false, status: String(err) }));
    check(!refused.ok,
          'session storage failure refuses to bind instead of degrading');
    const state = await controller.getState();
    check(state.ok === false &&
          state.status === 'session_storage_unavailable',
          'storage failure surfaces as unavailable, never as a binding');
  }

  {
    const { controller } = await scannedController({ tabs: [] });
    const scan = await controller.scan();
    check(scan.candidates.length === 0,
          'no ChatGPT tabs means no candidates and no binding path');
  }
}

await controllerTest();

// -- Static boundaries -----------------------------------------------------

{
  const policy = readFileSync(new URL('./extension/lib/target_binding.js',
    import.meta.url), 'utf8');
  const controller = readFileSync(new URL(
    './extension/lib/target_binding_controller.js', import.meta.url), 'utf8');
  const background = readFileSync(new URL('./extension/background.js',
    import.meta.url), 'utf8');
  const popup = readFileSync(new URL('./extension/popup.js', import.meta.url),
    'utf8');
  const manifest = JSON.parse(readFileSync(new URL('./extension/manifest.json',
    import.meta.url), 'utf8'));
  check(!policy.includes('chrome.') && !controller.includes('chrome.'),
        'T053 modules stay free of global Chrome APIs');
  check(!policy.includes('innerText') && !policy.includes('textContent') &&
        !controller.includes('innerText') &&
        !controller.includes('textContent'),
        'T053 modules never read page text');
  check(!policy.includes('.click(') && !policy.includes('dispatchEvent(') &&
        !controller.includes('.click(') &&
        !controller.includes('dispatchEvent('),
        'T053 modules have no page-write primitives');
  check(!controller.includes('storage.local'),
        'binding state never persists beyond the browser session');
  check(background.includes("msg.type.startsWith('t053-binding-')") &&
        background.includes("getURL('popup.html')"),
        'T053 binding messages are answered only for the extension popup');
  check(background.includes('onUpdated') && background.includes('onRemoved') &&
        background.includes('onReplaced') && background.includes('onDetached'),
        'tab lifecycle events are observed for sticky invalidation');
  check(!background.includes('chrome.tabs.update') &&
        !background.includes('executeScript'),
        'T053 background never activates, navigates or injects');
  check(!popup.includes('window.prompt'),
        'popup binding confirmation uses its own input, not prompts');
  check(manifest.permissions.length === 4 &&
        manifest.permissions.includes('storage') &&
        !manifest.permissions.includes('scripting') &&
        !manifest.permissions.includes('webNavigation'),
        'T053 adds no permission: storage.session rides the existing storage right');
  const sendGate = readFileSync(new URL('./extension/lib/send_gate.js',
    import.meta.url), 'utf8');
  check(!controller.includes('send_gate') && !policy.includes('send_gate'),
        'T053 binding never imports or weakens the T051 send gate');
}

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;

