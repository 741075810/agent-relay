// Explicit offline import only. No runtime entrypoint, coordinator creation or grant changes.
import { assessRecovery, DECISION } from './round_recovery.mjs';
import { planDigestOf } from './round_evidence.mjs';
import { createOfflineBoundReceiptAdapter } from './offline_bound_receipt.mjs';

export function createOfflineHandoff({ enabled = false, identity, planDigest, store, transport } = {}) {
  const expected = structuredClone(identity);
  const adapter = createOfflineBoundReceiptAdapter({ enabled, transport });
  let used = false;
  let active = null;
  let entered = false;
  const unknown = code => ({ outcome: 'unknown', code });
  const bridge = Object.freeze({ async request(request) {
    if (!active || entered) return unknown('offline_boundary_inactive');
    entered = true;
    try {
      const checkpoint = active.co.checkpoint();
      const parsed = JSON.parse(checkpoint);
      const job = parsed.store?.jobs?.[request.key];
      if (parsed.version !== 1 || parsed.sessionId !== expected.sessionId
        || request.sessionId !== expected.sessionId || job?.state !== 'leased'
        || job.sessionId !== request.sessionId || job.taskId !== request.taskId
        || job.epoch !== request.epoch || job.attempts !== request.attempt) {
        return unknown('lease_binding_invalid');
      }
      const envelope = { version: 1, ...expected, ...active.evidence, checkpoint };
      const exact = JSON.stringify(envelope);
      if ((await store.write(envelope))?.code !== null) return unknown('checkpoint_write_unverified');
      const saved = await store.read();
      if (saved?.code !== null || JSON.stringify(saved.envelope) !== exact
        || active.co.checkpoint() !== checkpoint) return unknown('checkpoint_readback_unverified');
      return await adapter.request(request);
    } catch { return unknown('checkpoint_or_transport_unverified'); }
  } });
  return Object.freeze({ bridge, async step(co, { tailText, goal, plan, at } = {}) {
    if (enabled !== true) return { code: 'disabled' };
    if (used) return { code: 'offline_boundary_used' };
    // One-shot even for rejected evidence; no implicit retry/reset or receipt replay.
    used = true;
    try {
      if (!expected || typeof expected.sessionId !== 'string' || !expected.sessionId
        || typeof expected.goalId !== 'string' || !expected.goalId
        || !Number.isSafeInteger(expected.goalRevision) || expected.goalRevision < 1
        || typeof tailText !== 'string' || !goal || !plan || !Number.isFinite(at)
        || typeof planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(planDigest)
        || !store || typeof store.read !== 'function' || typeof store.write !== 'function'
        || !transport || typeof transport.request !== 'function') return { code: 'offline_input_invalid' };
      if (goal.id !== expected.goalId || goal.revision !== expected.goalRevision
        || co?.sessionId !== expected.sessionId || co.bridge !== bridge
        || planDigestOf(plan) !== planDigest) return { code: 'offline_binding_mismatch' };
      const evidence = structuredClone({ tailText, goal, plan });
      const recovery = assessRecovery(evidence);
      if (recovery.code !== DECISION.RESUME_OK) return { code: 'recovery_refused', recovery };
      const before = co.checkpoint();
      const prior = await store.read();
      if (prior?.code !== 'missing') {
        if (prior?.code !== null) return { code: 'checkpoint_unreadable' };
        const old = prior.envelope;
        if (old?.sessionId !== expected.sessionId || old.goalId !== expected.goalId
          || old.goalRevision !== expected.goalRevision || old.checkpoint !== before) {
          return { code: 'checkpoint_stale_or_mismatched' };
        }
      }
      if (co.checkpoint() !== before) return { code: 'checkpoint_changed' };
      active = { co, evidence: { ...evidence, recovery } };
      return await co.step(at);
    } catch { return { code: 'offline_preflight_error' }; }
    finally { active = null; }
  } });
}
