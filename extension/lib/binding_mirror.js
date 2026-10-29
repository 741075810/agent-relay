// T095B76: keep the operator's confirmed target across an extension reload.
//
// T053 stores the binding in `chrome.storage.session` on purpose: it is meant to be
// scoped to the browser session, not remembered forever. But session storage is
// cleared by an extension reload too, so pressing reload in `chrome://extensions`
// silently deleted the one thing the standing T058/T059 grant depends on. The grant
// lives in `storage.local` and survived, which is why the failure looked like this:
//
//   01:22:12.784  reload            → onInstalled
//   01:22:43.497  terminal tick     → blocked, `target_not_bound`
//   autosend      conversationId 6ae2fb9a…, documentInstanceId 51fac95d…  (intact)
//
// Same write moment, same storage area family, one key gone and one key kept. The
// only difference between them was which area they were in.
//
// This module mirrors the binding state into `storage.local` and rehydrates the
// session copy from it. It is deliberately *not* a way to skip re-verification:
//
//   * a mirror is a claim, not a proof. Every send already re-probes the tab and
//     compares tab, window, url, conversation and document instance before typing;
//     restoring the claim cannot get past that, it can only save the operator from
//     retyping something the probe can still prove;
//   * a mirror that fails the shape check is ignored, never "repaired";
//   * an invalidated binding stays invalidated across the reload, because the mirror
//     carries `invalidatedReason` with it. Restoring the record must not restore
//     permission;
//   * nothing is written to the mirror except a value the controller itself just
//     wrote to session, so the two can never disagree about what was confirmed.
export const BINDING_KEY = 't053TargetBindingState';
export const BINDING_MIRROR_KEY = 't053BindingMirror';
export const BINDING_RESTORED_AT_KEY = 't053BindingRestoredAt';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Mirrors the checks `target_binding_controller` applies before it will read a state
// at all. Duplicating them here is intentional: a mirror that only this module
// trusts would be a second, weaker definition of "a valid binding".
export function isMirrorableState(state) {
  if (!isPlainObject(state) || state.version !== 1) return false;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) return false;
  if (!Array.isArray(state.candidates)) return false;
  if (!(state.candidateScannedAt === null ||
        Number.isSafeInteger(state.candidateScannedAt))) return false;
  if (state.binding === null) return true;
  const b = state.binding;
  if (!isPlainObject(b)) return false;
  if (!Number.isSafeInteger(b.tabId) || !Number.isSafeInteger(b.windowId)) return false;
  if (!Number.isSafeInteger(b.revision)) return false;
  if (typeof b.url !== 'string' || typeof b.conversationId !== 'string') return false;
  if (typeof b.documentInstanceId !== 'string') return false;
  return true;
}

/**
 * A `chrome.storage.session`-shaped area that survives a reload by way of `local`.
 *
 * Pass the result wherever the binding controller expects `api.session`. Everything
 * the controller writes goes to both areas; a read that finds the session copy gone
 * puts it back and says when.
 *
 * @param {object} api `{ session, local }`
 * @param {object} [options] `{ now, onRestore }`
 */
export function createMirroredSession(api, options = {}) {
  if (!api || !api.session || !api.local) {
    throw new TypeError('createMirroredSession needs session and local areas');
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onRestore = typeof options.onRestore === 'function' ? options.onRestore : () => {};

  async function restore() {
    const stored = await api.local.get({ [BINDING_MIRROR_KEY]: null });
    const mirror = stored[BINDING_MIRROR_KEY];
    if (mirror === null || mirror === undefined) return { restored: false };
    if (!isMirrorableState(mirror)) {
      // Shape-invalid mirror: leave it alone and leave the session empty. A binding
      // that cannot be read back exactly is not a binding.
      return { restored: false, invalid: true };
    }
    await api.session.set({ [BINDING_KEY]: mirror });
    const at = now();
    await api.local.set({ [BINDING_RESTORED_AT_KEY]: at });
    onRestore({ at, revision: mirror.revision,
      hasBinding: mirror.binding !== null,
      invalidatedReason: mirror.binding ? mirror.binding.invalidatedReason || null : null });
    return { restored: true, at, state: mirror };
  }

  async function get(defaults) {
    const wanted = isPlainObject(defaults) ? defaults : {};
    const values = await api.session.get(wanted);
    if (!Object.prototype.hasOwnProperty.call(wanted, BINDING_KEY)) return values;
    const current = values[BINDING_KEY];
    if (current !== null && current !== undefined) return values;
    const outcome = await restore();
    if (outcome.restored) {
      values[BINDING_KEY] = outcome.state;
      values[BINDING_RESTORED_AT_KEY] = outcome.at;
    }
    return values;
  }

  async function set(items) {
    const payload = isPlainObject(items) ? items : {};
    await api.session.set(payload);
    if (Object.prototype.hasOwnProperty.call(payload, BINDING_KEY)) {
      const value = payload[BINDING_KEY];
      if (value === null || value === undefined) {
        await api.local.remove(BINDING_MIRROR_KEY);
      } else {
        // Written only after the session write succeeded, so a failed session write
        // cannot leave a mirror claiming a state the controller does not hold.
        await api.local.set({ [BINDING_MIRROR_KEY]: value });
      }
    }
    return undefined;
  }

  async function remove(key) {
    await api.session.remove(key);
    if (key === BINDING_KEY) await api.local.remove(BINDING_MIRROR_KEY);
  }

  return { get, set, remove, restore, area: api.session };
}
