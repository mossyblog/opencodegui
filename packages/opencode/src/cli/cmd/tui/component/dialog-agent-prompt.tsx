import { InputRenderable, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { DialogContent, DialogFooter, DialogHeader, useDialog } from "@tui/ui/dialog"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"

export function DialogAgentPrompt(props: { onSubmit: (agent: string, prompt: string) => void }) {
  let input: InputRenderable
  const dialog = useDialog()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const [selected, setSelected] = createSignal(0)
  const [prompt, setPrompt] = createSignal("")
  const agents = createMemo(() => sync.data.agent.filter((item) => item.mode === "subagent" && !item.hidden))
  const current = createMemo(() => agents()[selected()])

  const move = (direction: number) => {
    if (agents().length === 0) return
    const next = selected() + direction
    if (next < 0) {
      setSelected(agents().length - 1)
      return
    }
    if (next >= agents().length) {
      setSelected(0)
      return
    }
    setSelected(next)
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault()
      move(-1)
      return
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault()
      move(1)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      const agent = current()
      if (!agent || !prompt().trim()) return
      props.onSubmit(agent.name, prompt().trim())
    }
  })

  return (
    <DialogContent>
      <box>
        <DialogHeader title="Agent task" onClose={() => dialog.clear()} />
        <box paddingTop={1}>
          <input
            onInput={setPrompt}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
            ref={(r) => {
              input = r
              input.traits = { status: "PROMPT" }
              setTimeout(() => {
                if (!input || input.isDestroyed) return
                input.focus()
              }, 1)
            }}
            placeholder="Type task for selected agent"
            placeholderColor={theme.textMuted}
          />
        </box>
      </box>
      <Show when={agents().length > 0} fallback={<box paddingLeft={4}><text fg={theme.textMuted}>No subagents available</text></box>}>
        <box>
          <For each={agents()}>
            {(agent, index) => {
              const active = createMemo(() => selected() === index())
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
                  onMouseOver={() => setSelected(index())}
                  onMouseUp={() => {
                    if (!prompt().trim()) return
                    props.onSubmit(agent.name, prompt().trim())
                  }}
                >
                  <text flexShrink={0} fg={active() ? fg : local.agent.color(agent.name)}>{index() + 1}</text>
                  <text fg={active() ? fg : theme.text} wrapMode="none">{agent.name}</text>
                  <text fg={active() ? fg : theme.textMuted} wrapMode="none">{agent.native ? "native" : agent.description}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <DialogFooter justifyContent="space-between">
        <text fg={theme.textMuted}>up/down select</text>
        <text fg={theme.textMuted}>enter send</text>
      </DialogFooter>
    </DialogContent>
  )
}
