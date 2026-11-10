// Finite caller of the existing DirectServer API. No config/secret reads or runtime wiring.
import { createHash } from 'node:crypto';
import { isTaskId, isRequestId, isSessionId, validateSubmitTask } from './protocol.mjs';

export function continuationRequestId(trigger) {
  return 'continue-' + createHash('sha256').update(JSON.stringify([
    trigger.sessionId, trigger.taskId, trigger.requestId, trigger.turnId,
  ])).digest('hex');
}

export function createContinueOnce({ enabled = false, client, verifyResult, budgetMs = 10000 } = {}) {
  let used = false;
  return Object.freeze({ async run(input) {
    if (enabled !== true) return { code: 'disabled', submitted: false };
    if (used) return { code: 'runner_used', submitted: false };
    used = true;
    let attempted = false;
    let requestId = null;
    const deadline = performance.now() + budgetMs;
    async function bounded(fn) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('deadline');
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('deadline')), remaining);
        })]);
      } finally { clearTimeout(timer); }
    }
    try {
      const { trigger, next } = structuredClone(input);
      if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 120000
        || !client || !['getResult', 'listSessions', 'submitTask'].every(k => typeof client[k] === 'function')
        || typeof verifyResult !== 'function'
        || !isTaskId(trigger?.taskId) || !isRequestId(trigger?.requestId)
        || !isSessionId(trigger?.sessionId) || typeof trigger?.turnId !== 'string' || !trigger.turnId
        || typeof trigger?.projectId !== 'string' || !trigger.projectId) {
        return { code: 'invalid_input', submitted: false };
      }
      requestId = continuationRequestId(trigger);
      const submission = validateSubmitTask(next);
      if (submission.requestId !== requestId || submission.sessionId !== trigger.sessionId
        || submission.projectId !== trigger.projectId) return { code: 'binding_mismatch', submitted: false };
      const reply = await bounded(() => client.getResult({ taskId: trigger.taskId }));
      const task = reply?.task;
      if (reply?.ok !== true || task?.state !== 'succeeded' || task.requiresReconcile !== false
        || task.unknownReason != null || task.error != null
        || !['taskId', 'requestId', 'sessionId', 'projectId', 'turnId'].every(k => task[k] === trigger[k])
        || task.result?.admission?.found !== true || typeof task.result?.text !== 'string') {
        return { code: 'completion_unverified', submitted: false };
      }
      // Trusted caller's acceptance check, not a claim that terminal status proves useful work.
      if (await bounded(() => verifyResult(structuredClone(task))) !== true) {
        return { code: 'acceptance_failed', submitted: false };
      }
      const listing = await bounded(() => client.listSessions({ projectId: trigger.projectId }));
      const sessions = listing?.sessions?.filter(s => s.sessionId === trigger.sessionId);
      if (listing?.ok !== true || sessions?.length !== 1 || sessions[0].cwd !== trigger.projectId
        || sessions[0].running !== false || sessions[0].agentAvailable !== true) {
        return { code: 'idle_unverified', submitted: false };
      }
      const receipt = await bounded(() => {
        attempted = true; // before invoking the only submit; timeout is uncertainty, never nonacceptance
        return client.submitTask(submission);
      });
      const accepted = receipt?.task;
      if (receipt?.ok !== true || !isTaskId(accepted?.taskId)
        || !['requestId', 'sessionId', 'projectId'].every(k => accepted[k] === submission[k])
        || accepted.promptSha256 !== createHash('sha256').update(submission.prompt).digest('hex')
        || accepted.requiresReconcile !== false || accepted.unknownReason != null
        || !['running', 'succeeded'].includes(accepted.state)) {
        return { code: 'submission_unknown', submitted: 'unknown', requestId };
      }
      return { code: 'handoff_recorded', submitted: true, requestId, taskId: accepted.taskId,
        state: accepted.state, duplicate: receipt.duplicate === true, completionVerified: false };
    } catch {
      return { code: attempted ? 'submission_unknown' : 'preflight_unverified',
        submitted: attempted ? 'unknown' : false, requestId };
    }
  } });
}
