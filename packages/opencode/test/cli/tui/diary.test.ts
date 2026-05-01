import { describe, expect, test } from "bun:test"
import { groupDiaryEntries, parseDiaryFileEntries, truncateDiaryText } from "../../../src/cli/cmd/tui/routes/session/sidebar"

describe("sidebar diary", () => {
  test("splits diary files into individual timeline entries", () => {
    const entries = parseDiaryFileEntries("2026-05-01.md", [
      "- 2026-05-01T01:00:00.000Z First decision",
      "- 2026-05-01T02:00:00.000Z Second decision",
    ].join("\n"))

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ date: "2026-05-01", content: "First decision" })
    expect(entries[0]?.timestamp).toBe(Date.parse("2026-05-01T01:00:00.000Z"))
  })

  test("groups full timeline entries by day", () => {
    const days = groupDiaryEntries(Array.from({ length: 6 }, (_, index) => ({ date: "2026-05-01", content: `entry ${index}`, timestamp: Date.parse(`2026-05-01T0${index}:00:00.000Z`) })))

    expect(days).toHaveLength(1)
    expect(days[0]?.entries).toHaveLength(6)
    expect(days[0]?.entries[0]?.content).toBe("entry 5")
  })

  test("truncates long diary text for side panel rows", () => {
    expect(truncateDiaryText("x".repeat(60))).toBe(`${"x".repeat(39)}...`)
  })
})
