import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TillDoneRunner } from "@/session/tilldone-runner"
import { Todo } from "@/session/todo"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  promptText.current = defaultPromptText
  await Instance.disposeAll()
})

const provider = ProviderTest.fake()
const defaultPromptText = [
  "Summary: completed the task.",
  "",
  "Decisions made:",
  "- Kept TillDone diary capture in the runner completion path.",
  "- Only explicit decisions sections should be persisted.",
  "",
  "Verification:",
  "- passed",
].join("\n")
const promptText = { current: defaultPromptText }
const promptLayer = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.succeed({
        info: {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          mode: input.agent ?? "general",
          agent: input.agent ?? "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: provider.model.id,
          providerID: provider.info.id,
          time: { created: Date.now() },
          finish: "stop",
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: input.sessionID,
            type: "text",
            text: promptText.current,
          },
        ],
      } satisfies MessageV2.WithParts),
    loop: () => Effect.die(new Error("not used")),
    shell: () => Effect.die(new Error("not used")),
    command: () => Effect.die(new Error("not used")),
  }),
)

const baseLayer = Layer.mergeAll(
    Agent.defaultLayer,
    Bus.layer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    provider.layer,
    promptLayer,
    Session.defaultLayer,
    Todo.defaultLayer,
)

const it = testEffect(
  Layer.mergeAll(baseLayer, TillDoneRunner.layer.pipe(Layer.provide(baseLayer))),
)

describe("TillDoneRunner", () => {
  it.live("appends decisions-made entries to the diary after task completion reports", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone diary" })
        yield* todos.create({ sessionID: session.id, content: "capture a meaningful decision", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const diary = yield* Effect.promise(() => Bun.file(`${dir}/.opencode/diary/${new Date().toISOString().slice(0, 10)}.md`).text())
        expect(diary.replace(/^-\s+\S+\s+/, "").trim()).toBe(
          "Kept TillDone diary capture in the runner completion path. Only explicit decisions sections should be persisted.",
        )
        expect(diary).not.toContain("Summary")
        expect(diary).not.toContain("Verification")
        expect((yield* todos.get(session.id))[0]?.status).toBe("completed")
      }),
    ),
  )

  it.live("skips diary entries when completion reports have no meaningful decisions", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        promptText.current = [
          "Summary: completed the task.",
          "",
          "Decisions made:",
          "- No meaningful decisions.",
          "",
          "Verification:",
          "- passed",
        ].join("\n")
        const sessions = yield* Session.Service
        const todos = yield* Todo.Service
        const runner = yield* TillDoneRunner.Service
        const session = yield* sessions.create({ title: "TillDone diary skip" })
        yield* todos.create({ sessionID: session.id, content: "complete without a decision", priority: "medium", assignedAgent: "general" })

        yield* runner.start({ sessionID: session.id })
        yield* runner.run({ sessionID: session.id })

        const exists = yield* Effect.promise(() => Bun.file(`${dir}/.opencode/diary/${new Date().toISOString().slice(0, 10)}.md`).exists())
        expect(exists).toBe(false)
        expect((yield* todos.get(session.id))[0]?.status).toBe("completed")
      }),
    ),
  )
})
