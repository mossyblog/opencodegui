import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-lsp"
const collapsedKey = "sidebar_lsp_collapsed"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp())
  const collapsed = createMemo(() => props.api.kv.get(collapsedKey, false))
  const off = createMemo(() => props.api.state.config.lsp === false)

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => props.api.kv.set(collapsedKey, !collapsed())}>
        <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text}>
          <b>LSP</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <Show when={list().length === 0}>
          <text fg={theme().textMuted}>
            {off() ? "LSPs have been disabled in settings" : "LSPs will activate as files are read"}
          </text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: item.status === "connected" ? theme().success : theme().error,
                }}
              >
                •
              </text>
              <text fg={theme().textMuted}>
                {item.id} {item.root}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
