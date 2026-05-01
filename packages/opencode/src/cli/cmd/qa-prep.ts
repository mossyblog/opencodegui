import { $ } from "bun"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { readdir } from "fs/promises"
import path from "path"

type GitSummary = {
  status: string
  stat: string
  files: string
}

const lines = (value: string) => value.trim().split("\n").filter(Boolean)

const readRecentDiary = async (cwd: string) => {
  const dir = path.join(cwd, ".opencode", "diary")
  const entries = await readdir(dir).catch(() => [])
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".md"))
        .toSorted()
        .slice(-3)
        .map(async (entry) => {
          const content = await Bun.file(path.join(dir, entry)).text().catch(() => "")
          return lines(content).slice(-8).map((line) => `${entry}: ${line}`)
        }),
    )
  ).flat()
}

const git = async (cwd: string, args: string[]) => {
  const result = await $`git ${args}`.cwd(cwd).quiet().nothrow()
  if (result.exitCode !== 0) return ""
  return result.stdout.toString().trim()
}

export const collectQaPrepReport = async (cwd: string) => {
  const diary = await readRecentDiary(cwd)
  const summary: GitSummary = {
    status: await git(cwd, ["status", "--short"]),
    stat: await git(cwd, ["diff", "--stat"]),
    files: await git(cwd, ["diff", "--name-only"]),
  }

  return formatQaPrepReport({ diary, summary })
}

export const formatQaPrepReport = (input: { diary: string[]; summary: GitSummary }) =>
  [
    "# QA prep report",
    "",
    "## What changed",
    input.summary.status ? lines(input.summary.status).map((line) => `- ${line}`).join("\n") : "- No modified files reported by git status.",
    "",
    "## Diff summary",
    input.summary.stat ? input.summary.stat : "No unstaged diff summary reported.",
    "",
    "## Touched files",
    input.summary.files ? lines(input.summary.files).map((line) => `- ${line}`).join("\n") : "- No unstaged files reported by git diff.",
    "",
    "## Relevant task history",
    input.diary.length ? input.diary.map((line) => `- ${line}`).join("\n") : "- No recent diary entries found.",
    "",
    "## Suggested focused checks",
    "- Review the changed files listed above against the completed task history.",
    "- Run only focused tests or typechecks relevant to those files if the user requests QA.",
  ].join("\n")

export const QaPrepCommand = cmd({
  command: "qa-prep",
  describe: "prepare a manual QA handoff report",
  builder: (yargs) => yargs,
  handler: async () => {
    UI.println(await collectQaPrepReport(process.cwd()))
  },
})
