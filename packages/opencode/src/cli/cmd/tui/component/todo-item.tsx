import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  assignedAgent?: string
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const fg = () => (props.status === "in_progress" ? theme.warning : props.status === "pending" && props.assignedAgent === "qa" ? theme.markdownLink : theme.textMuted)

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
