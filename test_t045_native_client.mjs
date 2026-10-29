// T045 tests for extension/lib/native_client.js. No Chrome required.
//
// The defect this file exists to pin down: T044's inline request() only had a
// timeout, so when the host port closed the promise was never rejected and the
// UI reported "no response within 10s" ten seconds later. That message describes
// the timer and hides Chrome's own reason. The cases below assert that a
// disconnect now settles the promise promptly and carries the real wording.
//
// The module is loaded from a temporary .mjs copy so this test does not require a
// package.json inside the shipped extension directory. The copy is byte-identical
// (asserted below), so what runs here is what ships.
//
// Run: node test_t045_native_client.mjs

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('./extension/lib/native_client.js', import.meta.url);

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function check(ok, label) {
  if (ok) {
    PASS += 1;
    console.log('  PASS  ' + label);
  } else {
    FAIL += 1;
    FAILURES.push(label);
    console.log('  FAIL  ' + label);
  }
}

// -- fake port ---------------------------------------------------------
class FakePort {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.closed = false;
    this._messageListeners = [];
    this._disconnectListeners = [];
    this.onMessage = {
      addListener: (fn) => { this._messageListeners.push(fn); },
      removeListener: (fn) => {
        this._messageListeners = this._messageListeners.filter((f) => f !== fn);
      },
    };
    this.onDisconnect = {
      addListener: (fn) => { this._disconnectListeners.push(fn); },
      removeListener: (fn) => {
        this._disconnectListeners = this._disconnectListeners.filter((f) => f !== fn);
      },
    };
  }

  postMessage(doc) {
    if (this.closed) {
      throw new Error('Attempting to use a disconnected port object');
    }
    this.sent.push(doc);
  }

  // -- test-side drivers -----------------------------------------------
  reply(doc) {
    for (const fn of this._messageListeners.slice()) {
      fn(doc);
    }
  }

  replyTo(index, mutate) {
    const request = this.sent[index];
    const base = { v: 1, id: request.id, ok: true, result: { echo: request.op } };
    this.reply(mutate ? mutate(base) : base);
  }

  disconnect(lastErrorMessage) {
    this.closed = true;
    for (const fn of this._disconnectListeners.slice()) {
      // Chrome populates lastError only for the duration of this callback, so
      // the fake installs it right before calling and clears it right after.
      FakePort.currentLastError = lastErrorMessage || null;
      try {
        fn();
      } finally {
        FakePort.currentLastError = null;
      }
    }
  }
}
FakePort.currentLastError = null;

const readLastError = () => FakePort.currentLastError;
const noop = () => {};

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), 't045-'));
  const copy = join(dir, 'native_client.mjs');
  const sourceBytes = readFileSync(SOURCE);
  writeFileSync(copy, sourceBytes);
  const copyBytes = readFileSync(copy);
  const mod = await import(pathToFileURL(copy).href);
  rmSync(dir, { recursive: true, force: true });
  return {
    mod,
    sourceDigest: createHash('sha256').update(sourceBytes).digest('hex'),
    copyDigest: createHash('sha256').update(copyBytes).digest('hex'),
  };
}

function shortTimeoutClient(connect, opts) {
  const { NativeClient } = harness.mod;
  return new NativeClient(Object.assign({
    connect,
    readLastError,
    timeoutMs: 120,
  }, opts || {}));
}

let harness = null;

// -- cases -------------------------------------------------------------
async function testHappyPath() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  const pending = client.request('hello', {});
  check(port.sent.length === 1, 'the request was written to the port');
  check(port.sent[0].v === 1 && port.sent[0].op === 'hello',
        'the frame carries v=1 and the op');
  port.replyTo(0);
  const result = await pending;
  check(result && result.echo === 'hello', 'the reply resolves the promise');
}

async function testDisconnectCarriesChromesReason() {
  const port = new FakePort('only');
  const errors = [];
  const client = shortTimeoutClient(() => port, { onFailure: (e) => errors.push(e) });
  const started = Date.now();
  const pending = client.request('hello', {});
  port.disconnect('Specified native messaging host not found.');
  let caught = null;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }
  const elapsed = Date.now() - started;
  check(caught !== null, 'a disconnect rejects the pending request');
  check(caught && caught.kind === 'disconnect', 'and is labelled a disconnect');
  check(caught && caught.message === 'Specified native messaging host not found.',
        'with Chrome\'s own wording, not a message about a timer: ' +
        (caught && caught.message));
  check(elapsed < 100,
        'and promptly (' + elapsed + 'ms), not after the 10s timeout');
  check(errors.length === 1, 'the failure hook saw it once');
}

async function testDisconnectWithoutReasonIsStillReported() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  const pending = client.request('status', {});
  port.disconnect(null);
  let caught = null;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'disconnect',
        'a disconnect with no lastError is still a disconnect');
  check(caught && /closed the port/.test(caught.message),
        'and says so plainly: ' + (caught && caught.message));
}

async function testSilentPortStillTimesOut() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  let caught = null;
  try {
    await client.request('poll', {});
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'timeout',
        'a port that stays open and silent still times out');
  check(caught && /silent/.test(caught.message),
        'and the message says the host is running but silent, which is a '
        + 'different problem from a disconnect');
}

async function testHostErrorResponse() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  const pending = client.request('poll', {});
  port.replyTo(0, (doc) => ({
    v: 1, id: doc.id, ok: false,
    error: { code: 'version_mismatch', message: 'protocol version 2 is not 1' },
  }));
  let caught = null;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'host', 'a host error is its own kind');
  check(caught && caught.message.includes('version_mismatch'),
        'and keeps the host\'s code: ' + (caught && caught.message));
}

async function testUnknownReplyIsIgnored() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  const pending = client.request('hello', {});
  port.reply({ v: 1, id: 'not-ours', ok: true, result: {} });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  check(settled === false, 'a reply with an unknown id settles nothing');
  port.replyTo(0);
  await pending;
  check(true, 'and the real reply still works afterwards');
}

async function testLateReplyAfterTimeoutIsHarmless() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  let caught = null;
  try {
    await client.request('hello', {});
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'timeout', 'the request timed out first');
  port.replyTo(0);
  await new Promise((r) => setTimeout(r, 20));
  check(true, 'a reply arriving after the timeout does not throw');
}

async function testConcurrentRequestsAreCorrelated() {
  const port = new FakePort('only');
  const client = shortTimeoutClient(() => port);
  const first = client.request('hello', {});
  const second = client.request('poll', {});
  check(port.sent.length === 2, 'two requests were written');
  check(port.sent[0].id !== port.sent[1].id, 'each has its own id');
  // Answer them out of order.
  port.replyTo(1);
  port.replyTo(0);
  const results = await Promise.all([first, second]);
  check(results[0].echo === 'hello' && results[1].echo === 'poll',
        'replies are matched by id, not by order');

  const onePort = new FakePort('only');
  check(onePort !== port, 'sanity');
}

async function testReconnectAfterDisconnect() {
  const ports = [];
  const client = shortTimeoutClient(() => {
    const port = new FakePort('p' + ports.length);
    ports.push(port);
    return port;
  });
  const first = client.request('hello', {});
  ports[0].disconnect('Native host has exited.');
  try {
    await first;
  } catch (err) {
    check(err.kind === 'disconnect', 'the first request failed as a disconnect');
  }
  const second = client.request('hello', {});
  check(ports.length === 2,
        'the next request opens a fresh port instead of reusing a dead one');
  ports[1].replyTo(0);
  await second;
  check(true, 'and that fresh port works');
}

async function testConnectThrowingIsReported() {
  const client = shortTimeoutClient(() => {
    throw new Error('nativeMessaging permission missing');
  });
  let caught = null;
  try {
    await client.request('hello', {});
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'connect', 'a throwing connect is its own kind');
  check(caught && caught.message.includes('nativeMessaging permission'),
        'and keeps the underlying reason: ' + (caught && caught.message));
}

async function testSendFailureIsReported() {
  const port = new FakePort('only');
  port.closed = true;                        // postMessage throws
  const client = shortTimeoutClient(() => port);
  let caught = null;
  try {
    await client.request('hello', {});
  } catch (err) {
    caught = err;
  }
  check(caught && caught.kind === 'send', 'a write failure is labelled send');
}

async function testCopyIsByteIdentical() {
  check(harness.sourceDigest === harness.copyDigest,
        'the temporary .mjs imported by Node is byte-identical to the shipped file');
}

async function testTheOldPatternIsGoneFromBackground() {
  const background = readFileSync(
    new URL('./extension/background.js', import.meta.url), 'utf8');
  check(!/addListener\(\(doc\)\s*=>\s*\{\s*if\s*\(!doc\s*\|\|\s*doc\.id\s*!==\s*id\)/.test(background),
        'background.js no longer hand-rolls the id check the module owns');
  check(background.includes('NativeClient'),
        'background.js uses the tested client');
  check(background.includes('readLastError'),
        'and passes Chrome\'s lastError through to it');
}

const TESTS = [
  ['testCopyIsByteIdentical', testCopyIsByteIdentical],
  ['testHappyPath', testHappyPath],
  ['testDisconnectCarriesChromesReason', testDisconnectCarriesChromesReason],
  ['testDisconnectWithoutReasonIsStillReported', testDisconnectWithoutReasonIsStillReported],
  ['testSilentPortStillTimesOut', testSilentPortStillTimesOut],
  ['testHostErrorResponse', testHostErrorResponse],
  ['testUnknownReplyIsIgnored', testUnknownReplyIsIgnored],
  ['testLateReplyAfterTimeoutIsHarmless', testLateReplyAfterTimeoutIsHarmless],
  ['testConcurrentRequestsAreCorrelated', testConcurrentRequestsAreCorrelated],
  ['testReconnectAfterDisconnect', testReconnectAfterDisconnect],
  ['testConnectThrowingIsReported', testConnectThrowingIsReported],
  ['testSendFailureIsReported', testSendFailureIsReported],
  ['testTheOldPatternIsGoneFromBackground', testTheOldPatternIsGoneFromBackground],
];

async function main() {
  console.log('== T045 native client tests (no Chrome) ==');
  console.log('');
  harness = await loadModule();
  for (const [name, fn] of TESTS) {
    console.log(name);
    try {
      await fn();
    } catch (err) {
      FAIL += 1;
      FAILURES.push(name + ' threw');
      console.log('  FAIL  threw: ' + (err && err.message ? err.message : err));
    }
    console.log('');
  }
  console.log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  if (FAILURES.length) {
    for (const label of FAILURES) {
      console.log('  FAILED: ' + label);
    }
    return 1;
  }
  return 0;
}

// `noop` is here so the injected options shape stays visible to readers.
void noop;

main().then((code) => process.exit(code));
