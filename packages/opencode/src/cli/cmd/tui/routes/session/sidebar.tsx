import { TextareaRenderable } from "@opentui/core"
import type { MouseEvent as TuiMouseEvent, RGBA } from "@opentui/core"
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
import { useDialog } from "../../ui/dialog"
import { useKeyboard } from "@opentui/solid"
import "opentui-spinner/solid"
import { spinnerFrames } from "../../component/spinner"

import { getScrollAcceleration } from "../../util/scroll"

type QueueTask = Todo & { id?: string; assignedAgent?: string; claimedBy?: string }
type SidebarTab = "general" | "tilldone" | "knowledge"
type DiaryEntry = { date: string; content: string }

export function Sidebar(props: {
  sessionID: string
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
  const [runner, setRunner] = createSignal<{ status: string; active: number; maxWorkers: number }>()
  const tabColor = (value: SidebarTab) => (value === "tilldone" ? theme.warning : local.agent.color(local.agent.current()?.name ?? "build"))
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
  const [diaryEntries] = createResource(
    () => project.instance.directory(),
    async (directory) => {
      if (!directory) return []
      const diary = path.join(directory, ".opencode", "diary")
      const entries = await Promise.all(
        (await readdir(diary).catch(() => []))
          .filter((file) => file.endsWith(".md"))
          .toSorted((a, b) => b.localeCompare(a))
          .map(async (file) => {
            const content = await readFile(path.join(diary, file), "utf8").catch(() => undefined)
            if (!content?.trim()) return undefined
            return { date: file.replace(/\.md$/, ""), content: content.trim() }
          }),
      )
      return entries.filter((entry): entry is DiaryEntry => !!entry)
    },
  )

  const tab = (value: SidebarTab, label: string) => (
    <box
      onMouseDown={() => setSelectedTab(value)}
      paddingLeft={1}
      paddingRight={1}
      border={["top"]}
      borderColor={selectedTab() === value ? tabColor(value) : theme.backgroundPanel}
      backgroundColor={selectedTab() === value ? theme.backgroundElement : undefined}
    >
      <text fg={selectedTab() === value ? theme.text : theme.textMuted}>
        <b>{label}</b>
      </text>
    </box>
  )

  const truncateTask = (content: string) => (content.length > 32 ? content.slice(0, 29) + "..." : content)

  const planColor = () => local.agent.color("plan")
  const isTodoQaTask = (item: QueueTask) => item.status === "pending" && item.assignedAgent === "qa"
  const taskColor = (item: QueueTask) =>
    item.status === "in_progress" || item.status === "claimed"
      ? theme.success
      : item.status === "completed" || item.status === "cancelled"
        ? theme.textMuted
        : isTodoQaTask(item)
          ? theme.markdownLink
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
                label="🗑"
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
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
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
              {tab("knowledge", "Knowledge")}
            </box>
            <Switch>
              <Match when={selectedTab() === "tilldone"}>
                <box gap={1}>
                  <box flexDirection="row" justifyContent="space-between" alignItems="center">
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text}>
                        <b>TillDone</b>
                      </text>
                      <text fg={runner()?.status === "running" ? theme.success : theme.textMuted}>{runner()?.status ?? "idle"}</text>
                      <text fg={theme.textMuted}>
                        {runner()?.active ?? 0}/{runner()?.maxWorkers ?? 3}
                      </text>
                    </box>
                    <box flexDirection="row" gap={1}>
                      <Button
                        label={runner()?.status === "running" ? "■" : "▶"}
                        fg={runner()?.status === "running" ? theme.warning : theme.success}
                        bg={theme.backgroundElement}
                        onClick={(event) => {
                          event.stopPropagation()
                          void tilldone(runner()?.status === "running" ? "stop" : "start")
                        }}
                      />
                      <Button
                        label="✕"
                        fg={theme.error}
                        bg={theme.backgroundElement}
                        onClick={(event) => {
                          event.stopPropagation()
                          void tilldone("abort")
                        }}
                      />
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
                  <KnowledgeDiary entries={diaryEntries() ?? []} loading={diaryEntries.loading} />
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

function KnowledgeDiary(props: { entries: DiaryEntry[]; loading: boolean }) {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text}>
        <b>Knowledge</b>
      </text>
      <Show
        when={!props.loading}
        fallback={<text fg={theme.textMuted}>Loading diary entries...</text>}
      >
        <Show
          when={props.entries.length > 0}
          fallback={<text fg={theme.textMuted}>No diary entries found in .opencode/diary.</text>}
        >
          <For each={props.entries}>
            {(entry) => (
              <box gap={0} border={["left"]} borderColor={theme.border} paddingLeft={1}>
                <text fg={theme.text}>
                  <b>{entry.date}</b>
                </text>
                <text fg={theme.textMuted}>{entry.content}</text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
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
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>Task</b>
        </text>
        <box onMouseDown={props.onClose} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>X</text>
        </box>
      </box>
      <scrollbox height={8} scrollAcceleration={scrollAcceleration()}>
        <textarea
          ref={(value: TextareaRenderable) => {
            textarea = value
          }}
          height={6}
          initialValue={props.item.content}
          placeholder="What needs to be done?"
          placeholderColor={theme.textMuted}
          textColor={state() === "working" ? theme.textMuted : theme.text}
          focusedTextColor={state() === "working" ? theme.textMuted : theme.text}
          cursorColor={state() === "working" ? theme.backgroundElement : theme.text}
        />
      </scrollbox>
      <box gap={0}>
        <text fg={theme.textMuted}>Status: {props.item.status}</text>
        <text fg={theme.textMuted}>Agent: {agent()}</text>
      </box>
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
        <text fg={theme.error}>Action failed. The task was not changed.</text>
      </Show>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>|</text>
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
          <Button label="Save" fg={state() === "working" ? theme.textMuted : theme.text} onClick={() => void save()} />
          <text fg={theme.textMuted}>|</text>
        </box>
      </box>
    </box>
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
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={theme.text}>
        <b>New Task</b>
      </text>
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
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>|</text>
        </box>
        <box flexDirection="row" gap={1}>
          <Button label="Cancel" fg={theme.text} onClick={props.onClose} />
          <Button label="Save" fg={state() === "working" ? theme.textMuted : theme.text} onClick={() => void save()} />
          <text fg={theme.textMuted}>|</text>
        </box>
      </box>
    </box>
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
