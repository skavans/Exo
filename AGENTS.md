# Exo — Memory Bank

> **⚠️ Memory Bank — read before working, not while.** This file is the project's living memory.
>
> - Read it in full before starting any work.
> - After any notable change (module structure, abstractions, protocol contracts, config file shape,
>   build tooling, dependencies), **update the relevant section in place**: replace outdated content,
>   do not append on top. The file must stay a faithful, current snapshot — not a changelog.
> - If you touch code that a section describes (renames, deletions, moved responsibilities),
>   fix that section in the same pass.
> - Do not pad it: remove obsolete detail instead of explaining it away.

## 1. Concept and Architecture

Exo is a VS Code extension that provides an interface to an autonomous AI agent via the ACP (Agent Communication Protocol).

**Architecture — three-tier stack:**
1. **ACP Agent** (external process): the "brain". Accepts requests, plans tasks, decides which tools to invoke, produces responses. Communicates over `stdio`.
2. **Extension Host** (Node.js/VS Code): a thin proxy. Manages agent process lifecycle, relays messages between agent and UI, implements system handlers (file access, permission flow, VS Code API).
3. **Webview UI** (Preact): sidebar UI. Renders chat, session list, plan widget, tool cards.

**Main data flow:** `User` → `Webview UI` → `Extension Host` → `ACP Agent` → `Extension Host` → `Webview UI` → `User`.

**Key UI behaviors:**

- **Input area:** `@`-mention attaches files (fuzzy-matched); `/`-slash commands advertised by agent. Draft text + attached-file chips persist across view switches and VS Code restarts (textarea is controlled, mirrored to host, restored via dedicated draft message). Images are NOT persisted (deliberate — base64 weight).
- **Auto-Allow Lock:** toggle at the start of `#controls-row` (before mode dropdown). Green/locked (`safe`, default) = standard permission flow; red/open (`auto`) = all `session/request_permission` requests are auto-approved client-side without a card or Diff Editor. Non-persistent (resets on every startup/session load).
- **Attachments:** three channels converge on two in-memory arrays in `MessageInput` (`attachedFiles: string[]`, `images: AttachedImage[]`): `@`-mention, drag-drop of file paths (validated host-side — folders rejected), and drag-drop/paste of images (capability-gated by `canPromptImage`).
- **File/image chips:** editable chips before send; read-only variants render under each user message in history.
- **Session header (tabs):** slim tab bar — title + status dot (idle/running/awaiting), close `×` on hover, horizontal scroll, sticky `⚠ N` pin when awaiting sessions are off-screen. The ACTIVE tab is two-line and ~1.5x wider: title on top, agent label tiny below; inactive tabs are compact one-liners. Right of the tab bar: the context pill (`200k/1m` token counter, tinted static green/yellow/red by fill: <50% / ≤70% / >70%). No separate title row — the session title lives only in its tab. Agent identity = `title || name` + optional `v{version}`.
- **Session navigation:** switching tabs / opening an item from the "+" menu is a pure UI view change — live ACP sessions keep running in the background. Closing a tab (`×`) kills the agent process; the session remains in the recent-sessions menu. Only `deleteSession` removes it permanently (and asks about the worktree if it has uncommitted changes).
- **Parallel sessions:** one tab = one `SessionRuntime` = one agent subprocess with its own `AcpClient`, `cwd` (a git worktree, or the shared workspace root when not a git repo), file cache and streaming/permission/plan state. The webview always renders the active tab; updates (`streamChunk`, `updateMessages`) for non-active runtimes are suppressed and full snapshots are sent by `showChat` on switch.

**Key persistence behavior:**
- Sidebar webview uses `retainContextWhenHidden` (set in `extension.ts`), so switching sidebar views keeps the live webview and Preact state intact.
- Extension Host persists three `workspaceState` entries via debounced saves: `exo.chatUiState` (open tab list `[{sessionId,title,cwd}]` + active session id), `exo.chatDraft` (textarea text + attached file paths — no images), `exo.sessionRegistry` (recent sessions for the "+" menu: id/title/updatedAt/cwd).
- On webview startup (`handleReady`), host restores these and reconnects the ACTIVE tab's agent via `session/load` or `session/resume`; the other persisted tabs stay lazy (header-only) and spawn their agent on first click. Session content comes from agent replay and remains agent-owned.

**Key assistant-message behavior:**
- Assistant markdown turns resolved workspace file paths into clickable pill-style links (`<a class="file-link">`). Bare paths, inline-code paths, and optional `:line`/`:line-endLine` suffixes are supported. Fenced code blocks are never linked. Resolution is a two-step contract: `MessageBubble` extracts candidates → host confirms file exists → re-render with cached links.
- **Math (KaTeX):** crash-safe — `marked-katex-extension` with `throwOnError: false`, a pre-parse `sanitizeInlineMath` pass escapes non-LaTeX `$` spans (e.g. `$HOME`, `${x}`), and `marked.parse` is wrapped in try-catch. Display math `$$...$$` is untouched.
- **Error Boundary:** message list wrapped in Preact `ErrorBoundary`; a malformed chunk shows a fallback with retry instead of white-screening the chat.

## 2. Technology Stack

- **Language:** TypeScript (strict mode).
- **Environment:** VS Code Extension API (`engines.vscode: ^1.73.0`).
- **Communication protocol:** `@agentclientprotocol/sdk` (ACP implementation, stdio transport).
- **Frontend:** Preact (`preact` + `preact/hooks`).
- **Bundler:** `esbuild` (CJS for extension, ESM for webview) via `esbuild.mjs`.
- **Configuration:** YAML (`js-yaml`) — list of available agents in `~/.config/exo/config.yml`.
- **Markdown:** `marked` + `marked-katex-extension` + `katex`.
- **Sanitization:** `dompurify`.
- **Syntax highlighting:** `shiki` (synchronous, pure-JS engine — see Section 4).
- **Validation:** `zod`.
- **Icons:** `@fortawesome/fontawesome-free`.

## 3. Code Structure

### Extension Host (`src/`)
- `extension.ts` — entry point: ensures config file, starts `ConfigWatcher`, creates and registers `ChatViewProvider`, registers commands (`openChat`, `openSessionPicker`→`exo.newSession`, `openConfig`), subscribes to `onDidChangeActiveColorTheme`.
- `config.ts` — configuration model and I/O. `AgentConfig` (`id`/`type:'stdio'`/`command`/`args`/`env`), `ExoConfig` (`agents?[]`). Resolves config dir via `$XDG_CONFIG_HOME` (default `~/.config/exo`), file `config.yml`. `ensureConfigFile()`/`loadConfig()`.
- `configWatcher.ts` — `ConfigWatcher` class (`vscode.Disposable`). `fs.watch` on config path with 300ms debounce; on change reloads config, shows toast, notifies subscribers. `ChatViewProvider` subscribes to re-initialize agents.
- `notify.ts` — **DELETED (was dead code).**
- `acp/` — core of agent communication:
    - `AcpClient.ts` — main ACP client. Manages agent process (spawn/kill) and sessions. Push-model: `onNotification(session.update)` registered once, dispatches all updates (new/load/resume/prompt) to callbacks. Exposes protocol state via getters: `agentCapabilities`, `canLoadSession`, `canResume`, `canClose`, `canList`, `canDelete`, `canPromptImage`, `modes`, `configOptions`, `availableCommands`, `agentInfo`, `connected`, `sessionId`.
    - `handlers/fs.ts` — `handleReadTextFile`/`handleWriteTextFile` via `Files` cache. ACP sends absolute paths; converted to relative for cache. Write = sync after agent's own write + cache refresh + `collectDiagnostics`. Edit-consent is NOT here (it's on the permission layer).
    - `handlers/permission.ts` — `handleRequestPermission`/`resolvePermission`/`cancelAllPermissions`. Shows agent-provided options inline as a tool card (`status: 'awaiting_permission'`); opens Diff Editor for edit-permission; resolves pending promise from webview decision.
    - `handlers/util.ts` — shared utilities: `extractToolText`, `extractDiffContent` (standard ACP `type:'diff'`), `applyToolCallPatch` (upsert `ToolCallInfo` from `ToolCallUpdate`), `extractEditSpec`, `EditSpec`/`ToolCallRegistryContext` types.
- `vendor/opencode/` — vendor-specific fallbacks for agents deviating from the ACP spec. Each submodule is self-contained and never a competitor to the spec'd surface:
    - `plan.ts` — `extractPlanFromToolArgs` (fallback: detects plan by `{todos:[...]}` tool-args shape — opencode doesn't emit the standard `plan` update).
    - `diff.ts` — `isOpenCodeEditArgs`/`restoreOpenCodeEditSpec` (fallback for opencode #37266: `type:'diff'` block omitted for edits inside indented blocks — `trimDiff` makes the patch unapplicable, so opencode sends no diff). Reconstructs EditSpec from edit-tool rawInput, recovering trimmed indentation from the file via `parsePatch` hunk offsets.
    - `index.ts` — re-export.
- `chat/` — UI logic management:
    - `ChatViewProvider.ts` — registry of parallel `SessionRuntime`s + bridge to the webview. Holds `sessions: Map<sessionId, SessionRuntime>`, the active id, the persisted tab list (`exo.chatUiState`) and the recent-sessions registry (`exo.sessionRegistry`). Builds per-runtime ACP callbacks, fs/permission contexts and Diff-Editor wiring. Implements auto-allow, reject-with-response optimistic queuing, plan mapping, config-selector wiring, file-link resolution, dropped-file validation. Registers `exo-diff:` content provider. `switchSession` is lazy: alive runtime → view switch; persisted tab/registry entry → spawn fresh agent (`session/load` or `session/resume`). `exo.newSession` title-bar command now opens the session picker; it's hidden from the command palette (`commandPalette: when:false`).
    - `SessionRuntime.ts` — per-tab runtime state: its own `AcpClient`, `cwd`, `Files` cache, `messages`/`plan`/`toolCalls`/`pendingPermissions`/streaming/throttle state. Exposes `status` (`idle`/`running`/`awaiting`) and a `SessionRuntimeCallbacks` interface (`sendPlan`/`sendMessages`/`sendTabs`/`sendStreamChunk`/`isActive`/…) supplied by ChatViewProvider.
    - `chat/HtmlProvider.ts` — generates webview HTML with CSP (`default-src 'none'`; `style-src`/`font-src`/`img-src data:`; `script-src 'nonce-...'`), nonce, script/style URIs.
    - `chat/handlers/WebviewMessageHandler.ts` — handles incoming webview messages. `handleUserMessage` serializes text/files/images into ACP `ContentBlock[]` (`text` / `resource_link` with `file://` URI / `image` with base64). Also: `searchFiles` (server-side fuzzy over the active session's cwd via fs walk), `openFile`, `resolveFileLinks`, `addDroppedFiles`, `updateDraftState`, permission decisions, session lifecycle (`newSession`, `switchSession`, `closeTab`, `deleteSession`).
    - `chat/configSelectors.ts` — pure functions building UI dropdown selectors from ACP `configOptions` only. Mode comes from `configOptions` with `category:'mode'` (modern ACP); legacy `modes`/`session/set_mode` NOT supported. Flattens grouped options. Hidden: `model_config`.
    - `chat/StreamThrottle.ts` — coalesces text-chunk delivery to UI (rAF-batched).
    - `chat/types.ts` — host-side runtime types: `ToolCallInfo`, `ChatMessage`, `MessageBlock`, `PendingPermission`, `PermissionOptionInfo`.
- `worktree.ts` — git worktree CLI helper. `isGitRepository`, `createWorktree` (local-only `exo/<slug>` branch in a sibling `.exo-worktrees/<slug>` dir), `hasUncommittedChanges`, `removeWorktree` (`--force`), `registerWorktreeInScm` (opens the worktree in VS Code's Source Control via the built-in git extension `api.openRepository` — worktrees live outside the workspace, so they're not auto-detected). Pure `child_process` + one vscode API call — no dependency on the VS Code git extension otherwise.
- `files/Files.ts` — flat line cache per `SessionRuntime` (`read(from,end)`, `replaceFull`). Uses `splitLines`/`resolveAndValidatePath` from `tools/utils.ts`. Legacy revealed-ranges/LRU-eviction removed.
- `tools/` — helpers:
    - `diagnostics.ts` — `collectDiagnostics` (LSP diagnostic polling after write, best-effort).
    - `utils.ts` — `splitLines`, `resolveAndValidatePath` (workspace path security).
    - `types.ts` — `Plan`/`PlanItem` (UI plan model).
- `types/md.d.ts` — type decl for the `EXO_VERSION` esbuild define.

### Webview UI (`webview-ui/src/`)
- `main.tsx` — entry point: `render(<App />, #root)`.
- `App.tsx` — root component. Holds top-level state (`tabs`, `activeSessionId`, `recentSessions`, `menuOpen`, `messages`, `config`, `plan`, `commands`, `agentInfo`, `tokenUsage`/`tokenLimit`, `isAgentRunning`, `autoAllowPermissions`, `promptCapabilities`, `colorThemeName`, `themeVersion`). Routes `postMessage` events. `MessageList` mounted with `key={activeSessionId}` (clean remount on session switch, resetting scroll/ErrorBoundary). Computes `pendingReject` (last awaiting-permission reject option) and passes to `MessageInput`.
- `fuzzy.ts` — shared fzf-style greedy subsequence matcher. Returns `{ score, indices }` with consecutive-match and boundary bonuses (`/._-`, space, start). Used by both `@`-file and `/`-command pickers (client only highlights for files; filters+ranks for commands).
- `shiki.ts` — synchronous Shiki highlighter (`createHighlighterCoreSync` + pure-JS engine, no oniguruma wasm). ~22 themes, ~30 languages statically imported. `resolveThemeId(name, kind)` maps VS Code theme name → bundled Shiki id; `setTheme(id)` bumps `themeVersion` (drives re-parse of already-rendered blocks).
- `vscode.ts` — typing and `postMessage` wrapper.
- `types.ts` — UI-side data contracts: `ChatMessage`, `MessageBlock`, `ToolCallInfo`, `AttachedImage`, `Plan`/`PlanItem`, `AcpSessionInfo`, `TabInfo`/`TabStatus`, `RecentSessionInfo`, `CommandInfo`, `AgentInfo`, `ConfigState`/`ConfigSelector`/`ConfigOption`, `MODE_COLORS` (ANSI-terminal token references), helpers (`formatAgentLabel`, `formatCompactNumber`, `modeColor`, `useActiveModeColor`).
- `components/`:
    - `TabBar.tsx` — session tab strip (title + status dot, close `×`, horizontal scroll, sticky awaiting-pin). Click = `switchSession`; close = `closeTab`.
    - `SessionPicker.tsx` — the "+" dropdown replacing the old session-list screen: "New session" entry (with agent label) on top, then recent sessions (title, relative time, delete on hover, open-tab marker). Closes on ESC / outside click.
    - `MessageList.tsx` — conversation list. Owns sticky autoscroll contract (single `stickToBottom` source of truth; rAF-coalesced; echo-suppression window for programmatic vs user scroll). Wraps content in `ErrorBoundary`. Remounted on session switch via `key`.
    - `MessageBubble.tsx` — message rendering. Detects path-like text in assistant markdown, debounces host resolution while streaming, renders `<a class="file-link">` pills. Exports `sanitizeInlineMath` (used here only, after `PlanCard` removal). Registers marked `renderer.code` → Shiki `highlightCode`.
    - `ErrorBoundary.tsx` — Preact class boundary with fallback + retry.
    - `MessageInput.tsx` — input with unified `@`/`/` popup picker (single state machine, scans backwards from cursor for nearest unbroken trigger), config selectors, fuzzy highlighting, controlled textarea mirrored to host. Drag-drop (files + images), paste (images), image chips, file chips. Auto-Allow Lock toggle. Reject-with-response input.
    - `SessionList.tsx` — agent session list with header (inline title + agent label), relative-time, delete buttons, empty state.
    - `ConfigRequired.tsx` — onboarding screen shown when `config.yml` has no agents. Explains that Exo needs an ACP agent, shows the config path, offers an "Open config.yml" button (sends `openConfig`).
    - `TodoList.tsx` — collapsible plan widget with progress bar, step icons (✓/●/○), current-step highlight.
    - `PlanCard.tsx` — **DELETED (was dead code, replaced by `TodoList`).**
    - `SessionList.tsx` — **DELETED (replaced by `SessionPicker` + `TabBar`).**

### Styles (`webview-ui/src/styles/`)
`styles.css` is the index (`@import`s). Tokens in `tokens.css` map VS Code theme variables to semantic `--ct-*` aliases; component CSS references only `--ct-*`. Per-component files: `base.css`, `messages.css`, `markdown.css`, `reasoning.css`, `tool-calls.css`, `input.css`, `controls.css`, `plan.css`, `tabs.css`, `menu.css`, `header.css`. KaTeX CSS imported from package. `context-modal.css` — **DELETED (was dead code).** `session-list.css` — **DELETED (replaced by `tabs.css`/`menu.css`).**

### Bundler / Config
- `esbuild.mjs` — builds extension (`out/extension.js`, CJS) and webview (`out/webview.js` + `out/webview.css`, ESM). `--watch` and `--production` flags.
- `eslint.config.mjs` — ESLint flat config (warning-heavy: `curly`, `eqeqeq`).
- `tsconfig.json` / `tsconfig.webview.json` — separate TS configs for host and webview.

## 4. Key Abstractions

- **ACP Session Lifecycle:** Sessions created (`session/new`), loaded (`session/load` with replay), or resumed (`session/resume` without replay). State fully agent-owned. Push-model: a single `onNotification(session.update)` handler dispatches all update types to callbacks; no ActiveSession/nextUpdate loop.
- **Parallel Session Model:** one tab = one `SessionRuntime` = one agent subprocess (own session). All "session" state (`messages`, `taskCalls`, `permissions`, `Files`, streaming) lives on the runtime; `ChatViewProvider` is a registry. This is pure host orchestration on top of ACP — the ACP protocol is untouched.
- **Worktree-per-session:** new sessions spawn their agent with a fresh `git worktree` cwd (local branch `exo/<slug>`, never pushed). Non-git workspaces fall back to the shared workspace root. `git.detectWorktrees` (on by default in VS Code) picks worktrees up in the SCM view automatically; the extension never opens `vscode.openFolder`.
- **Three-level Session Persistence:** shortest-lived continuity (tab switches) via `retainContextWhenHidden`; longer-lived (VS Code restarts) via `workspaceState` storing only client-owned state (open tab list + active id + draft). Message history and plan remain agent-owned, restored via ACP replay. The recent-sessions menu is a local registry (`exo.sessionRegistry`), not `session/list` — each agent only knows its own sessions. Three separate debounced keys: `exo.chatUiState`, `exo.chatDraft`, `exo.sessionRegistry`.
- **Edit Review Flow:** For edit-permission requests, client opens VS Code Diff Editor (`exo-diff:` scheme). Diff content (original/proposed) comes from the standard ACP `type:'diff'` content block within `requestPermission.toolCall.content`. Vendor `vendor/opencode/diff.ts` recovers it if opencode omitted it (issue #37266): EditSpec rebuilt from edit rawInput, indentation restored from the file. No unified-diff/args-based fallback beyond that vendor case.
- **Permission System (Zero Trust):** Agent requests permission via `session/request_permission` before dangerous actions. Client renders options inline as a tool card; user decision returns to agent via `permissionDecision` postMessage → `resolvePermission` → pending promise.
- **Auto-Allow Policy Override:** Client-side boolean `ChatViewProvider._autoAllowPermissions` (default `false`, non-persistent). When `true`, `handleRequestPermission` short-circuits: picks first `allow_once` (fallback `allow_always`), marks tool call `success`, skips Diff Editor, returns immediately. If no allow-option exists, falls through to manual flow.
- **Reject-with-Response (Optimistic Queued Follow-up):** Rejecting a permission request with follow-up text renders the message immediately as `isQueued: true` (dimmed, dashed border, spinner). `consumePendingFollowUp()` runs in the `finally` block BEFORE `agentRunning=false` is posted, so the follow-up dispatches as a new turn without lock/unlock flicker. The follow-up call passes `{ preQueued: true }`, flipping `isQueued→false` on the existing message instead of pushing a duplicate.
- **Plan-driven Execution:** Client supports both standard ACP `plan` updates AND a vendor-specific fallback (`extractPlanFromToolArgs`) detecting `{todos:[{content,status,priority}]}` shape in tool args. Standard plan takes priority; both map to UI `Plan` (`completed`→`done`).
- **Unified Trigger Picker:** Single popup state machine in `MessageInput` serves both `@`-file and `/`-command. Active trigger determined by scanning backwards from cursor for nearest unbroken `@` or `/` token; only one picker active at a time.
- **Fuzzy Matching:** `webview-ui/src/fuzzy.ts` — greedy subsequence (fzf-style) with consecutive and boundary bonuses. `indices` drive `<mark class="fuzzy-hit">` highlighting. Server-side ranking authoritative for files; client both filters/ranks and highlights for commands.
- **Sticky Autoscroll Contract:** `MessageList` treats autoscroll as explicit sticky mode. Single `stickToBottom(behavior)` writes directly to `el.scrollTo`; `scrollIntoView` avoided (walks ancestors). Programmatic vs user scroll distinguished via echo-suppression window + distance threshold. `CSS scroll-behavior: smooth` removed from `#messages` (streaming jank); smooth only on explicit user jumps.
- **Global Thin Scrollbar:** Universal `* { scrollbar-width: thin }` + `::-webkit-scrollbar` in `base.css`. No per-component scrollbar overrides.
- **Resolved File-Link Rendering:** Two-step contract — extract candidates → host resolution → re-render with cached pills. Bare text and inline code may link; fenced blocks never. Pill = `<a class="file-link">` with leading `fa-file-lines` icon, monospace, nowrap, link-tinted background via `color-mix`.
- **Crash-Safe Math Sanitization:** Three-layer guard — `sanitizeInlineMath` (escapes non-LaTeX `$` spans) + `markedKatex({ throwOnError: false })` + try-catch around `marked.parse`.
- **Tab Close vs Delete:** closing a tab kills the agent process but the session stays in the recent menu (and its worktree stays). Deleting from the menu is the permanent action — it also removes the worktree (with a confirm prompt when it has uncommitted changes). Deleting a session with no live runtime spawns a temporary agent, issues `session/delete`, and kills it (optimistic UI).
- **Attachment Channel Convergence:** `@`-mention, drag-drop paths, and drag-drop/paste images converge on `attachedFiles`/`images` arrays. On send → ACP `ContentBlock[]`: files → `resource_link` (absolute `file://` URI + relative `name`), images → `image` (base64 `data`). Agent cannot distinguish input channel.
- **Image Capability Gating:** `AcpClient.canPromptImage` gates image input end-to-end. Host pushes to webview as `updatePromptCapabilities`; webview forwards to `MessageInput` as `canPromptImage`. When `false`, dropped/pasted images rejected with transient notice; drag overlay text changes. Re-checked on every connect and `showChat`.
- **Theme Token System:** `tokens.css` maps every VS Code theme variable to semantic `--ct-*` aliases; component CSS references only `--ct-*`, never `--vscode-*` directly. Categories: text (primary/emphasis/secondary/muted), link, dropdown, button, bg, code, diff, overlay, shadow, icon. Mode colors (`MODE_COLORS`) reference `--vscode-terminal-ansi*`, pushed as `--ct-mode` CSS variable on `.chat-view`. High Contrast explicitly supported.
- **Syntax Highlighting (Shiki):** Synchronous at module load (`createHighlighterCoreSync` + pure-JS regex engine — no wasm). Slots into `marked.parse` pipeline via `renderer.code`. Theme tracking: host reads `workbench.colorTheme`, pushes name; webview resolves to bundled Shiki id via `THEME_NAME_MAP`, falls back by kind to `dark-plus`/`light-plus`. `themeVersion` bump re-parses rendered blocks. Unknown langs → escaped plaintext.
- **Agent Identity Header Pattern:** Agent identity is session-level metadata, not part of session title. Host pushes `agentInfo` separately; webview renders as subdued secondary label.

## 5. Data Models and Contracts

- **Configuration (`config.yml` / `AgentConfig` / `ExoConfig`):**
    - `AgentConfig`: `id` (string), `type` (`'stdio'`), `command` (string), `args?` (string[]), `env?` (Record<string,string>).
    - `ExoConfig`: `{ agents?: AgentConfig[], [key]: unknown }`.
    - Location: `$XDG_CONFIG_HOME/exo/config.yml` (default `~/.config/exo/config.yml`).

- **`CommandInfo` / ACP `AvailableCommand`:**
    - `name` (string): without leading `/`.
    - `description` (string): shown in picker.
    - `input?` (`{ hint: string } | null`): `input.hint` becomes textarea placeholder after command selection.

- **`AgentInfo`:**
    - `name` (string): required ACP agent name.
    - `title?` (string): optional display title.
    - `version?` (string): optional, used in header labels as `v{version}`.

- **`AttachedImage` (UI-side):**
    - `id` (string): ephemeral client id (React key + removal).
    - `mimeType` (string): e.g. `image/png`.
    - `data` (string): base64 **without** `data:...;base64,` prefix.
    - `name?` (string): optional original filename.

- **`ToolCallInfo` (tool-card model, defined in both `src/chat/types.ts` and `webview-ui/src/types.ts`):**
    - `toolCallId?` (string): ACP call ID.
    - `status`: `pending` | `success` | `error` | `awaiting_permission` | `rejected` | `cancelled`.
    - `summary` (string): short action description (from ACP `title`).
    - `args` (Record<string,unknown>): call arguments (from ACP `rawInput`).
    - `result?` (string): tool output text.
    - `kind?` (string): ACP tool kind (`read|edit|delete|move|search|execute|think|fetch|switch_mode|other`).
    - `locations?`: ACP follow-along paths/ranges.
    - `diffContent?`: `{ path: string, oldText?: string|null, newText: string }` — for Diff Editor.
    - `permissionRequestId?` / `permissionOptions?`: for permission flow.

- **`PermissionOptionInfo`:** `optionId`, `name`, `kind` (`'allow_once'|'allow_always'|'reject_once'|'reject_always'`).

- **`ChatMessage`:**
    - `role`: `user` | `assistant`.
    - `blocks`: `MessageBlock[]` — `{ type:'text', content }` | `{ type:'activity', toolCalls, reasoning, reasoningPhases, reasoningActive? }`.
    - `isError?`, `isStreaming?`, `isQueued?` (user-only, optimistic reject-follow-up).
    - `attachedFiles?` (string[], user-only): relative/absolute paths.
    - `images?` (AttachedImage[], user-only).
    - `_lastChunkKind?` (host runtime-only, not serialized): tracks last chunk type for reasoningPhases counter.

- **`Plan` / `PlanItem`:** `id`, `title`, `description`, `status` (`'pending'|'in_progress'|'done'`).

- **`PendingPermission`:** `requestId`, `toolCallId`, `resolve(response)`, `diffKey?` (Diff Editor cleanup).

- **ACP Protocol contracts:**
    - **Requests (Client → Agent):** `agent/initialize` (handshake/capabilities); `agent/session/new|load|resume|close|delete|list`; `agent/session/prompt` (slash commands sent as plain text — agent parses `/`); `agent/session/setConfigOption`; `agent/authenticate` (if `authMethods` present).
    - **Notifications (Agent → Client) via `session/update`:** `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `plan` (full replace), `usage_update`, `current_mode_update`, `available_commands_update`, `session_info_update`, `config_option_update`. (`plan_update`/`plan_removed` are experimental and ignored.)
    - **Handlers (Agent → Client → Host):** `client/fs/readTextFile|writeTextFile`, `client/session/requestPermission`.

- **Webview ↔ Host postMessage contracts (internal, non-ACP):**
    - **UI → Host:** `ready`; `sendMessage` (`text`, `attachedFiles?`, `images?`); `selectConfigOption` (`configId`,`value`); `toggleAutoAllowPermissions`; `permissionDecision` (`requestId`, `optionId`|`cancelled`, `followUpText?`); `stopGeneration`; `newSession`; `switchSession` (`sessionId`); `closeTab` (`sessionId`); `deleteSession` (`sessionId`); `searchFiles` (`query`); `updateDraftState` (`text`,`attachedFiles`); `openFile` (`path`,`line?`,`endLine?`); `resolveFileLinks` (`requestId`,`paths`); `addDroppedFiles` (`paths`); `openConfig`.
    - **Host → UI:** `updateMessages`; `updateConfig`; `updatePlan`; `updateCommands`; `updateTabs` (`tabs: [{sessionId,title,status}]`, `activeSessionId`); `updateSessions` (recent list: `[{sessionId,title,updatedAt,active}]`); `showChat` (`sessionId`,`messages`,`plan`,`title`); `showEmpty`; `showSessionPicker`; `showConfigRequired`; `sessionTitleUpdate` (`sessionId`,`title`) — sent by host, unused by UI (title lives in tabs); `updateTokenUsage` (`usage`,`tokenLimit?`); `updateAgentRunning` (`running`); `searchFilesResult`; `streamChunk` (`sessionId`,`index`,`blocks`); `updateAutoAllowPermissions` (`value`); `restoreDraft` (`text`,`attachedFiles`); `updateAgentInfo` (`agentInfo`); `updatePromptCapabilities` (`{ image }`); `updateColorTheme` (`{ name }`); `resolveFileLinksResult` (`requestId`,`resolved`); `addDroppedFilesResult` (`files`,`rejected`).

## 6. Development and Operations

- **Build commands** (no generic `build` script):
    - `npm run compile` — one-shot esbuild of extension (`out/extension.js`, CJS) + webview (`out/webview.js`/`out/webview.css`, ESM).
    - `npm run watch` — esbuild watch mode.
    - `npm run lint` — ESLint over `src/` only (webview not linted). Config is warning-heavy (`curly`, `eqeqeq`); new code should avoid triggering.
    - `npm run install-local` — builds production, packages `.vsix`, installs into VS Code (no version bump).
    - `npm run release -- [patch|minor|major]` — bumps version (default `patch`), builds production, packages `.vsix`, commits `release: vX.Y.Z`, tags `vX.Y.Z`, pushes commit+tag to `origin` and `github` remotes, creates GitHub Release with auto-generated notes and attached artifact (requires `gh` CLI authenticated). Artifact is `exo-<версия>.vsix`.

<!-- This section is intentionally minimal during initialization. Populate through real project work. -->
