// T052 offline tests for manual background read-only preflight.
// No Chrome, browser UI, DOM mutation, network or Native Host queue access.
import { readFileSync } from 'node:fs';

const G = await import(new URL('./extension/lib/readonly_preflight.js',
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
function tab(overrides = {}) {
  return Object.assign({
    id: 7,
    windowId: 2,
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    active: false,
    discarded: false,
    frozen: false,
  }, overrides);
}
function response(overrides = {}) {
  return Object.assign({
    requestId: 'probe-7',
    documentInstanceId: 'document-instance-7',
    routeStable: true,
    observedAt: 1000,
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    conversationId: '11111111-1111-4111-8111-111111111111',
    visibilityState: 'hidden',
    hasFocus: false,
    composerPresent: true,
    pageLoaded: true,
  }, overrides);
}

{
  const parsed = G.parseConversationUrl(
    'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111');
  check(parsed.ok && parsed.conversationId ===
    '11111111-1111-4111-8111-111111111111',
    'parses exact ChatGPT conversation URL');
  for (const url of [
    'https://chatgpt.com/',
    'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?x=1',
    'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111#x',
    'https://chat.openai.com/share/11111111-1111-4111-8111-111111111111',
    'https://evil.example/c/11111111-1111-4111-8111-111111111111',
  ]) {
    check(!G.parseConversationUrl(url).ok,
      'rejects non-canonical conversation route');
  }
}

{
  const pending = G.classifyTab(tab());
  check(pending.status === 'probe_required' && pending.sendEligible === false &&
        pending.accountIdentity === 'unavailable',
        'ordinary background tab needs an explicit read-only probe');
  const unknownFrozen = G.classifyTab(Object.assign(tab(), { frozen: undefined }));
  check(unknownFrozen.status === 'probe_required' &&
        unknownFrozen.frozenStateKnown === false &&
        unknownFrozen.sendEligible === false,
        'missing frozen field is unknown and never grants send eligibility');
  const discarded = G.classifyTab(tab({ discarded: true }));
  check(discarded.status === 'discarded' && !discarded.backgroundObservable &&
        discarded.reason === 'content_unloaded_until_activation',
        'discarded tab is refused without activation');
  const frozen = G.classifyTab(tab({ frozen: true }));
  check(frozen.status === 'frozen' && frozen.reason ===
        'frozen_tabs_cannot_execute_tasks',
        'frozen tab is refused because it cannot execute tasks');
  const blank = G.classifyTab(tab({ url: 'https://chatgpt.com/' }));
  check(blank.status === 'not_an_exact_conversation_url',
        'blank/new chat is not a target conversation');
}

{
  const assessed = G.assessProbe(tab(), response(), tab(), 1000, 'probe-7');
  check(assessed.ok && assessed.status === 'background_observable' &&
        assessed.backgroundObservable && assessed.sendEligible === false &&
        assessed.accountIdentity === 'unavailable' &&
        assessed.deliveryReceipt === 'unsupported',
        'background probe reports observation but never send eligibility');
  check(assessed.active === false && assessed.routeNote ===
        'background_snapshot_not_foreground',
        'non-active tab is represented without claiming foreground focus');
  check(assessed.conversationId ===
    '11111111-1111-4111-8111-111111111111' && assessed.composerPresent,
    'probe returns only URL identity and composer presence');
  // A tab answered a live probe, so it is demonstrably not frozen even when the
  // Chrome build omits `tab.frozen`. The evidence is marked so nothing mistakes
  // it for the property having been read.
  const frozenUnknown = G.assessProbe(
    Object.assign(tab(), { frozen: undefined }), response(),
    Object.assign(tab(), { frozen: undefined }), 1000, 'probe-7');
  check(frozenUnknown.status === 'background_observable' &&
        frozenUnknown.frozenStateKnown === true &&
        frozenUnknown.frozen === false &&
        frozenUnknown.frozenStateSource === 'live_probe',
        'a successful probe is itself evidence the tab is not frozen');

  const propertyKnown = G.assessProbe(
    Object.assign(tab(), { frozen: false }), response(),
    Object.assign(tab(), { frozen: false }), 1000, 'probe-7');
  check(propertyKnown.frozenStateKnown === true &&
        propertyKnown.frozenStateSource === 'tab_property',
        'when the property exists it is credited as the source');
}

{
  const cases = [
    [tab({ url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222' }),
      response(), tab(), 'route_changed_during_probe'],
    [tab(), response(), tab({ windowId: 3 }), 'window_changed_during_probe'],
    [tab(), response(), tab({ discarded: true }), 'discarded_during_probe'],
    [tab(), response(), tab({ frozen: true }), 'frozen_during_probe'],
    [tab(), response({ requestId: 'other' }), tab(), 'probe_response_mismatch'],
    [tab(), response({ routeStable: false }), tab(), 'route_changed_during_probe'],
    [tab(), response({ observedAt: -5000 }), tab(), 'probe_stale'],
    [tab(), response({ observedAt: 2000 }), tab(), 'probe_stale'],
    [tab(), response({ conversationId: '22222222-2222-4222-8222-222222222222' }),
      tab(), 'conversation_identity_mismatch'],
    [tab(), response({ url: 'https://chatgpt.com/' }), tab(),
      'route_changed_during_probe'],
  ];
  for (const [before, page, after, expected] of cases) {
    const got = G.assessProbe(before, page, after, 1000, 'probe-7');
    check(!got.ok && got.status === expected,
      'rejects probe fault: ' + expected);
  }
  const changedTab = G.assessProbe(tab(), response(),
    Object.assign({}, tab(), { id: 8 }), 1000, 'probe-7');
  check(changedTab.status === 'tab_changed_during_probe',
    'rejects tab replacement during probe');
}

// The compatibility fix must not become a licence: with `frozen` absent from the
// API, every refusal still has to refuse. Only a *successful* answer counts as
// evidence, and nothing else may quietly acquire it.
{
  const noFrozen = () => { const t = tab(); delete t.frozen; return t; };

  const beforeDiscarded = G.assessProbe(
    Object.assign(noFrozen(), { discarded: true }), response(), noFrozen(),
    1000, 'probe-7');
  check(beforeDiscarded.status === 'discarded',
    'discarded is still refused when the API omits frozen');

  const beforeFrozen = G.assessProbe(
    Object.assign(noFrozen(), { frozen: true }), response(), noFrozen(),
    1000, 'probe-7');
  check(beforeFrozen.status === 'frozen',
    'frozen:true is still refused when the API omits the property elsewhere');

  const afterDiscarded = G.assessProbe(noFrozen(), response(),
    Object.assign(noFrozen(), { discarded: true }), 1000, 'probe-7');
  check(afterDiscarded.status === 'discarded_during_probe',
    'discarded during the probe is still refused');

  const afterFrozen = G.assessProbe(noFrozen(), response(),
    Object.assign(noFrozen(), { frozen: true }), 1000, 'probe-7');
  check(afterFrozen.status === 'frozen_during_probe',
    'frozen during the probe is still refused');

  const silent = [
    ['no answer', null],
    ['wrong request id', response({ requestId: 'someone-else' })],
    ['route moved', response({ routeStable: false })],
    ['stale', response({ observedAt: -5000 })],
    ['wrong url', response({ url: 'https://chatgpt.com/' })],
    ['wrong conversation', response({ conversationId: '22222222-2222-4222-8222-222222222222' })],
    ['no document instance', response({ documentInstanceId: '' })],
  ];
  for (const [label, page] of silent) {
    const got = G.assessProbe(noFrozen(), page, noFrozen(), 1000, 'probe-7');
    check(!got.ok && got.status !== 'background_observable' &&
          got.frozenStateKnown !== true,
          'no anti-frozen evidence without a good answer: ' + label);
  }

  const failure = G.assessProbeFailure(noFrozen(), 'content_unavailable');
  check(failure.status === 'content_unavailable' &&
        failure.frozenStateKnown === false &&
        failure.frozenStateSource === 'unknown',
        'an unresponsive content script proves nothing about frozen state');
}

{
  const failure = G.assessProbeFailure(tab(), 'content_unavailable');
  check(!failure.ok && failure.status === 'content_unavailable' &&
        failure.sendEligible === false,
        'content-script failure cannot be treated as send readiness');
  const frozenFailure = G.assessProbeFailure(tab({ frozen: true }),
    'content_unavailable');
  check(frozenFailure.status === 'frozen',
    'failure classification preserves frozen lifecycle state');
}

{
  const calls = [];
  const active = { id: 1, windowId: 2, active: true };
  const target = tab();
  const api = {
    tabs: {
      query: async (query) => {
        calls.push(['query', query]);
        return query.active ? [active] : [target];
      },
      sendMessage: async (tabId, message) => {
        calls.push(['sendMessage', tabId, message]);
        return response({ requestId: message.requestId });
      },
      get: async (tabId) => {
        calls.push(['get', tabId]);
        return target;
      },
    },
  };
  const run = await G.runReadonlyProbe(api, {
    now: () => 1000,
    makeRequestId: () => 'probe-7',
  });
  check(run.mode === 'manual-readonly-dry-run' && run.sendEligible === false &&
        run.accountIdentity === 'unavailable' && run.tabs.length === 1 &&
        run.tabs[0].status === 'background_observable',
        'fake Chrome orchestration yields only read-only background observation');
  check(calls[0][1].active === true && calls[0][1].lastFocusedWindow === true &&
        calls[1][1].windowId === 2 && !('currentWindow' in calls[1][1]),
        'probe anchors to the recent focused window without activating tabs');
  check(calls.some((call) => call[0] === 'sendMessage') &&
        calls.some((call) => call[0] === 'get'),
        'probe queries content script and rechecks tab afterward');
}

{
  let sent = 0;
  const api = {
    tabs: {
      query: async (query) => query.active
        ? [{ id: 1, windowId: 2, active: true }]
        : [tab({ discarded: true }), tab({ frozen: true }),
           tab({ id: 8, windowId: 2 }), tab({ id: 9, windowId: 2 })],
      sendMessage: async (tabId, message) => {
        sent += 1;
        if (tabId === 9) return new Promise(() => {});
        return response({ requestId: message.requestId });
      },
      get: async (tabId) => tab({ id: tabId, frozen: true }),
    },
  };
  const run = await G.runReadonlyProbe(api, {
    now: () => 1000,
    makeRequestId: (id) => 'probe-' + id,
    timeoutMs: 2,
  });
  check(sent === 2 && run.tabs[0].status === 'discarded' &&
        run.tabs[1].status === 'frozen',
        'discarded and frozen tabs are skipped without message dispatch');
  check(run.tabs[2].status === 'frozen_during_probe',
        'tab becoming frozen after the response is reported as unavailable');
  check(run.tabs[3].status === 'probe_timeout',
        'non-responsive background tab times out without retry or activation');

  let routeSent = false;
  const routeApi = {
    tabs: {
      query: async (query) => query.active
        ? [{ id: 1, windowId: 2, active: true }]
        : [tab()],
      sendMessage: async (_id, message) => {
        routeSent = true;
        return response({ requestId: message.requestId });
      },
      get: async () => tab({ url:
        'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222' }),
    },
  };
  const route = await G.runReadonlyProbe(routeApi, {
    now: () => 1000, makeRequestId: () => 'probe-route',
  });
  check(routeSent && route.tabs[0].status === 'route_changed_during_probe',
        'SPA route change between request and recheck is refused');
}

{
  let activeProbes = 0;
  let maxActiveProbes = 0;
  const tabs = [
    tab({ id: 21, windowId: 2 }),
    tab({ id: 22, windowId: 2 }),
    tab({ id: 23, windowId: 2 }),
  ];
  const run = await G.runReadonlyProbe({ tabs: {
    query: async (query) => query.active
      ? [{ id: 1, windowId: 2, active: true }]
      : tabs,
    sendMessage: async (tabId, message) => {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await Promise.resolve();
      activeProbes -= 1;
      return response({ requestId: message.requestId });
    },
    get: async (tabId) => tab({ id: tabId, windowId: 2 }),
  } }, { now: () => 1000, makeRequestId: (id) => 'parallel-' + id });
  check(maxActiveProbes === 3 && run.tabs.length === 3 &&
        run.tabs.every((item) => item.status === 'background_observable'),
        'bounded target probes run concurrently and retain independent results');
}

{
  const tooMany = await G.runReadonlyProbe({ tabs: {
    query: async (query) => query.active
      ? [{ id: 1, windowId: 2, active: true }]
      : Array.from({ length: G.MAX_PROBE_TABS + 1 }, (_v, index) =>
          tab({ id: index + 10 })),
    sendMessage: async () => { throw new Error('must not dispatch'); },
    get: async () => tab(),
  } }, { now: () => 1000 });
  check(tooMany.error === 'too_many_chatgpt_tabs' &&
        tooMany.sendEligible === false && Array.isArray(tooMany.tabs),
        'probe fails closed above bounded per-run tab count');
  const noWindow = await G.runReadonlyProbe({ tabs: {
    query: async () => [],
    sendMessage: async () => { throw new Error('must not dispatch'); },
    get: async () => tab(),
  } }, { now: () => 1000 });
  check(noWindow.error === 'current_window_unavailable' &&
        Array.isArray(noWindow.tabs),
        'missing focused window returns a shaped dry-run refusal');
}

{
  const source = readFileSync(new URL('./extension/lib/readonly_preflight.js',
    import.meta.url), 'utf8');
  const content = readFileSync(new URL('./extension/content.js', import.meta.url),
    'utf8');
  const background = readFileSync(new URL('./extension/background.js',
    import.meta.url), 'utf8');
  check(!source.includes('chrome.') && !source.includes('innerText') &&
        !source.includes('textContent') && !source.includes('.click('),
    'preflight module avoids global Chrome and page-write/text APIs');
  for (const token of ['.click(', 'dispatchEvent(', 'execCommand(',
                       'innerText', 'textContent', '.value =', 'innerHTML =']) {
    check(!content.replace(/\/\/.*$/gm, '').includes(token),
      'content probe keeps existing read-only boundary: ' + token);
  }
  check(!content.slice(content.indexOf('function readonlyProbe'),
    content.indexOf('chrome.runtime.onMessage.addListener')).includes('countOwnMessages'),
    'manual probe never counts or reads user-message nodes');
  check(background.includes("msg.type === 'readonly-dry-run'") &&
        background.includes('runReadonlyProbe(chrome)'),
        'background only exposes probe chain behind manual message');
  check(!background.includes('chrome.tabs.update') &&
        !background.includes('chrome.windows.update') &&
        !background.includes('executeScript'),
        'probe chain cannot activate, navigate or inject pages');
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
