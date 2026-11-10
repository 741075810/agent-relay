// Campaign-local evidence only. This directory coordinates this owner, NOT legacy Direct writers.
import { openSync, closeSync, readFileSync, writeSync, fsyncSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './productive_manifest.mjs';

export function readControl(path) {
  const control = JSON.parse(readFileSync(path, 'utf8'));
  if (!control || Object.keys(control).sort().join(',') !== 'mode,revision'
    || !['run', 'pause', 'stop'].includes(control.mode)
    || !Number.isSafeInteger(control.revision) || control.revision < 1) throw Error('control_invalid');
  return control;
}
export function openCampaign(directory, plan) {
  const root = resolve(directory);
  // Exclusive creation preserves every existing campaign, including interrupted/partial evidence.
  mkdirSync(root);
  function create(name, text) {
    const fd = openSync(join(root, name), 'wx', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  }
  create('plan.json', JSON.stringify(plan, null, 2) + '\n');
  create('control.json', JSON.stringify({ revision: 1, mode: 'run' }) + '\n');
  const fd = openSync(join(root, 'events.jsonl'), 'wx', 0o600);
  let sequence = 0, closed = false;
  const planSha256 = sha256(JSON.stringify(plan));
  return {
    root, planSha256,
    control: () => readControl(join(root, 'control.json')),
    record(row) {
      if (closed) throw Error('journal_closed');
      writeSync(fd, JSON.stringify({ ...row, sequence: ++sequence, at: Date.now(), planSha256 }) + '\n'); fsyncSync(fd);
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
