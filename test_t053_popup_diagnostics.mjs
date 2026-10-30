// T063: the popup must show *why* every ChatGPT tab was dropped.
//
// popup.js is a classic script and touches the DOM on load, so it cannot be
// imported directly here. Instead this test pulls the two diagnostic functions
// out of the source and runs them against a minimal DOM stub -- the point is the
// rendered text, and that text is what the operator will read off the screen.
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./extension/popup.js', import.meta.url), 'utf8');

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

// Minimal document: just enough for createElement/appendChild/textContent.
function makeElement(tag) {
  return {
    tagName: tag,
    children: [],
    textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; this.textContent = ''; },
  };
}
const documentStub = { createElement: makeElement };

// Evaluate only the diagnostic helpers, in a scope with our stub document.
function loadHelpers() {
  const names = ['describeRejection', 'renderScanDiagnostics'];
  const body = names.map((name) => {
    const start = source.indexOf('function ' + name);
    if (start < 0) throw new Error('missing function ' + name);
    // Brace-match to the end of the function.
    let depth = 0;
    let i = source.indexOf('{', start);
    const from = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    return source.slice(start, i);
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('document', body + '\nreturn { describeRejection, renderScanDiagnostics };')(documentStub);
}

const helpers = loadHelpers();
const NOW = 1_700_000_000_000;

const rejectedItem = {
  tabId: 11, windowId: 4, status: 'background_observable',
  reason: 'candidate_page_state_incomplete', conversationId: 'c-1',
  frozen: false, frozenStateKnown: true, frozenStateSource: 'live_probe',
  observedAt: NOW - 2000, visibilityState: 'visible', hasFocus: true,
  composerPresent: false, pageLoaded: true, active: true, discarded: false,
  hasDocumentInstance: true,
};

console.log('== T063: one dropped tab, every diagnostic field present ==');
{
  const text = helpers.describeRejection(rejectedItem, NOW);
  check(text.includes('tabId=11'), 'shows the tab id');
  check(text.includes('candidate_page_state_incomplete'),
    'shows the exact rejection reason');
  check(text.includes('probe.status=background_observable'),
    'shows that the probe itself succeeded');
  check(text.includes('frozen=false'), 'shows the frozen value');
  check(text.includes('frozenStateKnown=true'), 'shows whether frozen is known');
  check(text.includes('source=live_probe'),
    'shows where the frozen evidence came from');
  check(text.includes('composer=false'), 'shows the fact that caused the drop');
  check(text.includes('observedAt='), 'shows the observation timestamp');
  check(text.includes('2s 前观测'), 'and how old it is, in human terms');
  check(!text.includes('SECRET'), 'and no page content leaked in');
}

console.log('== T063: absent frozen is shown as absent, not as false ==');
{
  const text = helpers.describeRejection(Object.assign({}, rejectedItem, {
    frozen: null, frozenStateKnown: false, frozenStateSource: 'unknown',
    observedAt: null,
  }), NOW);
  check(text.includes('frozen=absent'), 'an absent property reads as absent');
  check(text.includes('observedAt=unknown'),
    'an unknown observation time says so instead of pretending');
}

console.log('== T063: empty scan says something actionable ==');
{
  const container = makeElement('div');
  helpers.renderScanDiagnostics(container, { tabs: [], rejected: [] }, NOW);
  const text = container.children[0].textContent;
  check(text.includes('没有返回任何 ChatGPT 标签'),
    'an empty scan is reported as an empty scan');
  check(text.includes('chatgpt.com/c/'), 'and hints where to look');
}

console.log('== T063: every rejected tab is listed ==');
{
  const container = makeElement('div');
  helpers.renderScanDiagnostics(container, {
    tabs: [{}, {}],
    rejected: [rejectedItem, Object.assign({}, rejectedItem, {
      tabId: 12, reason: 'probe_stale', status: 'probe_stale',
    })],
  }, NOW);
  const text = container.children[0].textContent;
  check(text.includes('tabId=11') && text.includes('tabId=12'),
    'both tabs appear');
  check(text.includes('candidate_page_state_incomplete') &&
        text.includes('probe_stale'), 'with their own distinct reasons');
}

console.log('== T063: a scan with no recorded reasons is flagged, not faked ==');
{
  const container = makeElement('div');
  helpers.renderScanDiagnostics(container, { tabs: [{}], rejected: [] }, NOW);
  const text = container.children[0].textContent;
  check(text.includes('没有记录到拒绝理由'),
    'silence about reasons is admitted rather than invented');
}

console.log('== T063: the build stamp is visible in the popup ==');
{
  // T095B112: one definition. popup.js declares no stamp of its own -- that duplicate is what sat
  // at T069 through forty changes -- and reads the global loaded before it.
  check(!/const BUILD_STAMP = '/.test(source),
    'popup.js holds no literal stamp of its own');
  check(source.includes('globalThis.BUILD_STAMP'), 'it reads the shared stamp instead');
  const shared = readFileSync(
    new URL('./extension/lib/build_stamp.js', import.meta.url), 'utf8');
  check(/BUILD_STAMP = 'T\d{3}-[0-9a-f]{8}'/.test(shared),
    'the shared stamp is the derived T###-<digest> form, not a hand-written label');
  const htmlSource = readFileSync(new URL('./extension/popup.html', import.meta.url), 'utf8');
  check(htmlSource.indexOf('src="lib/build_stamp.js"') >= 0
    && htmlSource.indexOf('src="lib/build_stamp.js"') < htmlSource.indexOf('src="popup.js"'),
    'popup.html loads it before popup.js, or the popup prints stamp-missing');
  check(source.includes('代码版本: '),
    'the popup prints it so a stale load is visible');
}

console.log('== T063: popup stays a classic script (no import) ==');
{
  check(!/^\s*import\s/m.test(source),
    'no top-level import, which a classic script would fail to parse');
}

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
