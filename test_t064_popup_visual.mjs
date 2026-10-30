// Static checks for the popup visual update (T064).
//
// The popup is the one surface a human reads before authorizing anything, so the
// restyle is checked the way the safety invariants are checked: by parsing the
// real file, not by eyeballing it. Nothing here asserts colours; it asserts that
// the restyle did not move a single hook the JavaScript depends on.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./extension/popup.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./extension/popup.js', import.meta.url), 'utf8');

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(ids);

console.log('== T064: every id popup.js needs is still declared ==');
{
  const wanted = [...source.matchAll(/getElementById\('([^']+)'\)/g)]
    .map((m) => m[1]);
  const missing = wanted.filter((id) => !idSet.has(id));
  check(wanted.length > 20, 'popup.js still resolves its elements (' +
    wanted.length + ' lookups)');
  check(missing.length === 0,
    'no getElementById target went missing (' + JSON.stringify(missing) + ')');
}

console.log('== T064: the ids the other modules depend on are untouched ==');
{
  const required = [
    'bindingScan', 'bindingCandidates', 'bindingConfirmation',
    'bindingConfirmationPhrase', 'bindingConfirmationInput', 'bindingConfirm',
    'bindingCancel', 'bindingHealth', 'bindingClear', 'bindingHealthResult',
    't053BuildStamp',
    'dryRunStatus', 'dryRunRunId', 'dryRunGenerate', 'dryRunEvaluate',
    'dryRunResult', 'dryRunHistoryInfo',
    'receivedReviewList', 'receivedReviewChoice', 'receivedReviewMetadata',
    'receivedReviewEvaluate', 'receivedReviewResult',
    'notifyAuthState', 'notifyAuthPhrase', 'notifyAuthConfirmation',
    'notifyAuthRefresh', 'notifyAuthArm', 'notifyAuthDisarm', 'notifyAuthResult',
    'terminalTriggerState', 'terminalTriggerPhrase',
    'terminalTriggerConfirmation', 'terminalTriggerArm', 'terminalTriggerDisarm',
    'terminalTriggerResult',
    'host', 'caps', 'queue', 'lastPoll', 'lastError', 'received', 'tabs',
    'hello', 'status', 'poll', 'simulate', 'scan', 'readonlyProbe',
  ];
  const missing = required.filter((id) => !idSet.has(id));
  check(missing.length === 0,
    'all ' + required.length + ' original ids survive (' +
    JSON.stringify(missing) + ')');
  check(ids.length === idSet.size, 'no id is declared twice');
}

console.log('== T064: no new control can send ==');
{
  const lowered = html.toLowerCase();
  check(!lowered.includes('id="send'), 'no id begins with send');
  const controls = [...lowered.matchAll(/<(button|input)\b[^>]*>/g)]
    .map((m) => m[0]);
  const bad = controls.filter((tag) => tag.includes('send') ||
    tag.includes('发送') || tag.includes('提交'));
  check(bad.length === 0, 'no button/input mentions sending (' +
    JSON.stringify(bad) + ')');
  // T122 added exactly two controls: the text box for the restricted phrase and the button
  // that arms it. The count is a tripwire, not a design rule -- when it moves, say here which
  // controls were added and why.
  check(controls.length === 32,
    'the control count is 30 plus the two T122 single-shot controls ('
    + controls.length + ')');
}

console.log('== T064: the anchor bar points at sections that exist ==');
{
  const links = [...html.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
  check(links.length === 5, 'five jump links (' + links.length + ')');
  const targets = links.filter((id) => !idSet.has(id));
  check(targets.length === 0, 'every anchor target exists (' +
    JSON.stringify(targets) + ')');
  check(links.join(',') === 'sec-t053,sec-t054,sec-t055,sec-t065,sec-t058',
    'they point at the five numbered modules (' + links.join(',') + ')');
  // The bar must be inert: no script, no form, nothing that could fire a call.
  const nav = /<nav[\s\S]*?<\/nav>/.exec(html);
  check(Boolean(nav), 'the bar is a nav element');
  check(nav && !/<(script|button|input|form)/i.test(nav[0]),
    'and contains no control, only links');
}

console.log('== T064: numbered titles are visible and bold ==');
{
  const badges = [...html.matchAll(/class="mod-no">([^<]+)</g)].map((m) => m[1]);
  check(badges.length === 8, 'eight number badges (' + badges.length + ')');
  for (const wanted of ['T053', 'T054', 'T055', 'T058/T059', 'T059', 'T067',
    'T068']) {
    check(badges.includes(wanted), 'badge present: ' + wanted);
  }
  // Each badge must sit inside a heading, not in loose text.
  const loose = [...html.matchAll(/<span class="mod-no">/g)].length;
  const inHeading = [...html.matchAll(
    /<h[23] class="mod-title">[\s\S]{0,80}?<span class="mod-no">/g)].length;
  check(loose === inHeading,
    'every badge is inside a module heading (' + inHeading + '/' + loose + ')');
  check(/\.mod-title\s*\{[^}]*font-weight:\s*700/.test(html),
    'titles are bold');
  check(/--mod-title:\s*#8f1414/.test(html), 'light theme uses a dark red title');
  check(/--mod-title:\s*#ff9d9d/.test(html),
    'dark theme lifts the same hue so it stays readable');
}

console.log('== T064: the tinted rail is on the module sections ==');
{
  // Seven content sections carry the styling; the plain toolbar section between
  // them stays unstyled on purpose -- it is four buttons, not a module, and
  // giving it a header would imply it is one.
  const modules = [...html.matchAll(/<section class="module"/g)].length;
  const plain = [...html.matchAll(/<section>/g)].length;
  check(modules === 8, 'eight sections carry the module styling (' + modules + ')');
  check(plain === 1,
    'and only the button toolbar is left plain (' + plain + ')');
  check(/section\.module\s*\{[^}]*border-left:\s*3px solid var\(--mod-line\)/.test(html),
    'the left accent rail is declared');
  check(/section\.module\s*\{[^}]*background:\s*var\(--mod-bg\)/.test(html),
    'the soft background comes from a variable');
  const bg = /--mod-bg:\s*(#[0-9a-f]{6})/.exec(html);
  check(Boolean(bg), 'the light background is a hex colour (' +
    (bg ? bg[1] : 'absent') + ')');
  // A soft tint, not a saturated fill: each channel has to stay high.
  const soft = bg && [1, 3, 5].every((at) =>
    parseInt(bg[1].slice(at, at + 2), 16) >= 0xd0);
  check(soft, 'and it is pale enough to read text on');
}

console.log('== T064: dark mode is handled, not ignored ==');
{
  check((html.match(/@media \(prefers-color-scheme: dark\)/g) || []).length >= 2,
    'dark overrides are declared for modules and status colours');
  const colourScheme = /:root\s*\{[^}]*color-scheme:\s*light dark/.test(html);
  check(colourScheme, 'the document still opts into both colour schemes');
}

console.log('== T064: width stays inside the popup ==');
{
  check(/body\s*\{[^}]*width:\s*22rem/.test(html), 'popup width unchanged');
  check(/nav\.anchors\s*\{[^}]*flex-wrap:\s*wrap/.test(html),
    'the jump bar wraps instead of overflowing');
  check(/nav\.anchors a\s*\{[^}]*white-space:\s*nowrap/.test(html),
    'individual links do not break mid-label');
  check(/section\.module\s*\{[^}]*margin:\s*\.45rem \.5rem/.test(html),
    'module cards are inset from the 22rem edges');
}

console.log('== T064: popup.js was not needed and was not touched ==');
{
  check(!/^\s*import\s/m.test(source),
    'popup.js stays a classic script (no top-level import)');
  check(source.includes('globalThis.BUILD_STAMP'),
    'the popup still prints a stamp, now from the single shared definition');
  check(!/querySelector|scrollIntoView/.test(source),
    'no new DOM API the popup stub does not provide');
}

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
