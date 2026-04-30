import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { TaskQueueTool } from "../../src/tool/taskqueue"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID } from "@/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer, Session.defaultLayer, Todo.defaultLayer, Truncate.defaultLayer),
)

describe("tool.taskqueue", () => {
  it.live("creates, claims, and completes queued tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Task queue" })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.ascending(),
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        yield* def.execute({ action: "create", content: "first", priority: "low" }, ctx)
        yield* def.execute({ action: "create", content: "urgent", priority: "high" }, ctx)

        const claimed = yield* def.execute({ action: "claim_next" }, ctx)
        expect(claimed.metadata.claimed?.content).toBe("urgent")
        expect(claimed.metadata.next?.content).toBe("first")

        const completed = yield* def.execute({ action: "complete", id: claimed.metadata.claimed!.id }, ctx)
        expect(completed.metadata.next?.content).toBe("first")
        expect(completed.metadata.todos.find((todo) => todo.content === "urgent")?.status).toBe("completed")
        expect(completed.metadata.todos.find((todo) => todo.content === "urgent")?.completedBy).toBe("Task queue")
      }),
    ),
  )

  it.live("shares queued tasks across sessions in the same project", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const first = yield* sessions.create({ title: "First" })
        const second = yield* sessions.create({ title: "Second" })
        const tool = yield* TaskQueueTool
        const def = yield* tool.init()
        const base = {
          messageID: MessageID.ascending(),
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        yield* def.execute({ action: "create", content: "shared", priority: "medium" }, { ...base, sessionID: first.id })

        const list = yield* def.execute({ action: "list" }, { ...base, sessionID: second.id })
        expect(list.metadata.todos.map((todo) => todo.content)).toContain("shared")

        const claimed = yield* def.execute({ action: "claim_next" }, { ...base, sessionID: second.id })
        expect(claimed.metadata.claimed?.content).toBe("shared")
      }),
    ),
  )
})
