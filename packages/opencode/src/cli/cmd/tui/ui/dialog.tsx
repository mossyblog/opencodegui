import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createSignal, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { MouseButton, Renderable, RGBA, TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Selection from "@tui/util/selection"

export function Dialog(
  props: ParentProps<{
    size?: "small" | "medium" | "large" | "xlarge" | "fullscreen"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  let dismiss = false
  const width = () => {
    if (props.size === "small") return Math.max(40, Math.floor(dimensions().width / 2))
    if (props.size === "fullscreen") return Math.floor(dimensions().width * 0.8)
    if (props.size === "xlarge") return 116
    if (props.size === "large") return 88
    return 60
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={props.size === "fullscreen" ? Math.floor(dimensions().height * 0.1) : dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e) => {
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

export function DialogContent(props: ParentProps<{ gap?: number }>) {
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={props.gap ?? 1}>
      {props.children}
    </box>
  )
}

export function DialogHeader(props: { title: string; onClose: () => void; closeLabel?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={theme.text} wrapMode="none" overflow="hidden">
          {props.title}
        </text>
        <box onMouseUp={props.onClose} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted}>{props.closeLabel ?? "esc"}</text>
        </box>
      </box>
      <box height={1} border={["bottom"]} borderColor={theme.borderSubtle} />
    </>
  )
}

export function DialogFooter(props: ParentProps<{ justifyContent?: "space-between" | "flex-end" }>) {
  return (
    <box flexDirection="row" justifyContent={props.justifyContent ?? "flex-end"} gap={1} paddingTop={1}>
      {props.children}
    </box>
  )
}

export function DialogButton(props: { label: string; active?: boolean; onClick: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const [down, setDown] = createSignal(false)
  const background = () => (props.active ? theme.primary : down() ? theme.borderActive : hover() ? theme.border : undefined)
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
      onMouseUp={() => {
        setDown(false)
        props.onClick()
      }}
    >
      <text fg={props.active ? theme.selectedListItemText : theme.textMuted}>{props.label}</text>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
    size: "medium" as "small" | "medium" | "large" | "xlarge" | "fullscreen",
  })

  const renderer = useRenderer()

  useKeyboard((evt) => {
    if (store.stack.length === 0) return
    if (evt.defaultPrevented) return
    if ((evt.name === "escape" || (evt.ctrl && evt.name === "c")) && renderer.getSelection()?.getSelectedText()) return
    if (evt.name === "escape" || (evt.ctrl && evt.name === "c")) {
      if (renderer.getSelection()) {
        renderer.clearSelection()
      }
      const current = store.stack.at(-1)!
      current.onClose?.()
      setStore("stack", store.stack.slice(0, -1))
      evt.preventDefault()
      evt.stopPropagation()
      refocus()
    }
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: any, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "medium")
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: "small" | "medium" | "large" | "xlarge" | "fullscreen") {
      setStore("size", size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt) => {
          if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!Selection.copy(renderer, toast)) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={
          !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? () => Selection.copy(renderer, toast) : undefined
        }
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            {value.stack.at(-1)!.element}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
