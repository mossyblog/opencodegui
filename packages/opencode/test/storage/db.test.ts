import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(InstallationChannel)
      ? path.join(Global.Path.data, "opencode.db")
      : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })

  test("repairs TillDone durable state tables and indexes", () => {
    const db = Database.Client()
    const tables = db
      .$client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tilldone_runner', 'tilldone_worker')")
      .all() as { name: string }[]
    const indexes = db
      .$client.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'tilldone_%_idx'")
      .all() as { name: string }[]

    expect(tables.map((table) => table.name).sort()).toEqual(["tilldone_runner", "tilldone_worker"])
    expect(indexes.map((index) => index.name).sort()).toEqual([
      "tilldone_runner_project_idx",
      "tilldone_worker_project_idx",
      "tilldone_worker_runner_session_idx",
      "tilldone_worker_status_idx",
      "tilldone_worker_task_idx",
    ])
  })
})
