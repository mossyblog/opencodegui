# TillDone Cron Job Plan

## Problem

TillDone can run queued work now, but it has no first-class way to schedule work for the future or repeat operational checks.

Needed scheduling shapes:

- Run a task once at a chosen start time.
- Run a task every `X` minutes or hours.
- Run a task on selected days at a selected time.
- Run a lightweight recurring check against an existing agent worker, such as "every 5 minutes check whether agent1234 is done".

This should work with the new agent worker model. A schedule should create runnable work for the worker pool instead of bypassing the queue or directly owning child sessions.

## Target Behavior

Cron jobs are scheduled task templates that enqueue concrete TillDone tasks when due.

- A cron job has its own lifecycle separate from the task instances it creates.
- Due cron jobs enqueue normal pending tasks that existing agent workers can claim.
- Agent workers keep owning task execution, completion, interruption, and summaries.
- Cron jobs can be one-off or repeating.
- One-off jobs become complete after their first successful enqueue.
- Repeating jobs calculate `next_run_at` after each enqueue.
- Missed runs should enqueue at most one catch-up task on startup unless the UI later adds explicit backfill controls.
- Each completed run writes one diary sentence.

## Definitions

Cron job:

- A durable schedule record with title, task content, assigned agent, schedule rule, status, and next run time.

Cron run:

- A durable execution record for one due occurrence of a cron job.
- It points to the created TillDone task id when enqueue succeeds.

Due job:

- status is `active`.
- `next_run_at` is less than or equal to now.
- no active run already exists for the same scheduled occurrence.

Terminal cron job:

- `completed` for one-off jobs that already enqueued successfully.
- `cancelled` when the user disables future runs permanently.
- `failed` only when the scheduler cannot safely continue calculating or enqueueing runs.

## Data Model

Add durable schedule tables alongside the existing TillDone runner state.

```text
tilldone_cron_job
  id text primary key
  project_id text not null
  session_id text not null
  title text not null
  content text not null
  assigned_agent text
  status text not null
  schedule_kind text not null
  start_at integer not null
  repeat_interval_minutes integer
  repeat_days text
  next_run_at integer
  last_run_at integer
  created_by text
  time_created integer not null
  time_updated integer not null

tilldone_cron_run
  id text primary key
  cron_job_id text not null
  project_id text not null
  session_id text not null
  scheduled_for integer not null
  task_id text
  status text not null
  error text
  time_created integer not null
  time_updated integer not null
```

Indexes:

- cron job by project and status.
- cron job by session.
- cron job by `next_run_at`.
- cron run by cron job.
- cron run by created task id.

Store `repeat_days` as a compact JSON array of weekday numbers or names. Keep it nullable for interval-based repeats.

## Schedule Rules

Supported initial rule types:

- `once`: run once at `start_at`.
- `interval`: run every `repeat_interval_minutes` after `start_at`.
- `daily`: run every day at the time from `start_at`.
- `weekly`: run on selected weekdays at the time from `start_at`.

Validation:

- `once` needs only `start_at`.
- `interval` needs `repeat_interval_minutes > 0`.
- `daily` uses the local time from `start_at`.
- `weekly` needs at least one selected day.
- assigned agent must be empty or a visible runnable subagent/build agent.

Next run calculation:

- On create, set `next_run_at` to the first occurrence at or after `start_at`.
- After a successful enqueue, calculate the next occurrence strictly after the previous scheduled time.
- If the job is one-off, set status to `completed` and clear `next_run_at`.
- If the next occurrence is already in the past after downtime, set it to now for one catch-up enqueue, then continue from that scheduled occurrence.

## Scheduler Architecture

Use one lightweight cron scheduler per project/session, separate from the TillDone worker pool.

High-level loop:

```text
while cron scheduler is active:
  load due active cron jobs
  for each due job:
    create cron run row for scheduled occurrence
    create normal TillDone task from the job template
    link cron run to created task id
    advance job next_run_at or complete one-off job
    append diary sentence for the enqueued run
  sleep until nearest next_run_at or short poll interval
```

The cron scheduler only enqueues work. It must not:

- claim tasks.
- spawn child sessions.
- mark worker-owned tasks complete.
- bypass `Todo.claimNextRunnable`.
- run agent prompts directly.

## Agent Worker Integration

Each due cron run creates a normal task with these fields:

- content from the cron job template.
- assigned agent from the cron job, if set.
- status `pending`.
- metadata/history entry that references the cron job id and scheduled time.

Examples:

- "Every 2 hours do Task123" creates a pending task assigned to the configured agent or left unassigned for TillDone selection.
- "Every 5 minutes check agent1234" creates a pending task assigned to the check-capable agent with content that names the agent worker and expected check.

The existing worker pool sees these tasks exactly like manually-created tasks. This keeps concurrency, stop, abort, recovery, and summaries in one place.

## TUI Placement

In the TillDone sidebar, show schedules between `Todo` and `Done`.

```text
┌────────────────────────────────────────┐
│ TillDone                       running │
│ Active workers                    1/3  │
│                                        │
│ Todo 3                                 │
│   [ ] Implement retry budget           │
│   [ ] Review payment edge cases        │
│   [ ] Update docs                      │
│                                        │
│ Cron 2                      +          │
│   [~] every 2h  Task123         14:00  │  yellow
│   [~] weekdays Check agent1234  09:30  │  yellow
│                                        │
│ Done 5                         clear   │
│   [✓] Added worker slot polling        │
│   [x] Cancelled stale spike            │
└────────────────────────────────────────┘
```

Color rules:

- Cron section title and active cron rows use `theme.warning` yellow.
- Paused or completed cron rows use `theme.textMuted`.
- Failed cron rows use `theme.error`.
- Due-now rows can keep yellow text and use the existing spinner marker while the enqueue transaction is active.

Row text should prioritize cadence and next run:

```text
[~] every 2h  Task123         14:00
[~] once      Release notes   today
[~] Mon-Fri   Check worker    09:30
```

## Cron Modal UX

Clicking a cron row opens an edit modal. The action area mirrors the existing task modal, but `Delete` replaces the task `Claim` button.

```text
┌────────────────────────────────────────┐
│ Cron Job                            X  │
│                                        │
│ Title                                  │
│ [ Check agent1234                 ]    │
│                                        │
│ Task                                   │
│ ┌────────────────────────────────────┐ │
│ │ Check whether agent1234 is done.   │ │
│ │ If done, summarize the result.     │ │
│ └────────────────────────────────────┘ │
│                                        │
│ Assigned agent                         │
│ [Unassigned] [general] [qa] [build]    │
│                                        │
│ Start                                  │
│ [Today 09:30 v]                        │
│                                        │
│ Repeat                                 │
│ ( ) Once                               │
│ (●) Every [ 5 ] [minutes v]            │
│ ( ) Daily at start time                │
│ ( ) Weekly [Mon] [Tue] [Wed] [Thu]     │
│                                        │
│ Next run: today 09:30                  │
│ Last run: never                        │
│                                        │
│ | Delete                               │
│                         Cancel | Save |│
└────────────────────────────────────────┘
```

Start time pulldown:

- `Now`.
- `Today HH:mm`.
- `Tomorrow HH:mm`.
- custom date/time entry if the terminal supports typed input cleanly.

Repeat UI:

- `Once` hides interval/day controls.
- `Every` shows a numeric input and unit pulldown: minutes, hours, days.
- `Daily` uses the time from the selected start time.
- `Weekly` shows weekday toggles and uses the time from the selected start time.

Footer behavior:

- `Delete` cancels the cron job and removes future runs. It should not delete already-created tasks.
- `Cancel` closes without saving.
- `Save` validates, persists, recalculates `next_run_at`, and closes.

## New Cron Modal

The TillDone tab should expose a small yellow `+` near the Cron section header for creating schedules.

```text
│ Cron 2                      +          │
```

The new modal should use the same fields as edit mode with defaults:

- title empty.
- content empty.
- assigned agent unassigned.
- start `Now`.
- repeat `Once`.

Save creates the cron job. It does not immediately claim work; if `start_at` is now, the cron scheduler enqueues the task on its next tick.

## Diary Logging

When a cron run successfully creates a task, append one sentence to `.opencode/diary/<date>.md`.

Format:

```text
- 2026-05-01T09:30:00.000Z Cron job "Check agent1234" enqueued task <task_id> for the 09:30 scheduled run.
```

Only write the diary after the task creation transaction succeeds. If task creation fails, store the error on `tilldone_cron_run` and do not write a success diary line.

## API Surface

Add session-scoped cron endpoints near the existing TillDone endpoints.

```text
GET    /session/:sessionID/tilldone/cron
POST   /session/:sessionID/tilldone/cron
PATCH  /session/:sessionID/tilldone/cron/:id
DELETE /session/:sessionID/tilldone/cron/:id
```

Responses should include enough data for the TUI section without extra calls:

- id.
- title.
- content.
- assigned agent.
- status.
- schedule kind.
- start time.
- repeat interval or days.
- next run time.
- last run time.
- last error.

Regenerate the JavaScript SDK if endpoint schemas change.

## Recovery

On startup or scheduler resume:

- Load active cron jobs with `next_run_at <= now`.
- Create at most one run per due job.
- Use a transaction or unique key for `(cron_job_id, scheduled_for)` to avoid duplicate enqueues.
- Mark stuck `running` cron runs as `failed` if they have no linked task and are older than the recovery threshold.
- Do not cancel or mutate already-created TillDone tasks during cron recovery.

## Tests

Focused coverage should live in `packages/opencode`.

Required cases:

1. One-off cron job enqueues one pending task and completes.
2. Interval cron job advances `next_run_at` after enqueue.
3. Weekly cron job skips unselected days.
4. Duplicate scheduler ticks do not create duplicate tasks for the same scheduled occurrence.
5. Assigned agent is copied onto the created task.
6. Deleting a cron job prevents future enqueues and leaves existing tasks alone.
7. Successful enqueue appends one diary sentence.
8. Failed enqueue records a cron run error and does not append a success diary line.

## Verification Commands

Run from package directories only.

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test test/session/tilldone-cron.test.ts
```

If API schemas change:

```bash
./packages/sdk/js/script/build.ts
cd packages/sdk/js && bun typecheck
```

## Implementation Order

1. Add durable cron job and cron run schema.
2. Add migration and startup schema repair if needed.
3. Add schedule validation and next-run calculation helpers.
4. Add cron CRUD APIs.
5. Add cron scheduler loop that only enqueues normal TillDone tasks.
6. Add diary append on successful enqueue.
7. Update TillDone sidebar with yellow Cron section between Todo and Done.
8. Add create/edit cron modal with Start and Repeat controls.
9. Add focused cron scheduler tests.
10. Regenerate SDK if endpoint schemas changed.

## Acceptance Criteria

- Cron jobs appear in the TillDone sidebar between Todo and Done.
- Cron rows and header are yellow when active.
- Clicking a cron opens a modal with Start, Repeat, Delete, Cancel, and Save controls.
- One-off schedules enqueue exactly one normal TillDone task.
- Repeating schedules enqueue due tasks and advance to the next run.
- Agent worker execution remains owned by the existing TillDone worker pool.
- Completed cron enqueues append one diary sentence.
- Duplicate ticks or restarts do not duplicate the same scheduled occurrence.
- Focused package tests pass.

## Non-Goals

- Do not implement a full crontab expression editor in the first version.
- Do not add timezone management beyond local project runtime time.
- Do not make cron jobs directly run agents.
- Do not delete already-created tasks when a cron job is deleted.
- Do not redesign the broader TillDone tab outside the Cron section and modal.
