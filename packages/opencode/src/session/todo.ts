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
  }) => Effect.Effect<Info>
  readonly claimNext: (input: { sessionID: SessionID; agent: string }) => Effect.Effect<{ claimed?: Info; next?: Info }>
  readonly claim: (input: { sessionID: SessionID; id: string; agent: string }) => Effect.Effect<{ claimed?: Info; next?: Info }>
  readonly complete: (input: { sessionID: SessionID; id: string; agent: string }) => Effect.Effect<FinishResult>
  readonly cancel: (input: { sessionID: SessionID; id: string; agent: string }) => Effect.Effect<FinishResult>
  readonly unclaim: (input: { sessionID: SessionID; id: string }) => Effect.Effect<void>
  readonly remove: (input: { sessionID: SessionID; id: string }) => Effect.Effect<void>
  readonly edit: (input: { sessionID: SessionID; id: string; content: string }) => Effect.Effect<void>
}

type FinishResult = { completed?: Info; cancelled?: Info; next?: Info }

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    let schemaChecked = false

    const ensureSchema = () => {
      if (schemaChecked) return
      schemaChecked = true
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
      if (!columns.some((column) => column.name === "completed_by")) {
        Database.Client().$client.run("ALTER TABLE `todo` ADD COLUMN `completed_by` text")
      }
    }

    const fromRow = (row: typeof TodoTable.$inferSelect): Info => ({
      id: row.id,
      content: row.content,
      status: row.status,
      priority: row.priority,
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.completed_by ? { completedBy: row.completed_by } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    })

    const priorityRank = (priority: string) => (priority === "high" ? 0 : priority === "medium" ? 1 : 2)

    const nextPending = (todos: Info[]) =>
      todos
        .filter((todo) => todo.status === "pending")
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
            status: "pending",
            priority: input.priority,
            created_by: input.createdBy,
            position,
          }
          db.insert(TodoTable).values(row).run()
          return { id: row.id, content: row.content, status: row.status, priority: row.priority, createdBy: row.created_by }
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
          const claimed = nextPending(todos)
          if (!claimed?.id) return {}
          const now = Date.now()
          db.update(TodoTable)
            .set({ status: "in_progress", claimed_by: input.agent, claimed_at: now })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, claimed.id)))
            .run()
          return {
            claimed: { ...claimed, status: "in_progress", claimedBy: input.agent, claimedAt: now },
            next: nextPending(todos.filter((todo) => todo.id !== claimed.id)),
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
          const now = Date.now()
          db.update(TodoTable)
            .set({ status: "in_progress", claimed_by: input.agent, claimed_at: now })
            .where(and(eq(TodoTable.project_id, pid), eq(TodoTable.id, match.id)))
            .run()
          return {
            claimed: { ...match, status: "in_progress", claimedBy: input.agent, claimedAt: now },
            next: nextPending(todos.filter((todo) => todo.id !== match.id)),
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
      status: "completed" | "cancelled"
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
          const now = Date.now()
          db.update(TodoTable)
            .set({ status: input.status, completed_by: input.agent, completed_at: now })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, match.id)))
            .run()
          const done = { ...match, status: input.status, completedBy: input.agent, completedAt: now }
          return {
            ...(input.status === "completed" ? { completed: done } : { cancelled: done }),
            next: nextPending(todos.filter((todo) => todo.id !== match.id)),
          }
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
      return result
    })

    const complete = Effect.fn("Todo.complete")(function* (input: { sessionID: SessionID; id: string; agent: string }) {
      return yield* finish({ ...input, status: "completed" })
    })

    const cancel = Effect.fn("Todo.cancel")(function* (input: { sessionID: SessionID; id: string; agent: string }) {
      return yield* finish({ ...input, status: "cancelled" })
    })

    const unclaim = Effect.fn("Todo.unclaim")(function* (input: { sessionID: SessionID; id: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TodoTable)
            .set({ status: "pending", claimed_by: null, claimed_at: null, completed_by: null, completed_at: null })
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

    const edit = Effect.fn("Todo.edit")(function* (input: { sessionID: SessionID; id: string; content: string }) {
      ensureSchema()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(TodoTable)
            .set({ content: input.content })
            .where(and(eq(TodoTable.project_id, projectID(input.sessionID)), eq(TodoTable.id, input.id)))
            .run(),
        ),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: yield* get(input.sessionID) })
    })

    return Service.of({ update, get, create, claimNext, claim, complete, cancel, unclaim, remove, edit })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
