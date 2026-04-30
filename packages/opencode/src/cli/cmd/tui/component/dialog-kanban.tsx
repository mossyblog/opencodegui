import { useTerminalDimensions } from "@opentui/solid"
import { useKeyboard } from "@opentui/solid"
import type { MouseEvent as TuiMouseEvent, RGBA } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useSDK } from "@tui/context/sdk"

type QueueTask = Todo & { id?: string; assignedAgent?: string; claimedBy?: string }

const columns = [
  { title: "Todo", match: (task: QueueTask) => task.status === "pending" },
  { title: "Progress", match: (task: QueueTask) => task.status === "in_progress" || task.status === "claimed" },
  { title: "Blocked", match: (task: QueueTask) => task.status === "blocked" },
  { title: "Done", match: (task: QueueTask) => task.status === "completed" || task.status === "cancelled" },
]

const truncateTask = (content: string) => (content.length > 28 ? content.slice(0, 25) + "..." : content)

export function DialogKanban(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const todos = createMemo(() => (sync.data.todo[props.sessionID] ?? []) as QueueTask[])
  const height = createMemo(() => Math.max(12, Math.floor(dimensions().height * 0.8) - 6))
  const isTodoQaTask = (task: QueueTask) => task.status === "pending" && task.assignedAgent === "qa"
  const taskColor = (task: QueueTask) =>
    task.status === "in_progress" || task.status === "claimed"
      ? theme.success
      : task.status === "completed" || task.status === "cancelled"
        ? theme.textMuted
        : isTodoQaTask(task)
          ? theme.markdownLink
        : local.agent.color("plan")
  const saveTaskAssignment = async (task: QueueTask, assignedAgent: string | null) => {
    if (!task.id) return
    const result = await sdk.client.session.todoEdit({ sessionID: props.sessionID, id: task.id, content: task.content, assignedAgent })
    sync.set("todo", props.sessionID, result.data ?? [])
    dialog.clear()
  }

  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1} height={height()}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>TillDone Kanban</b>
        </text>
        <box onMouseDown={() => dialog.clear()} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>esc</text>
        </box>
      </box>
      <box flexDirection="row" gap={1} flexGrow={1}>
        <For each={columns}>
          {(column) => {
            const tasks = createMemo(() => todos().filter(column.match))
            return (
              <box border borderColor={theme.border} paddingLeft={1} paddingRight={1} flexGrow={1} flexBasis={0}>
                <text fg={theme.text} wrapMode="none" overflow="hidden">
                  <b>{column.title}</b> <span style={{ fg: theme.textMuted }}>{tasks().length}</span>
                </text>
                <scrollbox flexGrow={1}>
                  <box gap={0}>
                    <For each={tasks()}>
                      {(task) => (
                        <box
                          border={["left"]}
                          borderColor={theme.backgroundElement}
                          paddingLeft={1}
                          onMouseUp={(event) => {
                            event.stopPropagation()
                            dialog.replace(() => <TaskAssignmentDialog task={task} onClose={() => dialog.clear()} onSave={saveTaskAssignment} />)
                            dialog.setSize("small")
                          }}
                        >
                          <text fg={taskColor(task)} wrapMode="none" overflow="hidden">
                            {task.status === "completed" ? "[x]" : task.status === "cancelled" ? "[-]" : task.status === "in_progress" || task.status === "claimed" ? "[*]" : "[ ]"} {truncateTask(task.content)}
                          </text>
                        </box>
                      )}
                    </For>
                  </box>
                </scrollbox>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

function TaskAssignmentDialog(props: { task: QueueTask; onClose: () => void; onSave: (task: QueueTask, assignedAgent: string | null) => Promise<void> }) {
  const { theme } = useTheme()
  const sync = useSync()
  const local = useLocal()
  const [state, setState] = createSignal<"idle" | "working" | "failed">("idle")
  const [selectedAgent, setSelectedAgent] = createSignal<string | undefined>(props.task.assignedAgent)
  const agentOptions = createMemo(() => sync.data.agent.filter((item) => (item.mode === "subagent" || item.name === "build") && !item.hidden))
  const moveAgent = (direction: number) => {
    const options = [undefined, ...agentOptions().map((item) => item.name)]
    const next = options.indexOf(selectedAgent()) + direction
    setSelectedAgent(options[next < 0 ? options.length - 1 : next >= options.length ? 0 : next])
  }
  const save = async () => {
    if (state() === "working") return
    setState("working")
    await props.onSave(props.task, selectedAgent() ?? null).then(
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
      <text fg={theme.text} wrapMode="word" overflow="hidden">
        {props.task.content}
      </text>
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
