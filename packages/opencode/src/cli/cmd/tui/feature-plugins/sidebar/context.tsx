import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

const id = "internal:sidebar-context"
const collapsedKey = "sidebar_context_collapsed"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
const QUOTA_REFRESH_INTERVAL = 5 * 60 * 1000
const BAR_SIZE = 6

type Quota = {
  available: boolean
  limits: Array<{
    id: string
    name?: string
    primary?: { usedPercent: number; resetsAt?: number }
    secondary?: { usedPercent: number; resetsAt?: number }
    credits?: { hasCredits: boolean; unlimited: boolean; balance?: string }
  }>
  error?: string
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const collapsed = createMemo(() => props.api.kv.get(collapsedKey, false))
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))
  const [quota, setQuota] = createSignal<Quota>()

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      providerID: last.providerID,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })
  const tone = (percent: number | null | undefined) => {
    if (percent === null || percent === undefined) return theme().textMuted
    if (percent >= 90) return theme().error
    if (percent >= 80) return theme().warning
    return theme().textMuted
  }
  const bar = (percent: number | null | undefined) => {
    if (percent === null || percent === undefined) return `${"▱".repeat(BAR_SIZE)} --%`
    const used = Math.max(0, Math.min(100, percent))
    const filled = Math.ceil((used / 100) * BAR_SIZE)
    return `${"▰".repeat(filled)}${"▱".repeat(Math.max(0, BAR_SIZE - filled))} ${used.toFixed(0)}%`
  }
  const reset = (timestamp?: number) => {
    if (!timestamp) return
    const delta = Math.max(0, timestamp * 1000 - Date.now())
    const minutes = Math.ceil(delta / 60_000)
    if (minutes < 60) return `${minutes}mins reset`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}hrs reset`
    const days = Math.floor(hours / 24)
    return `${days} days @ ${new Date(timestamp * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
  }
  const quotaGroup = (item: Quota["limits"][number]) => {
    const label = item.name ?? (item.id === "codex" ? "GPT" : item.id.replaceAll("_", " "))
    return label.toLowerCase().includes("spark") ? "Spark" : label === "Codex" ? "GPT" : label
  }
  const quotaRow = (window?: { usedPercent: number; resetsAt?: number }, suffix?: string) => {
    if (!window) return undefined
    const resetAt = reset(window.resetsAt)
    return (
      <text fg={tone(window.usedPercent)}>
        {bar(window.usedPercent)} <Show when={resetAt}>{resetAt}</Show><Show when={suffix}> {suffix}</Show>
      </text>
    )
  }

  createEffect(() => {
    if (collapsed() || state().providerID !== "openai") {
      setQuota(undefined)
      return
    }
    let disposed = false
    const refresh = async () => {
      const result = await props.api.client.session.codexQuota().catch(() => undefined)
      if (!disposed) setQuota(result?.data as Quota | undefined)
    }
    void refresh()
    const timer = setInterval(refresh, QUOTA_REFRESH_INTERVAL)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => props.api.kv.set(collapsedKey, !collapsed())}>
        <text fg={theme().text}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text}>
          <b>Context</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <text fg={theme().textMuted}>Est Cost: {money.format(cost())}</text>
        <text fg={tone(state().percent)}>{bar(state().percent)} {state().tokens.toLocaleString()} tokens</text>
        <Show when={quota()?.available && (quota()?.limits.length ?? 0) > 0}>
          <For each={quota()?.limits ?? []}>
            {(item) => (
              <box gap={0} paddingTop={1}>
                <text fg={theme().textMuted}>{quotaGroup(item)}:</text>
                {quotaRow(item.primary)}
                {quotaRow(item.secondary, "(Wk)")}
                <Show when={item.credits?.hasCredits}>
                  <text fg={theme().textMuted}>
                    Credits: {item.credits?.unlimited ? "unlimited" : (item.credits?.balance ?? "0")}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
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
