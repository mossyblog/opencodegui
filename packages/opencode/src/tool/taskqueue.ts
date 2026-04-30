import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./taskqueue.txt"
import { Todo } from "../session/todo"
import { Session } from "@/session/session"

const Action = Schema.Literals(["create", "list", "claim_next", "complete", "cancel"])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "Queue action to perform" }),
  id: Schema.optional(Schema.String).annotate({ description: "Task id for complete or cancel actions" }),
  content: Schema.optional(Schema.String).annotate({ description: "Task content for create" }),
  priority: Schema.optional(Todo.Priority).annotate({ description: "Task priority for create" }),
})

type Metadata = {
  todos: Todo.Info[]
  claimed?: Todo.Info
  next?: Todo.Info
}

const fmt = (todo: Todo.Info) =>
  [
    `- ${todo.id ?? "unknown"} [${todo.status}] (${todo.priority}) ${todo.content}`,
    todo.claimedBy ? `  claimed_by: ${todo.claimedBy}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")

const summary = (todos: Todo.Info[]) => {
  const pending = todos.filter((todo) => todo.status === "pending").length
  const active = todos.filter((todo) => todo.status === "in_progress" || todo.status === "claimed").length
  const completed = todos.filter((todo) => todo.status === "completed").length
  return `${pending} pending, ${active} active, ${completed} completed`
}

export const TaskQueueTool = Tool.define<typeof Parameters, Metadata, Todo.Service | Session.Service>(
  "taskqueue",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service

    const actor = Effect.fn("TaskQueueTool.actor")(function* (ctx: Tool.Context<Metadata>) {
      return yield* sessions.get(ctx.sessionID).pipe(
        Effect.map((session) => session.title.replace(/ \(@.+ subagent\)$/, "")),
        Effect.catchCause(() => Effect.succeed(ctx.agent)),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "taskqueue", patterns: ["*"], always: ["*"], metadata: {} })
          const agent = yield* actor(ctx)

          if (params.action === "create") {
            if (!params.content) return yield* Effect.die(new Error("taskqueue create requires content"))
            const created = yield* todo.create({
              sessionID: ctx.sessionID,
              content: params.content,
              priority: params.priority ?? "medium",
              createdBy: agent,
            })
            const todos = yield* todo.get(ctx.sessionID)
            return {
              title: "task created",
              output: ["Created task:", fmt(created), "", `Queue: ${summary(todos)}`].join("\n"),
              metadata: { todos, next: todos.find((item) => item.status === "pending") },
            }
          }

          if (params.action === "claim_next") {
            const result = yield* todo.claimNext({ sessionID: ctx.sessionID, agent })
            const todos = yield* todo.get(ctx.sessionID)
            return {
              title: result.claimed ? "task claimed" : "no pending tasks",
              output: [
                result.claimed ? ["Claimed task:", fmt(result.claimed)].join("\n") : "No pending tasks.",
                result.next ? ["", "Next queued task:", fmt(result.next)].join("\n") : "",
                "",
                `Queue: ${summary(todos)}`,
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { todos, claimed: result.claimed, next: result.next },
            }
          }

          if (params.action === "complete" || params.action === "cancel") {
            if (!params.id) return yield* Effect.die(new Error(`taskqueue ${params.action} requires id`))
            const result = params.action === "complete"
              ? yield* todo.complete({ sessionID: ctx.sessionID, id: params.id, agent })
              : yield* todo.cancel({ sessionID: ctx.sessionID, id: params.id, agent })
            const changed = "completed" in result ? result.completed : result.cancelled
            const todos = yield* todo.get(ctx.sessionID)
            return {
              title: changed ? `task ${params.action}d` : "task not found",
              output: [
                changed ? [`Task ${params.action}d:`, fmt(changed)].join("\n") : `Task not found: ${params.id}`,
                result.next ? ["", "Next queued task:", fmt(result.next)].join("\n") : "",
                "",
                `Queue: ${summary(todos)}`,
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { todos, next: result.next },
            }
          }

          const todos = yield* todo.get(ctx.sessionID)
          return {
            title: `${todos.length} tasks`,
            output: todos.length ? [`Queue: ${summary(todos)}`, "", ...todos.map(fmt)].join("\n") : "No tasks.",
            metadata: { todos, next: todos.find((item) => item.status === "pending") },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
