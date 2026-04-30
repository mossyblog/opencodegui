import { Instance } from "@/project/instance"
import { appendFile, mkdir } from "fs/promises"
import path from "path"
import { Effect } from "effect"

export const decision = (text: string) => {
  const match = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:decisions-made|decisions made|decisions|decision log):?\s*\n?([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:changed files|verification|completion status|status|follow-ups|blockers|summary)\b|$)/i.exec(
    text,
  )
  const entry = match?.[1]
    ?.replace(/^\s*(?:[-*]|\d+[.)])\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!entry || /^(?:none|no meaningful decisions|no decisions|n\/a|not applicable)[.!]?$/i.test(entry)) return
  return entry.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ")
}

export const appendDecision = Effect.fn("SessionDiary.appendDecision")(function* (text: string) {
  const entry = decision(text)
  if (!entry) return
  const diary = path.join(Instance.directory, ".opencode", "diary")
  yield* Effect.promise(() => mkdir(diary, { recursive: true }))
  yield* Effect.promise(() => appendFile(path.join(diary, `${new Date().toISOString().slice(0, 10)}.md`), `- ${new Date().toISOString()} ${entry}\n`))
})

export * as SessionDiary from "./diary"
