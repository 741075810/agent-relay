// T095B152: fake Bridge transport -- the adapter seam, with the outcomes the real one has.
//
// The real adapter is not implemented here on purpose: dispatching a task to the Bridge is a
// supported operation only through an interface this repository does not own, and inventing one
// would mean calling something undocumented against production. So the seam is defined, the fake
// implements it, and README.md states what a real adapter must provide before it is allowed in.
//
// Contract:
//   request({ sessionId, taskId, key, title }) -> { outcome, code? }
//     outcome 'ack'     the Bridge took the work and will run it in that session
//     outcome 'unknown' the request may or may not have been taken
//     outcome 'failed'  the request was refused; retryable unless `code` says otherwise
//   throws BridgeDown when the transport is unavailable (no request left the process)

export class BridgeDown extends Error {
  constructor(message = 'bridge_down') {
    super(message);
    this.code = 'bridge_unavailable';
  }
}

export function createFakeBridge(options = {}) {
  const bridge = {
    calls: [],
    down: options.down === true,
    script: [],
    hanging: null,
    failNext(count, code) {
      for (let i = 0; i < count; i += 1) bridge.script.push({ outcome: 'failed', code });
      return bridge;
    },
    ackNext(count = 1) {
      for (let i = 0; i < count; i += 1) bridge.script.push({ outcome: 'ack' });
      return bridge;
    },
    /** Accepts the request but never answers: the caller must treat it as unknown, not as done. */
    hangOnce() { bridge.hanging = {}; return bridge; },
    async request(payload) {
      bridge.calls.push({ ...payload, at: bridge.calls.length });
      if (bridge.down) throw new BridgeDown();
      if (bridge.hanging) {
        const pending = bridge.hanging;
        bridge.hanging = null;
        return { outcome: 'unknown', pending, code: 'no_reply' };
      }
      const step = bridge.script.length > 1 ? bridge.script.shift() : bridge.script[0];
      if (!step) return { outcome: 'ack' };
      return { outcome: step.outcome, code: step.code };
    },
  };
  return bridge;
}

/** The documented shape of a real adapter. Everything else is out of scope until T152's README. */
export function unsupportedRealAdapter(reason = 'not_implemented') {
  return {
    async request() {
      const err = new Error('continuation transport is not implemented: ' + reason);
      err.code = 'transport_not_supported';
      throw err;
    },
  };
}
