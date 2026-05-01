# SDK extensibility proposal

## Executive summary

OpenCode should not ship a task system, Kanban board, workflow runner, diary, QA prep flow, or TillDone-specific concepts in its default release. Those are opinionated vertical slices that belong in aftermarket packages.

The SDK gap is lower level: external developers do not yet have enough stable hooks to bind their own workflow models to OpenCode sessions, agents, messages, tools, TUI surfaces, and durable state without patching OpenCode internals.

This proposal identifies the missing SDK and TUI extension surfaces needed for third parties to build those vertical slices outside OpenCode core.

## Non-goals

- Do not add a first-class OpenCode task system.
- Do not add a first-class OpenCode Kanban board.
- Do not add a first-class OpenCode workflow runner.
- Do not add a first-class OpenCode diary or decision-log feature.
- Do not add a first-class OpenCode QA handoff or QA prep workflow.
- Do not expose TillDone-branded APIs.
- Do not encode local prompt wording, local verification policy, or local orchestration rules into OpenCode core.
- Do not require OpenCode to understand plugin domain models such as tasks, boards, workers, approvals, or checklists.

## What the current branch proves

The current branch should be treated as evidence of extension pressure, not as a feature list to upstream. The important signal is where aftermarket code had to patch OpenCode internals because no stable extension surface existed.

Specific data points:

- `packages/opencode/src/session/todo.ts` stores durable project-scoped workflow records, stable ids, status, priority, assignment, claim metadata, completion metadata, and history.
- `packages/opencode/src/tool/taskqueue.ts` exposes workflow-specific operations to agents because there is no generic SDK mechanism for a plugin to expose its own durable records and actions to OpenCode agents.
- `packages/opencode/src/session/tilldone-runner.ts` owns long-running orchestration state, worker slots, child session reuse, stale recovery, stop/abort behavior, and result summaries because there is no generic SDK agent invocation and supervision surface.
- `packages/opencode/src/server/routes/instance/session.ts` contains fork-specific TillDone routes because there is no neutral SDK route family for plugin-owned actions, invocations, or status resources.
- `packages/sdk/js/src/v2/gen/types.gen.ts` and `packages/sdk/js/src/v2/gen/sdk.gen.ts` contain generated fork-specific methods because the generated SDK does not yet expose neutral extension primitives.
- `packages/opencode/src/session/session.sql.ts` contains `todo`, `tilldone_runner`, and `tilldone_worker` tables because plugins do not have a first-class namespaced persistence API for project/session scoped state.
- `packages/opencode/src/session/diary.ts` stores concise decision history because plugins do not have a generic append/read record surface suitable for their own logs or summaries.
- `packages/opencode/src/cli/cmd/qa-prep.ts` reads git state and recent diary entries to produce a report because plugins do not have enough SDK-accessible project/session context to assemble their own reports cleanly.
- `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` was patched with custom controls, panels, status rendering, navigation, and layout behavior because TUI plugins cannot yet deeply compose into the session UI.
- `packages/opencode/specs/tui-plugins.md` already sketches useful foundations such as `api.client`, `api.state.session.todo`, sidebar slots, dialogs, keybinds, routes, commands, KV, events, and cleanup, but the current hooks are not yet sufficient to move a full aftermarket workflow UI out of core patches.
- `packages/opencode/src/agent/agent.ts` and prompt/tool descriptions encode mode behavior such as Build, Plan, and Task because external clients do not have stable metadata describing agent/mode capabilities.

## Missing SDK surfaces

### 1. Event subscription API

External packages need to react to OpenCode activity without polling internal stores or modifying core services.

Required SDK capability:

```ts
type OpenCodeEvent =
  | { type: "session.created"; sessionID: string; projectID: string; parentSessionID?: string }
  | { type: "session.updated"; sessionID: string; projectID: string }
  | { type: "session.deleted"; sessionID: string; projectID: string }
  | { type: "message.created"; sessionID: string; messageID: string; role: string }
  | { type: "message.updated"; sessionID: string; messageID: string }
  | { type: "agent.started"; sessionID: string; invocationID: string; agentID: string }
  | { type: "agent.completed"; sessionID: string; invocationID: string; agentID: string; summary?: string }
  | { type: "agent.failed"; sessionID: string; invocationID: string; agentID: string; error: string }
  | { type: "agent.cancelled"; sessionID: string; invocationID: string; agentID: string }
  | { type: "tool.started"; sessionID: string; invocationID: string; tool: string }
  | { type: "tool.completed"; sessionID: string; invocationID: string; tool: string }
  | { type: "tool.failed"; sessionID: string; invocationID: string; tool: string; error: string }
  | { type: "workspace.changed"; projectID: string; paths?: string[] }
  | { type: "plugin.event"; pluginID: string; name: string; payload: unknown }
```

Endpoint sketch:

```txt
GET  /events
GET  /project/{projectID}/events
GET  /session/{sessionID}/events
POST /plugin/{pluginID}/events
```

Generated SDK shape:

```ts
client.events.subscribe(...)
client.events.subscribeProject(...)
client.events.subscribeSession(...)
client.events.emitPluginEvent(...)
```

Why this is missing:

- Aftermarket code cannot reliably know when sessions, messages, agent turns, or tool calls changed.
- Aftermarket workflow engines need to maintain their own state from OpenCode activity.
- Polling generated SDK endpoints is insufficient for native-feeling TUI workflows.

What this enables without OpenCode owning the vertical slice:

- A plugin can update its own task model when an agent turn completes.
- A plugin can update a board when messages or tool calls change.
- A plugin can maintain a status dashboard from events.
- A plugin can emit its own domain events without OpenCode knowing the event semantics.

### 2. Agent invocation API

External packages need to start, observe, link, and cancel agent work without creating a workflow runner inside OpenCode core.

Required SDK capability:

```ts
type AgentInvocationRequest = {
  sessionID: string
  agentID?: string
  modeID?: string
  prompt: string
  metadata?: Record<string, unknown>
  parentInvocationID?: string
  linkedRecord?: {
    pluginID: string
    recordID: string
  }
}

type AgentInvocation = {
  id: string
  sessionID: string
  agentID: string
  modeID?: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  startedAt?: number
  completedAt?: number
  summary?: string
  error?: string
  linkedRecord?: {
    pluginID: string
    recordID: string
  }
}
```

Endpoint sketch:

```txt
POST /session/{sessionID}/invocations
GET  /session/{sessionID}/invocations
GET  /session/{sessionID}/invocations/{invocationID}
POST /session/{sessionID}/invocations/{invocationID}/cancel
```

Generated SDK shape:

```ts
client.invocation.create(...)
client.invocation.list(...)
client.invocation.get(...)
client.invocation.cancel(...)
```

Why this is missing:

- The branch needed `tilldone-runner.ts` to supervise agent work directly.
- The branch needed runner-specific routes to expose start/status/stop/abort behavior.
- External code needs the primitive beneath that: invoke an agent, observe it, and cancel it.

What this enables without OpenCode owning the vertical slice:

- A plugin can build its own scheduler.
- A plugin can dispatch agents from records it owns.
- A plugin can link an invocation to a plugin record such as a task, checklist item, approval, test run, or incident.
- A plugin can decide its own concurrency, retry, handoff, and verification rules.

### 3. Plugin-owned persistence API

External packages need durable, namespaced storage for their own models. OpenCode should not define those models.

Required SDK capability:

```ts
type PluginRecordScope =
  | { type: "global" }
  | { type: "project"; projectID: string }
  | { type: "session"; sessionID: string }

type PluginRecord = {
  pluginID: string
  recordID: string
  scope: PluginRecordScope
  type?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  data: unknown
}
```

Endpoint sketch:

```txt
GET    /plugin/{pluginID}/records
POST   /plugin/{pluginID}/records
GET    /plugin/{pluginID}/records/{recordID}
PATCH  /plugin/{pluginID}/records/{recordID}
DELETE /plugin/{pluginID}/records/{recordID}
```

Query requirements:

```txt
scope=global|project|session
projectID=...
sessionID=...
type=...
tag=...
prefix=...
limit=...
cursor=...
```

Generated SDK shape:

```ts
client.plugin.records.list(...)
client.plugin.records.create(...)
client.plugin.records.get(...)
client.plugin.records.update(...)
client.plugin.records.delete(...)
```

Why this is missing:

- The branch added dedicated SQL tables for tasks, runner state, workers, and diary entries.
- Those tables are domain-specific. The SDK gap is durable plugin storage, not OpenCode-owned task or diary schemas.
- Existing plugin KV is useful but not enough if plugins need scoped, queryable records tied to projects or sessions.

What this enables without OpenCode owning the vertical slice:

- A plugin can store tasks, boards, notes, approvals, incidents, runbooks, or QA checklists in its own schema.
- A plugin can query records by project/session/type/tag without OpenCode understanding the data.
- A plugin can migrate its own records independently from OpenCode core migrations.

### 4. TUI extension API

External packages need deeper composition into the TUI so workflow UI can live in plugins instead of patched core files.

Required SDK capability:

```ts
type TuiPanelRegistration = {
  id: string
  pluginID: string
  label: string
  area: "sidebar" | "bottom" | "modal" | "status" | "commandPalette"
  order?: number
  contexts?: Array<"global" | "project" | "session">
}

type TuiActionRegistration = {
  id: string
  pluginID: string
  label: string
  keybind?: string
  contexts?: Array<"global" | "project" | "session" | "message" | "selection">
}
```

Required TUI hooks:

- Register sidebar tabs and panels with ordering.
- Register status-line items.
- Register command palette actions.
- Register contextual actions for sessions, messages, tool calls, files, and plugin records.
- Open plugin-owned dialogs and forms.
- Render plugin-owned views from plugin state.
- Persist plugin layout preferences such as selected tab, sidebar width, filters, and collapsed state.
- Navigate to sessions, messages, files, and plugin routes.
- Receive focus, selection, resize, and route-change events.
- Clean up registrations on plugin unload.

Generated SDK or plugin API shape:

```ts
api.tui.panel.register(...)
api.tui.panel.unregister(...)
api.tui.action.register(...)
api.tui.dialog.open(...)
api.tui.route.navigate(...)
api.tui.layout.get(...)
api.tui.layout.set(...)
```

Why this is missing:

- The branch patched `sidebar.tsx` for controls, custom panels, status feeds, navigation, and layout behavior.
- Existing TUI plugin foundations are directionally correct but not yet deep enough for a full workflow UI to be external.
- Without richer TUI hooks, any serious aftermarket workflow has to modify OpenCode's session UI.

What this enables without OpenCode owning the vertical slice:

- A plugin can render a board, queue, checklist, status feed, or report in the sidebar.
- A plugin can add buttons and keybinds for its own actions.
- A plugin can open its own edit/confirm/assign dialogs.
- A plugin can feel native without OpenCode shipping that workflow.

### 5. Metadata and capability API

External packages need to understand what OpenCode can safely do without reverse-engineering agent names, prompts, or tool descriptions.

Required SDK capability:

```ts
type Capability =
  | "read"
  | "edit"
  | "shell"
  | "plan"
  | "invokeAgent"
  | "cancelInvocation"
  | "useTools"
  | "writeFiles"
  | "modifyWorkspace"

type AgentInfo = {
  id: string
  label: string
  description?: string
  capabilities: Capability[]
  defaultModeID?: string
}

type ModeInfo = {
  id: string
  label: string
  description?: string
  capabilities: Capability[]
  agentID?: string
  default?: boolean
}

type ToolInfo = {
  id: string
  label: string
  description?: string
  permission?: "always" | "ask" | "never"
  capabilities: Capability[]
}
```

Endpoint sketch:

```txt
GET /metadata/agents
GET /metadata/modes
GET /metadata/tools
GET /metadata/capabilities
GET /session/{sessionID}/metadata
GET /project/{projectID}/metadata
```

Generated SDK shape:

```ts
client.metadata.agents(...)
client.metadata.modes(...)
client.metadata.tools(...)
client.metadata.capabilities(...)
client.metadata.session(...)
client.metadata.project(...)
```

Why this is missing:

- The branch encoded Build, Plan, and Task behavior in agents, prompts, and tool descriptions.
- External clients need machine-readable capability data instead of assumptions about names or prompt wording.
- Plugins need to know whether a selected mode can edit, run shell commands, invoke tools, or remain read-only.

What this enables without OpenCode owning the vertical slice:

- A plugin can select a safe mode for its own action.
- A plugin can hide unsafe actions when the current mode cannot perform them.
- A plugin can explain what an action will be allowed to do.
- A plugin can adapt to user configuration and future OpenCode modes.

### 6. Session linking and navigation API

External packages need traceability between plugin records, sessions, messages, and agent invocations.

Required SDK capability:

```ts
type SessionLink = {
  id: string
  pluginID?: string
  projectID: string
  source: {
    type: "session" | "message" | "invocation" | "pluginRecord"
    id: string
  }
  target: {
    type: "session" | "message" | "invocation" | "pluginRecord"
    id: string
  }
  relation: string
  metadata?: Record<string, unknown>
  createdAt: number
}
```

Endpoint sketch:

```txt
POST /session/{sessionID}/children
GET  /session/{sessionID}/children
POST /session/{sessionID}/links
GET  /session/{sessionID}/links
DELETE /session/{sessionID}/links/{linkID}
```

Generated SDK shape:

```ts
client.session.children.create(...)
client.session.children.list(...)
client.session.links.create(...)
client.session.links.list(...)
client.session.links.delete(...)
```

Why this is missing:

- The branch needed child-agent navigation and worker-session linking in the TUI.
- External workflows need to preserve traceability without OpenCode owning the concept of workers or tasks.
- Parent/child sessions exist internally, but plugin-visible linking and navigation are not stable enough.

What this enables without OpenCode owning the vertical slice:

- A plugin can link its own record to the session that produced it.
- A plugin can link an invocation to the message or child session that contains the transcript.
- A plugin can navigate users from its UI to the relevant OpenCode context.

### 7. Command and action API

External packages need to expose behavior through OpenCode command surfaces without patching prompts, tools, or TUI components.

Required SDK capability:

```ts
type CommandRegistration = {
  id: string
  pluginID: string
  label: string
  description?: string
  contexts?: Array<"global" | "project" | "session" | "message" | "selection">
  keybind?: string
}

type CommandInvocation = {
  commandID: string
  context: {
    projectID?: string
    sessionID?: string
    messageID?: string
    selection?: string
  }
  args?: Record<string, unknown>
}
```

Endpoint or plugin API sketch:

```txt
POST /plugin/{pluginID}/commands
GET  /commands
POST /commands/{commandID}/invoke
DELETE /plugin/{pluginID}/commands/{commandID}
```

Generated SDK or plugin API shape:

```ts
api.commands.register(...)
api.commands.unregister(...)
api.commands.invoke(...)
api.commands.list(...)
```

Why this is missing:

- The branch needed custom controls and tool descriptions to expose workflow behavior.
- External workflows should register their own actions instead of injecting behavior into OpenCode core tools.

What this enables without OpenCode owning the vertical slice:

- A plugin can add `Start`, `Stop`, `Assign`, `Review`, `Export`, or any other action for its own records.
- A plugin can bind actions to buttons, keybinds, command palette entries, or external SDK calls.
- OpenCode only hosts the action surface; the plugin owns the behavior.

### 8. Project and workspace context API

External packages need enough context to build reports and make decisions without shelling out or reading internal services.

Required SDK capability:

```ts
type ProjectContext = {
  projectID: string
  root: string
  vcs?: {
    type: "git"
    branch?: string
    baseBranch?: string
    status?: Array<{
      path: string
      state: string
    }>
  }
}

type WorkspaceDiffSummary = {
  projectID: string
  files: Array<{
    path: string
    additions?: number
    deletions?: number
    status?: string
  }>
}
```

Endpoint sketch:

```txt
GET /project/{projectID}/context
GET /project/{projectID}/vcs/status
GET /project/{projectID}/vcs/diff-summary
```

Generated SDK shape:

```ts
client.project.context(...)
client.project.vcsStatus(...)
client.project.vcsDiffSummary(...)
```

Why this is missing:

- The branch needed `qa-prep.ts` to assemble report context from git state and local records.
- The SDK gap is not QA prep. The gap is project/workspace context that plugins can use for their own reports.

What this enables without OpenCode owning the vertical slice:

- A plugin can build a QA report, release summary, incident summary, implementation audit, or handoff note.
- A plugin can combine OpenCode session data with VCS state without relying on private internals.

## Generated SDK requirements

Generated clients should expose neutral integration primitives, not workflow-specific concepts.

Recommended generated namespaces:

```ts
client.events.*
client.invocation.*
client.plugin.records.*
client.metadata.*
client.session.children.*
client.session.links.*
client.project.context.*
client.project.vcs.*
```

Avoid generated names like:

```ts
client.session.taskQueueList(...)
client.session.runnerStart(...)
client.project.diaryAppend(...)
client.session.tilldoneStatus(...)
```

Those names imply OpenCode owns the vertical slice. The SDK should instead expose primitives that an aftermarket workflow can compose.

## TUI/plugin requirements

The TUI plugin API should be strong enough that a workflow plugin can ship entirely outside OpenCode core.

Required capabilities:

- Register panels, tabs, status items, dialogs, and contextual actions.
- Subscribe to OpenCode events from TUI plugin code.
- Read and write plugin-owned records.
- Invoke agents and observe invocation lifecycle.
- Link plugin records to sessions, messages, and invocations.
- Navigate to linked OpenCode resources.
- Persist plugin UI state and layout preferences.
- Cleanly unload plugin UI, commands, keybinds, event listeners, and subscriptions.

Specific gap shown by the branch:

- Custom sidebar panels and controls currently require editing `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`.
- Custom workflow dialogs and status feeds currently need direct integration with OpenCode TUI state.
- Child-session navigation for aftermarket workflows is not a stable plugin-level contract.
- Plugin-owned layout and panel state needs a stable scoped persistence mechanism.

## Example aftermarket workflows enabled

These examples should remain outside OpenCode core. They are listed only to validate that the SDK abstractions are sufficient.

- A task plugin can store task records in plugin persistence, render a task panel in the TUI, invoke agents for selected records, and update its own task state from invocation events.
- A Kanban plugin can store board columns and cards in plugin persistence, render a board panel, and link cards to sessions or messages.
- A workflow-runner plugin can implement its own scheduling policy, worker limits, retries, and cancellation by composing plugin records, agent invocations, events, and child sessions.
- A decision-log plugin can append its own records and render them in a sidebar or report without OpenCode shipping a diary feature.
- A QA plugin can read project context, VCS summaries, session links, and plugin records to generate its own handoff report without OpenCode shipping QA prep.

## Fork-only exclusions

- TillDone naming stays outside OpenCode public APIs.
- Task, runner, Kanban, diary, and QA concepts stay outside OpenCode public APIs unless provided by a plugin.
- Local prompt wording stays outside OpenCode public APIs.
- Local verification policy stays outside OpenCode public APIs.
- Branding, theme, modal polish, and local visual tweaks are not SDK requirements.
- Codex quota and provider error normalization are separate provider/usage SDK topics and should not be bundled into this extensibility proposal.

## Phased adoption plan

1. Add event subscription APIs for sessions, messages, agent invocations, tool calls, workspace changes, and plugin events.
2. Add neutral agent invocation APIs for create/list/get/cancel plus lifecycle events.
3. Add namespaced plugin-owned persistence with global, project, and session scopes.
4. Add metadata APIs for agents, modes, tools, permissions, and capabilities.
5. Add session child/link APIs for traceability and navigation.
6. Deepen TUI plugin APIs for panels, commands, dialogs, status items, layout state, navigation, and cleanup.
7. Add project/workspace context APIs for VCS status and diff summaries.
8. Regenerate SDK clients with neutral namespaces and stable request/response types.
9. Validate the surface by moving fork-specific workflow UI and behavior into an external plugin without adding task, runner, Kanban, diary, or QA concepts to OpenCode core.

## Open questions

- Should plugin persistence support secondary indexes, tags, or only key-prefix listing?
- Should plugin events be persisted, transient, or configurable per event type?
- Should agent invocation metadata be visible to all plugins or only the plugin that created it?
- How should permissions be enforced when a plugin invokes an agent or command?
- Should child sessions be created directly by plugins, or only through agent invocations?
- What compatibility guarantees should TUI panel ids, action ids, and route ids carry?
- Should VCS context APIs be read-only, or should command APIs cover write operations such as staging files?
- Should plugin UI rendering be declarative, component-based, or limited to predefined TUI slots?
- How should plugin-owned records be exported, backed up, or migrated?

## Final checklist

- The proposal asks for SDK extensibility, not OpenCode workflow features.
- OpenCode does not own tasks, Kanban, runners, diary, QA prep, or TillDone concepts.
- Current branch files are cited only as evidence of missing extension surfaces.
- Missing surfaces are framed as events, invocation, persistence, metadata, TUI composition, links, commands, and project context.
- Generated SDK names are neutral and reusable.
- Policy and domain models remain plugin-owned.
