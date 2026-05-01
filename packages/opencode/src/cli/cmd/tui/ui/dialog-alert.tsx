import { useTheme } from "../context/theme"
import { DialogButton, DialogContent, DialogFooter, DialogHeader, useDialog, type DialogContext } from "./dialog"
import { useKeyboard } from "@opentui/solid"

export type DialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onConfirm?.()
      dialog.clear()
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
        <DialogButton
          label="ok"
          active
          onClick={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        />
      </DialogFooter>
    </DialogContent>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
