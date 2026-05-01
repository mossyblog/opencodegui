import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Effect, Layer, Context, Schema } from "effect"
import z from "zod"
import { Database } from "@/storage/db"
import { and, eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { SessionTable, TodoTable } from "./session.sql"
import { ulid } from "ulid"

export const Priority = Schema.Literals(["high", "medium", "low"])
export type Priority = Schema.Schema.Type<typeof Priority>

export const Info = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({ description: "Stable task identifier" }),
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({ description: "Current task status" }),
  priority: Schema.String.annotate({ description: "Priority level of the task" }),
  assignedAgent: Schema.optional(Schema.String).annotate({ description: "Agent assigned to the task" }),
  bounceCount: Schema.optional(Schema.Number).annotate({ description: "Manual QA handoff count for this task" }),
  history: Schema.optional(Schema.String).annotate({ description: "Simple timestamped lifecycle history" }),
  createdBy: Schema.optional(Schema.String).annotate({ description: "Agent or session that created the task" }),
  claimedBy: Schema.optional(Schema.String).annotate({ description: "Agent currently responsible for the task" }),
  claimedAt: Schema.optional(Schema.Number).annotate({ description: "Unix timestamp when the task was claimed" }),
  completedBy: Schema.optional(Schema.String).annotate({ description: "Agent that completed or cleared the task" }),
  completedAt: Schema.optional(Schema.Number).annotate({ description: "Unix timestamp when the task was completed" }),
})
  .annotate({ identifier: "Todo" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    Schema.Struct({
      sessionID: SessionID,
      todos: Schema.Array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly create: (input: {
    sessionID: SessionID
    content: string
    priority: Priority
    createdBy?: string
    assignedAgent?: string
    status?: string
    bounceCount?: number
    history?: string
  }) => Effect.Effect<Info>
  readonly claimNext: (input: { sessionID: SessionID; agent: string }) => Effect.Effect<{ claimed?: Info; next?: Info }>
  readonly claimNextRunnable: (input: { sessionID: SessionID; agents: RunnableAgent[] }) => Effect.Effect<{ claimed?: Info; agent?: string; next?: Info }>
  readonly claim: (input: { sessionID: SessionID; id: string; agent: string }) => Effect.Effect<{ claimed?: Info; next?: Info }>
  readonly complete: (input: { sessionID: SessionID; id: string; agent: string; summary?: string; workerSessionID?: string }) => Effect.Effect<FinishResult>
  readonly block: (input: { sessionID: SessionID; id: string; agent: string; blocker: string; workerSessionID?: string }) => Effect.Effect<FinishResult>
  readonly interrupt: (input: { sessionID: SessionID; id: string; agent: string; reason: string; workerSessionID?: string }) => Effect.Effect<FinishResult>
  readonly cancel: (input: { sessionID: SessionID; id: string; agent: string }) => Effect.Effect<FinishResult>
  readonly handoff: (input: { sessionID: SessionID; id: string; agent: string; assignedAgent?: string; status?: string; priority?: Priority; bounceCount?: number; message: string }) => Effect.Effect<Info | undefined>
  readonly interruptActive: (input: { sessionID: SessionID; agent?: string; reason: string }) => Effect.Effect<Info[]>
  readonly unclaim: (input: { sessionID: SessionID; id: string }) => Effect.Effect<void>
  readonly reassign: (input: { sessionID: SessionID; id: string; agent?: string }) => Effect.Effect<void>
  readonly remove: (input: { sessionID: SessionID; id: string }) => Effect.Effect<void>
  readonly edit: (input: { sessionID: SessionID; id: string; content: string; assignedAgent?: string | null }) => Effect.Effect<void>
  readonly updatePending: (input: { sessionID: SessionID; id: string; agent: string; content?: string; priority?: Priority; assignedAgent?: string }) => Effect.Effect<Info | undefined>
}

type FinishResult = { completed?: Info; cancelled?: Info; next?: Info }
export type RunnableAgent = string | { name: string; hidden?: boolean }

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const ensureSchema = () => {
      const columns = Database.Client().$client.query("PRAGMA table_info(todo)").all() as { name: string }[]
      if (columns.length === 0) return
      if (!columns.some((column) => column.name === "project_id")) {
        Database.Client().$client.run("PRAGMA foreign_keys=OFF")
        Database.Client().$client.run(`CREATE TABLE \`__new_todo\` (
          \`id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`assigned_agent\` text,
          \`bounce_count\` integer,
          \`history\` text,
          \`created_by\` text,
          \`claimed_by\` text,
          \`claimed_at\` integer,
          \`completed_by\` text,
          \`completed_at\` integer,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`project_id\`, \`id\`),
          CONSTRAINT \`fk_todo_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )`)
        Database.Client().$client.run(
          "INSERT INTO `__new_todo`(`id`, `project_id`, `content`, `status`, `priority`, `position`, `time_created`, `time_updated`) SELECT `todo`.`session_id` || ':' || `todo`.`position`, `session`.`project_id`, `todo`.`content`, `todo`.`status`, `todo`.`priority`, `todo`.`position`, `todo`.`time_created`, `todo`.`time_updated` FROM `todo` INNER JOIN `session` ON `session`.`id` = `todo`.`session_id`",
        )
        Database.Client().$client.run("DROP TABLE `todo`")
        Database.Client().$client.run("ALTER TABLE `__new_todo` RENAME TO `todo`")
        Database.Client().$client.run("CREATE INDEX `todo_project_idx` ON `todo` (`project_id`)")
        Database.Client().$client.run("PRAGMA foreign_keys=ON")
        return
      }
      if (!columns.some((column) => column.name === "assigned_agent")) {
        Database.Client().$client.run("ALTER TABLE `todo` ADD COLUMN `assigned_agent` text")
      }
      if (!columns.some((column) => column.name === "bounce_count")) {
        Database.Client().$client.run("ALTER TABLE `todo` ADD COLUMN `bounce_count` integer")
      }
      if (!columns.some((column) => column.name === "history")) {
        Database.Client().$client.run("ALTER TABLE `todo` ADD COLUMN `history` text")
      }
      if (!columns.some((column) => column.name === "completed_by")) {
        Database.Client().$client.run("ALTER TABLE `todo` ADD COLUMN `completed_by` text")
      }
    }

    const fromRow = (row: typeof TodoTable.$inferSelect): Info => ({
      id: row.id,
      content: row.content,
      status: row.status,
      priority: row.priority,
      ...(row.assigned_agent ? { assignedAgent: row.assigned_agent } : {}),
      ...(row.bounce_count ? { bounceCount: row.bounce_count } : {}),
      ...(row.history ? { history: row.history } : {}),
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.completed_by ? { completedBy: row.completed_by } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    })

    const priorityRank = (priority: string) => (priority === "high" ? 0 : priority === "medium" ? 1 : 2)
    const historyEntry = (agent: string, message: string) => `### ${new Date().toISOString()} ${agent}\n${message}`
    const appendHistory = (todo: Info, agent: string, message: string) =>
      [todo.history, historyEntry(agent, message)].filter(Boolean).join("\n\n")

    const nextPending = (todos: Info[], agent?: string) =>
      todos
        .filter((todo) => todo.status === "pending" && (!agent || !todo.assignedAgent || todo.assignedAgent === agent))
        .toSorted((a, b) => priorityRank(a.priority) - priorityRank(b.priority))[0]

    const runnableAgent = (todo: Info, agents: string[]) => todo.assignedAgent ? agents.find((agent) => agent === todo.assignedAgent) : agents[0]

    const runnableAgents = (agents: RunnableAgent[]) =>
      agents
        .filter((agent) => typeof agent === "string" || !agent.hidden)
        .map((agent) => typeof agent === "string" ? agent : agent.name)
        .filter((agent, index, all) => all.indexOf(agent) === index)

    const nextRunnable = (todos: Info[], agents: string[]) =>
      todos
        .filter((todo) => todo.status === "pending" && runnableAgent(todo, agents))
        .toSorted((a, b) => priorityRank(a.priority) - priorityRank(b.priority))[0]

    const projectID = (sessionID: SessionID) => {
      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
      if (!row) throw new Error(`Session not found: ${sessionID}`)
      return row.project_id
    }

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      ensureSchema()
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.project_id, projectID(sessionID))).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map(fromRow)
    })

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          db.delete(TodoTable).where(eq(TodoTable.project_id, pid)).run()
          if (input.todos.length === 0) return
          db.insert(TodoTable)
            .values(
              input.todos.map((todo, position) => ({
                id: todo.id ?? ulid(),
                project_id: pid,
                content: todo.content,
                status: todo.status,
                priority: todo.priority,
                assigned_agent: todo.assignedAgent,
                bounce_count: todo.bounceCount,
                history: todo.history,
                created_by: todo.createdBy,
                claimed_by: todo.claimedBy,
                claimed_at: todo.claimedAt,
                completed_by: todo.completedBy,
                completed_at: todo.completedAt,
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    const create = Effect.fn("Todo.create")(function* (input: {
      sessionID: SessionID
      content: string
      priority: Priority
      createdBy?: string
      assignedAgent?: string
      status?: string
      bounceCount?: number
      history?: string
    }) {
      ensureSchema()
      const created = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const position = db.select().from(TodoTable).where(eq(TodoTable.project_id, pid)).all().length
          const row = {
            id: ulid(),
            project_id: pid,
            content: input.content,
            status: input.status ?? "pending",
            priority: input.priority,
            assigned_agent: input.assignedAgent,
            bounce_count: input.bounceCount,
            history: input.history,
            created_by: input.createdBy,
            position,
          }
          db.insert(TodoTable).values(row).run()
          return { id: row.id, content: row.content, status: row.status, priority: row.priority, assignedAgent: row.assigned_agent, bounceCount: row.bounce_count, history: row.history, createdBy: row.created_by }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return created
    })

    const claimNext = Effect.fn("Todo.claimNext")(function* (input: { sessionID: SessionID; agent: string }) {
      ensureSchema()
      const result = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const todos = db
            .select()
            .from(TodoTable)
            .where(eq(TodoTable.project_id, projectID(input.sessionID)))
            .orderBy(asc(TodoTable.position))
            .all()
            .map(fromRow)
          const claimed = nextPending(todos, input.agent)
          if (!claimed?.id) return {}
          const now = Date.now()
          const history = appendHistory(claimed, input.agent, "Claimed task.")
          db.update(TodoTable)
            .set({ status: "in_progress", claimed_by: input.agent, claimed_at: now, history })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, claimed.id)))
            .run()
          return {
            claimed: { ...claimed, status: "in_progress", claimedBy: input.agent, claimedAt: now, history },
              next: nextPending(todos.filter((todo) => todo.id !== claimed.id), input.agent),
          }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const claimNextRunnable = Effect.fn("Todo.claimNextRunnable")(function* (input: { sessionID: SessionID; agents: RunnableAgent[] }) {
      ensureSchema()
      const result = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const agents = runnableAgents(input.agents)
          if (agents.length === 0) return {}
          const pid = projectID(input.sessionID)
          const todos = db.select().from(TodoTable).where(eq(TodoTable.project_id, pid)).orderBy(asc(TodoTable.position)).all().map(fromRow)
          const claimed = nextRunnable(todos, agents)
          const agent = claimed ? runnableAgent(claimed, agents) : undefined
          if (!claimed?.id || !agent) return {}
          const now = Date.now()
          const history = appendHistory(claimed, agent, "Claimed task.")
          db.update(TodoTable)
            .set({ status: "in_progress", claimed_by: agent, claimed_at: now, history })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, claimed.id), eq(TodoTable.status, "pending")))
            .run()
          return {
            claimed: { ...claimed, status: "in_progress", claimedBy: agent, claimedAt: now, history },
            agent,
            next: nextRunnable(todos.filter((todo) => todo.id !== claimed.id), agents),
          }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const claim = Effect.fn("Todo.claim")(function* (input: { sessionID: SessionID; id: string; agent: string }) {
      ensureSchema()
      const result = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const todos = db
            .select()
            .from(TodoTable)
            .where(eq(TodoTable.project_id, pid))
            .orderBy(asc(TodoTable.position))
            .all()
            .map(fromRow)
          const match = todos.find((todo) => todo.id === input.id)
          if (!match?.id) return {}
          if (match.status !== "pending") return {}
          if (match.assignedAgent && match.assignedAgent !== input.agent) return {}
          const now = Date.now()
          const history = appendHistory(match, input.agent, "Claimed task.")
          db.update(TodoTable)
            .set({ status: "in_progress", claimed_by: input.agent, claimed_at: now, history })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, match.id)))
            .run()
          return {
            claimed: { ...match, status: "in_progress", claimedBy: input.agent, claimedAt: now, history },
              next: nextPending(todos.filter((todo) => todo.id !== match.id), input.agent),
          }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const finish = Effect.fn("Todo.finish")(function* (input: {
      sessionID: SessionID
      id: string
      agent: string
      status: "completed" | "cancelled" | "blocked" | "interrupted" | "failed"
      summary?: string
      workerSessionID?: string
    }) {
      ensureSchema()
      const result: FinishResult = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const todos = db
            .select()
            .from(TodoTable)
            .where(eq(TodoTable.project_id, projectID(input.sessionID)))
            .orderBy(asc(TodoTable.position))
            .all()
            .map(fromRow)
          const match = todos.find((todo) => todo.id === input.id)
          if (!match?.id) return {}
          if (match.status !== "in_progress" && match.status !== "claimed") return {}
          if (match.claimedBy !== input.agent) return {}
          const now = Date.now()
          const history = appendHistory(
            match,
            input.agent,
            [
              input.status === "completed"
                ? "Completed task."
                : input.status === "cancelled"
                  ? "Cancelled task."
                  : input.status === "blocked"
                    ? "Blocked task."
                    : input.status === "failed"
                      ? "Failed task."
                      : "Interrupted task.",
              input.workerSessionID ? `Worker session: ${input.workerSessionID}` : undefined,
              input.summary ? `Worker summary:\n${input.summary}` : undefined,
            ].filter(Boolean).join("\n\n"),
          )
          db.update(TodoTable)
            .set({ status: input.status, completed_by: input.agent, completed_at: now, history })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, match.id)))
            .run()
          const done = { ...match, status: input.status, completedBy: input.agent, completedAt: now, history }
          return {
            ...(input.status === "cancelled" ? { cancelled: done } : { completed: done }),
            next: nextPending(todos.filter((todo) => todo.id !== match.id), input.agent),
          }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const complete = Effect.fn("Todo.complete")(function* (input: { sessionID: SessionID; id: string; agent: string; summary?: string; workerSessionID?: string }) {
      return yield* finish({ ...input, status: "completed" })
    })

    const block = Effect.fn("Todo.block")(function* (input: { sessionID: SessionID; id: string; agent: string; blocker: string; workerSessionID?: string }) {
      return yield* finish({ sessionID: input.sessionID, id: input.id, agent: input.agent, status: "blocked", summary: input.blocker, workerSessionID: input.workerSessionID })
    })

    const interrupt = Effect.fn("Todo.interrupt")(function* (input: { sessionID: SessionID; id: string; agent: string; reason: string; workerSessionID?: string }) {
      return yield* finish({ sessionID: input.sessionID, id: input.id, agent: input.agent, status: "interrupted", summary: input.reason, workerSessionID: input.workerSessionID })
    })

    const cancel = Effect.fn("Todo.cancel")(function* (input: { sessionID: SessionID; id: string; agent: string }) {
      ensureSchema()
      const result: FinishResult = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const match = db.select().from(TodoTable).where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id))).get()
          if (!match) return {}
          const row = fromRow(match)
          if (row.status !== "pending" && row.status !== "in_progress" && row.status !== "claimed") return {}
          if ((row.status === "in_progress" || row.status === "claimed") && row.claimedBy !== input.agent) return {}
          const now = Date.now()
          const history = appendHistory(row, input.agent, "Cancelled task.")
          db.update(TodoTable)
            .set({ status: "cancelled", completed_by: input.agent, completed_at: now, history })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id)))
            .run()
          return { cancelled: { ...row, status: "cancelled", completedBy: input.agent, completedAt: now, history } }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const handoff = Effect.fn("Todo.handoff")(function* (input: { sessionID: SessionID; id: string; agent: string; assignedAgent?: string; status?: string; priority?: Priority; bounceCount?: number; message: string }) {
      ensureSchema()
      const changed = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const match = db.select().from(TodoTable).where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id))).get()
          if (!match) return undefined
          const row = fromRow(match)
          const updated = {
            ...row,
            status: input.status ?? "pending",
            priority: input.priority ?? row.priority,
            assignedAgent: input.assignedAgent,
            bounceCount: input.bounceCount ?? row.bounceCount,
            claimedBy: undefined,
            claimedAt: undefined,
            completedBy: undefined,
            completedAt: undefined,
            history: appendHistory(row, input.agent, input.message),
          }
          db.update(TodoTable)
            .set({
              status: updated.status,
              priority: updated.priority,
              assigned_agent: updated.assignedAgent ?? null,
              bounce_count: updated.bounceCount,
              claimed_by: null,
              claimed_at: null,
              completed_by: null,
              completed_at: null,
              history: updated.history,
            })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id)))
            .run()
          return updated
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return changed
    })

    const interruptActive = Effect.fn("Todo.interruptActive")(function* (input: { sessionID: SessionID; agent?: string; reason: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const rows = db.select().from(TodoTable).where(eq(TodoTable.project_id, pid)).all().map(fromRow)
          rows
            .filter((todo) => (todo.status === "in_progress" || todo.status === "claimed") && (!input.agent || todo.claimedBy === input.agent))
            .forEach((todo) => {
              if (!todo.id) return
              db.update(TodoTable)
                .set({
                  status: "interrupted",
                  history: appendHistory(todo, input.agent ?? todo.claimedBy ?? "tilldone", input.reason),
                })
                .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, todo.id)))
                .run()
            })
        }),
      )
      const todos = yield* get(input.sessionID)
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos })
      return todos
    })

    const unclaim = Effect.fn("Todo.unclaim")(function* (input: { sessionID: SessionID; id: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) => {
          const match = db
            .select()
            .from(TodoTable)
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id)))
            .get()
          db
            .update(TodoTable)
            .set({
              status: "pending",
              claimed_by: null,
              claimed_at: null,
              completed_by: null,
              completed_at: null,
              history: match ? appendHistory(fromRow(match), match.claimed_by ?? "system", "Returned task to pending.") : undefined,
            })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id)))
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    const reassign = Effect.fn("Todo.reassign")(function* (input: { sessionID: SessionID; id: string; agent?: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TodoTable)
            .set({ assigned_agent: input.agent })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id)))
            .run(),
        ),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    const remove = Effect.fn("Todo.remove")(function* (input: { sessionID: SessionID; id: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.delete(TodoTable).where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id))).run(),
        ),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    const edit = Effect.fn("Todo.edit")(function* (input: { sessionID: SessionID; id: string; content: string; assignedAgent?: string | null }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TodoTable)
            .set({ content: input.content, assigned_agent: input.assignedAgent })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id)))
            .run(),
        ),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    const updatePending = Effect.fn("Todo.updatePending")(function* (input: { sessionID: SessionID; id: string; agent: string; content?: string; priority?: Priority; assignedAgent?: string }) {
      ensureSchema()
      const changed = yield* Effect.sync(() =>
        Database.transaction((db) => {
          const pid = projectID(input.sessionID)
          const match = db.select().from(TodoTable).where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id))).get()
          if (!match) return undefined
          const row = fromRow(match)
          if (row.status !== "pending") return undefined
          const updated = {
            ...row,
            content: input.content ?? row.content,
            priority: input.priority ?? row.priority,
            assignedAgent: input.assignedAgent ?? row.assignedAgent,
            history: appendHistory(row, input.agent, input.agent === "plan" || input.agent === "task" ? `Updated task from ${input.agent} mode.` : `Updated task from ${input.agent}.`),
          }
          db.update(TodoTable)
            .set({
              content: updated.content,
              priority: updated.priority,
              assigned_agent: updated.assignedAgent,
              history: updated.history,
            })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, input.id)))
            .run()
          return updated
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return changed
    })

    return Service.of({ update, get, create, claimNext, claimNextRunnable, claim, complete, block, interrupt, cancel, handoff, interruptActive, unclaim, reassign, remove, edit, updatePending })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
