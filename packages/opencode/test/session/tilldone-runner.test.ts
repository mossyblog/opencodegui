import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Database } from "@/storage/db"
import { TillDoneRunner } from "@/session/tilldone-runner"
import { Todo } from "@/session/todo"
import { SessionTable, TillDoneRunnerTable, TillDoneWorkerTable } from "@/session/session.sql"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { eq } from "drizzle-orm"

afterEach(async () => {
  promptText.current = defaultPromptText
  promptDelay.current = () => undefined
  promptError.current = () => undefined
  promptEvents.current = []
  cancelledSessions.current = []
})

const provider = ProviderTest.fake()
const defaultPromptText = [
  "Summary: completed the task.",
  "",
  "Decisions made:",
  "- Kept TillDone diary capture in the runner completion path.",
  "- Only explicit decisions sections should be persisted.",
  "",
  "Verification:",
  "- passed",
].join("\n")
const promptText = { current: defaultPromptText as string | ((text: string) => string) }
const promptDelay = { current: (_text: string): Parameters<typeof Effect.sleep>[0] | undefined => undefined }
const promptError = { current: (_text: string): Error | undefined => undefined }
const promptEvents = { current: [] as { text: string; event: "start" | "finish"; time: number; agent?: string; sessionID: string }[] }
const cancelledSessions = { current: [] as string[] }
const promptLayer = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: (sessionID) =>
      Effect.sync(() => {
        cancelledSessions.current.push(sessionID)
      }),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const text = input.parts.map((part) => part.type === "text" ? part.text : "").join("\n")
        const response = typeof promptText.current === "function" ? promptText.current(text) : promptText.current
        promptEvents.current.push({ text, event: "start", time: Date.now(), agent: input.agent, sessionID: input.sessionID })
        const delay = promptDelay.current(text)
        if (delay) yield* Effect.sleep(delay)
        const error = promptError.current(text)
        if (error) return yield* Effect.die(error)
        promptEvents.current.push({ text, event: "finish", time: Date.now(), agent: input.agent, sessionID: input.sessionID })
        return {
          info: {
            id: MessageID.ascending(),
            role: "assistant",
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: provider.model.id,
            providerID: provider.info.id,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: MessageID.ascending(),
              sessionID: input.sessionID,
              type: "text" as const,
              text: response,
            },
          ],
        } satisfies MessageV2.WithParts
      }),
    loop: () => Effect.die(new Error("not used")),
    shell: () => Effect.die(new Error("not used")),
    command: () => Effect.die(new Error("not used")),
  }),
)

const baseLayer = Layer.mergeAll(
    Agent.defaultLayer,
    Bus.layer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    provider.layer,
    promptLayer,
    Session.defaultLayer,
    Todo.defaultLayer,
)

const it = testEffect(
  Layer.mergeAll(baseLayer, TillDoneRunner.layer.pipe(Layer.provide(baseLayer))),
)

describe("TillDoneRunner", () => {
  it.live("drains more unassigned tasks than worker slots", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone drains queue" })
        const tasks = yield* Effect.all(
          Array.from({ length: 7 }, (_, index) =>
            todos.create({ sessionID: session.id, content: `drain unassigned ${index}`, priority: index < 2 ? "high" : "medium" }),
          ),
        )

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const final = yield* runner.status({ sessionID: session.id })
        const all = yield* todos.get(session.id)
        expect(final.status).toBe("complete")
        expect(final.workers).toHaveLength(3)
        expect(promptEvents.current.filter((item) => item.event === "start" && item.text.includes("drain unassigned"))).toHaveLength(tasks.length)
        expect(all.filter((item) => tasks.some((task) => task.id === item.id)).map((item) => item.status)).toEqual(tasks.map(() => "completed"))
      }),
    ),
  )

  it.live("uses only the assigned agent for assigned tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone assigned agents" })
        const general = yield* todos.create({ sessionID: session.id, content: "assigned work for g", priority: "high", assignedAgent: "general" })
        const explore = yield* todos.create({ sessionID: session.id, content: "assigned work for x", priority: "high", assignedAgent: "explore" })
        const tui = yield* todos.create({ sessionID: session.id, content: "assigned work for t", priority: "high", assignedAgent: "tui-dev" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const all = yield* todos.get(session.id)
        expect(promptEvents.current.find((item) => item.event === "start" && item.text.includes("assigned work for g"))?.agent).toBe("general")
        expect(promptEvents.current.find((item) => item.event === "start" && item.text.includes("assigned work for x"))?.agent).toBe("explore")
        expect(promptEvents.current.find((item) => item.event === "start" && item.text.includes("assigned work for t"))?.agent).toBe("tui-dev")
        expect([general, explore, tui].map((task) => all.find((item) => item.id === task.id)?.completedBy)).toEqual(["general", "explore", "tui-dev"])
      }),
    ),
  )

  it.live("instructs workers to avoid broad verification during parallel work", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone focused verification" })
        yield* todos.create({ sessionID: session.id, content: "change one prompt", priority: "high", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const prompt = promptEvents.current.find((item) => item.event === "start" && item.text.includes("change one prompt"))?.text ?? ""
        expect(prompt).toContain("Run only focused checks relevant to this claimed task")
        expect(prompt).toContain("Do not run broad/full test batteries or repo-root builds")
        expect(prompt).toContain("explicit final verification task")
      }),
    ),
  )

  it.live("does not duplicate task claims across concurrent worker slots", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = () => "10 millis"
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone unique claims" })
        const tasks = yield* Effect.all(
          Array.from({ length: 12 }, (_, index) => todos.create({ sessionID: session.id, content: `unique claim ${index}`, priority: "high" })),
        )

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const claimedIDs = promptEvents.current
          .filter((item) => item.event === "start" && item.text.includes("unique claim"))
          .map((item) => item.text.match(/Work on TillDone task ([^:]+):/)?.[1])
          .filter((item): item is string => !!item)
        expect(claimedIDs).toHaveLength(tasks.length)
        expect(new Set(claimedIDs).size).toBe(tasks.length)
        expect((yield* todos.get(session.id)).filter((item) => item.content.includes("unique claim") && item.status === "completed")).toHaveLength(tasks.length)
      }),
    ),
  )

  it.live("appends decisions-made entries to the diary after task completion reports", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone diary" })
        yield* todos.create({ sessionID: session.id, content: "capture a meaningful decision", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const diary = yield* Effect.promise(() => Bun.file(`${dir}/.opencode/diary/${new Date().toISOString().slice(0, 10)}.md`).text())
        expect(diary.replace(/^-\s+\S+\s+/, "").trim()).toBe(
          "Kept TillDone diary capture in the runner completion path. Only explicit decisions sections should be persisted.",
        )
        expect(diary).not.toContain("Summary")
        expect(diary).not.toContain("Verification")
        expect((yield* todos.get(session.id))[0]?.status).toBe("completed")
      }),
    ),
  )

  it.live("skips diary entries when completion reports have no meaningful decisions", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        promptText.current = [
          "Summary: completed the task.",
          "",
          "Decisions made:",
          "- No meaningful decisions.",
          "",
          "Verification:",
          "- passed",
        ].join("\n")
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone diary skip" })
        yield* todos.create({ sessionID: session.id, content: "complete without a decision", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const exists = yield* Effect.promise(() => Bun.file(`${dir}/.opencode/diary/${new Date().toISOString().slice(0, 10)}.md`).exists())
        expect(exists).toBe(false)
        expect((yield* todos.get(session.id))[0]?.status).toBe("completed")
      }),
    ),
  )

  it.live("stores worker session id and concise summary in task history", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptText.current = [
          "Summary:",
          "Captured the worker summary for history.",
          "",
          "Changed files:",
          "- src/example.ts",
          "",
          "Verification:",
          "- passed",
          "",
          "Blockers:",
          "- none",
        ].join("\n")
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone completion history" })
        const task = yield* todos.create({ sessionID: session.id, content: "capture completion history", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const completed = (yield* todos.get(session.id)).find((item) => item.id === task.id)
        const worker = (yield* runner.status({ sessionID: session.id })).workers[0]
        expect(completed?.status).toBe("completed")
        expect(completed?.history).toContain(`Worker session: ${worker?.sessionID}`)
        expect(completed?.history).toContain("Worker summary:\nCaptured the worker summary for history.")
        expect(completed?.history).not.toContain("Changed files:")
      }),
    ),
  )

  it.live("marks explicit blocker reports blocked and stores blocker text", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptText.current = [
          "Summary: could not continue.",
          "",
          "Blockers:",
          "- Missing production credentials needed to verify the fix.",
        ].join("\n")
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone blocker history" })
        const task = yield* todos.create({ sessionID: session.id, content: "hit a blocker", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const blocked = (yield* todos.get(session.id)).find((item) => item.id === task.id)
        expect((yield* runner.status({ sessionID: session.id })).status).toBe("blocked")
        expect(blocked?.status).toBe("blocked")
        expect(blocked?.history).toContain("Blocked task.")
        expect(blocked?.history).toContain("Missing production credentials needed to verify the fix.")
        if (task.id) yield* todos.remove({ sessionID: session.id, id: task.id })
      }),
    ),
  )

  it.live("marks worker errors interrupted and stores error context", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptError.current = (text) => text.includes("worker error history") ? new Error("worker failed while editing") : undefined
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone error history" })
        const task = yield* todos.create({ sessionID: session.id, content: "worker error history", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const interrupted = (yield* todos.get(session.id)).find((item) => item.id === task.id)
        const worker = (yield* runner.status({ sessionID: session.id })).workers[0]
        expect(interrupted?.status).toBe("interrupted")
        expect(interrupted?.history).toContain(`Worker session: ${worker?.sessionID}`)
        expect(interrupted?.history).toContain("Worker error:")
        expect(interrupted?.history).toContain("worker failed while editing")
        expect(worker?.status).toBe("error")
        expect(worker?.error).toContain("worker failed while editing")
        if (task.id) yield* todos.remove({ sessionID: session.id, id: task.id })
      }),
    ),
  )

  it.live("reuses a finished worker slot while other worker slots are still running", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = (text) => text.includes("slow") ? "100 millis" : undefined
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone slot scheduler" })
        yield* todos.create({ sessionID: session.id, content: "slow general first", priority: "high", assignedAgent: "general" })
        yield* todos.create({ sessionID: session.id, content: "fast explore", priority: "high", assignedAgent: "explore" })
        yield* todos.create({ sessionID: session.id, content: "slow general second", priority: "medium", assignedAgent: "general" })
        yield* todos.create({ sessionID: session.id, content: "general after fast slot", priority: "low", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const firstSlowFinish = promptEvents.current.find((item) => item.event === "finish" && item.text.includes("slow general first"))
        const followUpStart = promptEvents.current.find((item) => item.event === "start" && item.text.includes("general after fast slot"))
        expect(followUpStart?.time).toBeLessThan(firstSlowFinish?.time ?? 0)
        expect((yield* todos.get(session.id)).filter((item) => item.content.includes("general") || item.content.includes("explore")).map((item) => item.status)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
        ])
      }),
    ),
  )

  it.live("reads runner and worker status from durable state", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = () => "500 millis"
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone durable status" })
        const task = yield* todos.create({ sessionID: session.id, content: "persist worker lifecycle", priority: "high", assignedAgent: "general" })

        const started = yield* runner.start({ sessionID: session.id })
        expect(started.status).toBe("running")
        expect(started.startedAt).toBeNumber()

        const fiber = yield* runner.run({ sessionID: session.id }).pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")

        const active = yield* runner.status({ sessionID: session.id })
        expect(active.status).toBe("running")
        expect(active.active).toBe(1)
        expect(active.workers[0]?.slot).toBeNumber()
        expect(active.workers[0]?.status).toBe("running")
        expect(active.workers[0]?.taskID).toBe(task.id)
        expect(active.workers[0]?.agent).toBe("general")
        expect(active.workers[0]?.sessionID).toBeString()
        expect(active.workers[0]?.startedAt).toBeNumber()
        expect(active.workers[0]?.updatedAt).toBeNumber()

        yield* Fiber.join(fiber)

        const complete = yield* runner.status({ sessionID: session.id })
        const afterAbort = yield* runner.abort({ sessionID: session.id })
        expect(complete.status).toBe("complete")
        expect(afterAbort.status).toBe("complete")
        expect(complete.stoppedAt).toBeNumber()
        expect(complete.workers[0]?.status).toBe("idle")
        expect(complete.workers[0]?.completedAt).toBeNumber()
      }),
    ),
  )

  it.live("graceful stop lets active work finish without claiming new tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = (text) => text.includes("active before stop") ? "200 millis" : undefined
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone graceful stop" })
        const active = yield* todos.create({ sessionID: session.id, content: "active before stop", priority: "high", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        const fiber = yield* runner.run({ sessionID: session.id }).pipe(Effect.forkScoped)
        yield* Effect.sleep("50 millis")

        const stopping = yield* runner.stop({ sessionID: session.id })
        expect(stopping.status).toBe("stopping")
        const pending = yield* todos.create({ sessionID: session.id, content: "pending after stop", priority: "high", assignedAgent: "general" })
        yield* Fiber.join(fiber)

        const final = yield* runner.status({ sessionID: session.id })
        const all = yield* todos.get(session.id)
        expect(final.status).toBe("blocked")
        expect(final.stoppedAt).toBeNumber()
        expect(all.find((item) => item.id === active.id)?.status).toBe("completed")
        expect(all.find((item) => item.content === "pending after stop")?.status).toBe("pending")
        expect(promptEvents.current.filter((item) => item.event === "start").map((item) => item.text)).toHaveLength(1)
        expect(all.find((item) => item.id === active.id)?.history).toContain("Worker summary:")
        expect(all.find((item) => item.id === active.id)?.history).toContain("completed the task.")
        if (pending.id) yield* todos.remove({ sessionID: session.id, id: pending.id })
      }),
    ),
  )

  it.live("graceful stop completes after active work finishes when no runnable work remains", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = (text) => text.includes("only active before stop") ? "200 millis" : undefined
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone graceful stop complete" })
        const active = yield* todos.create({ sessionID: session.id, content: "only active before stop", priority: "high", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        const fiber = yield* runner.run({ sessionID: session.id }).pipe(Effect.forkScoped)
        yield* Effect.sleep("50 millis")

        const stopping = yield* runner.stop({ sessionID: session.id })
        expect(stopping.status).toBe("stopping")
        yield* Fiber.join(fiber)

        const final = yield* runner.status({ sessionID: session.id })
        const completed = (yield* todos.get(session.id)).find((item) => item.id === active.id)
        expect(final.status).toBe("complete")
        expect(final.stoppedAt).toBeNumber()
        expect(final.workers[0]?.status).toBe("idle")
        expect(final.workers[0]?.completedAt).toBeNumber()
        expect(final.workers[0]?.sessionID).toBeString()
        expect(completed?.status).toBe("completed")
        expect(completed?.history).toContain(`Worker session: ${final.workers[0]?.sessionID}`)
        expect(completed?.history).toContain("Worker summary:")
        expect(completed?.history).toContain("completed the task.")
        expect(promptEvents.current.filter((item) => item.event === "start").map((item) => item.text)).toHaveLength(1)
      }),
    ),
  )

  it.live("hard abort cancels active child sessions and interrupts active tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = () => "500 millis"
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone hard abort" })
        const task = yield* todos.create({ sessionID: session.id, content: "active before abort", priority: "high", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        const fiber = yield* runner.run({ sessionID: session.id }).pipe(Effect.forkScoped)
        yield* Effect.promise(async () => {
          const started = Date.now()
          while (Date.now() - started < 2_000 && !promptEvents.current.some((item) => item.event === "start" && item.text.includes("active before abort"))) await Bun.sleep(25)
        })

        const aborting = yield* runner.abort({ sessionID: session.id })
        const abortingWorker = aborting.workers.find((worker) => worker.taskID === task.id)
        const interrupted = (yield* todos.get(session.id)).find((item) => item.id === task.id)

        expect(aborting.status).toBe("aborting")
        expect(aborting.active).toBe(0)
        expect(aborting.stoppedAt).toBeNumber()
        expect(abortingWorker?.status).toBe("aborted")
        expect(abortingWorker?.completedAt).toBeNumber()
        expect(abortingWorker?.sessionID && cancelledSessions.current.includes(abortingWorker.sessionID)).toBe(true)
        expect(interrupted?.status).toBe("interrupted")
        expect(interrupted?.history).toContain("Interrupted by TillDone abort.")
        expect((yield* runner.abort({ sessionID: session.id })).status).toBe("aborting")

        yield* Fiber.join(fiber)
        const final = yield* runner.status({ sessionID: session.id })
        const finalWorker = final.workers.find((worker) => worker.taskID === task.id)
        const durable = yield* Effect.sync(() => Database.use((db) => db.select().from(TillDoneRunnerTable).where(eq(TillDoneRunnerTable.session_id, session.id)).get()))
        expect(final.status).toBe("blocked")
        expect(final.active).toBe(0)
        expect(final.stoppedAt).toBeNumber()
        expect(finalWorker?.status).toBe("aborted")
        expect(durable?.status).toBe("blocked")
        expect((yield* runner.abort({ sessionID: session.id })).status).toBe("blocked")
        if (task.id) yield* todos.remove({ sessionID: session.id, id: task.id })
      }),
    ),
  )

  it.live("recovers stale durable workers and interrupts stale active tasks before restarting", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone recovery" })
        const stale = yield* todos.create({ sessionID: session.id, content: "stale active task", priority: "high", assignedAgent: "general", status: "in_progress" })
        const pending = yield* todos.create({ sessionID: session.id, content: "fresh scheduler work", priority: "high", assignedAgent: "general" })
        const now = Date.now()

        yield* Effect.sync(() =>
          Database.use((db) => {
            const sessionRow = db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
            if (!sessionRow) throw new Error("session missing")
            db.insert(TillDoneRunnerTable)
              .values({
                session_id: session.id,
                project_id: sessionRow.project_id,
                status: "running",
                max_workers: 3,
                started_at: now - 1_000,
                time_created: now - 1_000,
                time_updated: now - 1_000,
              })
              .run()
            db.insert(TillDoneWorkerTable)
              .values({
                id: `${session.id}:0`,
                runner_session_id: session.id,
                project_id: sessionRow.project_id,
                slot: 0,
                task_id: stale.id,
                agent: "general",
                session_id: session.id,
                status: "running",
                started_at: now - 1_000,
                updated_at: now - 1_000,
                time_created: now - 1_000,
                time_updated: now - 1_000,
              })
              .run()
          }),
        )

        const started = yield* runner.start({ sessionID: session.id })
        const recovered = yield* todos.get(session.id)

        expect(started.status).toBe("running")
        expect(started.active).toBe(0)
        expect(started.workers[0]?.status).toBe("interrupted")
        expect(started.workers[0]?.completedAt).toBeNumber()
        expect(recovered.find((item) => item.id === stale.id)?.status).toBe("interrupted")
        expect(recovered.find((item) => item.id === stale.id)?.history).toContain("Recovered stale active task before TillDone start.")

        yield* runner.run({ sessionID: session.id })

        expect((yield* todos.get(session.id)).find((item) => item.id === pending.id)?.status).toBe("completed")
        if (stale.id) yield* todos.remove({ sessionID: session.id, id: stale.id })
      }),
    ),
  )

  it.live("claims newly runnable work before reporting complete", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        promptDelay.current = (text) => text.includes("first runnable") ? "500 millis" : undefined
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone pending before complete" })
        const first = yield* todos.create({ sessionID: session.id, content: "first runnable", priority: "high", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        const fiber = yield* runner.run({ sessionID: session.id }).pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        const second = yield* todos.create({ sessionID: session.id, content: "second runnable before complete", priority: "high", assignedAgent: "general" })
        yield* Fiber.join(fiber)

        const final = yield* runner.status({ sessionID: session.id })
        const all = yield* todos.get(session.id)
        expect(final.status).toBe("complete")
        expect(all.find((item) => item.id === first.id)?.status).toBe("completed")
        expect(all.find((item) => item.id === second.id)?.status).toBe("completed")
        expect(promptEvents.current.filter((item) => item.event === "start" && item.text.includes("runnable"))).toHaveLength(2)
      }),
    ),
  )

  it.live("reports blocked when pending work is assigned to a missing agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone impossible assignment" })
        const task = yield* todos.create({ sessionID: session.id, content: "impossible assignment", priority: "high", assignedAgent: "missing-agent" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const final = yield* runner.status({ sessionID: session.id })
        expect(final.status).toBe("blocked")
        expect(final.active).toBe(0)
        expect((yield* todos.get(session.id)).find((item) => item.id === task.id)?.status).toBe("pending")
        expect(promptEvents.current.filter((item) => item.event === "start")).toHaveLength(0)
      }),
    ),
  )
})
