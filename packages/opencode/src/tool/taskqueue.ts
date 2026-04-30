import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./taskqueue.txt"
import { Todo } from "../session/todo"
import { Session } from "@/session/session"

const Action = Schema.Literals(["create", "list", "claim_next", "complete", "cancel", "reassign"])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "Queue action to perform" }),
  id: Schema.optional(Schema.String).annotate({ description: "Task id for complete or cancel actions" }),
  content: Schema.optional(Schema.String).annotate({ description: "Task content for create" }),
  priority: Schema.optional(Todo.Priority).annotate({ description: "Task priority for create" }),
  assigned_agent: Schema.optional(Schema.String).annotate({ description: "Agent assigned to this task" }),
})

type Metadata = {
  todos: Todo.Info[]
  claimed?: Todo.Info
  next?: Todo.Info
}

const fmt = (todo: Todo.Info) =>
  [
    `- ${todo.id ?? "unknown"} [${todo.status}] (${todo.priority}) ${todo.content}`,
    todo.assignedAgent ? `  assigned_agent: ${todo.assignedAgent}` : undefined,
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

const buildTaskPatterns = [
  /\bbuild[- ]system\b/,
  /\bbuild script\b/,
  /\bbundler\b/,
  /\bpackag(?:e|ing)\b.*\b(?:build|publish|release|ci|workflow)\b/,
  /\b(?:build|publish|release|ci|workflow)\b.*\bpackag(?:e|ing)\b/,
  /\bci\b/,
  /\bgithub actions?\b/,
  /\b(?:build|ci|release) workflow\b/,
  /\bworkflow\b.*\b(?:build|ci|release)\b/,
  /\brelease[- ]engineering\b/,
  /\brelease pipeline\b/,
  /\bcompile\b.*\b(?:build|bundler|package|packaging|ci|pipeline)\b/,
]

const buildBounce = (source?: Todo.Info) => source?.content.toLowerCase().includes("validate build's completed work")
const buildTask = (content: string, source?: Todo.Info) => buildTaskPatterns.some((item) => item.test(content.toLowerCase())) || buildBounce(source)

const assignAgent = (content: string) => {
  const lower = content.toLowerCase()
  if (["tui", "kanban", "modal", "sidebar", "ctrl+", "keybind", "tab", "spinner", "ellipsis"].some((item) => lower.includes(item))) return "tui-dev"
  if (["verify", "typecheck", "test", "regression"].some((item) => lower.includes(item))) return "qa"
  if (["readme", "docs", "documentation"].some((item) => lower.includes(item))) return "general"
  if (buildTask(content)) return "build"
  return "general"
}

const assignedAgent = (content: string, agent?: string, source?: Todo.Info) => {
  if (agent !== "build") return agent ?? assignAgent(content)
  if (buildTask(content, source)) return "build"
  return assignAgent(content)
}

const nextForAgent = (todos: Todo.Info[], agent: string) =>
  todos
    .filter((todo) => todo.status === "pending" && todo.assignedAgent === agent)
    .toSorted((a, b) => priorityRank(a.priority) - priorityRank(b.priority))[0]

const priorityRank = (value: string) => value === "high" ? 0 : value === "medium" ? 1 : 2

const activeForAgent = (todos: Todo.Info[], agent: string) =>
  todos.find((todo) =>
    (todo.status === "in_progress" || todo.status === "claimed") && todo.claimedBy === agent
  )

const qaTaskContent = (task: Todo.Info, agent: string) =>
  `Validate ${agent}'s completed work for task ${task.id ?? "unknown"}: ${task.content}`

const priority = (value: string): Todo.Priority => value === "high" ? "high" : value === "low" ? "low" : "medium"
const entry = (agent: string, message: string) => `### ${new Date().toISOString()} ${agent}\n${message}`
const referencedTaskID = (content: string) => /task\s+([0-9A-Z]{26})/.exec(content)?.[1]
const blockedInPlan = (action: Schema.Schema.Type<typeof Parameters>["action"]) =>
  action === "claim_next" || action === "complete" || action === "cancel" || action === "reassign"

export const TaskQueueTool = Tool.define<typeof Parameters, Metadata, Todo.Service | Session.Service>(
  "taskqueue",
  Effect.gen(function* () {
    const todo = yield* Todo.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "taskqueue", patterns: ["*"], always: ["*"], metadata: {} })
          const agent = ctx.agent
          const session = yield* sessions.get(ctx.sessionID)
          const sessionID = session.parentID ?? ctx.sessionID

          if (agent === "plan" && blockedInPlan(params.action)) {
            const todos = yield* todo.get(sessionID)
            return {
              title: "task execution blocked in plan mode",
              output: [
                "Plan mode can create and list tasks, but it cannot claim, complete, or cancel queued work.",
                "Switch to build mode before starting task execution.",
                "",
                `Queue: ${summary(todos)}`,
              ].join("\n"),
              metadata: { todos },
            }
          }

          if (params.action === "create") {
            if (!params.content) return yield* Effect.die(new Error("taskqueue create requires content"))
            const existing = yield* todo.get(sessionID)
            const qaHandoff = agent === "qa" && params.assigned_agent && params.assigned_agent !== "qa"
            const sourceID = referencedTaskID(params.content)
            const source = sourceID ? existing.find((item) => item.id === sourceID) : qaHandoff ? activeForAgent(existing, agent) : undefined
            const bounceCount = qaHandoff ? (source?.bounceCount ?? 0) + 1 : 0
            const blocked = bounceCount > 3
            const assigned = blocked ? undefined : assignedAgent(params.content, params.assigned_agent, source)
            const created = yield* todo.create({
              sessionID,
              content: blocked
                ? `Blocked after ${bounceCount} QA/dev handoffs. Human decision required: ${params.content}`
                : params.content,
              priority: params.priority ?? "medium",
              createdBy: agent,
              assignedAgent: assigned,
              status: blocked ? "blocked" : "pending",
              bounceCount,
              history: [source?.history, entry(agent, blocked ? "Blocked because QA/dev handoff limit was exceeded." : "Task created.")]
                .filter(Boolean)
                .join("\n\n"),
            })
            const todos = yield* todo.get(sessionID)
            return {
              title: "task created",
              output: ["Created task:", fmt(created), "", `Queue: ${summary(todos)}`].join("\n"),
              metadata: { todos, next: todos.find((item) => item.status === "pending") },
            }
          }

          if (params.action === "claim_next") {
            const current = activeForAgent(yield* todo.get(sessionID), agent)
            if (current) {
              const todos = yield* todo.get(sessionID)
              return {
                title: "task already claimed",
                output: [
                  "Finish or cancel your currently claimed task before claiming another:",
                  fmt(current),
                  "",
                  `Queue: ${summary(todos)}`,
                ].join("\n"),
                metadata: { todos, claimed: current },
              }
            }
            const result = agent === "build"
              ? yield* Effect.gen(function* () {
                  const next = nextForAgent(yield* todo.get(sessionID), agent)
                  if (!next?.id) return {}
                  return yield* todo.claim({ sessionID, id: next.id, agent })
                })
              : yield* todo.claimNext({ sessionID, agent })
            const todos = yield* todo.get(sessionID)
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

          if (params.action === "reassign") {
            if (!params.id) return yield* Effect.die(new Error("taskqueue reassign requires id"))
            if (!params.assigned_agent) return yield* Effect.die(new Error("taskqueue reassign requires assigned_agent"))
            const existing = yield* todo.get(sessionID)
            yield* todo.reassign({ sessionID, id: params.id, agent: assignedAgent(existing.find((item) => item.id === params.id)?.content ?? "", params.assigned_agent) })
            const todos = yield* todo.get(sessionID)
            const changed = todos.find((item) => item.id === params.id)
            return {
              title: changed ? "task reassigned" : "task not found",
              output: [changed ? ["Task reassigned:", fmt(changed)].join("\n") : `Task not found: ${params.id}`, "", `Queue: ${summary(todos)}`].join("\n"),
              metadata: { todos },
            }
          }

          if (params.action === "complete" || params.action === "cancel") {
            if (!params.id) return yield* Effect.die(new Error(`taskqueue ${params.action} requires id`))
            const result = params.action === "complete"
              ? yield* todo.complete({ sessionID, id: params.id, agent })
              : yield* todo.cancel({ sessionID, id: params.id, agent })
            const changed = "completed" in result ? result.completed : result.cancelled
            const qaTask = params.action === "complete" && changed && agent !== "qa"
              ? yield* todo.create({
                  sessionID,
                  content: qaTaskContent(changed, agent),
                  priority: changed.priority === "low" ? "medium" : priority(changed.priority),
                  createdBy: "taskqueue",
                  assignedAgent: "qa",
                  bounceCount: changed.bounceCount ?? 0,
                  history: [changed.history, entry("taskqueue", `Queued QA validation for ${agent}'s completed work.`)]
                    .filter(Boolean)
                    .join("\n\n"),
                })
              : undefined
            const todos = yield* todo.get(sessionID)
            return {
              title: changed ? `task ${params.action}d` : "task not found",
              output: [
                changed ? [`Task ${params.action}d:`, fmt(changed)].join("\n") : `Task not found: ${params.id}`,
                qaTask ? ["", "QA validation queued:", fmt(qaTask)].join("\n") : "",
                "",
                `Queue: ${summary(todos)}`,
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { todos },
            }
          }

          const todos = yield* todo.get(sessionID)
          return {
            title: `${todos.length} tasks`,
            output: todos.length ? [`Queue: ${summary(todos)}`, "", ...todos.map(fmt)].join("\n") : "No tasks.",
            metadata: { todos, next: todos.find((item) => item.status === "pending") },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
