// T095B161 round 3: an exhaustive boundary audit of the notification consent gate.
//
// `optInUsable` is the function that decides whether a page notice may be sent for a task. AGENTS.md's
// one unbreakable rule lives here, so it gets swept rather than spot-checked: every combination of
// (armedAt, endedAtMs) in a boundary grid, plus every shape of absent or malformed terminal time, plus
// the opt-in lifecycle states. The sweep asserts the rule directly -- allowed exactly when
// `armedAt < endedAtMs` -- instead of asserting whatever the implementation happens to do.
//
// This suite is read-only in spirit: it loads the real module and calls it.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib', 'terminal_trigger.js');
const TT = await import(pathToFileURL(LIB).href + '?r=t161c'
  + Math.random().toString(36).slice(2));

const NOW = 1793600000000;
const entry = (over = {}) => ({ runId: 'run-1', armedAt: NOW - 60000, consumedAt: null, ...over });
const cand = (over = {}) => ({ runId: 'run-1', endedAtMs: NOW - 1000, ...over });

test('T161-3: the gate allows exactly when armedAt < endedAtMs, across every boundary', () => {
  const armedAt = NOW - 60000;
  const offsets = [-2, -1, 0, 1, 2];
  for (const offset of offsets) {
    const endedAtMs = armedAt + offset;
    const out = TT.optInUsable(entry({ armedAt }), cand({ endedAtMs }), NOW);
    if (offset > 0) {
      assert.equal(out.ok, true, 'armedAt + ' + offset + ' must be allowed: ' + JSON.stringify(out));
      assert.equal(out.armedAt, armedAt);
      assert.equal(out.endedAtMs, endedAtMs);
    } else {
      assert.equal(out.ok, false, 'armedAt + ' + offset + ' must be refused');
      assert.equal(out.code, 'opt_in_after_terminal', 'offending pair ' + armedAt + '/' + endedAtMs);
      assert.equal(out.armedAt, armedAt, 'the refusal carries both numbers for the operator');
      assert.equal(out.endedAtMs, endedAtMs);
    }
  }
});

test('T161-3: the same millisecond is refused, not tolerated as "close enough"', () => {
  const t = NOW - 5000;
  const out = TT.optInUsable(entry({ armedAt: t }), cand({ endedAtMs: t }), NOW);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'opt_in_after_terminal');
});

test('T161-3: an absent or unusable terminal time never authorises a notice', () => {
  const bad = [undefined, null, 0, -1, -0.5, 1.5, NaN, Infinity, -Infinity, '1793500000000', {}];
  for (const endedAtMs of bad) {
    const out = TT.optInUsable(entry(), cand({ endedAtMs }), NOW);
    assert.equal(out.ok, false, 'endedAtMs=' + String(endedAtMs) + ' must not authorise');
    assert.equal(out.code, 'terminal_time_unknown', 'endedAtMs=' + String(endedAtMs));
  }
});

test('T161-3: the opt-in lifecycle states each refuse with their own code', () => {
  const cases = [
    [null, 'no_opt_in'],
    [entry({ consumedAt: NOW - 1 }), 'already_settled'],
    [entry({ armedAt: 0 }), 'opt_in_unreadable'],
    [entry({ armedAt: NaN }), 'opt_in_unreadable'],
    [entry({ armedAt: NOW + TT.OPTIN_FUTURE_SLACK_MS + 1000 }), 'opt_in_from_the_future'],
    [entry({ armedAt: NOW - TT.OPTIN_MAX_AGE_MS - 1000 }), 'opt_in_expired'],
  ];
  for (const [optIn, code] of cases) {
    const out = TT.optInUsable(optIn, cand(), NOW);
    assert.equal(out.ok, false, code);
    assert.equal(out.code, code);
  }
});

test('T161-3: an opt-in carries its run, and a notice for another run is refused', () => {
  // The identity rule from AGENTS.md: never infer identity from a guess. A consent recorded for run A
  // must not authorise a notice about run B, however well the timestamps line up.
  const out = TT.optInUsable(entry({ runId: 'run-A' }), cand({ runId: 'run-B' }), NOW);
  assert.equal(out.ok, false, 'cross-run consent must not send');
  assert.equal(out.code, 'opt_in_run_mismatch');
});

test('T161-3: a matching or absent run id still behaves by the time rule', () => {
  assert.equal(TT.optInUsable(entry({ runId: 'run-1' }), cand({ runId: 'run-1' }), NOW).ok, true);
  // Legacy entries without a run id keep the old behaviour: the time rule decides.
  assert.equal(TT.optInUsable(entry({ runId: undefined }), cand({ runId: 'run-1' }), NOW).ok, true);
  assert.equal(TT.optInUsable(entry({ runId: 'run-1' }), cand({ runId: undefined }), NOW).ok, true);
});

test('T161-3: the sweep is exhaustive over the grid, not a sample of it', () => {
  let allowed = 0;
  let refused = 0;
  for (let armed = 0; armed <= 6; armed++) {
    for (let ended = 0; ended <= 6; ended++) {
      // Relative to NOW, so the age window cannot mask the comparison being swept.
      const armedAt = NOW - 60000 + armed;
      const endedAtMs = NOW - 60000 + ended;
      const out = TT.optInUsable(entry({ armedAt }), cand({ endedAtMs }), NOW);
      if (armedAt < endedAtMs) {
        assert.equal(out.ok, true, armedAt + '<' + endedAtMs);
        allowed++;
      } else {
        assert.equal(out.code, 'opt_in_after_terminal', armedAt + '>=' + endedAtMs);
        refused++;
      }
    }
  }
  assert.equal(allowed, 21, 'strict triangle of a 7x7 grid');
  assert.equal(refused, 28);
});
