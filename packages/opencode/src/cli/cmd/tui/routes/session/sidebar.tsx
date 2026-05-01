import { MouseButton, TextareaRenderable, type MouseEvent as TuiMouseEvent, type RGBA } from "@opentui/core"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import type { Todo } from "@opencode-ai/sdk/v2"
import { DialogContent, DialogFooter, DialogHeader, useDialog } from "../../ui/dialog"
import { useKeyboard } from "@opentui/solid"
import "opentui-spinner/solid"
import { spinnerFrames } from "../../component/spinner"

import { getScrollAcceleration } from "../../util/scroll"

type QueueTask = Todo & { id?: string; assignedAgent?: string; claimedBy?: string }
export type SidebarTab = "general" | "tilldone" | "knowledge"
export type DiaryEntry = { date: string; content: string; timestamp?: number }
export type DiaryDay = { date: string; label: string; entries: DiaryEntry[] }
export const sidebarDefaultWidth = 42
export const sidebarMinWidth = 32
export const sidebarMaxWidth = 72
export const sidebarMainFeedMinWidth = 40
export const getSidebarWidthBounds = (terminalWidth: number, overlay = false) => {
  const available = Math.max(1, Math.floor(terminalWidth) - (overlay ? 0 : sidebarMainFeedMinWidth))
  const max = Math.max(1, Math.min(sidebarMaxWidth, available))
  return {
    min: Math.min(sidebarMinWidth, max),
    max,
    default: Math.min(sidebarDefaultWidth, max),
  }
}
export const clampSidebarWidth = (width: number | undefined, terminalWidth: number, overlay = false) => {
  const bounds = getSidebarWidthBounds(terminalWidth, overlay)
  return Math.max(bounds.min, Math.min(bounds.max, Math.floor(width ?? sidebarDefaultWidth)))
}
export const resizeSidebarWidth = (width: number, direction: "grow" | "shrink", terminalWidth: number, overlay = false) =>
  clampSidebarWidth(width + (direction === "grow" ? 4 : -4), terminalWidth, overlay)
export const resizeSidebarDragWidth = (width: number, startX: number, currentX: number, terminalWidth: number, overlay = false) =>
  clampSidebarWidth(width + startX - currentX, terminalWidth, overlay)
export const getSessionContentWidth = (terminalWidth: number, sidebarVisible: boolean, sidebarWidth: number) =>
  terminalWidth - (sidebarVisible ? sidebarWidth : 0) - 4
export const getSidebarRenderWidth = (width: number) => width
export const getResizeGripBackgroundColor = (active: boolean, hover: boolean, activeColor: RGBA, hoverColor: RGBA) => (active ? activeColor : hover ? hoverColor : undefined)
export const shouldRefetchDiaryEntries = (tab: SidebarTab) => tab === "knowledge"
export const parseDiaryFileEntries = (file: string, content: string) => {
  const date = file.replace(/\.md$/, "")
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^-\s+(\S+)\s+(.+)$/.exec(line)
      const timestamp = match ? Date.parse(match[1]!) : undefined
      return {
        date,
        content: match ? match[2]! : line.replace(/^-\s*/, ""),
        ...(timestamp && !Number.isNaN(timestamp) ? { timestamp } : {}),
      }
    })
}
export const formatDiaryDateHeader = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
export const formatDiaryTimeLabel = (entry: DiaryEntry, now = Date.now()) => {
  if (!entry.timestamp) return entry.date
  const minutes = Math.max(0, Math.floor((now - entry.timestamp) / 60000))
  if (minutes < 60) return minutes <= 1 ? "1m ago" : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 12) return hours === 1 ? "1hr ago" : `${hours}hr ago`
  return new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
}
export const truncateDiaryText = (content: string) => {
  const trimmed = content.replace(/\s+/g, " ").trim()
  return trimmed.length > 42 ? trimmed.slice(0, 39) + "..." : trimmed
}
export const groupDiaryEntries = (entries: DiaryEntry[]) =>
  entries
    .toSorted((a, b) => (b.timestamp ?? Date.parse(`${b.date}T00:00:00`)) - (a.timestamp ?? Date.parse(`${a.date}T00:00:00`)))
    .reduce<DiaryDay[]>((acc, entry) => {
      const day = acc.find((item) => item.date === entry.date)
      if (day) {
        day.entries.push(entry)
        return acc
      }
      acc.push({ date: entry.date, label: formatDiaryDateHeader(entry.date), entries: [entry] })
      return acc
    }, [])
export const listDiaryEntries = async (directory?: string) => {
  if (!directory) return []
  const diary = path.join(directory, ".opencode", "diary")
  const entries = await Promise.all(
    (await readdir(diary).catch(() => []))
      .filter((file) => file.endsWith(".md"))
      .toSorted((a, b) => b.localeCompare(a))
      .slice(0, 7)
      .map(async (file) => {
        const content = await readFile(path.join(diary, file), "utf8").catch(() => undefined)
        if (!content?.trim()) return undefined
        return parseDiaryFileEntries(file, content.trim())
      }),
  )
  return groupDiaryEntries(entries.filter((entry): entry is DiaryEntry[] => !!entry).flat()).flatMap((day) => day.entries)
}
export const diaryEntryDialogActions = ["Cancel", "Ok"] as const
export function SidebarTabButton(props: {
  value: SidebarTab
  label: string
  selected: () => SidebarTab
  select: (tab: SidebarTab) => void
  color: (tab: SidebarTab) => RGBA
  refetchDiaryEntries: () => unknown
}) {
  const { theme } = useTheme()
  return (
    <box
      onMouseDown={() => {
        props.select(props.value)
        if (shouldRefetchDiaryEntries(props.value)) void props.refetchDiaryEntries()
      }}
      paddingLeft={1}
      paddingRight={1}
      border={["top"]}
      borderColor={props.selected() === props.value ? props.color(props.value) : theme.backgroundPanel}
      backgroundColor={props.selected() === props.value ? theme.backgroundElement : undefined}
    >
      <text fg={props.selected() === props.value ? theme.text : theme.textMuted}>
        <b>{props.label}</b>
      </text>
    </box>
  )
}
type TillDoneWorker = {
  slot?: number
  agent: string
  status: string
  taskID?: string
  sessionID?: string
  error?: string
  startedAt?: number
  updatedAt?: number
  completedAt?: number
}
type TillDoneStatus = {
  status: "idle" | "running" | "stopping" | "aborting" | "complete" | "blocked" | "error"
  active: number
  maxWorkers: number
  startedAt?: number
  stoppedAt?: number
  error?: string
  workers: TillDoneWorker[]
}

export function Sidebar(props: {
  sessionID: string
  width: number
  onResize?: (width: number) => void
  onResizeStart?: (event: TuiMouseEvent, width: number, overlay: boolean) => void
  resizing?: boolean
  overlay?: boolean
  tab?: SidebarTab
  setTab?: (tab: SidebarTab) => void
  feedSessionID?: string
  setFeedSessionID?: (sessionID: string) => void
}) {
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const agentSessions = createMemo(() => {
    const childSessions = sync.data.session.filter((item) => item.parentID === props.sessionID)
    return sync.data.agent
      .filter((item) => (item.mode === "subagent" || item.name === "build") && !item.hidden)
      .map((agent, index) => {
        const sessions = childSessions.filter((item) => {
          const match = /^(.*) \(@(.+) subagent\)$/.exec(item.title)
          return (item.agent ?? match?.[2]) === agent.name
        })
        const running = sessions.find((item) => sync.session.status(item.id) !== "idle")
        const latest = sessions.toSorted((a, b) => b.time.updated - a.time.updated)[0]
        const active = running ?? latest
        return {
          id: active?.id,
          slot: index + 2,
          name: agent.name,
          status: active ? sync.session.status(active.id) : "idle",
          color: local.agent.color(agent.name),
        }
      })
  })

  const openAgent = async (agent: { id?: string; name: string }) => {
    if (agent.id) {
      props.setFeedSessionID?.(agent.id)
      return
    }
    const created = await sdk.client.session.create({
      parentID: props.sessionID,
      title: `${agent.name} (@${agent.name} subagent)`,
      agent: agent.name,
    })
    if (!created.data) return
    sync.set("session", sync.data.session.length, created.data)
    props.setFeedSessionID?.(created.data.id)
    void sync.session.sync(created.data.id)
  }
  const [store, setStore] = createStore({ tab: "general" as SidebarTab })
  const selectedTab = () => props.tab ?? store.tab
  const setSelectedTab = (tab: SidebarTab) => (props.setTab ? props.setTab(tab) : setStore("tab", tab))
  const todos = createMemo(() => (sync.data.todo[props.sessionID] ?? []) as QueueTask[])
  const todoTasks = createMemo(() => todos().filter((item) => item.status !== "completed" && item.status !== "cancelled"))
  const doneTasks = createMemo(() => todos().filter((item) => item.status === "completed" || item.status === "cancelled"))
  const [runner, setRunner] = createSignal<TillDoneStatus>()
  const tabColor = (value: SidebarTab) => (value === "tilldone" ? theme.warning : local.agent.color(local.agent.current()?.name ?? "build"))
  const runnerStatusColor = () =>
    runner()?.status === "running"
      ? theme.success
      : runner()?.status === "stopping" || runner()?.status === "aborting"
        ? theme.warning
        : runner()?.status === "error" || runner()?.status === "blocked"
          ? theme.error
          : theme.textMuted
  const formatTime = (value?: number) => (value ? new Date(value).toLocaleTimeString() : undefined)
  const activeWorkers = () => runner()?.workers.filter((item) => item.status === "running") ?? []
  const canStartTillDone = () => !runner() || runner()?.status === "idle" || runner()?.status === "complete" || runner()?.status === "blocked" || runner()?.status === "error"
  const canStopTillDone = () => runner()?.status === "running"
  const canAbortTillDone = () => runner()?.status === "running" || runner()?.status === "stopping"
  const createTask = async (content: string, assignedAgent?: string) => {
    const trimmed = content.trim()
    if (!trimmed) return
    const result = await sdk.client.session.todoCreate({ sessionID: props.sessionID, content: trimmed, assignedAgent })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }
  const updateTasks = async (action: "claim" | "unclaim" | "clear", item: QueueTask) => {
    if (!item.id) return
    const result =
      action === "claim"
        ? await sdk.client.session.todoClaim({ sessionID: props.sessionID, id: item.id })
        : action === "unclaim"
          ? await sdk.client.session.todoUnclaim({ sessionID: props.sessionID, id: item.id })
        : await sdk.client.session.todoClear({ sessionID: props.sessionID, id: item.id })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }
  const saveTask = async (item: QueueTask, content: string, assignedAgent: string | null) => {
    if (!item.id) return
    const result = await sdk.client.session.todoEdit({ sessionID: props.sessionID, id: item.id, content: content.trim(), assignedAgent })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }
  const clearDoneTasks = async () => {
    await doneTasks()
      .filter((item) => item.id)
      .reduce(async (previous, item) => {
        await previous
        const result = await sdk.client.session.todoClear({ sessionID: props.sessionID, id: item.id! })
        sync.set("todo", props.sessionID, result.data ?? [])
      }, Promise.resolve())
  }
  const workspaceStatus = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "error"
    return project.workspace.status(workspaceID) ?? "error"
  }
  const workspaceLabel = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "unknown"
    const info = project.workspace.get(workspaceID)
    if (!info) return "unknown"
    return `${info.type}: ${info.name}`
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const tilldone = async (action: "status" | "start" | "stop" | "abort") => {
    const result = await (action === "status"
      ? sdk.client.session.tilldoneStatus({ sessionID: props.sessionID })
      : action === "start"
        ? sdk.client.session.tilldoneStart({ sessionID: props.sessionID })
        : action === "stop"
          ? sdk.client.session.tilldoneStop({ sessionID: props.sessionID })
          : sdk.client.session.tilldoneAbort({ sessionID: props.sessionID }))
    if (result.data) setRunner(result.data)
  }

  createEffect(() => {
    if (selectedTab() !== "tilldone") return
    void tilldone("status")
    const timer = setInterval(() => void tilldone("status"), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const [diaryEntries, { refetch: refetchDiaryEntries }] = createResource(() => project.instance.directory(), listDiaryEntries)

  const tab = (value: SidebarTab, label: string) => <SidebarTabButton value={value} label={label} selected={selectedTab} select={setSelectedTab} color={tabColor} refetchDiaryEntries={refetchDiaryEntries} />

  const truncateTask = (content: string) => (content.length > 32 ? content.slice(0, 29) + "..." : content)
  const [resizeGripHover, setResizeGripHover] = createSignal(false)
  const [resizeGripActive, setResizeGripActive] = createSignal(false)
  const [resizeGripDrag, setResizeGripDrag] = createSignal<{ x: number; width: number }>()
  const resizeGripColor = () => getResizeGripBackgroundColor(resizeGripActive() || !!props.resizing, resizeGripHover(), theme.borderActive, theme.border)
  createEffect(() => {
    if (props.resizing) return
    setResizeGripActive(false)
    setResizeGripDrag(undefined)
  })
  const handleResizeGripMouse = (event: TuiMouseEvent) => {
    if (!props.onResize) return
    if (event.type === "down" && event.button === MouseButton.LEFT) {
      event.preventDefault()
      event.stopPropagation()
      setResizeGripActive(true)
      setResizeGripDrag({ x: event.x, width: props.width })
      props.onResizeStart?.(event, props.width, !!props.overlay)
      return
    }
    if (event.type === "drag" && resizeGripDrag()) {
      event.preventDefault()
      event.stopPropagation()
      props.onResize(resizeSidebarDragWidth(resizeGripDrag()!.width, resizeGripDrag()!.x, event.x, Number.MAX_SAFE_INTEGER))
      return
    }
    if (event.type !== "up") return
    setResizeGripActive(false)
    setResizeGripDrag(undefined)
  }

  const planColor = () => local.agent.color("plan")
  const isTodoQaTask = (item: QueueTask) => item.assignedAgent === "qa"
  const taskColor = (item: QueueTask) =>
    item.status === "completed" || item.status === "cancelled"
      ? theme.textMuted
      : isTodoQaTask(item)
        ? theme.markdownLink
        : item.status === "in_progress" || item.status === "claimed"
          ? theme.success
          : planColor()

  const taskLine = (item: QueueTask) => (
    <box
      flexDirection="row"
      gap={0}
      paddingLeft={1}
      onMouseUp={(event) => {
        event.stopPropagation()
        dialog.replace(() => <TaskDialog item={item} onClose={() => dialog.clear()} onAction={updateTasks} onSave={saveTask} />)
        dialog.setSize("small")
      }}
    >
      <box width={4} flexShrink={0}>
        <Show when={item.status === "in_progress" || item.status === "claimed"} fallback={<text fg={taskColor(item)}>{item.status === "completed" ? "[✓]" : item.status === "cancelled" ? "[x]" : "[ ]"}</text>}>
          <box flexDirection="row">
            <text fg={taskColor(item)}>[</text>
            <spinner frames={spinnerFrames} interval={80} color={taskColor(item)} />
            <text fg={taskColor(item)}>]</text>
          </box>
        </Show>
      </box>
      <text fg={taskColor(item)} wrapMode="none" overflow="hidden" flexGrow={1}>
        {truncateTask(item.content)}
      </text>
    </box>
  )

  const taskSection = (title: string, items: ReturnType<typeof todos>, action?: () => void) => (
    <Show when={items.length > 0}>
      <box gap={0}>
        <box flexDirection="row" gap={1} alignItems="center">
          <Show when={action}>
            {(run) => (
              <Button
                label=""
                fg={theme.error}
                bg={theme.backgroundElement}
                onClick={(event) => {
                  event.stopPropagation()
                  run()()
                }}
              />
            )}
          </Show>
          <text fg={theme.text}>
            <b>{title}</b> <span style={{ fg: theme.textMuted }}>{items.length}</span>
          </text>
        </box>
        <For each={items}>{taskLine}</For>
      </box>
    </Show>
  )

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={getSidebarRenderWidth(props.width)}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <box
          position="absolute"
          left={0}
          top={0}
          width={1}
          height="100%"
          zIndex={1}
          backgroundColor={resizeGripColor()}
          onMouse={handleResizeGripMouse}
          onMouseOver={() => setResizeGripHover(true)}
          onMouseOut={() => {
            setResizeGripHover(false)
            if (!resizeGripDrag()) setResizeGripActive(false)
          }}
        />
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <box gap={0} paddingBottom={1}>
                    <AgentStatus
                      slot={1}
                      name="Main"
                      status={props.feedSessionID === props.sessionID ? "Viewing" : "Idle"}
                      tone={props.feedSessionID === props.sessionID ? theme.primary : theme.textMuted}
                      color={local.agent.color(local.agent.current()?.name ?? "build")}
                      active={props.feedSessionID === props.sessionID}
                      onClick={() => props.setFeedSessionID?.(props.sessionID)}
                    />
                  <For each={agentSessions()}>
                    {(agent) => (
                      <AgentStatus
                        slot={agent.slot}
                          name={agent.name}
                          status={agent.status === "working" ? "Running" : agent.status === "compacting" ? "Compacting" : "Idle"}
                          tone={agent.status === "working" ? theme.success : agent.status === "compacting" ? theme.warning : theme.textMuted}
                          color={agent.color}
                          active={props.feedSessionID === agent.id}
                          onClick={() => void openAgent(agent)}
                        />
                    )}
                  </For>
                </box>
                <text fg={theme.text}>
                  <b>Session: {session()!.title}</b>
                </text>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: workspaceStatus() === "connected" ? theme.success : theme.error }}>●</span>{" "}
                    {workspaceLabel()}
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
              {tab("general", "General")}
              {tab("tilldone", "TillDone")}
              {tab("knowledge", "Diary")}
            </box>
            <Switch>
              <Match when={selectedTab() === "tilldone"}>
                <box gap={1}>
                  <box flexDirection="row" justifyContent="space-between" alignItems="center">
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text}>
                        <b>TillDone</b>
                      </text>
                      <text fg={runnerStatusColor()}>{runner()?.status ?? "idle"}</text>
                      <text fg={theme.textMuted}>
                        {runner()?.active ?? 0}/{runner()?.maxWorkers ?? 3}
                      </text>
                    </box>
                    <box flexDirection="row" gap={1}>
                      <Show when={canStartTillDone()}>
                        <Button
                          label="▶"
                          fg={theme.success}
                          bg={theme.backgroundElement}
                          onClick={(event) => {
                            event.stopPropagation()
                            void tilldone("start")
                          }}
                        />
                      </Show>
                      <Show when={canStopTillDone()}>
                        <Button
                          label="■"
                          fg={theme.warning}
                          bg={theme.backgroundElement}
                          onClick={(event) => {
                            event.stopPropagation()
                            void tilldone("stop")
                          }}
                        />
                      </Show>
                      <Show when={canAbortTillDone()}>
                        <Button
                          label="✕"
                          fg={theme.error}
                          bg={theme.backgroundElement}
                          onClick={(event) => {
                            event.stopPropagation()
                            void tilldone("abort")
                          }}
                        />
                      </Show>
                      <Button
                        label="+"
                        fg={theme.text}
                        bg={theme.backgroundElement}
                        onClick={(event) => {
                          event.stopPropagation()
                          dialog.replace(() => <NewTaskDialog onClose={() => dialog.clear()} onSave={createTask} />)
                          dialog.setSize("small")
                        }}
                      />
                    </box>
                  </box>
                  <Show when={runner()?.stoppedAt}>
                    {(stoppedAt) => <text fg={theme.textMuted}>{runner()?.status === "complete" ? "Completed" : "Stopped"}: {formatTime(stoppedAt())}</text>}
                  </Show>
                  <Show when={runner()?.error}>
                    {(error) => <text fg={theme.error}>Error: {error()}</text>}
                  </Show>
                  <Show when={activeWorkers().length > 0}>
                    <box gap={0}>
                      <text fg={theme.text}>
                        <b>Active workers</b>
                      </text>
                      <For each={activeWorkers()}>
                        {(worker) => (
                          <box gap={0} paddingLeft={1}>
                            <text fg={theme.success} wrapMode="none" overflow="hidden">
                              #{worker.slot ?? "?"} {worker.agent} task {worker.taskID ?? "-"}
                            </text>
                            <Show when={worker.sessionID}>
                              {(sessionID) => <text fg={theme.textMuted}>session {sessionID()}</text>}
                            </Show>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                  <Show when={runner()?.workers.find((worker) => worker.error || worker.status === "interrupted" || worker.status === "aborted" || worker.status === "error") }>
                    {(worker) => (
                      <text fg={theme.error} wrapMode="word">
                        Worker {worker().slot ?? "?"} {worker().status}{worker().error ? `: ${worker().error}` : ""}
                      </text>
                    )}
                  </Show>
                  <Show
                    when={todos().length > 0}
                    fallback={<text fg={theme.textMuted}>No queued tasks. Press + to add work.</text>}
                  >
                    <box gap={1}>
                      {taskSection("Todo", todoTasks())}
                      {taskSection("Done", doneTasks(), () => void clearDoneTasks())}
                    </box>
                  </Show>
                </box>
              </Match>
              <Match when={selectedTab() === "general"}>
                <box gap={1}>
                  <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
                </box>
              </Match>
              <Match when={true}>
                <Show when={selectedTab() === "knowledge"}>
                  <KnowledgeDiary
                    entries={diaryEntries() ?? []}
                    loading={diaryEntries.loading}
                    onOpenDay={(day) => {
                      dialog.replace(() => <DiaryDayDialog day={day} onClose={() => dialog.clear()} onOpenEntry={(entry) => dialog.replace(() => <DiaryEntryDialog entry={entry} onClose={() => dialog.clear()} />)} />)
                      dialog.setSize("small")
                    }}
                    onOpen={(entry) => {
                      dialog.replace(() => <DiaryEntryDialog entry={entry} onClose={() => dialog.clear()} />)
                      dialog.setSize("small")
                    }}
                  />
                </Show>
              </Match>
            </Switch>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>OpenGui</b>
              <span style={{ fg: theme.text }}> (OpenCode)</span> <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

function AgentStatus(props: { slot: number; name: string; status: string; tone: RGBA; color: RGBA; active: boolean; onClick: () => void }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={props.active ? theme.backgroundElement : undefined}
      border={["left"]}
      borderColor={props.color}
      onMouseUp={props.onClick}
    >
      <text fg={props.active ? props.color : theme.textMuted}>{props.slot} {props.name}</text>
      <text fg={props.tone}>{props.status}</text>
    </box>
  )
}

export function KnowledgeDiary(props: { entries: DiaryEntry[]; loading: boolean; onOpen: (entry: DiaryEntry) => void; onOpenDay: (day: DiaryDay) => void }) {
  const { theme } = useTheme()
  const days = createMemo(() => groupDiaryEntries(props.entries))
  return (
    <box gap={1}>
      <box gap={0}>
        <text fg={theme.text}>
          <b>Diary timeline</b>
        </text>
        <text fg={theme.textMuted}>Recent decisions from the last week</text>
      </box>
      <Show
        when={!props.loading}
        fallback={<text fg={theme.textMuted}>Loading diary entries...</text>}
      >
        <Show
          when={days().length > 0}
          fallback={<text fg={theme.textMuted}>No diary entries found in .opencode/diary.</text>}
        >
          <For each={days()}>
            {(day) => (
              <box gap={0} paddingLeft={1} border={["left"]} borderColor={theme.border}>
                <box>
                  <text
                    fg={theme.text}
                    onMouseUp={(event) => {
                      event.stopPropagation()
                      props.onOpenDay(day)
                    }}
                  >
                    <b>{day.label}</b>
                  </text>
                </box>
                <For each={day.entries.slice(0, 5)}>
                  {(entry) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      onMouseUp={(event) => {
                        event.stopPropagation()
                        props.onOpen(entry)
                      }}
                    >
                      <box width={10} flexShrink={0}>
                        <text fg={theme.textMuted}>{formatDiaryTimeLabel(entry)}</text>
                      </box>
                      <text fg={theme.text} wrapMode="none" overflow="hidden" flexGrow={1}>
                        {truncateDiaryText(entry.content)}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export function DiaryEntryDialog(props: { entry: DiaryEntry; onClose: () => void }) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <DialogContent>
      <DialogHeader title={formatDiaryDateHeader(props.entry.date)} onClose={props.onClose} closeLabel="X" />
      <Show when={props.entry.timestamp}>
        <text fg={theme.textMuted}>{formatDiaryTimeLabel(props.entry)}</text>
      </Show>
      <scrollbox height={12} scrollAcceleration={scrollAcceleration()}>
        <text fg={theme.text} wrapMode="word">
          {props.entry.content}
        </text>
      </scrollbox>
      <DialogFooter>
        <box flexDirection="row" gap={1}>
          <Button label={diaryEntryDialogActions[0]} fg={theme.text} onClick={props.onClose} />
          <Button label={diaryEntryDialogActions[1]} fg={theme.text} onClick={props.onClose} />
        </box>
      </DialogFooter>
    </DialogContent>
  )
}

export function DiaryDayDialog(props: { day: DiaryDay; onClose: () => void; onOpenEntry: (entry: DiaryEntry) => void }) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <DialogContent>
      <DialogHeader title={props.day.label} onClose={props.onClose} closeLabel="X" />
      <text fg={theme.textMuted}>{props.day.entries.length === 1 ? "1 diary entry" : `${props.day.entries.length} diary entries`}</text>
      <scrollbox height={14} scrollAcceleration={scrollAcceleration()}>
        <box gap={1}>
          <For each={props.day.entries}>
            {(entry) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={(event) => {
                  event.stopPropagation()
                  props.onOpenEntry(entry)
                }}
              >
                <box width={3} alignItems="center" flexShrink={0}>
                  <text fg={theme.border}>│</text>
                  <text fg={theme.primary}>●</text>
                  <text fg={theme.border}>│</text>
                </box>
                <box gap={0} flexGrow={1}>
                  <text fg={theme.textMuted}>{formatDiaryTimeLabel(entry)}</text>
                  <text fg={theme.text} wrapMode="word">
                    {entry.content}
                  </text>
                </box>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <DialogFooter>
        <box flexDirection="row" gap={1}>
          <Button label={diaryEntryDialogActions[0]} fg={theme.text} onClick={props.onClose} />
          <Button label={diaryEntryDialogActions[1]} fg={theme.text} onClick={props.onClose} />
        </box>
      </DialogFooter>
    </DialogContent>
  )
}

function TaskDialog(props: {
  item: QueueTask
  onClose: () => void
  onAction: (action: "claim" | "unclaim" | "clear", item: QueueTask) => Promise<void>
  onSave: (item: QueueTask, content: string, assignedAgent: string | null) => Promise<void>
}) {
  const { theme } = useTheme()
  const sync = useSync()
  const local = useLocal()
  const tuiConfig = useTuiConfig()
  const [state, setState] = createSignal<"idle" | "working" | "failed">("idle")
  const [selectedAgent, setSelectedAgent] = createSignal<string | undefined>(props.item.assignedAgent)
  const agentOptions = createMemo(() => sync.data.agent.filter((item) => (item.mode === "subagent" || item.name === "build") && !item.hidden))
  let textarea: TextareaRenderable
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const agent = () => props.item.completedBy ?? props.item.claimedBy ?? props.item.createdBy ?? "unknown"
  const history = createMemo(() => props.item.history?.split("\n\n### ").map((item) => item.replace(/^### /, "")).filter(Boolean) ?? [])
  const moveAgent = (direction: number) => {
    const options = [undefined, ...agentOptions().map((item) => item.name)]
    const next = options.indexOf(selectedAgent()) + direction
    setSelectedAgent(options[next < 0 ? options.length - 1 : next >= options.length ? 0 : next])
  }
  const runAction = async (action: "claim" | "unclaim" | "clear") => {
    if (state() === "working") return
    setState("working")
    await props.onAction(action, props.item).then(
      () => setState("idle"),
      () => setState("failed"),
    )
  }
  const save = async () => {
    if (state() === "working") return
    setState("working")
    await props.onSave(props.item, textarea.plainText, selectedAgent() ?? null).then(
      () => setState("idle"),
      () => setState("failed"),
    )
  }

  useKeyboard((event) => {
    if (event.ctrl && (event.name === "n" || event.name === "p")) {
      event.preventDefault()
      event.stopPropagation()
      moveAgent(event.name === "n" ? 1 : -1)
    }
  })

  onMount(() => {
    setTimeout(() => {
      if (textarea?.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (state() === "working") {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <DialogContent>
      <DialogHeader title="Task" onClose={props.onClose} closeLabel="X" />
      <box gap={0}>
        <text fg={theme.textMuted}>Content</text>
        <scrollbox height={7} scrollAcceleration={scrollAcceleration()} border={true} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <textarea
            ref={(value: TextareaRenderable) => {
              textarea = value
            }}
            height={5}
            initialValue={props.item.content}
            placeholder="What needs to be done?"
            placeholderColor={theme.textMuted}
            textColor={state() === "working" ? theme.textMuted : theme.text}
            focusedTextColor={state() === "working" ? theme.textMuted : theme.text}
            cursorColor={state() === "working" ? theme.backgroundElement : theme.text}
          />
        </scrollbox>
      </box>
      <box gap={0}>
        <text fg={theme.textMuted}>Details</text>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.textMuted}>Status</text>
          <text fg={theme.text} wrapMode="none" overflow="hidden">
            {props.item.status}
          </text>
        </box>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.textMuted}>Actor</text>
          <text fg={theme.text} wrapMode="none" overflow="hidden">
            {agent()}
          </text>
        </box>
      </box>
      <box gap={0}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Assignment</text>
          <text fg={theme.textMuted}>ctrl+n/ctrl+p</text>
        </box>
        <box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            label="Unassigned"
            fg={selectedAgent() ? theme.textMuted : theme.text}
            bg={selectedAgent() ? undefined : theme.backgroundElement}
            onClick={(event) => {
              event.stopPropagation()
              setSelectedAgent(undefined)
            }}
          />
          <For each={agentOptions()}>
            {(agent) => (
              <Button
                label={agent.name}
                fg={selectedAgent() === agent.name ? local.agent.color(agent.name) : theme.textMuted}
                bg={selectedAgent() === agent.name ? theme.backgroundElement : undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedAgent(agent.name)
                }}
              />
            )}
          </For>
        </box>
      </box>
      <Show when={history().length > 0}>
        <box gap={0}>
          <text fg={theme.textMuted}>History</text>
          <scrollbox height={4} scrollAcceleration={scrollAcceleration()}>
            <For each={history()}>
              {(entry) => <text fg={theme.textMuted} wrapMode="word">• {entry.replace("\n", " — ")}</text>}
            </For>
          </scrollbox>
        </box>
      </Show>
      <Show when={state() === "failed"}>
        <text fg={theme.error}>Action failed. The task was not changed.</text>
      </Show>
      <box gap={1} border={["top"]} borderColor={theme.borderSubtle} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <Button label="Clear" fg={state() === "working" ? theme.textMuted : theme.error} bg={theme.backgroundElement} onClick={() => void runAction("clear")} />
            <Button
              label={props.item.status === "completed" ? "Unclaim" : "Claim"}
              fg={state() === "working" ? theme.textMuted : props.item.status === "completed" ? theme.warning : theme.success}
              bg={theme.backgroundElement}
              onClick={() => void runAction(props.item.status === "completed" ? "unclaim" : "claim")}
            />
          </box>
          <box flexDirection="row" gap={1}>
            <Button label="Cancel" fg={theme.text} onClick={props.onClose} />
            <Button label="Save" fg={state() === "working" ? theme.textMuted : theme.text} bg={theme.backgroundElement} onClick={() => void save()} />
          </box>
        </box>
      </box>
    </DialogContent>
  )
}

function NewTaskDialog(props: { onClose: () => void; onSave: (content: string, assignedAgent?: string) => Promise<void> }) {
  const { theme } = useTheme()
  const sync = useSync()
  const local = useLocal()
  const [state, setState] = createSignal<"idle" | "working" | "failed">("idle")
  const [selectedAgent, setSelectedAgent] = createSignal<string | undefined>()
  const agentOptions = createMemo(() => sync.data.agent.filter((item) => (item.mode === "subagent" || item.name === "build") && !item.hidden))
  let textarea: TextareaRenderable

  const moveAgent = (direction: number) => {
    const options = [undefined, ...agentOptions().map((item) => item.name)]
    const next = options.indexOf(selectedAgent()) + direction
    setSelectedAgent(options[next < 0 ? options.length - 1 : next >= options.length ? 0 : next])
  }

  const save = async () => {
    if (state() === "working") return
    setState("working")
    await props.onSave(textarea.plainText, selectedAgent()).then(
      () => setState("idle"),
      () => setState("failed"),
    )
  }

  useKeyboard((event) => {
    if (event.name === "return") {
      event.preventDefault()
      event.stopPropagation()
      void save()
      return
    }
    if (event.ctrl && (event.name === "n" || event.name === "p")) {
      event.preventDefault()
      event.stopPropagation()
      moveAgent(event.name === "n" ? 1 : -1)
    }
  })

  onMount(() => {
    setTimeout(() => {
      if (textarea?.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    if (state() === "working") {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <DialogContent>
      <DialogHeader title="New Task" onClose={props.onClose} closeLabel="X" />
      <textarea
        ref={(value: TextareaRenderable) => {
          textarea = value
        }}
        height={3}
        placeholder="What needs to be done?"
        placeholderColor={theme.textMuted}
        textColor={state() === "working" ? theme.textMuted : theme.text}
        focusedTextColor={state() === "working" ? theme.textMuted : theme.text}
        cursorColor={state() === "working" ? theme.backgroundElement : theme.text}
        keyBindings={state() === "working" ? [] : [{ name: "return", action: "submit" }]}
        onSubmit={() => void save()}
      />
      <box gap={0}>
        <text fg={theme.textMuted}>Assigned agent</text>
        <box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            label="Unassigned"
            fg={selectedAgent() ? theme.textMuted : theme.text}
            bg={selectedAgent() ? undefined : theme.backgroundElement}
            onClick={(event) => {
              event.stopPropagation()
              setSelectedAgent(undefined)
            }}
          />
          <For each={agentOptions()}>
            {(agent) => (
              <Button
                label={agent.name}
                fg={selectedAgent() === agent.name ? local.agent.color(agent.name) : theme.textMuted}
                bg={selectedAgent() === agent.name ? theme.backgroundElement : undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedAgent(agent.name)
                }}
              />
            )}
          </For>
        </box>
        <text fg={theme.textMuted}>ctrl+n/ctrl+p select agent</text>
      </box>
      <Show when={state() === "failed"}>
        <text fg={theme.error}>Could not save task.</text>
      </Show>
      <DialogFooter>
        <box flexDirection="row" gap={1}>
          <Button label="Cancel" fg={theme.text} onClick={props.onClose} />
          <Button label="Save" fg={state() === "working" ? theme.textMuted : theme.text} onClick={() => void save()} />
        </box>
      </DialogFooter>
    </DialogContent>
  )
}

function Button(props: { label: string; fg: RGBA; bg?: RGBA; onClick: (event: TuiMouseEvent) => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const [down, setDown] = createSignal(false)
  const background = () => (down() ? theme.borderActive : hover() ? theme.border : props.bg)

  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={background()}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => {
        setHover(false)
        setDown(false)
      }}
      onMouseDown={() => setDown(true)}
      onMouseUp={(event) => {
        setDown(false)
        props.onClick(event)
      }}
    >
      <text fg={props.fg}>{props.label}</text>
    </box>
  )
}
