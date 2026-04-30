import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"
const collapsedKey = "sidebar_todo_collapsed"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const collapsed = createMemo(() => props.api.kv.get(collapsedKey, false))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => props.api.kv.set(collapsedKey, !collapsed())}>
          <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
          <text fg={theme().text}>
            <b>Todo</b>
          </text>
        </box>
        <Show when={!collapsed()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
