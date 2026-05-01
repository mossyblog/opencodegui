import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { TaskQueueTool } from "../../src/tool/taskqueue"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, type SessionID } from "@/session/schema"
import { Database } from "@/storage/db"

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer, Session.defaultLayer, Todo.defaultLayer, Truncate.defaultLayer),
)

describe("tool.taskqueue", () => {
  const context = (sessionID: SessionID, agent = "general") => ({
    sessionID,
    messageID: MessageID.ascending(),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  })

  it.live("creates, claims, and completes queued tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Task queue" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()
        const ctx = context(session.id)

        yield* def.execute({ action: "create", content: "first", priority: "low" }, ctx)
        yield* def.execute({ action: "create", content: "urgent", priority: "high" }, ctx)

        const claimed = yield* def.execute({ action: "claim_next" }, ctx)
        expect(claimed.metadata.claimed?.content).toBe("urgent")
        expect(claimed.metadata.next?.content).toBe("first")

        const completed = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, ctx)
        expect(completed.metadata.todos.find((todo) => todo.content === "urgent")?.status).toBe("completed")
        expect(completed.metadata.todos).toHaveLength(2)
      }),
    ),
  )

  it.live("shares queued tasks across sessions in the same project", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const first = yield* sessions.create({ title: "First" })
        yield* todos.update({ sessionID: first.id, todos: [] })
        const second = yield* sessions.create({ title: "Second" })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()
        const base = context(first.id)

        yield* def.execute({ action: "create", content: "shared", priority: "medium" }, { ...base, sessionID: first.id })

        const list = yield* def.execute({ action: "list" }, { ...base, sessionID: second.id })
        expect(list.metadata.todos.map((todo) => todo.content)).toContain("shared")

        const claimed = yield* def.execute({ action: "claim_next" }, { ...base, sessionID: second.id })
        expect(claimed.metadata.claimed?.content).toBe("shared")
      }),
    ),
  )

  it.live("migrates legacy session todo tables before queue lifecycle writes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Legacy todos" })
        Database.Client().$client.run("DROP TABLE `todo`")
        Database.Client().$client.run(`CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`)
        Database.Client().$client.run(
          "INSERT INTO `todo`(`session_id`, `content`, `status`, `priority`, `position`, `time_created`, `time_updated`) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [session.id, "legacy task", "pending", "medium", 0, Date.now(), Date.now()],
        )
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const listed = yield* def.execute({ action: "list" }, context(session.id, "build"))
        yield* def.execute({ action: "create", content: "assigned build workflow task", priority: "high", assigned_agent: "build" }, context(session.id, "qa"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))
        const columns = Database.Client().$client.query("PRAGMA table_info(todo)").all() as { name: string }[]

        expect(listed.metadata.todos.find((todo) => todo.content === "legacy task")?.status).toBe("pending")
        expect(claimed.metadata.claimed?.content).toBe("assigned build workflow task")
        expect(columns.map((column) => column.name)).toContain("assigned_agent")
        expect(columns.map((column) => column.name)).toContain("bounce_count")
        expect(columns.map((column) => column.name)).toContain("history")
      }),
    ),
  )

  it.live("refuses to give an agent a second task while one is already claimed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Single task" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()
        const ctx = context(session.id, "tui-dev")

        yield* def.execute({ action: "create", content: "first tui task", priority: "high", assigned_agent: "tui-dev" }, ctx)
        yield* def.execute({ action: "create", content: "second tui task", priority: "high", assigned_agent: "tui-dev" }, ctx)

        const first = yield* def.execute({ action: "claim_next" }, ctx)
        const second = yield* def.execute({ action: "claim_next" }, ctx)

        expect(first.metadata.claimed?.content).toBe("first tui task")
        expect(second.title).toBe("task already claimed")
        expect(second.metadata.claimed?.id).toBe(first.metadata.claimed?.id)
        expect(second.metadata.todos.find((todo) => todo.content === "second tui task")?.status).toBe("pending")
      }),
    ),
  )

  it.live("allows plan mode to update and cancel pending tasks but blocks execution actions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Plan queue" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "safe planning task", priority: "medium" }, context(session.id, "plan"))
        const updated = yield* def.execute({ action: "update", id: created.metadata.todos[0]!.id, content: "safer planning task", priority: "high", assigned_agent: "qa" }, context(session.id, "plan"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "plan"))
        const completed = yield* def.execute({ action: "complete", id: created.metadata.todos[0]!.id }, context(session.id, "plan"))
        const cancelled = yield* def.execute({ action: "cancel", id: created.metadata.todos[0]!.id }, context(session.id, "plan"))
        const listed = yield* def.execute({ action: "list" }, context(session.id, "plan"))

        expect(created.metadata.todos).toHaveLength(1)
        expect(updated.title).toBe("task updated")
        expect(updated.metadata.todos[0]?.content).toBe("safer planning task")
        expect(updated.metadata.todos[0]?.priority).toBe("high")
        expect(updated.metadata.todos[0]?.assignedAgent).toBe("qa")
        expect(updated.metadata.todos[0]?.history).toContain("plan\nUpdated task from plan mode.")
        expect(claimed.title).toBe("task execution blocked in plan mode")
        expect(completed.title).toBe("task execution blocked in plan mode")
        expect(cancelled.title).toBe("task cancelled")
        expect(listed.metadata.todos[0]?.status).toBe("cancelled")
        expect(listed.metadata.todos[0]?.completedBy).toBe("plan")
        expect(listed.metadata.todos[0]?.history).toContain("plan\nUpdated task from plan mode.")
        expect(listed.metadata.todos[0]?.history).toContain("plan\nCancelled task.")
      }),
    ),
  )

  it.live("blocks plan mode from cancelling active tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Plan active cancel" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "active task", priority: "medium" }, context(session.id, "general"))
        yield* def.execute({ action: "claim_next" }, context(session.id, "general"))
        const cancelled = yield* def.execute({ action: "cancel", id: created.metadata.todos[0]!.id }, context(session.id, "plan"))

        expect(cancelled.title).toBe("task execution blocked in plan mode")
        expect(cancelled.metadata.todos[0]?.status).toBe("in_progress")
      }),
    ),
  )

  it.live("updates pending tasks without claiming them", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Pending update" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "draft task", priority: "medium", assigned_agent: "general" }, context(session.id, "general"))
        const updated = yield* def.execute({ action: "update", id: created.metadata.todos[0]!.id, content: "ready task", priority: "high", assigned_agent: "qa" }, context(session.id, "general"))
        const task = updated.metadata.todos[0]

        expect(updated.title).toBe("task updated")
        expect(updated.output).toContain("Task updated:")
        expect(updated.output).toContain("Queue: 1 pending, 0 active, 0 completed")
        expect(task?.id).toBe(created.metadata.todos[0]!.id)
        expect(task?.status).toBe("pending")
        expect(task?.claimedBy).toBeUndefined()
        expect(task?.content).toBe("ready task")
        expect(task?.priority).toBe("high")
        expect(task?.assignedAgent).toBe("qa")
        expect(task?.history).toContain("general\nTask created.")
        expect(task?.history).toContain("general\nUpdated task from general.")
      }),
    ),
  )

  it.live("lets plan mode cancel stale summary tasks after replacement tasks are created", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Stale summary cleanup" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const summary = yield* def.execute({ action: "create", content: "summary placeholder", priority: "medium" }, context(session.id, "plan"))
        yield* def.execute({ action: "create", content: "detailed replacement one", priority: "high", assigned_agent: "general" }, context(session.id, "plan"))
        yield* def.execute({ action: "create", content: "detailed replacement two", priority: "high", assigned_agent: "tui-dev" }, context(session.id, "plan"))
        const cancelled = yield* def.execute({ action: "cancel", id: summary.metadata.todos[0]!.id }, context(session.id, "plan"))
        const listed = yield* def.execute({ action: "list" }, context(session.id, "plan"))
        const stale = listed.metadata.todos.find((todo) => todo.id === summary.metadata.todos[0]!.id)

        expect(cancelled.title).toBe("task cancelled")
        expect(listed.metadata.todos).toHaveLength(3)
        expect(stale?.status).toBe("cancelled")
        expect(stale?.history).toContain("plan\nTask created.")
        expect(stale?.history).toContain("plan\nCancelled task.")
        expect(listed.metadata.todos.find((todo) => todo.content === "detailed replacement one")?.status).toBe("pending")
        expect(listed.metadata.todos.find((todo) => todo.content === "detailed replacement two")?.status).toBe("pending")
      }),
    ),
  )

  it.live("allows task mode queue maintenance but blocks execution actions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Task mode queue" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "queued planning task", priority: "medium" }, context(session.id, "task"))
        const updated = yield* def.execute({ action: "update", id: created.metadata.todos[0]!.id, priority: "high" }, context(session.id, "task"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "task"))
        const cancelled = yield* def.execute({ action: "cancel", id: created.metadata.todos[0]!.id }, context(session.id, "task"))

        expect(updated.title).toBe("task updated")
        expect(updated.metadata.todos[0]?.history).toContain("task\nUpdated task from task mode.")
        expect(claimed.title).toBe("task execution blocked in task mode")
        expect(cancelled.title).toBe("task cancelled")
        expect(cancelled.metadata.todos[0]?.status).toBe("cancelled")
      }),
    ),
  )

  it.live("does not let an agent claim work assigned to another agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Assignments" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "verify behavior", priority: "high", assigned_agent: "qa" }, context(session.id, "general"))

        const general = yield* def.execute({ action: "claim_next" }, context(session.id, "general"))
        const qa = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))

        expect(general.metadata.claimed).toBeUndefined()
        expect(qa.metadata.claimed?.content).toBe("verify behavior")
      }),
    ),
  )

  it.live("assigns uncategorized tasks to general instead of leaving them for build", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Default assignment" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "implement request handling", priority: "medium" }, context(session.id, "build"))

        expect(created.metadata.todos[0]?.assignedAgent).toBe("general")
      }),
    ),
  )

  it.live("routes explicit build assignments for implementation work away from build", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Build assignment guard" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "implement request handling", priority: "medium", assigned_agent: "build" }, context(session.id, "build"))

        expect(created.metadata.todos[0]?.assignedAgent).toBe("general")
      }),
    ),
  )

  it.live("keeps build assignments for build-system work", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Build task" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "fix CI workflow packaging", priority: "medium", assigned_agent: "build" }, context(session.id, "general"))

        expect(created.metadata.todos[0]?.assignedAgent).toBe("build")
      }),
    ),
  )

  it.live("keeps explicit final verification tasks assigned to build", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Final verification" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "Final verification: from packages/opencode run bun typecheck and agreed package-level checks", priority: "high", assigned_agent: "build" }, context(session.id, "general"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))

        expect(created.metadata.todos[0]?.assignedAgent).toBe("build")
        expect(claimed.metadata.claimed?.content).toContain("Final verification")
      }),
    ),
  )

  it.live("routes development phrases with build terms away from build", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Development assignment guard" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "implement user onboarding workflow", priority: "medium" }, context(session.id, "general"))
        yield* def.execute({ action: "create", content: "fix provider compile error", priority: "medium" }, context(session.id, "general"))
        const build = yield* def.execute({ action: "create", content: "fix release-engineering package publish", priority: "medium" }, context(session.id, "general"))

        expect(build.metadata.todos.find((todo) => todo.content === "implement user onboarding workflow")?.assignedAgent).toBe("general")
        expect(build.metadata.todos.find((todo) => todo.content === "fix provider compile error")?.assignedAgent).toBe("general")
        expect(build.metadata.todos.find((todo) => todo.content === "fix release-engineering package publish")?.assignedAgent).toBe("build")
      }),
    ),
  )

  it.live("prevents build from claiming unassigned development work", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Build claim guard" })
        yield* todos.update({
          sessionID: session.id,
          todos: [
            { content: "implement request handling", status: "pending", priority: "high" },
            { content: "fix CI workflow packaging", status: "pending", priority: "medium", assignedAgent: "build" },
          ],
        })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))

        expect(claimed.metadata.claimed?.content).toBe("fix CI workflow packaging")
        expect(claimed.metadata.todos.find((todo) => todo.content === "implement request handling")?.status).toBe("pending")
      }),
    ),
  )

  it.live("refuses completion unless the same agent claimed the task first", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Lifecycle" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "owned task", priority: "medium" }, context(session.id, "general"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "general"))

        const wrongAgent = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, context(session.id, "qa"))
        const stillActive = wrongAgent.metadata.todos.find((todo) => todo.id === claimed.metadata.claimed!.id)
        expect(wrongAgent.title).toBe("task not found")
        expect(stillActive?.status).toBe("in_progress")
        expect(stillActive?.claimedBy).toBe("general")

        const completed = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, context(session.id, "general"))
        expect(completed.metadata.todos).toHaveLength(1)
        expect(completed.metadata.todos.find((todo) => todo.id === claimed.metadata.claimed!.id)?.status).toBe("completed")
        expect(completed.output).not.toContain("QA validation queued")
      }),
    ),
  )

  it.live("cancels pending tasks by id without requiring a claim", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Pending cancel" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        const created = yield* def.execute({ action: "create", content: "stale validation task", priority: "medium", assigned_agent: "qa" }, context(session.id, "general"))
        const cancelled = yield* def.execute({ action: "cancel", id: created.metadata.todos[0]!.id }, context(session.id, "general"))

        expect(cancelled.title).toBe("task cancelled")
        expect(cancelled.metadata.todos[0]?.status).toBe("cancelled")
        expect(cancelled.metadata.todos[0]?.completedBy).toBe("general")
      }),
    ),
  )

  it.live("keeps timestamped lifecycle history across create claim and complete", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "History" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "history task", priority: "medium" }, context(session.id, "general"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "general"))
        const completed = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, context(session.id, "general"))
        const history = completed.metadata.todos.find((todo) => todo.id === claimed.metadata.claimed!.id)?.history ?? ""

        expect(history).toContain("general\nTask created.")
        expect(history).toContain("general\nClaimed task.")
        expect(history).toContain("general\nCompleted task.")
        expect(completed.output).toContain("timeline:")
        expect(completed.output).toContain("+->")
      }),
    ),
  )

  it.live("keeps one task id through explicit QA handoffs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Single handoff task" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "validate tui hover state", priority: "high", assigned_agent: "qa" }, context(session.id, "general"))
        const qa = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const bounced = yield* def.execute({ action: "create", content: "hover still leaks mouse events", priority: "high", assigned_agent: "tui-dev" }, context(session.id, "qa"))

        expect(bounced.metadata.todos.map((todo) => todo.id)).toEqual([qa.metadata.claimed!.id])
        expect(bounced.metadata.todos[0]?.assignedAgent).toBe("tui-dev")
        expect(bounced.metadata.todos[0]?.bounceCount).toBe(1)
        expect(bounced.output).toContain("timeline:")
      }),
    ),
  )

  it.live("does not create recursive QA tasks when QA completes validation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "QA" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "validate the thing", priority: "medium", assigned_agent: "qa" }, context(session.id, "general"))
        const claimed = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const completed = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, context(session.id, "qa"))

        expect(completed.metadata.todos.filter((todo) => todo.assignedAgent === "qa" && todo.status === "pending")).toHaveLength(0)
      }),
    ),
  )

  it.live("blocks after four manual QA handoffs without task IDs in the issue text", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Bounce guard" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()

        yield* def.execute({ action: "create", content: "fix flaky CI workflow", priority: "high", assigned_agent: "build" }, context(session.id, "general"))

        const firstBuild = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))
        yield* def.execute({ action: "complete", id: firstBuild.metadata.claimed!.id }, context(session.id, "build"))
        yield* todos.handoff({ sessionID: session.id, id: firstBuild.metadata.claimed!.id!, agent: "user", assignedAgent: "qa", status: "pending", message: "Manual QA requested." })

        const firstQA = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const firstBounce = yield* def.execute({ action: "create", content: "same problem still failing", priority: "high", assigned_agent: "build" }, context(session.id, "qa"))

        const secondBuild = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))
        yield* def.execute({ action: "complete", id: secondBuild.metadata.claimed!.id }, context(session.id, "build"))
        yield* todos.handoff({ sessionID: session.id, id: firstBuild.metadata.claimed!.id!, agent: "user", assignedAgent: "qa", status: "pending", message: "Manual QA requested." })

        const secondQA = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const secondBounce = yield* def.execute({ action: "create", content: "same problem still failing", priority: "high", assigned_agent: "build" }, context(session.id, "qa"))

        const thirdBuild = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))
        yield* def.execute({ action: "complete", id: thirdBuild.metadata.claimed!.id }, context(session.id, "build"))
        yield* todos.handoff({ sessionID: session.id, id: firstBuild.metadata.claimed!.id!, agent: "user", assignedAgent: "qa", status: "pending", message: "Manual QA requested." })

        const thirdQA = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const thirdBounce = yield* def.execute({ action: "create", content: "same problem still failing", priority: "high", assigned_agent: "build" }, context(session.id, "qa"))

        const fourthBuild = yield* def.execute({ action: "claim_next" }, context(session.id, "build"))
        yield* def.execute({ action: "complete", id: fourthBuild.metadata.claimed!.id }, context(session.id, "build"))
        yield* todos.handoff({ sessionID: session.id, id: firstBuild.metadata.claimed!.id!, agent: "user", assignedAgent: "qa", status: "pending", message: "Manual QA requested." })

        const fourthQA = yield* def.execute({ action: "claim_next" }, context(session.id, "qa"))
        const fourthBounce = yield* def.execute({ action: "create", content: "same problem still failing", priority: "high", assigned_agent: "build" }, context(session.id, "qa"))

        expect(firstBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.bounceCount).toBe(1)
        expect(secondBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.bounceCount).toBe(2)
        expect(thirdBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.bounceCount).toBe(3)
        expect(fourthBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.status).toBe("blocked")
        expect(fourthBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.bounceCount).toBe(4)
        expect(fourthBounce.metadata.todos.find((todo) => todo.id === firstBuild.metadata.claimed?.id)?.assignedAgent).toBeUndefined()
        expect(fourthQA.metadata.claimed?.bounceCount).toBe(3)
      }),
    ),
  )

})
