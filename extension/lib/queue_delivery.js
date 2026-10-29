// Durable at-least-once handoff from the native host into extension storage.
const MAX_STORED = 100;

function createConsumerId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'dsh-ext-' + Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0')).join('');
}

function errorText(err) {
  return String(err && err.message ? err.message : err);
}

export class QueueDelivery {
  constructor(options) {
    const opts = options || {};
    this.request = opts.request;
    this.get = opts.get;
    this.set = opts.set;
    this.onAdded = opts.onAdded || (() => {});
    this.now = opts.now || (() => new Date().toISOString());
    this.consumerId = opts.consumerId || null;
    if (this.consumerId && !/^[A-Za-z0-9._-]{1,80}$/.test(this.consumerId)) {
      throw new TypeError('consumerId must be a safe 1..80 character token');
    }
    if (typeof this.request !== 'function' || typeof this.get !== 'function' ||
        typeof this.set !== 'function') {
      throw new TypeError('QueueDelivery needs request(), get(), and set()');
    }
    this.scheduleRetry = opts.scheduleRetry || (() => null);
    this.clearRetry = opts.clearRetry || (() => {});
    this._pollTail = Promise.resolve();
    this._retryDelayMs = 30000;
    this._retryTimer = null;
  }

  async storeEvents(events) {
    const stored = await this.get({ received: [] });
    const received = Array.isArray(stored.received) ? stored.received : [];
    const seen = new Set(received.map((event) => event.eventId));
    const accepted = [];
    const ackableIds = [];
    const refused = [];

    for (const event of events) {
      if (!event || typeof event.eventId !== 'string' || !event.eventId) {
        refused.push('(missing eventId)');
        continue;
      }
      if (event.deliverable !== false) {
        refused.push(event.eventId);
        continue;
      }
      if (seen.has(event.eventId)) {
        ackableIds.push(event.eventId);
        continue;
      }
      seen.add(event.eventId);
      accepted.push({
        eventId: event.eventId,
        name: event.name,
        runId: event.runId,
        status: event.status,
        createdAt: event.createdAt,
        message: event.message,
        replay: event.replay === true,
        receivedAt: this.now(),
      });
      ackableIds.push(event.eventId);
    }

    if (refused.length) {
      throw new Error('refusing events without deliverable:false: ' +
                      refused.join(', '));
    }
    if (accepted.length) {
      await this.set({ received: received.concat(accepted).slice(-MAX_STORED) });
    }
    return { added: accepted.length, ackableIds };
  }

  async _scheduleRetry() {
    if (this._retryTimer) return;
    const delay = this._retryDelayMs;
    const pending = {};
    this._retryTimer = pending;
    try {
      const nextDelay = Math.min(delay * 2, 5 * 60 * 1000);
      const handle = await this.scheduleRetry(delay, () => {
        this._retryTimer = null;
        this.poll();
      });
      this._retryTimer = handle || pending;
      await this.set({ retryDelayMs: nextDelay });
      this._retryDelayMs = nextDelay;
    } catch (err) {
      this._retryTimer = null;
      throw err;
    }
  }

  async retryFromAlarm() {
    this._retryTimer = null;
    try {
      await this.clearRetry(null);
    } catch (_alarmError) {
      // Chrome may already have consumed the one-shot alarm.
    }
    return this.poll();
  }

  poll() {
    const current = this._pollTail.then(() => this._pollOnce());
    this._pollTail = current.catch(() => {});
    return current;
  }

  async _pollOnce() {
    let cursor = 0;
    try {
      const state = await this.get({
        cursor: 0, lastPollAt: null, lastError: null, received: [],
        consumerId: null, retryDelayMs: 30000,
      });
      this._retryDelayMs = Number.isSafeInteger(state.retryDelayMs) &&
        state.retryDelayMs >= 30000 && state.retryDelayMs <= 5 * 60 * 1000
        ? state.retryDelayMs : 30000;
      cursor = state.cursor === undefined ? 0 : state.cursor;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error('stored cursor is not a non-negative safe integer');
      }

      let consumerId = state.consumerId || this.consumerId;
      let adoptedFresh = false;
      if (!consumerId) {
        consumerId = createConsumerId();
        adoptedFresh = true;
      }
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(consumerId)) {
        throw new Error('stored consumer id is invalid');
      }
      this.consumerId = consumerId;
      if (state.consumerId !== consumerId) {
        // A freshly minted identity has never acknowledged anything, so a cursor
        // inherited from a lost one would skip events it has not seen. Rewind it
        // in the same write that adopts the identity.
        if (adoptedFresh && cursor > 0) {
          cursor = 0;
          await this.set({ consumerId, cursor: 0 });
        } else {
          await this.set({ consumerId });
        }
      }

      const result = await this.request('poll', {
        cursor, limit: 20, consumer: consumerId,
      });
      if (!result || !Array.isArray(result.events) ||
          !Number.isSafeInteger(result.cursor) || result.cursor < 0) {
        throw new Error('host returned an invalid poll page');
      }

      const saved = await this.storeEvents(result.events);
      if (saved.ackableIds.length) {
        await this.request('ack', {
          acked: saved.ackableIds, consumer: consumerId,
        });
      }

      const committedCursor = Math.max(cursor, result.cursor);
      try {
        await this.set({
          cursor: committedCursor,
          lastPollAt: this.now(),
          lastError: null,
        });
      } catch (err) {
        await this._scheduleRetry();
        throw err;
      }
      if (result.more) {
        queueMicrotask(() => this.poll());
      } else {
        if (this._retryTimer) {
          try {
            await this.clearRetry(this._retryTimer);
            await this.clearRetry(null);
            this._retryTimer = null;
            this._retryDelayMs = 30000;
            await this.set({ retryDelayMs: 30000 });
          } catch (_alarmError) {
            // The periodic poll remains a recovery path.
          }
        } else {
          this._retryDelayMs = 30000;
          await this.set({ retryDelayMs: 30000 });
        }
      }
      if (saved.added) {
        this.onAdded(saved.added);
      }
      return {
        ok: true,
        added: saved.added,
        cursor: committedCursor,
        more: result.more === true,
      };
    } catch (err) {
      const message = errorText(err);
      try {
        await this._scheduleRetry();
      } catch (retryErr) {
        // Preserve the delivery error; the periodic alarm remains the fallback.
        this._lastRetryError = errorText(retryErr);
      }
      try {
        await this.set({ lastPollAt: this.now(), lastError: message });
      } catch (_storageError) {
        // Preserve the original failure; the uncommitted cursor forces a retry.
      }
      return { ok: false, error: message, cursor };
    }
  }
}
