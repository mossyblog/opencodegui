import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir } from "fs/promises"
import path from "path"
import { collectQaPrepReport, formatQaPrepReport } from "../../src/cli/cmd/qa-prep"
import { tmpdir } from "../fixture/fixture"

describe("qa-prep", () => {
  test("formats diary entries and git summaries", () => {
    const report = formatQaPrepReport({
      diary: ["2026-05-01.md: - decision made"],
      summary: {
        status: " M src/tool/taskqueue.ts",
        stat: " src/tool/taskqueue.ts | 2 +-",
        files: "src/tool/taskqueue.ts",
      },
    })

    expect(report).toContain("# QA prep report")
    expect(report).toContain("- M src/tool/taskqueue.ts")
    expect(report).toContain("- 2026-05-01.md: - decision made")
    expect(report).toContain("Run only focused tests or typechecks")
  })

  test("collects recent diary entries and current git diff without mutating files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "tracked.txt"), "before\n")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit -m tracked`.cwd(tmp.path).quiet()
    await mkdir(path.join(tmp.path, ".opencode", "diary"), { recursive: true })
    await Bun.write(path.join(tmp.path, ".opencode", "diary", "2026-05-01.md"), "- changed taskqueue behavior\n")
    await Bun.write(path.join(tmp.path, "tracked.txt"), "after\n")

    const before = await Bun.file(path.join(tmp.path, "tracked.txt")).text()
    const report = await collectQaPrepReport(tmp.path)

    expect(await Bun.file(path.join(tmp.path, "tracked.txt")).text()).toBe(before)
    expect(report).toContain("tracked.txt")
    expect(report).toContain("changed taskqueue behavior")
  })
})
