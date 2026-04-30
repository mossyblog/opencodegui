import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-files"
const collapsedKey = "sidebar_files_collapsed"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const collapsed = createMemo(() => props.api.kv.get(collapsedKey, false))

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => props.api.kv.set(collapsedKey, !collapsed())}>
          <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
        </box>
        <Show when={!collapsed()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="none">
                  {item.file}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
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
