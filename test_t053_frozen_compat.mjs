// T062: the T053 binding scan must not lose a target on Chrome builds whose
// `tabs.Tab` has no `frozen` boolean.
//
// This drives the real controller against a mock chrome.tabs, so the whole path
// is exercised: query -> per-tab probe -> assessProbe -> assessBindingCandidate
// -> persisted candidate list. The pure-function cases live in
// test_readonly_preflight.mjs; this file answers the only question that matters
// to the user: after a successful manual preflight, does "scan all windows"
// actually produce a candidate?
import { createTargetBindingController } from
  './extension/lib/target_binding_controller.js';

const CONV = '33333333-3333-4333-8333-333333333333';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const DOC = 'document-instance-0001';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

function makeEnv(opts = {}) {
  const store = { session: {}, local: {} };
  const calls = { sendMessage: [], query: 0, get: 0, update: 0, highlight: 0 };
  let tab = Object.assign({
    id: 11, windowId: 4, url: URL_OK, active: true, discarded: false,
    // Deliberately no `frozen` key: this is the Chrome shape being supported.
  }, opts.tab);

  const chromeApi = {
    tabs: {
      // The scan path starts here; the real one filters by URL only.
      async query() { calls.query += 1; return opts.queryResult || [tab]; },
      async get(id) { calls.get += 1; return Object.assign({}, tab, { id }); },
      async sendMessage(id, msg) {
        calls.sendMessage.push(msg);
        if (opts.silent) {
          throw new Error('Could not establish connection.');
        }
        if (opts.navigateDuringProbe) {
          tab = Object.assign({}, tab, { url: URL_OK + '?moved=1' });
        }
        const observedAt = opts.observedAt === undefined
          ? Date.now() : opts.observedAt;
        return {
          requestId: msg.requestId,
          routeStable: opts.routeStable !== false,
          observedAt,
          url: opts.responseUrl || tab.url,
          conversationId: CONV,
          documentInstanceId: opts.documentInstanceId || DOC,
          visibilityState: opts.visibilityState || 'visible',
          hasFocus: opts.hasFocus !== false,
          composerPresent: opts.composerPresent !== false,
          pageLoaded: true,
        };
      },
      async update() { calls.update += 1; throw new Error('not allowed'); },
      async highlight() { calls.highlight += 1; throw new Error('not allowed'); },
    },
    windows: {
      async update() { throw new Error('not allowed'); },
      async getAll() { return [{ id: 4, focused: true }]; },
    },
    storage: {
      session: {
        async get(defaults) {
          return Object.assign({}, defaults, store.session);
        },
        async set(patch) { Object.assign(store.session, patch); },
      },
      local: {
        async get(defaults) { return Object.assign({}, defaults, store.local); },
        async set(patch) { Object.assign(store.local, patch); },
      },
    },
  };
  return { chromeApi, store, calls };
}

function build(opts) {
  const env = makeEnv(opts);
  const controller = createTargetBindingController({
    tabs: env.chromeApi.tabs,
    session: env.chromeApi.storage.session,
  }, {
    now: opts.now,
    timeoutMs: opts.timeoutMs,
    makeRequestId: opts.makeRequestId,
  });
  return Object.assign({ controller }, env);
}

console.log('== T062: scan produces a candidate when the API omits frozen ==');
{
  const { controller } = build({});
  const scan = await controller.scan();
  check(!scan.error, 'the scan itself succeeds (' + (scan.error || 'ok') + ')');
  check(scan.candidates.length === 1,
    'a probed, eligible target becomes a candidate (' +
    scan.candidates.length + ')');
  const candidate = scan.candidates[0] || {};
  check(candidate.status === 'candidate_eligible',
    'with candidate_eligible status (' + candidate.status + ')');
  check(candidate.frozen === false && candidate.frozenStateKnown === true,
    'and the frozen evidence is recorded as known-and-not-frozen');
  check(candidate.sendEligible === false,
    'while send eligibility stays off: observation is not authorization');
  check(candidate.accountIdentity === 'unverified',
    'and no account identity is invented (' + candidate.accountIdentity + ')');
  check(typeof candidate.token === 'string' && candidate.token.length >= 8,
    'the candidate carries a confirmation token');
  check(candidate.conversationId === CONV, 'with the right conversation id');
  const persisted = await controller.getState();
  check(Array.isArray(persisted.candidates) && persisted.candidates.length === 1,
        'and it is persisted in the binding state');
}

console.log('== T062: a silent content script still yields nothing ==');
{
  const { controller, calls } = build({ silent: true });
  const scan = await controller.scan();
  check(scan.candidates.length === 0,
    'no answer means no candidate (' + scan.candidates.length + ')');
  check(calls.update === 0 && calls.highlight === 0,
    'and nothing tried to activate a tab');
  const probe = (scan.tabs || [])[0] || {};
  check(probe.frozenStateKnown !== true,
    'an unresponsive page proves nothing about frozen state');
}

console.log('== T062: timeout is a refusal, not evidence ==');
{
  const { controller } = build({ silent: true, timeoutMs: 5 });
  const scan = await controller.scan();
  check(scan.candidates.length === 0, 'a timed-out probe yields no candidate');
  const probe = (scan.tabs || [])[0] || {};
  check(probe.status === 'content_unavailable' || probe.status === 'probe_timeout',
    'and is reported as an unreachable content script (' + probe.status + ')');
}

console.log('== T062: navigation during the probe is refused ==');
{
  const { controller } = build({ navigateDuringProbe: true });
  const scan = await controller.scan();
  check(scan.candidates.length === 0,
    'a route change during the probe yields no candidate (' +
    scan.candidates.length + ')');
}

console.log('== T062: a stale observation is refused ==');
{
  const { controller } = build({
    observedAt: Date.now() - 600000,
    now: () => Date.now(),
  });
  const scan = await controller.scan();
  check(scan.candidates.length === 0,
    'a ten-minute-old observation cannot back a candidate (' +
    scan.candidates.length + ')');
}

console.log('== T062: discarded and frozen are still hard refusals ==');
{
  const discarded = build({ tab: { discarded: true } });
  const scanA = await discarded.controller.scan();
  check(scanA.candidates.length === 0, 'a discarded tab never becomes a candidate');

  const frozen = build({ tab: { frozen: true } });
  const scanB = await frozen.controller.scan();
  check(scanB.candidates.length === 0, 'a frozen tab never becomes a candidate');

  const missingComposer = build({ composerPresent: false });
  const scanC = await missingComposer.controller.scan();
  check(scanC.candidates.length === 0,
    'a page without a composer is not offered as a target');
}

console.log('== T062: an existing binding keeps its own frozen evidence check ==');
{
  const { controller } = build({});
  const scan = await controller.scan();
  const candidate = scan.candidates[0];
  const phrase = 'BIND tab=' + candidate.tabId + ' window=' + candidate.windowId +
    ' url=' + candidate.url + ' conversation=' + candidate.conversationId;
  const confirmed = await controller.bind(candidate.token, phrase);
  check(confirmed.ok === true, 'the candidate can be bound with its token (' +
    JSON.stringify(confirmed.ok) + ' ' + (confirmed.status || '') + ')');
  const health = await controller.health();
  check(health.ok === true, 'and then reports healthy (' + health.status + ')');
  check(health.frozen === false && health.frozenStateKnown === true,
    'with frozen state known through the live probe');
}

console.log('== T063: every dropped tab carries a reason, not a shrug ==');
{
  const env = build({ composerPresent: false });
  const scan = await env.controller.scan();
  check(scan.candidates.length === 0, 'no composer means no candidate');
  const rejected = scan.rejected || [];
  check(rejected.length === 1, 'the dropped tab is reported (' + rejected.length + ')');
  const item = rejected[0] || {};
  check(item.reason === 'candidate_page_state_incomplete',
    'with the exact gate that rejected it (' + item.reason + ')');
  check(item.tabId === 11 && item.windowId === 4, 'and its tab identity');
  check(item.status === 'background_observable',
    'the probe itself had succeeded (' + item.status + ')');
  check(item.frozenStateKnown === true && item.frozen === false &&
        item.frozenStateSource === 'live_probe',
        'the frozen evidence is spelled out (' + item.frozenStateSource + ')');
  check(item.composerPresent === false && item.pageLoaded === true,
    'along with the page facts that caused it');
  check(Number.isSafeInteger(item.observedAt), 'and when it was observed');
  check(!('url' in item) && !('body' in item) && !('text' in item) &&
        !('message' in item) && !('token' in item),
        'and nothing beyond the whitelisted diagnostic fields');
}

console.log('== T063: a failing probe reports its own code ==');
{
  const env = build({ silent: true });
  const scan = await env.controller.scan();
  const item = (scan.rejected || [])[0] || {};
  check(item.reason === 'content_unavailable',
    'a silent page is reported as such (' + item.reason + ')');  check(item.frozenStateKnown === false &&
        item.frozenStateSource === 'unknown',
        'and proves nothing about frozen state');
}

console.log('== T063: an eligible tab is not listed as rejected ==');
{
  const env = build({});
  const scan = await env.controller.scan();
  check(scan.candidates.length === 1, 'the good tab is a candidate');
  check((scan.rejected || []).length === 0,
    'and does not also appear in the rejection list (' +
    (scan.rejected || []).length + ')');
}

console.log('== T063: a stale probe is reported as stale, not as frozen ==');
{
  const env = build({ observedAt: Date.now() - 600000, now: () => Date.now() });
  const scan = await env.controller.scan();
  const item = (scan.rejected || [])[0] || {};
  check(item.reason === 'probe_stale' || item.reason === 'candidate_snapshot_stale',
    'the reason names staleness (' + item.reason + ')');
  check(item.observedAt !== null, 'and the observation time is shown');
}

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
