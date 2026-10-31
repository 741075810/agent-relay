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

## 7. Files

| File | Purpose |
|---|---|
| `tools/continuation/plans/TEMPLATE.json` | versioned plan template (`goal-plan/1`) |
| `tools/continuation/goal_plan.mjs` | validator + objective/checklist emitter (exit 0 accepted, 2 refused, 3 unreadable) |
| `tools/continuation/dsh_native.mjs` | `buildGoalHandoff`, capability matrix, refusal codes |
| `tools/continuation/probe_dsh.mjs` | read-only capability probe against a runtime manifest |
| `test_t095b155_dsh_native.mjs`, `test_t095b156_goal_plan.mjs` | the tests that pin all of the above |
