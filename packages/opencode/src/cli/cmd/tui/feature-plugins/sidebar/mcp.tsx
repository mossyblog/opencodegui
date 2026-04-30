import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"

const id = "internal:sidebar-mcp"
const collapsedKey = "sidebar_mcp_collapsed"

function View(props: { api: TuiPluginApi }) {
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const theme = () => props.api.theme.current
  const collapsed = createMemo(() => props.api.kv.get(collapsedKey, false))
  const disabledKey = createMemo(() => `mcp_disabled:${project.instance.directory()}`)
  const disabled = createMemo<string[]>(() => props.api.kv.get(disabledKey(), []))
  const list = createMemo(() => props.api.state.mcp())
  const on = createMemo(() => list().filter((item) => item.status === "connected").length)
  const bad = createMemo(
    () =>
      list().filter(
        (item) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "failed") return theme().error
    if (status === "disabled") return theme().textMuted
    if (status === "needs_auth") return theme().warning
    if (status === "needs_client_registration") return theme().error
    return theme().textMuted
  }
  const toggle = async (name: string) => {
    if (sync.data.mcp[name]?.status === "connected") {
      props.api.kv.set(disabledKey(), [...new Set([...disabled(), name])])
      await sdk.client.mcp.disconnect({ name })
    } else {
      props.api.kv.set(disabledKey(), disabled().filter((item) => item !== name))
      await sdk.client.mcp.connect({ name })
    }
    const result = await sdk.client.mcp.status()
    if (result.data) sync.set("mcp", result.data)
  }

  createEffect(() => {
    for (const item of list()) {
      if (!disabled().includes(item.name)) continue
      if (item.status !== "connected") continue
      void sdk.client.mcp.disconnect({ name: item.name }).then(async () => {
        const result = await sdk.client.mcp.status()
        if (result.data) sync.set("mcp", result.data)
      })
    }
  })

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => props.api.kv.set(collapsedKey, !collapsed())}>
          <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
          <text fg={theme().text}>
            <b>MCP</b>
            <Show when={collapsed()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({on()} active{bad() > 0 ? `, ${bad()} error${bad() > 1 ? "s" : ""}` : ""})
              </span>
            </Show>
          </text>
        </box>
        <Show when={!collapsed()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} onMouseUp={() => void toggle(item.name)}>
                <text
                  flexShrink={0}
                  style={{
                    fg: dot(item.status),
                  }}
                >
                  {item.status === "connected" ? "(*)" : "( )"}
                </text>
                <text fg={theme().text} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed"}>
                        <i>{item.error}</i>
                      </Match>
                      <Match when={item.status === "disabled"}>Disabled</Match>
                      <Match when={item.status === "needs_auth"}>Needs auth</Match>
                      <Match when={item.status === "needs_client_registration"}>Needs client ID</Match>
                    </Switch>
                  </span>
                </text>
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
    order: 200,
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
