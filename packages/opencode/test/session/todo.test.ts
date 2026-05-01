import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Bus.layer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer, Session.defaultLayer, Todo.defaultLayer))

describe("Todo", () => {
  it.live("claimNextRunnable claims pending tasks by priority and queue position", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Runnable priority" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        yield* todos.create({ sessionID: session.id, content: "first low", priority: "low" })
        yield* todos.create({ sessionID: session.id, content: "first high", priority: "high" })
        yield* todos.create({ sessionID: session.id, content: "second high", priority: "high" })

        const first = yield* todos.claimNextRunnable({ sessionID: session.id, agents: ["general"] })
        const second = yield* todos.claimNextRunnable({ sessionID: session.id, agents: ["general"] })

        expect(first.claimed?.content).toBe("first high")
        expect(first.agent).toBe("general")
        expect(second.claimed?.content).toBe("second high")
      }),
    ),
  )

  it.live("claimNextRunnable matches assigned tasks to compatible agents", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Runnable assignment" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        yield* todos.create({ sessionID: session.id, content: "qa task", priority: "high", assignedAgent: "qa" })

        const claimed = yield* todos.claimNextRunnable({ sessionID: session.id, agents: ["general", "qa"] })

        expect(claimed.claimed?.content).toBe("qa task")
        expect(claimed.agent).toBe("qa")
        expect(claimed.claimed?.claimedBy).toBe("qa")
      }),
    ),
  )

  it.live("claimNextRunnable leaves missing or hidden assigned agents pending", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Runnable blocked" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        yield* todos.create({ sessionID: session.id, content: "missing agent", priority: "high", assignedAgent: "missing" })
        yield* todos.create({ sessionID: session.id, content: "hidden agent", priority: "high", assignedAgent: "secret" })

        const missing = yield* todos.claimNextRunnable({ sessionID: session.id, agents: ["general"] })
        const hidden = yield* todos.claimNextRunnable({ sessionID: session.id, agents: [{ name: "secret", hidden: true }] })

        expect(missing.claimed).toBeUndefined()
        expect(hidden.claimed).toBeUndefined()
        expect((yield* todos.get(session.id)).map((todo) => todo.status)).toEqual(["pending", "pending"])
      }),
    ),
  )

  it.live("claimNextRunnable does not duplicate concurrent claims", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const session = yield* sessions.create({ title: "Runnable duplicate" })
        yield* todos.update({ sessionID: session.id, todos: [] })
        yield* todos.create({ sessionID: session.id, content: "single", priority: "high" })

        const results = yield* Effect.all(
          [
            todos.claimNextRunnable({ sessionID: session.id, agents: ["general"] }),
            todos.claimNextRunnable({ sessionID: session.id, agents: ["qa"] }),
          ],
          { concurrency: "unbounded" },
        )

        expect(results.filter((result) => result.claimed?.content === "single")).toHaveLength(1)
        expect((yield* todos.get(session.id)).filter((todo) => todo.status === "in_progress")).toHaveLength(1)
      }),
    ),
  )
})
