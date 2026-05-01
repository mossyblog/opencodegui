# TillDone Production Plan

## Problem

The current TillDone runner is wired through the TUI and API, but the scheduler is not a real worker pool yet.

Observed behavior:

- Two workers start.
- One worker finishes.
- The finished worker waits while the other continues.
- New work is not immediately claimed by the free capacity.

Root cause:

- The current runner starts one sequential loop per agent.
- Worker capacity is effectively tied to agent names, not independent worker slots.
- A finished agent loop can poll or idle while another agent loop remains active.
- The runner waits for all agent loops to settle instead of continuously filling open worker slots from the queue.

This is a half-finished orchestration model. The production behavior needs to be slot-based and queue-driven.

## Target Behavior

TillDone should behave like a bounded worker pool over the project task queue.

- `maxWorkers` means concurrent worker slots, not number of agents.
- The scheduler should keep worker slots busy while runnable tasks exist.
- When a worker finishes, its slot should immediately claim the next runnable task.
- Unassigned tasks should run on any compatible available subagent.
- Assigned tasks should only run on the assigned agent.
- The runner should only complete when there are no active workers and no runnable pending tasks.
- Stop should be graceful: no new claims, active workers finish.
- Abort should be hard: cancel active child sessions and mark active tasks interrupted.
- Restart/recovery should not leave tasks permanently stuck in `claimed` or `in_progress`.

## Definitions

Runnable task:

- status is `pending`.
- if `assignedAgent` is set, that agent exists and is available.
- if `assignedAgent` is unset, at least one available subagent can run it.

Active task:

- status is `claimed` or `in_progress`.
- has an active worker record or stale worker record.

Terminal task:

- `completed`.
- `cancelled`.
- `blocked`.
- `interrupted`.
- `failed`.

Runner states:

- `idle`: no runner is active.
- `running`: scheduler is claiming and running tasks.
- `stopping`: graceful stop requested; active workers may continue; no new claims.
- `aborting`: hard abort requested; active workers are being cancelled.
- `complete`: no active workers and no runnable work remains.
- `blocked`: no active workers remain, but tasks are blocked, interrupted, failed, or impossible to assign.
- `error`: scheduler failed unexpectedly.

## Required Architecture

### 1. Central Scheduler

Replace the current per-agent loop with one central scheduler loop.

The scheduler owns:

- runner state.
- worker slot lifecycle.
- task selection.
- agent selection.
- child session creation/reuse.
- stop/abort handling.
- completion state calculation.

High-level loop:

```text
while runner is running:
  recover stale state if needed
  refresh active workers
  fill open worker slots with runnable tasks
  if no active workers and no runnable tasks:
    finish as complete or blocked
  sleep briefly or wait for worker completion signal
```

### 2. Worker Slots

Worker slots are independent from agents.

Each slot tracks:

- slot id.
- task id.
- agent name.
- child session id.
- status.
- started timestamp.
- updated timestamp.
- last error, if any.

Slots are reused:

- slot starts task A.
- task A finishes.
- slot immediately claims task B.
- repeat until queue is drained, stop is requested, or abort is requested.

### 3. Task Selection

The scheduler should choose tasks before choosing workers.

Selection order:

1. Pending high-priority tasks.
2. Pending medium-priority tasks.
3. Pending low-priority tasks.
4. Existing queue position within the same priority.

Agent compatibility:

- If task has `assignedAgent`, only that agent may claim it.
- If unassigned, choose an available subagent.
- Do not choose hidden subagents.
- Do not choose main/general unless explicitly allowed by existing agent config.

### 4. Atomic Claim

Task claims must remain atomic.

Requirements:

- Two worker slots must not claim the same task.
- Claim should update task status and owner in one transaction.
- Claim should be conditional on current status still being `pending`.
- The returned task should include updated claim metadata.

Current `Todo.claimNext` is close, but the scheduler may need one of these shapes:

- `claimNext({ sessionID, agent })` for agent-specific claiming.
- or `claimNextRunnable({ sessionID, agents })` that picks task and agent together in one transaction.

Preferred production shape:

- Add `Todo.claimNextRunnable({ sessionID, agents })`.
- It receives available agent names in scheduler priority order.
- It selects the best pending task and compatible agent inside one transaction.
- It returns `{ claimed, agent }`.

This avoids claim races between scheduler task selection and claim execution.

### 5. Child Sessions

Workers should create or reuse child sessions per agent.

Requirements:
- Child session has `parentID` set to the root/main session.
- Child session has `agent` set to the assigned subagent.
- Child session title should identify it as a TillDone worker.
- Reuse the latest child session for the same agent when safe.

Worker prompt must include:

- task id.
- task content.
- assigned agent.
- queue ownership rule: runner owns claim/complete/interruption.
- expected final report format.

Final report format:

- Summary.
- Changed files.
- Verification.
- Decisions made.
- Follow-ups.
- Blockers.

### 6. Worker Completion

On successful child prompt completion:

- mark task `completed`.
- store completion timestamp and completed agent.
- append task history with worker session id and summary.
- clear worker slot.
- immediately fill the slot with next runnable work if runner is still running.

On worker error:

- mark task `interrupted` or `failed` based on error type.
- store error in task history.
- clear worker slot.
- continue scheduling remaining runnable tasks unless the runner itself is aborting.

On worker blocker report:

- mark task `blocked` only if the worker explicitly reports a blocker that prevents progress.
- store blocker text in history.
- do not spin on blocked tasks.

### 7. Stop

Stop is graceful.

When stop is requested:

- set runner status to `stopping`.
- stop claiming new tasks.
- let active workers finish.
- once active workers finish, set runner to `complete` or `blocked` depending on remaining tasks.

Stop must not:

- cancel active child sessions.
- mark active tasks interrupted.
- lose worker result summaries.

### 8. Abort

Abort is hard.

When abort is requested:

- set runner status to `aborting`.
- cancel active child sessions through `SessionPrompt.cancel`.
- mark active `claimed` and `in_progress` tasks as `interrupted`.
- append task history with abort reason.
- clear active worker slots.
- stop scheduler loop.

Abort must be idempotent:

- calling abort twice should not throw.
- calling abort after completion should return final status.

### 9. Durable State

The current module-level in-memory runner map is not enough.

Add durable runner and worker state so restart and recovery are explicit.

Schema additions:

```text
tilldone_runner
  session_id text primary key
  project_id text not null
  status text not null
  max_workers integer not null
  started_at integer
  stopped_at integer
  stop_requested_at integer
  abort_requested_at integer
  error text
  time_created integer not null
  time_updated integer not null

tilldone_worker
  id text primary key
  runner_session_id text not null
  project_id text not null
  slot integer not null
  task_id text
  agent text
  session_id text
  status text not null
  started_at integer
  updated_at integer
  completed_at integer
  error text
  time_created integer not null
  time_updated integer not null
```

Indexes:

- runner by project.
- worker by runner session.
- worker by project.
- worker by task id.
- worker by status.

Runtime memory may still keep active fibers, but source of truth should be durable state.

### 10. Recovery

On runner start:

- load durable runner state.
- if prior runner is `running`, `stopping`, or `aborting`, recover it.
- find worker rows in active states.
- find tasks in `claimed` or `in_progress`.
- mark stale active tasks `interrupted` unless there is a live worker fiber in the current process.
- append recovery history.
- clear or close stale worker records.
- start a fresh scheduler loop.

Recovery policy:

- Stale `claimed` tasks should become `interrupted` by default.
- Stale `in_progress` tasks should become `interrupted` by default.
- User can manually unclaim/retry interrupted tasks from the UI.

This avoids silently rerunning partially completed work.

### 11. UI Status

The TillDone tab should reflect durable runner state.

Display:

- runner state.
- active worker count and max workers.
- active workers with agent, task id, and child session id.
- stopped/completed timestamp when present.
- error/interrupted state when present.

Controls:

- `Start` visible when idle, complete, blocked, or error.
- `Stop` visible while running.
- `Abort` visible while running or stopping.
- `Status` refresh should poll while TillDone tab is selected.

### 12. Tests

Add runner-specific tests. These are required before calling this done.

Test cases:

1. Drains unassigned tasks

- create more pending tasks than workers.
- start runner.
- assert all tasks complete.
- assert worker slots kept claiming as prior tasks completed.

2. Free worker slot claims next task immediately

- create slow and fast worker behavior.
- assert fast slot claims another task while slow slot is still active.

3. Assigned tasks use only assigned agent

- create tasks assigned to specific agents.
- assert worker prompt uses matching agent.

4. No duplicate claims

- run multiple scheduler slots concurrently.
- assert each task id is completed once.

5. Stop is graceful

- start runner with multiple tasks.
- request stop while a worker is active.
- assert no new tasks are claimed after stop.
- assert active task can complete.

6. Abort is hard

- start runner with active task.
- request abort.
- assert child session cancel is called.
- assert active task becomes `interrupted`.

7. Recovery interrupts stale active tasks

- create durable active worker and `in_progress` task.
- start runner after simulated restart.
- assert stale task becomes `interrupted`.

8. Runner does not complete with runnable pending work

- create pending task while a worker finishes.
- assert runner claims it before reporting complete.

9. Blocked/impossible assignment reports blocked

- create task assigned to missing agent.
- start runner.
- assert runner reports `blocked`, not `complete`.

10. Status endpoint returns durable worker state

- start runner.
- call status.
- assert active/max workers and worker rows are returned.

### 13. Verification Commands

Run from package directories only.

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test test/tool/taskqueue.test.ts
cd packages/opencode && bun test test/session/tilldone-runner.test.ts
cd packages/sdk/js && bun typecheck
```

If endpoint schemas change, regenerate SDK from repo root:

```bash
./packages/sdk/js/script/build.ts
```

Then rerun both package typechecks.

## Implementation Order

1. Add durable SQL schema for runner and worker state.
2. Add migration for new tables.
3. Add schema repair for existing local DBs if needed.
4. Add `Todo.claimNextRunnable` or equivalent atomic scheduler claim API.
5. Replace per-agent runner loops with central slot-based scheduler.
6. Persist runner status transitions.
7. Persist worker slot lifecycle.
8. Implement graceful stop.
9. Implement hard abort.
10. Implement stale recovery on start.
11. Capture worker summaries/errors in task history.
12. Update TUI status rendering to show durable runner/worker state.
13. Add runner tests.
14. Regenerate SDK if API schemas changed.
15. Run typechecks and focused tests.

## Acceptance Criteria

This work is done only when all of these are true:

- More tasks than workers are drained without idle free slots while runnable work exists.
- A worker finishing early immediately claims the next runnable task while other workers continue.
- Assigned tasks only run on compatible agents.
- Unassigned tasks run on available subagents.
- Stop prevents new claims and lets active work finish.
- Abort cancels active child sessions and marks active tasks interrupted.
- Restart recovery does not leave stale `claimed` or `in_progress` tasks stuck.
- Runner status is durable and visible through the API/TUI.
- Tests cover scheduler drain, stop, abort, no duplicate claims, and recovery.
- `packages/opencode` typecheck passes.
- SDK typecheck passes if generated files changed.

## Non-Goals

- Do not redesign the whole TUI.
- Do not change unrelated taskqueue tool behavior unless required by scheduler correctness.
- Do not add git checkpointing/commits from workers.
- Do not make child agents own queue lifecycle; the runner owns claim/complete/interruption.
- Do not report success based only on typecheck. Scheduler behavior must be tested.

## Cleanup

The accidental `.opencode/references/effect-smol` clone should be removed if it is not wanted in the workspace. It is not part of the TillDone implementation.
