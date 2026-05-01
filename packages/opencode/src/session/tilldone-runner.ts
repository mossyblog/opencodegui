import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Provider } from "@/provider/provider"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { SessionDiary } from "@/session/diary"
import { Database } from "@/storage/db"
import { SessionPrompt } from "./prompt"
import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { SessionTable, TillDoneRunnerTable, TillDoneWorkerTable } from "./session.sql"
import type { ProjectID } from "@/project/schema"

const MAX_WORKERS = 3
const POLL_INTERVAL = "500 millis"
const ACTIVE_TASK_STATUS = ["in_progress", "claimed"]
const RECOVERABLE_RUNNER_STATUS = ["running", "stopping", "aborting"]
const ACTIVE_WORKER_STATUS = ["running"]
const OPEN_TASK_STATUS = ["pending", "in_progress", "claimed", "blocked", "interrupted", "failed"]

const reportSection = (text: string, section: string) => {
  const match = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${section}:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:#{1,6}\\s*)?(?:summary|changed files|verification|decisions made|decisions-made|follow-ups|blockers)\\b|$)`, "i").exec(text)
  return match?.[1]
    ?.replace(/^\s*(?:[-*]|\d+[.)])\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

const conciseReport = (text: string) => (reportSection(text, "summary") ?? text).trim().split(/\n\s*\n/)[0]?.trim() || text.trim()
const blockerReport = (text: string) => {
  const section = reportSection(text, "blockers")
  if (!section || /^(?:none|no blockers?|n\/a|not applicable)[.!]?$/i.test(section)) return
  return section
}

export const RunnerStatus = Schema.Literals(["idle", "running", "stopping", "aborting", "complete", "blocked", "error"])
export type RunnerStatus = Schema.Schema.Type<typeof RunnerStatus>

export class WorkerInfo extends Schema.Class<WorkerInfo>("TillDoneWorkerInfo")({
  slot: Schema.optional(Schema.Number),
  agent: Schema.String,
  status: Schema.String,
  taskID: Schema.optional(Schema.String),
  sessionID: Schema.optional(SessionID),
  error: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
}) {}

export class Status extends Schema.Class<Status>("TillDoneStatus")({
  status: RunnerStatus,
  sessionID: Schema.optional(SessionID),
  active: Schema.Number,
  maxWorkers: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  stoppedAt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  workers: Schema.Array(WorkerInfo),
}) {}

type Runner = {
  sessionID: SessionID
  projectID: ProjectID
  status: RunnerStatus
  startedAt?: number
  stoppedAt?: number
  stopRequestedAt?: number
  abortRequestedAt?: number
  error?: string
  maxWorkers: number
  stop: boolean
  abort: boolean
  workers: Map<string, WorkerInfo>
}

export interface Interface {
  readonly status: (input: { sessionID: SessionID }) => Effect.Effect<Status>
  readonly start: (input: { sessionID: SessionID }) => Effect.Effect<Status>
  readonly run: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly stop: (input: { sessionID: SessionID }) => Effect.Effect<Status>
  readonly abort: (input: { sessionID: SessionID }) => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TillDoneRunner") {}

const runners = new Map<string, Runner>()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const todo = yield* Todo.Service
    const provider = yield* Provider.Service
    yield* Bus.Service

    const key = (sessionID: SessionID) => sessionID
    const getRunner = (sessionID: SessionID) => runners.get(key(sessionID))
    const projectID = (sessionID: SessionID) => {
      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
      if (!row) throw new Error(`Session not found: ${sessionID}`)
      return row.project_id
    }

    const workerInfo = (row: typeof TillDoneWorkerTable.$inferSelect) =>
      new WorkerInfo({
        slot: row.slot,
        agent: row.agent ?? "",
        status: row.status,
        ...(row.task_id ? { taskID: row.task_id } : {}),
        ...(row.session_id ? { sessionID: row.session_id } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      })

    const snapshot = Effect.fn("TillDoneRunner.snapshot")(function* (sessionID?: SessionID) {
      if (!sessionID) return new Status({ status: "idle", active: 0, maxWorkers: MAX_WORKERS, workers: [] })
      const row = yield* Effect.sync(() => Database.use((db) => db.select().from(TillDoneRunnerTable).where(eq(TillDoneRunnerTable.session_id, sessionID)).get()))
      if (!row) return new Status({ status: "idle", sessionID, active: 0, maxWorkers: MAX_WORKERS, workers: [] })
      const workers = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(TillDoneWorkerTable)
            .where(eq(TillDoneWorkerTable.runner_session_id, sessionID))
            .all()
            .toSorted((a, b) => a.slot - b.slot)
            .map(workerInfo),
        ),
      )
      return new Status({
        status: row.status as RunnerStatus,
        sessionID: row.session_id,
        active: workers.filter((item) => item.status === "running").length,
        maxWorkers: row.max_workers,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
        ...(row.error ? { error: row.error } : {}),
        workers,
      })
    })

    const persistRunner = Effect.fn("TillDoneRunner.persistRunner")(function* (runner: Runner) {
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(TillDoneRunnerTable)
            .values({
              session_id: runner.sessionID,
              project_id: runner.projectID,
              status: runner.status,
              max_workers: runner.maxWorkers,
              started_at: runner.startedAt ?? null,
              stopped_at: runner.stoppedAt ?? null,
              stop_requested_at: runner.stopRequestedAt ?? null,
              abort_requested_at: runner.abortRequestedAt ?? null,
              error: runner.error ?? null,
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: TillDoneRunnerTable.session_id,
              set: {
                status: runner.status,
                max_workers: runner.maxWorkers,
                started_at: runner.startedAt ?? null,
                stopped_at: runner.stoppedAt ?? null,
                stop_requested_at: runner.stopRequestedAt ?? null,
                abort_requested_at: runner.abortRequestedAt ?? null,
                error: runner.error ?? null,
                time_updated: Date.now(),
              },
            })
            .run(),
        ),
      )
    })

    const childSession = Effect.fn("TillDoneRunner.childSession")(function* (sessionID: SessionID, agent: string) {
      const children = yield* sessions.children(sessionID)
      const existing = children
        .filter((item) => item.agent === agent)
        .toSorted((a, b) => b.time.updated - a.time.updated)[0]
      if (existing) return existing
      return yield* sessions.create({ parentID: sessionID, title: `${agent} worker (@${agent} subagent)`, agent })
    })

    const setStatus = Effect.fn("TillDoneRunner.setStatus")(function* (runner: Runner, status: RunnerStatus, input?: { stoppedAt?: number; error?: string }) {
      runner.status = status
      runner.stoppedAt = input?.stoppedAt ?? runner.stoppedAt
      runner.error = input?.error ?? runner.error
      yield* persistRunner(runner)
    })

    const setWorker = Effect.fn("TillDoneRunner.setWorker")(function* (runner: Runner, slot: number, worker: WorkerInfo) {
      const now = Date.now()
      const value = new WorkerInfo({ slot, updatedAt: now, ...worker })
      runner.workers.set(slot.toString(), value)
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(TillDoneWorkerTable)
            .values({
              id: `${runner.sessionID}:${slot}`,
              runner_session_id: runner.sessionID,
              project_id: runner.projectID,
              slot,
              task_id: value.taskID ?? null,
              agent: value.agent,
              session_id: value.sessionID ?? null,
              status: value.status,
              started_at: value.startedAt ?? null,
              updated_at: value.updatedAt,
              completed_at: value.completedAt ?? null,
              error: value.error ?? null,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: TillDoneWorkerTable.id,
              set: {
                task_id: value.taskID ?? null,
                agent: value.agent,
                session_id: value.sessionID ?? null,
                status: value.status,
                started_at: value.startedAt ?? null,
                updated_at: value.updatedAt,
                completed_at: value.completedAt ?? null,
                error: value.error ?? null,
                time_updated: now,
              },
            })
            .run(),
        ),
      )
    })
    const recoverStaleState = Effect.fn("TillDoneRunner.recoverStaleState")(function* (sessionID: SessionID) {
      const live = getRunner(sessionID)
      if (live && RECOVERABLE_RUNNER_STATUS.includes(live.status)) return
      const row = yield* Effect.sync(() => Database.use((db) => db.select().from(TillDoneRunnerTable).where(eq(TillDoneRunnerTable.session_id, sessionID)).get()))
      if (!row || !RECOVERABLE_RUNNER_STATUS.includes(row.status)) return
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(TillDoneWorkerTable)
            .where(eq(TillDoneWorkerTable.runner_session_id, sessionID))
            .all()
            .filter((worker) => ACTIVE_WORKER_STATUS.includes(worker.status))
            .forEach((worker) => {
              db.update(TillDoneWorkerTable)
                .set({ status: "interrupted", completed_at: now, updated_at: now, error: "Recovered stale active worker before TillDone start.", time_updated: now })
                .where(eq(TillDoneWorkerTable.id, worker.id))
                .run()
            }),
        ),
      )
      yield* todo.interruptActive({ sessionID, reason: "Recovered stale active task before TillDone start." })
    })
    const finishStatus = (todos: Todo.Info[]) => todos.some((item) => OPEN_TASK_STATUS.includes(item.status)) ? "blocked" : "complete"
    const terminalStatus = (status: RunnerStatus) => status === "complete" || status === "blocked" || status === "error"
    const runnableAgents = Effect.fn("TillDoneRunner.runnableAgents")(function* () {
      return (yield* agents.list()).filter((item) => item.mode === "subagent" && !item.hidden).map((item) => item.name)
    })

    const runTask = Effect.fn("TillDoneRunner.runTask")(function* (runner: Runner, slot: number, agentName: string, task: Todo.Info) {
      if (!task.id) return
      const taskID = task.id
      const agent = yield* agents.get(agentName)
      if (!agent) return
      const child = yield* childSession(runner.sessionID, agentName)
      const startedAt = Date.now()
      yield* setWorker(runner, slot, new WorkerInfo({ agent: agentName, status: "running", taskID, sessionID: child.id, startedAt }))

      const model = agent.model ?? (yield* provider.defaultModel())
      const result = yield* prompts
        .prompt({
          sessionID: child.id,
          messageID: MessageID.ascending(),
          agent: agentName,
          model: { providerID: model.providerID, modelID: model.modelID },
          parts: [
            {
              type: "text" as const,
              text: [
                `Work on TillDone task ${taskID}: ${task.content}`,
                "",
                "Return a concise completion report with: Summary, Changed files, Verification, Decisions made, Follow-ups, Blockers.",
                "Run only focused checks relevant to this claimed task. Do not run broad/full test batteries or repo-root builds while parallel TillDone work is active; leave broad package/build verification to an explicit final verification task.",
                "Do not claim or complete queue tasks yourself; the TillDone runner owns task lifecycle.",
              ].join("\n"),
            },
          ],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = String(cause)
              yield* setWorker(runner, slot, new WorkerInfo({ agent: agentName, status: "error", taskID, sessionID: child.id, startedAt, completedAt: Date.now(), error }))
              yield* todo.interrupt({ sessionID: runner.sessionID, id: taskID, agent: agentName, reason: `Worker error:\n${error}`, workerSessionID: child.id })
              return undefined
            }),
          ),
        )

      if (runner.abort || runner.status === "aborting") {
        yield* prompts.cancel(child.id).pipe(Effect.ignore)
        yield* todo.interruptActive({ sessionID: runner.sessionID, agent: agentName, reason: "Interrupted by TillDone abort." })
        yield* setWorker(runner, slot, new WorkerInfo({ agent: agentName, status: "aborted", taskID, sessionID: child.id, startedAt, completedAt: Date.now() }))
        return
      }
      if (!result) return
      const report = result.parts.findLast((item) => item.type === "text")?.text ?? ""
      const blocker = blockerReport(report)
      if (blocker) {
        yield* todo.block({ sessionID: runner.sessionID, id: taskID, agent: agentName, blocker, workerSessionID: child.id })
        yield* setWorker(runner, slot, new WorkerInfo({ agent: agentName, status: "blocked", taskID, sessionID: child.id, startedAt, completedAt: Date.now() }))
        return
      }
      yield* SessionDiary.appendDecision(report)
      yield* todo.complete({ sessionID: runner.sessionID, id: taskID, agent: agentName, summary: conciseReport(report), workerSessionID: child.id })
      yield* setWorker(runner, slot, new WorkerInfo({ agent: agentName, status: "idle", taskID, sessionID: child.id, startedAt, completedAt: Date.now() }))
    })

    const slotLoop = Effect.fn("TillDoneRunner.slotLoop")(function* (runner: Runner, slot: number) {
      while (!runner.stop && !runner.abort) {
        const result = yield* todo.claimNextRunnable({ sessionID: runner.sessionID, agents: yield* runnableAgents() })
        if (result.claimed && result.agent) {
          yield* runTask(runner, slot, result.agent, result.claimed)
          continue
        }
        if (!(yield* todo.get(runner.sessionID)).some((item) => ACTIVE_TASK_STATUS.includes(item.status))) return
        yield* Effect.sleep(POLL_INTERVAL)
      }
    })

    const start = Effect.fn("TillDoneRunner.start")(function* (input: { sessionID: SessionID }) {
      const existing = getRunner(input.sessionID)
      if (existing && RECOVERABLE_RUNNER_STATUS.includes(existing.status)) return yield* snapshot(input.sessionID)
      yield* recoverStaleState(input.sessionID)
      const runner: Runner = {
        sessionID: input.sessionID,
        projectID: projectID(input.sessionID),
        status: "running",
        startedAt: Date.now(),
        maxWorkers: MAX_WORKERS,
        stop: false,
        abort: false,
        workers: new Map(),
      }
      runners.set(key(input.sessionID), runner)
      yield* persistRunner(runner)
      return yield* snapshot(input.sessionID)
    })

    const run = Effect.fn("TillDoneRunner.run")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner || runner.status !== "running") return
      yield* Effect.all(Array.from({ length: runner.maxWorkers }, (_, slot) => slotLoop(runner, slot)), { concurrency: "unbounded" }).pipe(Effect.ignore)
      if (runner.abort) yield* setStatus(runner, "aborting", { stoppedAt: Date.now() })
      if (runner.stop && !runner.abort) yield* setStatus(runner, "stopping")
      const remaining = yield* todo.get(input.sessionID)
      if (runner.status === "running" || runner.status === "stopping" || runner.status === "aborting") {
        yield* setStatus(runner, finishStatus(remaining), { stoppedAt: Date.now() })
      }
    })

    const status = Effect.fn("TillDoneRunner.status")(function* (input: { sessionID: SessionID }) {
      return yield* snapshot(input.sessionID)
    })

    const stop = Effect.fn("TillDoneRunner.stop")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner) return yield* snapshot(input.sessionID)
      runner.stop = true
      runner.stopRequestedAt = Date.now()
      yield* setStatus(runner, "stopping")
      return yield* snapshot(input.sessionID)
    })

    const abort = Effect.fn("TillDoneRunner.abort")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner) return yield* snapshot(input.sessionID)
      if (terminalStatus(runner.status)) return yield* snapshot(input.sessionID)
      if (runner.status === "aborting") return yield* snapshot(input.sessionID)
      runner.abort = true
      runner.abortRequestedAt = runner.abortRequestedAt ?? Date.now()
      yield* setStatus(runner, "aborting", { stoppedAt: Date.now() })
      yield* Effect.all(
        Array.from(runner.workers.values())
          .filter((worker) => worker.status === "running")
          .map((worker) =>
            Effect.gen(function* () {
              if (worker.sessionID) yield* prompts.cancel(worker.sessionID).pipe(Effect.ignore)
              if (worker.slot === undefined) return
              yield* setWorker(
                runner,
                worker.slot,
                new WorkerInfo({
                  agent: worker.agent,
                  status: "aborted",
                  ...(worker.taskID ? { taskID: worker.taskID } : {}),
                  ...(worker.sessionID ? { sessionID: worker.sessionID } : {}),
                  ...(worker.startedAt ? { startedAt: worker.startedAt } : {}),
                  completedAt: Date.now(),
                }),
              )
            }),
          ),
        { concurrency: "unbounded" },
      )
      yield* todo.interruptActive({ sessionID: input.sessionID, reason: "Interrupted by TillDone abort." })
      return yield* snapshot(input.sessionID)
    })

    return Service.of({ status, start, run, stop, abort })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Todo.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Bus.defaultLayer),
)

export * as TillDoneRunner from "./tilldone-runner"
