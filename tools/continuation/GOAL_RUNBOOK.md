# Goal runbook (v1) — multi-round work in the fixed native session

Scope: how to drive several independent, gated work rounds in the **same** DSH native session
without the ChatGPT page being in the foreground, using only the goal tooling that ships with DSH.

Written against the installed runtime (`dsh-goal`, `dsh-goal-round-driver`, `dsh-tool-goal`), which
`tools/continuation/probe_dsh.mjs` reports as present **and** enabled. Nothing here creates a goal,
starts a timer or submits work: the operator arms the goal, and the harness runs the rounds.

## 1. Real tool surface (verified in this session, not inferred)

| Tool | Arguments | What it does |
|---|---|---|
| `create_goal` | `objective` (string), `max_goal_rounds` (integer, optional) | persists a goal and arms it for automatic continuation rounds |
| `get_goal` | — | returns `{ goal: { id, revision, objective, phase, roundsStarted, maxGoalRounds }, activation }` |
| `update_goal` | `goal_id`, `revision`, `action` ∈ `edit\|pause\|resume\|complete\|blocked`, plus `objective`/`max_goal_rounds` for `edit`, `blocked_reason` for `blocked` | changes phase; `edit`, `pause`, `resume` need a direct request from the operator; `complete` and `blocked` are allowed during an automatic round |

Observed live state in this session (evidence that the fields are real, and that a finished goal stays
on record):

```json
{"goal":{"id":"goal-…","revision":2,"phase":"complete","roundsStarted":1,"maxGoalRounds":40},
 "activation":"disarmed"}
```

Rules the tool description states, and which the runbook relies on:

* `revision` is required and must be exact — a stale revision is rejected, so a round cannot
  accidentally overwrite a newer goal;
* after a session resume or fork an active goal is **disarmed**; continuing needs
  `update_goal action=resume`;
* `blocked` is rejected until the same blocking condition has persisted for the configured minimum
  number of rounds, and must carry `blocked_reason`.

## 2. Fixed-session conditions

1. One goal per session, armed by the operator, objective text as the whole authorisation surface.
2. The objective names the repository and the approved scope; no task may widen it.
3. Never create a second session to "get a clean start". If a round fails, it fails in place.
4. No goal is created for a task that outlives the current request unless the operator asks for it
   (T156 itself is such a case: its work runs as in-task rounds, not as a persistent goal).

## 3. Round loop

```
1. read the plan (tools/continuation/plans/<plan>.json)
2. node tools/continuation/goal_plan.mjs plans/<plan>.json    # must exit 0
3. paste the printed objective into create_goal (once)
4. per round: implement one plan task, then run the gates:
     python -B -W ignore::ResourceWarning -m unittest discover -s . -p 'test_*.py'
     $env:PYTHON = <python>; Get-ChildItem -Filter 'test_*.mjs' | ForEach-Object { node $_.FullName }
     python -B tools/hygiene_scan.py --all
     python -B tools/release_gate.py --clean-clone
5. commit only when every gate is green; push fast-forward; verify the remote SHA and both CI jobs
6. update_goal action=edit only to NARROW the objective; never to widen scope
7. when the list is done: update_goal action=complete with the evidence summary
```

## 4. Stop conditions

* the approved task list is finished;
* a task needs a scope outside the plan (`stop_and_report`);
* `maxRounds` reached;
* the same gate is red twice in a row for the same reason → `blocked` with `blocked_reason`, not a
  retry loop.

## 5. Failure recovery

| Symptom | Action |
|---|---|
| gates red for a fixable reason | fix inside the round; do not commit |
| a task was implemented on a wrong assumption | revert that round's files, keep the plan, retry once |
| session restarted / goal disarmed | `update_goal action=resume` with the same objective **before** touching files; re-read the plan digest |
| `revision` mismatch | re-read with `get_goal`; never guess a revision |
| wait: a change needs production access | stop and report; do not widen the plan |

## 6. What this does not give you

* no event hook: a completed task does not start the next round on its own — the plan's order is
  enforced by the round loop, not by the harness;
* no unattended resume after a restart: someone (operator or an already-running agent) must call
  `update_goal action=resume`;
* no page dependency: rounds are driven by the session, so the ChatGPT page may be closed, backgrounded
  or on another tab — but that is a property of this session, not of the page.

## 7. Reading an unattended run

`tools/continuation/round_guard.mjs` gives a run two things prose cannot: a durable record per round
and a decision about the next one.

Ledger: one JSON line per round, appended by `createLedger(file).append(entry)`. Fields:

| Field | Meaning |
|---|---|
| `roundId` | identity of the round; a replay returns `duplicate` and appends nothing |
| `taskId` | which plan task the round worked on — an unknown id is a scope stop |
| `planDigest` | sha256 of the approved plan, so the record is tied to what was authorised |
| `gates` | `[{name, result}]` with `result ∈ pass\|fail\|skip` |
| `outcome` | `done`, `continue`, `blocked`, `stop_and_report` |
| `recordDigest` | sha256 over the row's own content, so a silent edit is detectable |

`evaluateStop({plan, records, finishedTaskIds, maxRounds})` returns one of four codes:

| Code | When |
|---|---|
| `continue` | tasks remain, no repeat failure, cap not reached |
| `done` | every approved task has an outcome of `done` |
| `blocked` | the same gate failed twice in a row, or the round cap is reached |
| `stop_and_report` | a round reported a scope stop, or worked outside the plan |

Nothing here creates, arms or resumes a goal: the driver decides when a round starts, and these
functions decide what the finished round left behind and whether another may start.

## 8. Surviving and reviewing a real run

`tools/continuation/round_evidence.mjs` provides offline evidence helpers. Its decision functions
operate on supplied values; `readLedgerFile(file)` reads only the caller-specified file and returns
the complete parser result. Do not point it at production history as part of these offline tests.

| Function | What it answers |
|---|---|
| `recoverTail(text)` | returns valid `records` plus `invalid` (non-object JSON), `unparsable` (syntax errors before the final physical line), and `torn` (unparsable final physical line); no file is rewritten |
| `openRounds(records)` | each record without a terminal outcome stays open; another terminal record for the same task, including an older completion or conflicting duplicate, does not settle it |
| `planDigestOf(plan)` | the same digest `goal_plan.mjs` prints, recomputed from the plan, so the two cannot disagree |
| `verifyPlanBinding({records, plan})` | `ok`, or `plan_drift` naming the rounds recorded against a different plan, or `plan_missing` |
| `buildEvidence({plan, records, commit, gates})` | one entry per round — task, outcome, gates, `recordDigest`, commit, and whether the task is even in the plan (`knownTask`) |
| `renderEvidenceMarkdown(bundle)` | a table plus plan digest, open rounds and `Complete:`, for reading after the fact |

`buildEvidence` reports `problems` and derives `complete` from that list, not from the absence of a
visible one: `out_of_plan:<round>:<task>`, `missing_record_digest:<round>`, `duplicate_round:<round>`,
`open_round:<round>` and `no_rounds`. A run is complete only when the list is empty, and the markdown
renderer prints `Problems:` whenever it is not -- so a done-looking round against a task the plan never
had cannot close the run.

For raw-ledger integrity, pass the original text as `assessRecovery({goal, plan, tailText})`.
Do not pass only `recoverTail(text).records`: that projection discards evidence of rejected lines.
The `records` input is for a complete, independently validated record set, not filtered survivors.
`verifyPlanBinding` returning `plan_drift` still requires explicit re-approval; no helper creates it.

The existing executable offline contract is `test_t095b161b_round_recovery.mjs`: T303 fixtures pass
raw text directly into `assessRecovery`, assert `blocked / ledger_corrupt` and line indexes, and
check input immutability and rejected-content non-disclosure. Clean-text and torn-tail-only controls
remain covered. Run only that suite from the repository root:

```powershell
node --test --test-timeout=10000 test_t095b161b_round_recovery.mjs
```

No new adapter is needed to exercise this route. These synthetic strings do not read a ledger file,
contact a Host/Bridge, or dispatch work. The decision reports zero-based diagnostic line indexes,
not raw rejected content; retain the original text separately as evidence.

## 9. Proving a round came from the driver

A commit message saying "native goal round N" is a claim. `tools/continuation/round_provenance.mjs`
joins three things so it becomes evidence:

* `normalizeRecord({goal, taskId, planDigest, commit, outcome})` -> one record with the goal's real
  `id`, `revision`, `roundsStarted`, `phase`, `activation`, plus refusal codes (`goal_id_missing`,
  `rounds_started_missing`, `revision_missing`, `plan_digest_invalid`, `commit_invalid`,
  `phase_invalid`, `activation_invalid`);
* `linkProvenance({goal, records, commits, planDigest})` -> `ok` or `provenance_gap`, with each
  problem named: `foreign_goal`, `duplicate_rounds_started`, `rounds_started_went_backwards`,
  `ledger_ahead_of_goal`, `goal_ahead_of_ledger`, `plan_mismatch`, `commit_not_in_log`,
  `done_without_commit`, `unreadable_record`;
* `renderProvenanceMarkdown(report)` -> the table an operator reads, ending in a verdict and a digest.

`commitPresent` is tri-state: `true` the commit is in the supplied `git log`, `false` it is not, `null`
no log was supplied so existence was never checked. The renderer prints `unverified` for `null`, because
"not checked" reported as "present" is the failure this module exists to prevent.

## 10. What to do after a restart

`tools/continuation/round_recovery.mjs` returns an offline assessment, not authority to dispatch.
The T304 repository audit found no non-test caller of `assessRecovery` or `readLedgerFile`.
The non-test `recoverTail` calls are internal to those two helpers and preserve diagnostics.
This is not evidence of deployed integration: external consumers and runtime wiring were not inspected.
No helper resumes goals, clears ledgers, releases leases or calls a production service.

Decision codes and conservative handling:

| Decision | When | First step |
|---|---|---|
| `blocked`, `why=ledger_corrupt` | parser reports invalid/non-object or unparsable interior lines, even alongside a torn tail or complete goal | preserve **all** original evidence; no deletion, rewrite, resume or retry |
| `discard_tail` | only the final physical line is unparsable, with no other rejected lines; checked before complete | preserve the original first; the code is legacy repair advice, not an automatic file operation or dispatch permission; reconcile unknown work before any repair/reassessment |
| `nothing_to_do` | goal is complete after raw-text integrity checks | no new round; this does not prove unknown upstream work settled |
| `revision_drift` | a round claims a revision newer than the goal | stop; report the gap without replay |
| `plan_changed` | plan digest differs | stop; retain evidence and require explicit re-approval |
| `blocked` (other reasons) | missing plan or missing row revision | stop and report the specific reason |
| `finish_open_round_first` | a record remains nonterminal | establish authoritative settlement, not a synthetic terminal record merely to clear this check |
| `needs_human_resume` | goal is disarmed | remain stopped until explicit resume; do not create a replacement goal |
| `resume_ok` | the helper's supplied inputs pass its checks | assessment only; not proof of runtime permission, upstream rejection or a runnable production driver |

With a valid goal, rejected-line corruption blocks first; otherwise torn-tail-only handling precedes
complete. Revision drift precedes plan mismatch, open rounds precede activation, and disarmed never
means automatic resume. A trailing newline makes an earlier syntax failure an interior failure;
`torn` is a parser classification, not forensic proof of why a write ended.

**Unknown accepted work:** `desktop_host_exited`, a lost callback or an unreadable record does not
prove the upstream rejected the task. Do not automatically retry, clear history, release a lease,
rearm a goal or discard uncommitted Git work. T306 advisory regressions require original-tail
preservation, authoritative settlement evidence and assessment-only `resume_ok` wording. The legacy
`discard_tail` code remains for compatibility; it is not an instruction to delete evidence.
Preserve original session identity, consent and task history. Any future production integration needs
its own authoritative reconciliation and authorization contract; this runbook does not enable one.

## 11. Files

| File | Purpose |
|---|---|
| `tools/continuation/plans/TEMPLATE.json` | versioned plan template (`goal-plan/1`) |
| `tools/continuation/goal_plan.mjs` | validator + objective/checklist emitter (exit 0 accepted, 2 refused, 3 unreadable) |
| `tools/continuation/dsh_native.mjs` | `buildGoalHandoff`, capability matrix, refusal codes |
| `tools/continuation/probe_dsh.mjs` | read-only capability probe against a runtime manifest |
| `test_t095b155_dsh_native.mjs`, `test_t095b156_goal_plan.mjs` | the tests that pin all of the above |
