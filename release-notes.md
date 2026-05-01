# Release Notes

## feature/session-task-queue

Commit: `b60b5c9f5` (`feat: improve TillDone task orchestration`)

### Highlights

- Added durable TillDone runner and worker state so active work can be monitored, stopped, aborted, and recovered safely.
- Improved task queue lifecycle handling for plan/task modes, explicit handoffs, bounce limits, queue maintenance, and worker history.
- Added TUI updates for TillDone dispatch, sidebar status, dialogs, diary rendering, and todo interactions.
- Added QA prep command coverage, Task mode prompt wiring, generated SDK status fields, plans, and diary notes.

### Verification

- `bun typecheck` from `packages/opencode`
- Focused package tests for changed task queue, TillDone runner, storage, QA prep, diary, todo item, sidebar diary, and todo modules
- Pre-push `bun turbo typecheck`
