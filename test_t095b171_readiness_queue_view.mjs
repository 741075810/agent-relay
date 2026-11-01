// T171: the readiness line, tested where it actually runs.
//
// The view is a classic script (no modules), so it is loaded the way popup.html loads it: evaluated with
// a `window` object and then called. The wiring half is checked at the real call sites -- the worker's
// readiness return, the popup's render, and the script tag order in popup.html.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');

function loadView() {
  const source = readFileSync(path.join(EXT, 'lib', 'readiness_queue_view.js'), 'utf8');
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(source, context, { filename: 'readiness_queue_view.js' });
  return window;
}

const view = loadView();

test('T171: blocked with a known count names the layer and the number waiting', () => {
  const line = view.readinessQueueLine({ blockedBy: ['t058_grant'], unknownBy: [] }, 2);
  assert.match(line, /blocked: t058_grant/);
  assert.match(line, /2 waiting/);
  assert.match(line, /never retried automatically/);
  assert.match(line, /written_not_clicked, clicked_unknown/);
});

test('T171: blocked with an unknown count says unknown and never 0', () => {
  for (const waiting of [undefined, null, -1, 1.5, '3', NaN]) {
    const line = view.readinessQueueLine({ blockedBy: ['t059_binding'] }, waiting);
    assert.match(line, /blocked: t059_binding/, String(waiting));
    assert.match(line, /waiting: unknown/, String(waiting));
    assert.doesNotMatch(line, /0 waiting/, 'a missing count must not read as an empty queue');
  }
});

test('T171: ready state reads as ready, and a non-empty queue still names the uncertain states', () => {
  const quiet = view.readinessQueueLine({ blockedBy: [], unknownBy: [] }, 0);
  assert.match(quiet, /notifications: ready/);
  assert.match(quiet, /0 waiting/);
  assert.doesNotMatch(quiet, /never retried/, 'nothing waits, so there is nothing to warn about');

  const busy = view.readinessQueueLine({ ok: true, blockedBy: [], unknownBy: [] }, 3);
  assert.match(busy, /notifications: ready/);
  assert.match(busy, /3 waiting/);
  assert.match(busy, /never retried automatically/);
});

test('T171: unknownBy is reported separately from blockedBy', () => {
  const line = view.readinessQueueLine({ blockedBy: [], unknownBy: ['t053_binding'] }, 1);
  assert.match(line, /unknown: t053_binding/);
  assert.doesNotMatch(line, /blocked:/);
});

test('T171: conservative inputs do not throw and do not invent blockers', () => {
  for (const readiness of [undefined, null, {}, { blockedBy: 'x' }, { blockedBy: [1, null, ''] }]) {
    const line = view.readinessQueueLine(readiness, undefined);
    assert.equal(typeof line, 'string');
    assert.match(line, /notifications: /);
  }
  assert.deepEqual(Array.from(view.READINESS_UNCERTAIN_STATES),
    ['written_not_clicked', 'clicked_unknown']);
});

test('T171: the worker carries the count it already computes, and says it is known', () => {
  const bg = readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const i = bg.indexOf('async function readCanaryReadiness');
  const body = bg.slice(i, bg.indexOf('\n}\n', i));
  assert.match(body, /queue: \{/);
  assert.match(body, /waiting: deferredCount/);
  assert.match(body, /waitingKnown: true/);
  assert.match(body, /uncertainStates: \['written_not_clicked', 'clicked_unknown'\]/);
  // Read-only: the readiness function must not write anything back.
  assert.doesNotMatch(body, /storage\.local\.set|saveState|\.set\(/);
});

test('T171: the popup renders it from the readiness result, and the script is loaded first', () => {
  const popup = readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  assert.match(popup, /window\.readinessQueueLine\(ready\.result, waiting\)/);
  assert.match(popup, /waitingKnown === true/);
  const html = readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const viewAt = html.indexOf('lib/readiness_queue_view.js');
  const popupAt = html.indexOf('src="popup.js"');
  assert.ok(viewAt > 0, 'popup.html must load the view script');
  assert.ok(viewAt < popupAt, 'the view must load before popup.js uses it');
});

test('T171: the popup path still sends nothing and clears nothing', () => {
  const popup = readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const block = popup.slice(popup.indexOf("const blocked = ready.result.blockedBy"),
    popup.indexOf("const mark = (item)"));
  assert.doesNotMatch(block, /t069-canary-send|sendReply|\.click\(/);
});
