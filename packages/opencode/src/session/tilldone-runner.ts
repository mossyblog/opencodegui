import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Provider } from "@/provider/provider"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { SessionDiary } from "@/session/diary"
import { SessionPrompt } from "./prompt"
import { Context, Effect, Layer, Schema } from "effect"

const MAX_WORKERS = 3
const POLL_INTERVAL = "500 millis"

export const RunnerStatus = Schema.Literals(["idle", "running", "stopping", "aborting", "complete", "blocked", "error"])
export type RunnerStatus = Schema.Schema.Type<typeof RunnerStatus>

export class WorkerInfo extends Schema.Class<WorkerInfo>("TillDoneWorkerInfo")({
  agent: Schema.String,
  status: Schema.String,
  taskID: Schema.optional(Schema.String),
  sessionID: Schema.optional(SessionID),
  error: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
}) {}

export class Status extends Schema.Class<Status>("TillDoneStatus")({
  status: RunnerStatus,
  sessionID: Schema.optional(SessionID),
  active: Schema.Number,
  maxWorkers: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  stoppedAt: Schema.optional(Schema.Number),
  workers: Schema.Array(WorkerInfo),
}) {}

type Runner = {
  sessionID: SessionID
  status: RunnerStatus
  startedAt?: number
  stoppedAt?: number
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
    const snapshot = (runner?: Runner) =>
      new Status({
        status: runner?.status ?? "idle",
        sessionID: runner?.sessionID,
        active: [...(runner?.workers.values() ?? [])].filter((item) => item.status === "running").length,
        maxWorkers: runner?.maxWorkers ?? MAX_WORKERS,
        startedAt: runner?.startedAt,
        stoppedAt: runner?.stoppedAt,
        workers: [...(runner?.workers.values() ?? [])],
      })

    const childSession = Effect.fn("TillDoneRunner.childSession")(function* (sessionID: SessionID, agent: string) {
      const children = yield* sessions.children(sessionID)
      const existing = children
        .filter((item) => item.agent === agent)
        .toSorted((a, b) => b.time.updated - a.time.updated)[0]
      if (existing) return existing
      return yield* sessions.create({ parentID: sessionID, title: `${agent} worker (@${agent} subagent)`, agent })
    })

    const setWorker = (runner: Runner, worker: WorkerInfo) => runner.workers.set(worker.agent, worker)

    const runTask = Effect.fn("TillDoneRunner.runTask")(function* (runner: Runner, agentName: string, task: Todo.Info) {
      if (!task.id) return
      const agent = yield* agents.get(agentName)
      if (!agent) return
      const child = yield* childSession(runner.sessionID, agentName)
      setWorker(runner, new WorkerInfo({ agent: agentName, status: "running", taskID: task.id, sessionID: child.id, startedAt: Date.now() }))

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
                `Work on TillDone task ${task.id}: ${task.content}`,
                "",
                "Return a concise completion report with: Summary, Changed files, Verification, Decisions made, Follow-ups, Blockers.",
                "Do not claim or complete queue tasks yourself; the TillDone runner owns task lifecycle.",
              ].join("\n"),
            },
          ],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = String(cause)
              setWorker(runner, new WorkerInfo({ agent: agentName, status: "error", taskID: task.id, sessionID: child.id, error }))
              yield* todo.interruptActive({ sessionID: runner.sessionID, agent: agentName, reason: `Interrupted after worker error: ${error}` })
              return undefined
            }),
          ),
        )

      if (runner.abort || runner.status === "aborting") {
        yield* prompts.cancel(child.id).pipe(Effect.ignore)
        yield* todo.interruptActive({ sessionID: runner.sessionID, agent: agentName, reason: "Interrupted by TillDone abort." })
        setWorker(runner, new WorkerInfo({ agent: agentName, status: "aborted", taskID: task.id, sessionID: child.id }))
        return
      }
      if (!result) return
      yield* SessionDiary.appendDecision(result.parts.findLast((item) => item.type === "text")?.text ?? "")
      yield* todo.complete({ sessionID: runner.sessionID, id: task.id, agent: agentName })
      setWorker(runner, new WorkerInfo({ agent: agentName, status: "idle", sessionID: child.id }))
    })

    const agentLoop = Effect.fn("TillDoneRunner.agentLoop")(function* (runner: Runner, agentName: string) {
      while (!runner.stop && !runner.abort) {
        const current = yield* todo.get(runner.sessionID)
        const result = yield* todo.claimNext({ sessionID: runner.sessionID, agent: agentName })
        if (result.claimed) {
          yield* runTask(runner, agentName, result.claimed)
          continue
        }
        if (!current.some((item) => item.status === "pending" || item.status === "in_progress" || item.status === "claimed")) return
        yield* Effect.sleep(POLL_INTERVAL)
      }
    })

    const start = Effect.fn("TillDoneRunner.start")(function* (input: { sessionID: SessionID }) {
      const existing = getRunner(input.sessionID)
      if (existing?.status === "running") return snapshot(existing)
      const runner: Runner = {
        sessionID: input.sessionID,
        status: "running",
        startedAt: Date.now(),
        maxWorkers: MAX_WORKERS,
        stop: false,
        abort: false,
        workers: new Map(),
      }
      runners.set(key(input.sessionID), runner)
      yield* todo.interruptActive({ sessionID: input.sessionID, reason: "Recovered stale active task before TillDone start." })
      return snapshot(runner)
    })

    const run = Effect.fn("TillDoneRunner.run")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner || runner.status !== "running") return
      const available = (yield* agents.list()).filter((item) => item.mode === "subagent" && !item.hidden)
      const todos = yield* todo.get(input.sessionID)
      const agentNames = [
        ...new Set(
          [
            ...todos
              .map((item) => item.assignedAgent)
              .filter((item): item is string => !!item)
              .filter((item) => available.some((agent) => agent.name === item)),
            ...available.map((agent) => agent.name),
          ],
        ),
      ].slice(0, runner.maxWorkers)
      yield* Effect.all(agentNames.map((agentName) => agentLoop(runner, agentName)), { concurrency: "unbounded" }).pipe(Effect.ignore)
      if (runner.abort) runner.status = "aborting"
      if (runner.stop && !runner.abort) runner.status = "stopping"
      const remaining = yield* todo.get(input.sessionID)
      if (runner.status === "running") {
        runner.status = remaining.some((item) => item.status === "blocked" || item.status === "interrupted") ? "blocked" : "complete"
      }
      runner.stoppedAt = Date.now()
    })

    const status = Effect.fn("TillDoneRunner.status")(function* (input: { sessionID: SessionID }) {
      return snapshot(getRunner(input.sessionID))
    })

    const stop = Effect.fn("TillDoneRunner.stop")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner) return snapshot()
      runner.stop = true
      runner.status = "stopping"
      return snapshot(runner)
    })

    const abort = Effect.fn("TillDoneRunner.abort")(function* (input: { sessionID: SessionID }) {
      const runner = getRunner(input.sessionID)
      if (!runner) return snapshot()
      runner.abort = true
      runner.status = "aborting"
      for (const worker of runner.workers.values()) {
        if (worker.sessionID) yield* prompts.cancel(worker.sessionID).pipe(Effect.ignore)
      }
      yield* todo.interruptActive({ sessionID: input.sessionID, reason: "Interrupted by TillDone abort." })
      return snapshot(runner)
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
