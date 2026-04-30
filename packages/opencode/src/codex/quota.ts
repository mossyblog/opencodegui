import { Auth } from "@/auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Context, Effect, Layer, Schema } from "effect"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

const BackendWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.optional(Schema.Number),
  reset_at: Schema.optional(Schema.Number),
})

const BackendRateLimit = Schema.Struct({
  primary_window: Schema.optional(BackendWindow),
  secondary_window: Schema.optional(BackendWindow),
})

const BackendCredits = Schema.Struct({
  has_credits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.optional(Schema.String),
})

const BackendAdditionalLimit = Schema.Struct({
  limit_name: Schema.optional(Schema.String),
  metered_feature: Schema.optional(Schema.String),
  rate_limit: BackendRateLimit,
})

const BackendUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: BackendRateLimit,
  credits: Schema.optional(BackendCredits),
  additional_rate_limits: Schema.optional(Schema.Array(BackendAdditionalLimit)),
})

const decodeBackendUsage = Schema.decodeUnknownSync(BackendUsage)

export class Window extends Schema.Class<Window>("CodexQuotaWindow")({
  usedPercent: Schema.Number,
  windowMinutes: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
}) {}

export class Credits extends Schema.Class<Credits>("CodexQuotaCredits")({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.optional(Schema.String),
}) {}

export class Limit extends Schema.Class<Limit>("CodexQuotaLimit")({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  primary: Schema.optional(Window),
  secondary: Schema.optional(Window),
  credits: Schema.optional(Credits),
}) {}

export class Info extends Schema.Class<Info>("CodexQuotaInfo")({
  available: Schema.Boolean,
  plan: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
  limits: Schema.Array(Limit),
  error: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly read: () => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodexQuota") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const refresh = Effect.fn("CodexQuota.refresh")(function* (current: Auth.Oauth) {
      const tokens = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: current.refresh,
              client_id: CLIENT_ID,
            }).toString(),
          })
          if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
          return response.json() as Promise<{ access_token: string; refresh_token: string; expires_in?: number }>
        },
        catch: (cause) => cause,
      })
      const next = {
        ...current,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      }
      yield* auth.set("openai", next).pipe(Effect.orDie)
      return next
    })

    const read = Effect.fn("CodexQuota.read")(
      function* () {
        const current = yield* auth.get("openai").pipe(Effect.orDie)
        if (current?.type !== "oauth") {
          return new Info({ available: false, updatedAt: Date.now(), limits: [], error: "OpenAI OAuth is not configured" })
        }

        const usable = current.expires < Date.now() ? yield* refresh(current) : current
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(USAGE_ENDPOINT, {
              headers: {
                authorization: `Bearer ${usable.access}`,
                "User-Agent": `opencode/${InstallationVersion}`,
                ...(usable.accountId ? { "ChatGPT-Account-Id": usable.accountId } : {}),
              },
            }),
          catch: (cause) => cause,
        })
        if (!response.ok) {
          return new Info({ available: false, updatedAt: Date.now(), limits: [], error: `Quota check failed: ${response.status}` })
        }

        const usage = decodeBackendUsage(yield* Effect.promise(() => response.json()))
        const limits = [
          new Limit({
            id: "codex",
            primary: window(usage.rate_limit.primary_window),
            secondary: window(usage.rate_limit.secondary_window),
            credits: usage.credits
              ? new Credits({
                  hasCredits: usage.credits.has_credits,
                  unlimited: usage.credits.unlimited,
                  balance: usage.credits.balance,
                })
              : undefined,
          }),
          ...(usage.additional_rate_limits ?? []).map(
            (item) =>
              new Limit({
                id: item.metered_feature ?? item.limit_name ?? "codex_other",
                name: item.limit_name,
                primary: window(item.rate_limit.primary_window),
                secondary: window(item.rate_limit.secondary_window),
              }),
          ),
        ]
        return new Info({ available: true, plan: usage.plan_type, updatedAt: Date.now(), limits })
      },
      Effect.orElseSucceed(
        () =>
          new Info({
            available: false,
            updatedAt: Date.now(),
            limits: [],
            error: "Quota check failed",
          }),
      ),
    )

    return Service.of({ read })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))

function window(input: typeof BackendWindow.Type | undefined) {
  if (!input) return undefined
  return new Window({
    usedPercent: input.used_percent,
    windowMinutes: input.limit_window_seconds ? Math.ceil(input.limit_window_seconds / 60) : undefined,
    resetsAt: input.reset_at,
  })
}

export * as CodexQuota from "./quota"
