import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  assignedAgent?: string
}

export const todoItemColor = <T,>(props: Pick<TodoItemProps, "status" | "assignedAgent">, theme: { textMuted: T; markdownLink: T; warning: T }) =>
  props.status === "completed" || props.status === "cancelled" ? theme.textMuted : props.assignedAgent === "qa" ? theme.markdownLink : props.status === "in_progress" ? theme.warning : theme.textMuted

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const fg = () => todoItemColor(props, theme)

  return (
    <box flexDirection="row" gap={0}>
      <text
        flexShrink={0}
        style={{
          fg: fg(),
        }}
      >
        [{props.status === "completed" ? "✓" : props.status === "in_progress" ? "•" : " "}]{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: fg(),
        }}
      >
        {props.content}
      </text>
    </box>
  )
}
