// T054 integration: real T053 binding controller + real dry-run controller,
// with a fake Chrome tabs/session surface. Still fully offline: no browser, no
// page writes, no Native Host queue, no send adapter.
import { readFileSync } from 'node:fs';

const T = await import(
  new URL('./extension/lib/target_binding_controller.js', import.meta.url).href);
const D = await import(
  new URL('./extension/lib/bound_dry_run_controller.js', import.meta.url).href);

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

const RUN1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN1B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONV1 = '11111111-1111-4111-8111-111111111111';
const URL1 = 'https://chatgpt.com/c/' + CONV1;
const DOC1 = 'document-instance-integration1';
const NOW = 2000000000000;

function page(overrides = {}) {
  return Object.assign({
    id: 7, windowId: 2, url: URL1, active: false, discarded: false,
    frozen: false, documentInstanceId: DOC1, responsive: true,
  }, overrides);
}

function fakeChrome(tabs) {
  const store = new Map();
  const calls = { sendMessage: [], get: [] };
  const api = {
    tabs: {
      async query() { return tabs.slice(); },
      async get(tabId) {
        calls.get.push(tabId);
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) throw new Error('No tab with id: ' + tabId);
        return Object.assign({}, tab);
      },
      async sendMessage(tabId, message) {
        calls.sendMessage.push([tabId, message.type]);
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab || tab.responsive === false) throw new Error('no receiver');
        const before = tab.url;
        if (message.type !== 'readonly-probe') throw new Error('unexpected');
        return {
          requestId: message.requestId,
          url: before, conversationId: CONV1, observedAt: NOW - 100,
          documentInstanceId: tab.documentInstanceId,
          visibilityState: 'hidden', hasFocus: false,
          composerPresent: true, pageLoaded: true,
          routeStable: tab.url === before,
        };
      },
    },
    session: {
      async get(defaults) {
        const out = {};
        for (const [key, value] of Object.entries(defaults)) {
          out[key] = store.has(key) ? store.get(key) : value;
        }
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) store.set(key, value);
      },
    },
  };
  return { api, store, calls, tabs };
}

function clock(start = NOW) {
  let value = start;
  return { now: () => value, advance(ms) { value += ms; } };
}

const target = page();
const fake = fakeChrome([target]);
const clk = clock();
const binding = T.createTargetBindingController(fake.api, {
  now: clk.now, timeoutMs: 100, makeToken: (() => {
    let n = 0;
    return () => 'tok-' + (n += 1);
  })(),
});
const dry = D.createBoundDryRunController({}, {
  targetBinding: binding, session: fake.api.session, now: clk.now,
});

// Bind exactly as the popup does: scan, then confirm the full phrase.
const scan = await binding.scan();
check(scan.candidates.length === 1, 'scan yields the single ChatGPT page');
const token = scan.candidates[0].token;
const phrase = 'BIND tab=7 window=2 url=' + URL1 + ' conversation=' + CONV1;
const saved = await binding.bind(token, phrase);
check(saved.ok && saved.status === 'bound_saved', 'binding is saved');
clk.advance(1000);

// Healthy binding + simulated event => review allowed, never sendable.
const allowed = await dry.run({ runId: RUN1, status: 'completed' });
check(allowed.reviewAllowed && allowed.sendEligible === false &&
      allowed.pageWriteEligible === false,
      'bound + healthy + simulated event allows human review only');
check(allowed.target.tabId === 7 && allowed.target.windowId === 2 &&
      allowed.target.url === URL1,
      'review decision names the exact bound page');

// Same event again => duplicate, blocked.
const dup = await dry.run({ runId: RUN1, status: 'completed' });
check(!dup.reviewAllowed && dup.reasons.includes('duplicate_event'),
      'replayed terminal event is blocked as duplicate');

// A different event on the same healthy page => allowed.
const second = await dry.run({ runId: RUN1B, status: 'failed' });
check(second.reviewAllowed, 'a second distinct run is reviewable');

// Tab becomes unresponsive => probe fails closed, blocked.
target.responsive = false;
const unavailable = await dry.run({ runId: RUN1B, status: 'cancelled' });
check(!unavailable.reviewAllowed &&
      unavailable.reasons.includes('content_unavailable'),
      'unresponsive target blocks review with a specific reason');
target.responsive = true;

// Navigation invalidates the stored binding before the next decision.
await binding.onUpdated(7, { status: 'loading' });
target.url = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const navigated = await dry.run({ runId: RUN1B, status: 'cancelled' });
check(!navigated.reviewAllowed &&
      navigated.reasons.includes('binding_invalidated'),
      'navigation invalidates the binding and blocks review');

// A lookalike tab in another window is never substituted.
const lookalike = page({ id: 8, windowId: 3 });
fake.tabs.push(lookalike);
const stillBlocked = await dry.run({ runId: RUN1B, status: 'cancelled' });
check(!stillBlocked.reviewAllowed &&
      !stillBlocked.reasons.includes('review_history_unavailable'),
      'a lookalike tab cannot re-enable a blocked review');
check(fake.calls.sendMessage.every(([tabId]) => tabId === 7),
      'dry-run never probes any tab other than the bound tabId');

// Isolation guarantees on the source.
{
  const source = readFileSync(
    new URL('./extension/lib/bound_dry_run_controller.js', import.meta.url),
    'utf8');
  for (const token of ['send_gate', 'chrome.', 'nativeMessaging',
    'storage.local', 'executeScript', 'innerText']) {
    check(!source.includes(token), 'controller isolation: ' + token);
  }
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
