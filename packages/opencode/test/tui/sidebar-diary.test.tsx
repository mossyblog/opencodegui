/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RGBA } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { createSignal, Show } from "solid-js"
import { KVProvider } from "../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../src/cli/cmd/tui/context/tui-config"
import { DialogButton, DialogContent, DialogFooter, DialogHeader } from "../../src/cli/cmd/tui/ui/dialog"
import {
  DiaryEntryDialog,
  DiaryDayDialog,
  KnowledgeDiary,
  SidebarTabButton,
  clampSidebarWidth,
  getSessionContentWidth,
  getSidebarRenderWidth,
  getResizeGripBackgroundColor,
  diaryEntryDialogActions,
  getSidebarWidthBounds,
  resizeSidebarDragWidth,
  resizeSidebarWidth,
  sidebarDefaultWidth,
  truncateDiaryText,
  listDiaryEntries,
  formatDiaryDateHeader,
  shouldRefetchDiaryEntries,
  type DiaryDay,
  type SidebarTab,
} from "../../src/cli/cmd/tui/routes/session/sidebar"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function stateDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-sidebar-diary-state-"))
  dirs.push(dir)
  await writeFile(path.join(dir, "kv.json"), "{}")
  return dir
}

async function wait(fn: () => boolean) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function Providers(props: { children: JSX.Element }) {
  return (
    <TuiConfigProvider config={{}}>
      <KVProvider>
        <ThemeProvider mode="dark">{props.children}</ThemeProvider>
      </KVProvider>
    </TuiConfigProvider>
  )
}

function position(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`could not find ${text}`)
  return { x: lines[y]!.indexOf(text), y }
}

async function withState<T>(run: () => Promise<T>) {
  const previous = Global.Path.state
  Global.Path.state = await stateDir()
  try {
    return await run()
  } finally {
    Global.Path.state = previous
  }
}

describe("sidebar diary", () => {
  test("sidebar width defaults and clamps to terminal bounds", () => {
    expect(sidebarDefaultWidth).toBe(42)
    expect(getSidebarWidthBounds(160)).toEqual({ min: 32, max: 72, default: 42 })
    expect(clampSidebarWidth(undefined, 160)).toBe(42)
    expect(clampSidebarWidth(20, 160)).toBe(32)
    expect(clampSidebarWidth(90, 160)).toBe(72)
  })

  test("sidebar width protects narrow main feed and overlay viewport", () => {
    expect(getSidebarWidthBounds(80)).toEqual({ min: 32, max: 40, default: 40 })
    expect(clampSidebarWidth(undefined, 80)).toBe(40)
    expect(getSidebarWidthBounds(60)).toEqual({ min: 20, max: 20, default: 20 })
    expect(clampSidebarWidth(42, 60)).toBe(20)
    expect(getSidebarWidthBounds(60, true)).toEqual({ min: 32, max: 60, default: 42 })
    expect(clampSidebarWidth(90, 60, true)).toBe(60)
  })

  test("sidebar keyboard resize step persists through shared clamp", () => {
    expect(resizeSidebarWidth(42, "grow", 160)).toBe(46)
    expect(resizeSidebarWidth(42, "shrink", 160)).toBe(38)
    expect(resizeSidebarWidth(32, "shrink", 160)).toBe(32)
    expect(resizeSidebarWidth(72, "grow", 160)).toBe(72)
  })

  test("sidebar mouse resize drag updates layout through shared clamp", () => {
    const resized = resizeSidebarDragWidth(42, 120, 100, 160)

    expect(resized).toBe(62)
    expect(getSessionContentWidth(160, true, resized)).toBe(94)
    expect(resizeSidebarDragWidth(42, 120, 20, 160)).toBe(72)
    expect(resizeSidebarDragWidth(42, 20, 120, 160)).toBe(32)
  })

  test("sidebar resize grip is invisible until hover or drag", () => {
    const active = RGBA.fromInts(255, 255, 255)
    const hover = RGBA.fromInts(128, 128, 128)

    expect(getResizeGripBackgroundColor(false, false, active, hover)).toBeUndefined()
    expect(getResizeGripBackgroundColor(false, true, active, hover)).toBe(hover)
    expect(getResizeGripBackgroundColor(true, false, active, hover)).toBe(active)
  })

  test("session layout helpers use persisted sidebar width", () => {
    expect(getSessionContentWidth(160, true, 54)).toBe(102)
    expect(getSessionContentWidth(160, false, 54)).toBe(156)
    expect(getSidebarRenderWidth(54)).toBe(54)
  })

  test("shared dialog shell renders full-width divider and aligned footer", async () => {
    await withState(async () => {
      const app = await testRender(() => (
        <Providers>
          <box width={60}>
            <DialogContent>
              <DialogHeader title="Example modal" onClose={() => {}} />
              <text>Body</text>
              <DialogFooter>
                <DialogButton label="Cancel" onClick={() => {}} />
                <DialogButton label="Save" active onClick={() => {}} />
              </DialogFooter>
            </DialogContent>
          </box>
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes("Example modal"))
        const frame = app.captureCharFrame()
        expect(frame).toContain("Example modal")
        expect(frame).toMatch(/Cancel\s+Save/)
        expect(frame).toMatch(/[─━▀]{20,}/)
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("refetches from .opencode/diary when the Diary tab is selected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-sidebar-diary-"))
    dirs.push(dir)
    await mkdir(path.join(dir, ".opencode", "diary"), { recursive: true })

    await writeFile(path.join(dir, ".opencode", "diary", "2026-04-30.md"), "- 2026-04-30T01:00:00.000Z older entry\n")
    expect(shouldRefetchDiaryEntries("knowledge")).toBe(true)
    expect(shouldRefetchDiaryEntries("general")).toBe(false)
    expect(await listDiaryEntries(dir)).toEqual([{ date: "2026-04-30", content: "older entry", timestamp: Date.parse("2026-04-30T01:00:00.000Z") }])

    await writeFile(path.join(dir, ".opencode", "diary", "2026-05-01.md"), "- 2026-05-01T01:00:00.000Z newer entry\n")
    await writeFile(path.join(dir, ".opencode", "diary", "ignore.txt"), "not a diary entry")
    await writeFile(path.join(dir, ".opencode", "diary", "2026-04-29.md"), "   ")

    expect(await listDiaryEntries(dir)).toEqual([
      { date: "2026-05-01", content: "newer entry", timestamp: Date.parse("2026-05-01T01:00:00.000Z") },
      { date: "2026-04-30", content: "older entry", timestamp: Date.parse("2026-04-30T01:00:00.000Z") },
    ])
  })

  test("Diary tab click invokes the refetch path", async () => {
    await withState(async () => {
      let refetches = 0
      let selected = "general" as SidebarTab
      const app = await testRender(() =>
        <Providers>
            <SidebarTabButton
              value="knowledge"
              label="Diary"
              selected={() => selected}
              select={(tab) => {
                selected = tab
              }}
              color={() => RGBA.fromInts(255, 255, 255)}
              refetchDiaryEntries={() => {
                refetches += 1
              }}
            />
        </Providers>,
      )

      try {
        await wait(() => app.captureCharFrame().includes("Diary"))
        await app.mockMouse.click(position(app.captureCharFrame(), "Diary").x, position(app.captureCharFrame(), "Diary").y)

        expect(selected).toBe("knowledge")
        expect(refetches).toBe(1)
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("renders diary entries as a compact timeline", async () => {
    await withState(async () => {
      const app = await testRender(() => (
        <Providers>
          <KnowledgeDiary entries={[{ date: "2026-05-01", content: "line one\nline two", timestamp: Date.parse("2026-05-01T01:00:00.000Z") }]} loading={false} onOpen={() => {}} onOpenDay={() => {}} />
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes(truncateDiaryText("line one\nline two")))
        expect(app.captureCharFrame()).not.toContain("[ ]")
        expect(app.captureCharFrame()).toContain(truncateDiaryText("line one\nline two"))
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("keeps compact diary display while opening the full day", async () => {
    await withState(async () => {
      const entries = Array.from({ length: 6 }, (_, index) => ({
        date: "2026-05-01",
        content: `diary entry ${index + 1}`,
        timestamp: Date.parse(`2026-05-01T0${index}:00:00.000Z`),
      }))
      let opened = 0
      const app = await testRender(() => (
        <Providers>
          <KnowledgeDiary entries={entries} loading={false} onOpen={() => {}} onOpenDay={(day) => (opened = day.entries.length)} />
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes("diary entry 6"))
        expect(app.captureCharFrame()).toContain("diary entry 2")
        expect(app.captureCharFrame()).not.toContain("diary entry 1")

        await app.mockMouse.click(position(app.captureCharFrame(), formatDiaryDateHeader("2026-05-01")).x, position(app.captureCharFrame(), formatDiaryDateHeader("2026-05-01")).y)
        expect(opened).toBe(6)
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("opening a diary entry exposes full content with Cancel and Ok", async () => {
    await withState(async () => {
      const entry = { date: "2026-05-01", content: "full diary content" }
      const App = () => {
        const [open, setOpen] = createSignal(false)
        return (
          <box>
            <KnowledgeDiary entries={[entry]} loading={false} onOpen={() => setOpen(true)} onOpenDay={() => {}} />
            <Show when={open()}>
              <DiaryEntryDialog entry={entry} onClose={() => setOpen(false)} />
            </Show>
          </box>
        )
      }
      const app = await testRender(() => (
        <Providers>
          <App />
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes(truncateDiaryText(entry.content)))
        await app.mockMouse.click(position(app.captureCharFrame(), truncateDiaryText(entry.content)).x, position(app.captureCharFrame(), truncateDiaryText(entry.content)).y)
        await wait(() => app.captureCharFrame().includes("full diary content"))

        expect(app.captureCharFrame()).toContain("full diary content")
        expect(app.captureCharFrame()).toContain(diaryEntryDialogActions[0])
        expect(app.captureCharFrame()).toContain(diaryEntryDialogActions[1])
        expect(app.captureCharFrame()).not.toContain("|")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("opening a diary day exposes entries for that day", async () => {
    await withState(async () => {
      const entries = [
        { date: "2026-05-01", content: "first diary decision", timestamp: Date.parse("2026-05-01T02:00:00.000Z") },
        { date: "2026-05-01", content: "second diary decision", timestamp: Date.parse("2026-05-01T01:00:00.000Z") },
      ]
      const app = await testRender(() => (
        <Providers>
          <DiaryDayDialog day={{ date: "2026-05-01", label: "1 May 2026", entries }} onClose={() => {}} onOpenEntry={() => {}} />
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes("first diary decision"))

        expect(app.captureCharFrame()).toContain("1 May 2026")
        expect(app.captureCharFrame()).toContain("2 diary entries")
        expect(app.captureCharFrame()).toContain("●")
        expect(app.captureCharFrame()).toContain("first diary decision")
        expect(app.captureCharFrame()).toContain("second diary decision")
      } finally {
        app.renderer.destroy()
      }
    })
  })

  test("clicking a diary day header opens the full sorted timeline modal", async () => {
    await withState(async () => {
      const hiddenFullText = "oldest hidden decision beyond compact trim!"
      const entries = [
        { date: "2026-05-01", content: hiddenFullText, timestamp: Date.parse("2026-05-01T00:00:00.000Z") },
        ...Array.from({ length: 5 }, (_, index) => ({
          date: "2026-05-01",
          content: index === 4 ? "visible compact entry 5 beyond compact trim!" : `visible compact entry ${index + 1}`,
          timestamp: Date.parse(`2026-05-01T0${index + 1}:00:00.000Z`),
        })),
      ]
      const App = () => {
        const [day, setDay] = createSignal<DiaryDay>()
        return (
          <box>
            <KnowledgeDiary entries={entries} loading={false} onOpen={() => {}} onOpenDay={setDay} />
            <Show when={day()}>{(selected) => <DiaryDayDialog day={selected()} onClose={() => setDay(undefined)} onOpenEntry={() => {}} />}</Show>
          </box>
        )
      }
      const app = await testRender(() => (
        <Providers>
          <App />
        </Providers>
      ))

      try {
        await wait(() => app.captureCharFrame().includes("visible compact entry 5"))
        expect(app.captureCharFrame()).not.toContain(hiddenFullText)
        expect(app.captureCharFrame()).not.toContain("beyond compact trim!")

        await app.mockMouse.click(position(app.captureCharFrame(), formatDiaryDateHeader("2026-05-01")).x, position(app.captureCharFrame(), formatDiaryDateHeader("2026-05-01")).y)
        await wait(() => app.captureCharFrame().includes("6 diary entries"))
        const modalFrame = app.captureCharFrame().slice(app.captureCharFrame().indexOf("6 diary entries"))

        expect(modalFrame).toContain("6 diary entries")
        expect(position(modalFrame, "visible compact entry 5").y).toBeLessThan(position(modalFrame, "visible compact entry 4").y)
        expect(modalFrame).toContain("beyond compact trim!")
        expect(modalFrame).not.toContain(truncateDiaryText("visible compact entry 5 beyond compact trim!"))
      } finally {
        app.renderer.destroy()
      }
    })
  })
})
