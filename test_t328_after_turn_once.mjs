import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerPreflight, exactFinished, main } from './tools/dsh-direct/after_turn_once.mjs';

test('T328 disabled owner is inert; exact native turn proof is required', async () => {
  await main([]);
  const page = { done: true, admission: { found: true }, turnId: 'turn-1', terminal: { kind: 'completed' } };
  assert.equal(exactFinished(page, 'turn-1'), true);
  assert.equal(exactFinished(page, 'other'), false);
  assert.equal(exactFinished({ ...page, admission: { found: false } }, 'turn-1'), false);
  assert.equal(exactFinished({ ...page, terminal: { kind: 'failed' } }, 'turn-1'), false);
});
test('T328 ledger and preserved reservation refuse without changing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 't328-'));
  try {
    const config = { stateDir: dir, boundSessionIds: ['original'] };
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [{ state: 'running' }] }));
    assert.equal(ledgerPreflight(config, 'original'), 'ledger_unresolved');
    assert.equal(ledgerPreflight(config, 'other'), 'session_not_bound');
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [{ state: 'succeeded' }] }));
    assert.equal(ledgerPreflight(config, 'original'), null);
    mkdirSync(join(dir, '.completion-owner'));
    assert.equal(ledgerPreflight(config, 'original'), 'preserved_owner');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
