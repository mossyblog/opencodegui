import { DialogButton, DialogContent, DialogFooter, DialogHeader, useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Locale } from "@/util/locale"
import { useTheme } from "../context/theme"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
}

export type DialogConfirmResult = boolean | undefined

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      if (store.active === "confirm") props.onConfirm?.()
      if (store.active === "cancel") props.onCancel?.()
      dialog.clear()
    }

    if (evt.name === "left" || evt.name === "right") {
      setStore("active", store.active === "confirm" ? "cancel" : "confirm")
    }
  })
  return (
    <DialogContent>
      <DialogHeader title={props.title} onClose={() => dialog.clear()} />
      <box paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="word">
          {props.message}
        </text>
      </box>
      <DialogFooter>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <DialogButton
              label={Locale.titlecase(key === "cancel" ? (props.label ?? key) : key)}
              active={key === store.active}
              onClick={() => {
                if (key === "confirm") props.onConfirm?.()
                if (key === "cancel") props.onCancel?.()
                dialog.clear()
              }}
            />
          )}
        </For>
      </DialogFooter>
    </DialogContent>
  )
}

DialogConfirm.show = (dialog: DialogContext, title: string, message: string, label?: string) => {
  return new Promise<DialogConfirmResult>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
          label={label}
        />
      ),
      () => resolve(undefined),
    )
  })
}
