// T045: the request/response layer for a native messaging port.
//
// Why this is a separate module with no `chrome.*` calls in it.
//
// T044 shipped this logic inline in background.js, and it had a defect that cost
// a full debugging round: the pending promise only had a timeout. When Chrome
// closed the port -- host not found, host exited immediately, origin rejected --
// `onDisconnect` fired, `chrome.runtime.lastError` carried the real reason, and
// nothing rejected the promise. Ten seconds later the UI said "no response within
// 10s", which is true and useless: it describes the timer, not the failure.
//
// A defect that hides its own cause cannot be diagnosed from the browser side, so
// the fix has to be verifiable without a browser. Hence this file: pure logic, a
// fake port in the tests, `node --check` and node tests in CI. The `chrome.*`
// surface it needs is injected.

/** Chrome's native messaging limits, as documented. */
export const DEFAULTS = {
  timeoutMs: 10000,
};

export class PortError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'PortError';
    this.kind = kind;          // 'disconnect' | 'timeout' | 'send' | 'host' | 'connect'
    // T095B109: the host can refuse a write that it has already published -- the queue file
    // was replaced but the directory entry was not synced, so the content is on disk and its
    // survival across a power cut is not. That refusal must not look like "nothing happened":
    // a caller that cannot tell the two apart resends a notice for a task that already
    // finished. Older hosts never send the field, so the default is a plain `false`.
    this.committed = false;
  }
}

/**
 * Sends requests over one native messaging port and correlates the replies.
 *
 * @param {object} options
 * @param {() => object} options.connect        returns a port-like object; may throw
 * @param {() => (string|null)} options.readLastError
 *        returns `chrome.runtime.lastError.message`. Chrome only exposes that
 *        property while a listener is running, so it has to be read from inside
 *        the callback rather than captured afterwards.
 * @param {(error: PortError) => void} [options.onFailure]  observability hook
 * @param {number} [options.timeoutMs]
 */
export class NativeClient {
  constructor(options) {
    const opts = options || {};
    if (typeof opts.connect !== 'function') {
      throw new TypeError('NativeClient needs a connect() function');
    }
    this._connect = opts.connect;
    this._readLastError = opts.readLastError || (() => null);
    this._onFailure = opts.onFailure || (() => {});
    this._timeoutMs = opts.timeoutMs || DEFAULTS.timeoutMs;
    this._pending = new Map();
    this._seq = 0;
    this._port = null;
  }

  get connected() {
    return this._port !== null;
  }

  /** Drop the current port without touching pending requests (used by tests). */
  reset() {
    this._pending.clear();
    this._port = null;
  }

  _attach() {
    if (this._port) {
      return this._port;
    }
    let port;
    try {
      port = this._connect();
    } catch (err) {
      // connectNative itself rarely throws -- Chrome reports "host not found"
      // asynchronously -- but when it does, it is the whole answer.
      throw new PortError(
        'could not open the native host: ' + (err && err.message ? err.message : err),
        'connect');
    }
    if (!port) {
      throw new PortError('connect() returned no port', 'connect');
    }
    port.onMessage.addListener((doc) => this._onMessage(doc));
    port.onDisconnect.addListener(() => this._onDisconnect());
    this._port = port;
    return port;
  }

  _onDisconnect() {
    // Read the reason before anything else: `lastError` is only populated for
    // the duration of this callback, and it is the single most useful string in
    // the whole exchange.
    const reason = this._readLastError() || 'the native host closed the port';
    this._port = null;
    if (this._pending.size === 0) {
      this._onFailure(new PortError(reason, 'disconnect'));
      return;
    }
    // Every in-flight request failed for the same reason, so they all get the
    // real one instead of their own timer.
    const pending = Array.from(this._pending.values());
    this._pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      const error = new PortError(reason, 'disconnect');
      this._onFailure(error);
      entry.reject(error);
    }
  }

  _onMessage(doc) {
    if (!doc || typeof doc !== 'object') {
      return;
    }
    const entry = this._pending.get(doc.id);
    if (!entry) {
      // A reply to something we are no longer waiting for (already timed out, or
      // never ours). Ignoring it is correct; guessing would be worse.
      return;
    }
    this._pending.delete(doc.id);
    clearTimeout(entry.timer);
    if (doc.ok) {
      entry.resolve(doc.result);
      return;
    }
    const detail = doc.error || {};
    const failure = new PortError(
      (detail.code || 'host_error') + ': ' + (detail.message || 'no detail'),
      'host');
    // Only an explicit `true` counts. A missing field, a string, or an older host means the
    // write was not published, and guessing the other way would suppress a legitimate retry.
    failure.committed = detail.committed === true;
    entry.reject(failure);
  }

  /**
   * Send one request and settle its promise.
   *
   * Rejects with kind 'disconnect' as soon as the port closes, so a failure is
   * reported in milliseconds with Chrome's own wording rather than after the
   * timeout with a message about the timer.
   */
  request(op, args) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = this._attach();
      } catch (err) {
        this._onFailure(err);
        reject(err);
        return;
      }
      this._seq += 1;
      const id = 'req-' + Date.now().toString(36) + '-' + this._seq;
      const timer = setTimeout(() => {
        const entry = this._pending.get(id);
        if (!entry) {
          return;
        }
        this._pending.delete(id);
        const error = new PortError(
          'the host did not answer ' + op + ' within ' + this._timeoutMs +
          'ms and did not close the port either; it is running but silent',
          'timeout');
        this._onFailure(error);
        reject(error);
      }, this._timeoutMs);

      this._pending.set(id, { resolve, reject, timer, op });
      try {
        port.postMessage({ v: 1, id, op, args: args || {} });
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        const error = new PortError(
          'could not write to the host port: ' + (err && err.message ? err.message : err),
          'send');
        this._onFailure(error);
        reject(error);
      }
    });
  }
}
