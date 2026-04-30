import { TextareaRenderable } from "@opentui/core"
import type { MouseEvent as TuiMouseEvent, RGBA } from "@opentui/core"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useDialog } from "../../ui/dialog"
import { useKeyboard } from "@opentui/solid"

import { getScrollAcceleration } from "../../util/scroll"

type QueueTask = Todo & { id?: string; claimedBy?: string }
type SidebarTab = "general" | "tilldone" | "knowledge"

export function Sidebar(props: { sessionID: string; overlay?: boolean; tab?: SidebarTab; setTab?: (tab: SidebarTab) => void }) {
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const [store, setStore] = createStore({ tab: "general" as SidebarTab })
  const selectedTab = () => props.tab ?? store.tab
  const setSelectedTab = (tab: SidebarTab) => (props.setTab ? props.setTab(tab) : setStore("tab", tab))
  const todos = createMemo(() => (sync.data.todo[props.sessionID] ?? []) as QueueTask[])
  const todoTasks = createMemo(() => todos().filter((item) => item.status !== "completed" && item.status !== "cancelled"))
  const doneTasks = createMemo(() => todos().filter((item) => item.status === "completed" || item.status === "cancelled"))
  const tabColor = (value: SidebarTab) => (value === "tilldone" ? theme.warning : local.agent.color(local.agent.current()?.name ?? "build"))
  const createTask = async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return
    const result = await sdk.client.session.todoCreate({ sessionID: props.sessionID, content: trimmed })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }
  const updateTasks = async (action: "claim" | "clear", item: QueueTask) => {
    if (!item.id) return
    const result =
      action === "claim"
        ? await sdk.client.session.todoClaim({ sessionID: props.sessionID, id: item.id })
        : await sdk.client.session.todoClear({ sessionID: props.sessionID, id: item.id })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }
  const saveTask = async (item: QueueTask, content: string) => {
    if (!item.id) return
    const result = await sdk.client.session.todoEdit({ sessionID: props.sessionID, id: item.id, content: content.trim() })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
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

  const taskLine = (item: QueueTask) => (
    <box
      gap={0}
      paddingLeft={1}
      onMouseUp={(event) => {
        event.stopPropagation()
        dialog.replace(() => <TaskDialog item={item} onClose={() => dialog.clear()} onAction={updateTasks} onSave={saveTask} />)
        dialog.setSize("small")
      }}
    >
      <text fg={item.status === "in_progress" || item.status === "claimed" ? theme.warning : theme.textMuted}>
        {item.status === "completed" ? "[✓]" : item.status === "cancelled" ? "[x]" : "[ ]"} {item.content}
      </text>
      <Show when={item.claimedBy}>
        <text fg={theme.textMuted}>claimed: {item.claimedBy}</text>
      </Show>
    </box>
  )

  const taskSection = (title: string, items: ReturnType<typeof todos>) => (
    <Show when={items.length > 0}>
      <box gap={0}>
        <text fg={theme.text}>
          <b>{title}</b> <span style={{ fg: theme.textMuted }}>{items.length}</span>
        </text>
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
                  <AgentStatus name="TUI Dev" status="Idle" tone={theme.textMuted} />
                  <AgentStatus name="QA" status="Running" tone={theme.success} />
                  <AgentStatus name="Scribe" status="Idle" tone={theme.textMuted} />
                </box>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
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
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.text}>
                      <b>TillDone</b>
                    </text>
                    <Button
                      label="[+] New Task"
                      fg={theme.text}
                      bg={theme.backgroundElement}
                      onClick={(event) => {
                        event.stopPropagation()
                        dialog.replace(() => <NewTaskDialog onClose={() => dialog.clear()} onSave={createTask} />)
                        dialog.setSize("small")
                      }}
                    />
                  </box>
                  <Show
                    when={todos().length > 0}
                    fallback={<text fg={theme.textMuted}>No queued tasks. Use [+] New Task to add work.</text>}
                  >
                    <box gap={1}>
                      {taskSection("Todo", todoTasks())}
                      {taskSection("Done", doneTasks())}
                    </box>
                  </Show>
                </box>
              </Match>
              <Match when={true}>
                <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
              </Match>
            </Switch>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

function AgentStatus(props: { name: string; status: string; tone: RGBA }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.textMuted}>{props.name}</text>
      <text fg={props.tone}>{props.status}</text>
    </box>
  )
}

function TaskDialog(props: {
  item: QueueTask
  onClose: () => void
  onAction: (action: "claim" | "clear", item: QueueTask) => Promise<void>
  onSave: (item: QueueTask, content: string) => Promise<void>
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const [state, setState] = createSignal<"idle" | "working" | "failed">("idle")
  let textarea: TextareaRenderable
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const agent = () => props.item.completedBy ?? props.item.claimedBy ?? props.item.createdBy ?? "unknown"
  const runAction = async (action: "claim" | "clear") => {
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
    await props.onSave(props.item, textarea.plainText).then(
      () => setState("idle"),
      () => setState("failed"),
    )
  }

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
      <Show when={state() === "failed"}>
        <text fg={theme.error}>Action failed. The task was not changed.</text>
      </Show>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>|</text>
          <Button label="Clear" fg={state() === "working" ? theme.textMuted : theme.error} bg={theme.backgroundElement} onClick={() => void runAction("clear")} />
          <Button label="Claim" fg={state() === "working" ? theme.textMuted : theme.success} bg={theme.backgroundElement} onClick={() => void runAction("claim")} />
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

function NewTaskDialog(props: { onClose: () => void; onSave: (content: string) => Promise<void> }) {
  const { theme } = useTheme()
  const [state, setState] = createSignal<"idle" | "working" | "failed">("idle")
  let textarea: TextareaRenderable

  const save = async () => {
    if (state() === "working") return
    setState("working")
    await props.onSave(textarea.plainText).then(
      () => setState("idle"),
      () => setState("failed"),
    )
  }

  useKeyboard((event) => {
    if (event.name !== "return") return
    event.preventDefault()
    event.stopPropagation()
    void save()
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
