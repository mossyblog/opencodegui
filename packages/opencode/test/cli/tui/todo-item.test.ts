import { describe, expect, test } from "bun:test"
import { todoItemColor } from "../../../src/cli/cmd/tui/component/todo-item"

describe("TodoItem", () => {
  const theme = { textMuted: "muted", markdownLink: "blue", warning: "yellow" }

  test("renders explicit QA assignments blue while pending", () => {
    expect(todoItemColor({ status: "pending", assignedAgent: "qa" }, theme)).toBe("blue")
  })

  test("keeps completed QA tasks muted", () => {
    expect(todoItemColor({ status: "completed", assignedAgent: "qa" }, theme)).toBe("muted")
  })
})
