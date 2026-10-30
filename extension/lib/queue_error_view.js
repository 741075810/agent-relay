// T095B110: one place that decides how a queue error is worded, so the popup and the tests
// agree on what "committed but not durable" means.
//
// The host refuses a write it has already published with `error.committed: true` -- the queue
// file was replaced, the directory entry was not synced. The write is on disk; its survival
// across a power cut is not. That is not the same fact as "nothing happened", and neither is
// the silence of a host that predates the field.
//
// The rule: only `committed === true` may say the write landed. A missing field is "no evidence
// of a commit", which is weaker than "not committed" -- an older host simply cannot answer.

const CLEAN = '—';

function describeQueueError(state) {
  const record = state || {};
  const message = typeof record.lastError === 'string' ? record.lastError : null;
  if (!message) {
    // Nothing failed, or the queue converged after a retry. A leftover flag must not colour a
    // clean state: the uncertainty belonged to an error that no longer exists.
    return { tone: 'ok', text: CLEAN, committed: false };
  }
  if (record.lastErrorCommitted === true) {
    return {
      tone: 'warn',
      committed: true,
      text: '已写入，但耐久性未确认（文件已替换、目录项未同步；不要当作“未写入”重放）：'
        + message,
    };
  }
  if (record.lastErrorCommitted === false) {
    return {
      tone: 'bad',
      committed: false,
      text: '队列写入被拒绝（Host 报告没有已提交证据）：' + message,
    };
  }
  return {
    tone: 'bad',
    committed: false,
    text: '队列写入被拒绝（旧版 Host 不会报告提交状态，无法判断是否落盘；先读回队列再决定）：'
      + message,
  };
}
// popup.js is a classic script on purpose (T063 pins that), so it cannot import: this file is
// loaded by popup.html as a plain script *before* popup.js and shares the decision through one
// global. The test suite imports this module for its side effect and calls the same function,
// so what is tested is what ships -- not a copy.
globalThis.describeQueueError = describeQueueError;