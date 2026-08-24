import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfigPath } from '../config';
import type { ConfigWatcher } from '../configWatcher';
import type { ChatMessage, PendingPermission, ToolCallInfo } from './types';
import type { Plan } from '../tools/types';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { HtmlProvider } from './HtmlProvider';
import { AcpClient, type AcpClientCallbacks } from '../acp/AcpClient';
import { SessionRuntime, type SessionRuntimeCallbacks } from './SessionRuntime';
import { buildConfigSelectors } from './configSelectors';
import { handleReadTextFile, handleWriteTextFile, type FsHandlerContext } from '../acp/handlers/fs';
import {
	handleRequestPermission,
	resolvePermission as resolvePermissionImpl,
	cancelAllPermissions,
	type PermissionHandlerContext,
} from '../acp/handlers/permission';
import { applyToolCallPatch, createToolCallInfo, type EditSpec } from '../acp/handlers/util';
import {
	createWorktree,
	ensureGitExclude,
	isGitRepository,
	refreshScmStatus,
	registerWorktreeInScm,
	removeWorktree,
	resolveMainBranch,
	sessionHasUncommittedWork,
} from '../worktree';
import {
	WorkspaceFolderSwitcher,
	enterManagedWorkspace,
	getPinnedRoot,
	isExoWorktreePath,
	managedWorkspacePath,
	pinRoot,
} from '../workspaceMode';
import { StreamThrottle } from './StreamThrottle';
import type { AvailableCommand, PlanEntry } from '@agentclientprotocol/sdk';

/** One persisted tab: the client-owned tab id (`exo-<N>`) + the agent's ACP session id. */
interface TabEntry {
	/** Client-owned tab id — `exo-<N>`, derived from the ordinal number. Never changes. */
	tabId: string;
	/** Agent-owned ACP session id — used for session/load|resume|close|delete. */
	agentSessionId: string;
	title: string;
	cwd: string;
	number: number;
}

interface PersistedChatUiState {
	tabs: TabEntry[];
	activeSessionId: string | null;
}

/**
 * Per-agent remembered config setup, keyed by mode: which (model, effort) was
 * last selected with each mode. The agent always picks the default MODE itself
 * (on session creation and on load/resume); the remembered (model, effort) is
 * applied to whatever mode ends up active — both on a fresh session and when
 * the user switches modes by hand.
 * Persisted in globalState under `exo.lastSetupByMode`.
 */
interface LastSetupByMode {
	[agentId: string]: Record<string, { model: string; effort: string }>;
}

/** globalState key for `LastSetupByMode`. */
const LAST_SETUP_BY_MODE_KEY = 'exo.lastSetupByMode';

interface DraftState {
	text: string;
}

/** Session registry entry (the "recent sessions" menu source). Persistent. Keyed by tab id. */
interface SessionRegistryEntry {
	/** Client-owned tab id (`exo-<N>`). */
	tabId: string;
	/** Agent-owned ACP session id — used for session/load|resume|close|delete. */
	agentSessionId: string;
	title: string;
	updatedAt: number;
	cwd: string;
}

/**
 * In-flight session operation (create/load) shown to the user as a loading tab
 * until the real runtime exists. Never persisted; a restart simply drops it.
 */
interface PendingSession {
	/** Temporary id (`pending-<n>`) — not an agent session id. */
	id: string;
	title: string;
	mode: 'new' | 'load';
	/**
	 * Agent session id this op loads (`load`), null for `new`. If the resolved
	 * runtime ends up with a DIFFERENT agent session (load fell back to `new`),
	 * only `agentSessionId` changes — the tab id (`exo-<N>`) never does, so the
	 * tab/registry/draft entries need no shuffling.
	 */
	agentSessionId: string | null;
	/** Ordinal session number — already assigned at pending time, carried to the runtime. */
	number: number;
	/**
	 * cwd chosen for this session (worktree path for git repos, shared root
	 * otherwise). Set in `completeNewSession` right after the worktree exists,
	 * so a cancelled/failed create can remove the orphan worktree.
	 */
	cwd: string | null;
	/** Session to restore the active view to if this pending operation fails. */
	prevActiveId: string | null;
	/** Set when the user closes the pending tab — resolve/fail become no-ops. */
	cancelled: boolean;
	/**
	 * Messages typed while the `new` session is still spawning. Rendered
	 * optimistically as `isQueued` and dispatched once the runtime exists.
	 * Only ever populated for `mode === 'new'`.
	 */
	queuedMessages: ChatMessage[];
}

const MAX_RECENT_SESSIONS = 10;

/** Poll interval for discovering the agent-generated session title via `session/list`. */
const TITLE_POLL_INTERVAL_MS = 5000;
/** Give up discovering a real title after this long (agent may not title sessions). */
const TITLE_POLL_MAX_MS = 300000;
/** Client-side fallback title: first message line, clamped. */
const FALLBACK_TITLE_MAX_LEN = 48;
/** Default agent titles (e.g. opencode's) — not real, don't read them back. */
const DEFAULT_TITLE_PATTERN = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * User-message sent by the "commit & merge to main" button. The agent commits
 * its work and merges the repository's `main` branch INTO its own branch
 * (resolving any conflicts in its own worktree), so that a host-side
 * `--ff-only` merge of the branch into main afterwards can never conflict.
 * Commit messages are written in English, always.
 */
function buildCommitAndMergePrompt(mainBranch: string): string {
	return (
		'Commit all your changes with a descriptive commit message written in English. ' +
		`Then merge the repository's \`${mainBranch}\` branch into your current branch (run \`git merge --no-edit ${mainBranch}\`). ` +
		`If the merge reports conflicts, resolve them by editing the files, staging them and completing the merge with a commit — your branch must end up containing all of ${mainBranch}. ` +
		'Do not merge your branch into main and do not switch branches — Exo performs that final merge.'
	);
}

/**
 * Terminal ANSI color keys, ordered exactly like `MODE_COLORS` in
 * `webview-ui/src/types.ts` — the two must stay in sync (separate bundles,
 * different value forms: ThemeColor strings here, CSS vars in the webview).
 */
const SESSION_COLOR_KEYS = [
	'terminal.ansiBlue',
	'terminal.ansiYellow',
	'terminal.ansiCyan',
	'terminal.ansiMagenta',
	'terminal.ansiGreen',
	'terminal.ansiRed',
	'terminal.ansiBrightYellow',
	'terminal.ansiBrightBlue',
	'terminal.ansiBrightMagenta',
	'terminal.ansiBrightCyan',
];

/** Per-session color index 0..9, derived from the ordinal number so the header
 *  badge and the terminal tab always share the same color. */
function sessionColorNumber(number: number): number {
	return Math.max(0, number - 1) % SESSION_COLOR_KEYS.length;
}

/** Client-owned tab id: `exo-<N>`, derived from the ordinal number (matches the worktree/terminal name). */
function tabIdForNumber(number: number): string {
	return `exo-${number}`;
}

/** Ordinal number back out of an `exo-<N>` tab id (0 when it isn't one). */
function sessionNumberFromTabId(tabId: string): number {
	const n = Number(tabId.replace(/^exo-/, ''));
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True when `id` is a valid client-owned tab id (`exo-<N>`, N > 0). */
function isValidTabId(id: unknown): id is string {
	return typeof id === 'string' && /^exo-[1-9]\d*$/.test(id);
}

/** Terminal label: `exo-<N>` — the session's ordinal number (matches the header badge and tab id). */
function formatTerminalName(number: number): string {
	return tabIdForNumber(number);
}

/**
 * ChatViewProvider — registry of parallel session runtimes.
 *
 * One tab = one `SessionRuntime` = one agent subprocess with its own cwd
 * (usually a git worktree). Switching tabs is a pure view change: runtimes
 * keep running while hidden. Closed tabs return to the recent-sessions menu;
 * only `deleteSession` permanently removes a session (and its worktree).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'exo.chatView';

	public view?: vscode.WebviewView;

	/** Shared content store for the `exo-diff:` scheme (edit-permission Diff Editor). */
	public readonly diffContents = new Map<string, string>();

	/** Live session runtimes, keyed by session id. */
	public readonly sessions = new Map<string, SessionRuntime>();

	private _activeSessionId: string | null = null;

	/** Open tabs (persistent). Order matters (left→right). */
	private _tabList: TabEntry[] = [];

	/**
	 * Next ordinal session number to hand out — a monotonic high-water mark.
	 * Freed numbers are reused first (see `_freeNumbers`), so the counter itself
	 * only grows; it is re-seeded from persisted state on restore.
	 */
	private _nextSessionNumber = 1;

	/**
	 * Session numbers whose owning tab/registry/draft/runtime/terminal/worktree
	 * are all gone. Reused by new sessions before `_nextSessionNumber` is
	 * bumped. A number enters this set ONLY after its full teardown, so the
	 * client-owned tab id `exo-<N>` can never collide with a live entity.
	 */
	private _freeNumbers = new Set<number>();

	/** Recent-sessions registry (persistent) — drives the "+" menu. */
	private _sessionRegistry = new Map<string, SessionRegistryEntry>();

	/** In-flight create/load operations (loading tabs). Not persisted. */
	private _pendingSessions = new Map<string, PendingSession>();
	private _pendingCounter = 0;

	private _autoAllowPermissions = false;
	private _readyHandled = false;

	/**
	 * True while a config setup is being applied (mode switch cascade or the
	 * remembered (model, effort) restore on session create). While set, agent
	 * `config_option_update` pushes skip their `sendConfig` — only the final
	 * state is broadcast, so the selectors never flicker through intermediate
	 * values.
	 */
	private _applyingConfig = false;

	/** Per-session input drafts, keyed by session id (or `pending-<n>` while spawning). */
	private _drafts = new Map<string, DraftState>();

	/** Per-session worktree terminals, keyed by session id. */
	private readonly _sessionTerminals = new Map<string, vscode.Terminal>();
	private _persistUiTimer: ReturnType<typeof setTimeout> | null = null;
	private _persistRegistryTimer: ReturnType<typeof setTimeout> | null = null;
	private _persistRegistryDirty = false;

	private readonly _messageHandler: WebviewMessageHandler;
	private readonly _htmlProvider: HtmlProvider;
	private readonly _extensionUri: vscode.Uri;

	/** Pinned repo root (globalState). The Explorer may follow sessions — this must not. */
	private _workspaceRoot: string;

	/** Serialized, coalescing driver for the Explorer-follow folder switch. */
	private readonly _workspaceSwitcher = new WorkspaceFolderSwitcher();

	constructor(
		extensionUri: vscode.Uri,
		public readonly configWatcher: ConfigWatcher,
		public readonly globalState: vscode.Memento,
		private readonly workspaceState: vscode.Memento,
	) {
		this._extensionUri = extensionUri;
		this._messageHandler = new WebviewMessageHandler(this);
		this._htmlProvider = new HtmlProvider(extensionUri);
		this._workspaceRoot = this.guessWorkspaceRoot();
	}

	/**
	 * Best-effort root before mementos are loaded (constructor). Correct for a
	 * single-folder window; may be wrong for a managed workspace reopened on a
	 * session worktree — re-resolved in `handleReady` from the pinned root.
	 */
	private guessWorkspaceRoot(): string {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			const first = folders[0].uri.fsPath;
			if (!isExoWorktreePath(first)) {
				return first;
			}
		}
		return process.cwd();
	}

	/**
	 * Resolve the repo root for session cwds. Adopts the current first
	 * workspace folder as the root — EXCEPT when it is a session worktree (a
	 * legacy managed workspace could open with `folders[0]` = a worktree), in
	 * which case the pinned root (set during the one-time migration, before the
	 * reload) is used. This keeps the pin from leaking across projects. Requires
	 * loaded mementos.
	 */
	private resolveWorkspaceRoot(): string {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			const first = folders[0].uri.fsPath;
			if (!isExoWorktreePath(first)) {
				pinRoot(this.globalState, first);
				return first;
			}
		}
		return getPinnedRoot(this.globalState) ?? process.cwd();
	}

	public register(context: vscode.ExtensionContext): void {
		const contents = this.diffContents;
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider('exo-diff', {
				provideTextDocumentContent(uri: vscode.Uri): string {
					return contents.get(uri.toString()) ?? '';
				},
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this._workspaceSwitcher.onWorkspaceFoldersChanged()),
			vscode.window.onDidCloseTerminal((terminal) => {
				for (const [sessionId, t] of this._sessionTerminals) {
					if (t === terminal) {
						this._sessionTerminals.delete(sessionId);
					}
				}
			}),
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};
		webviewView.webview.html = this._htmlProvider.getHtmlForWebview(webviewView.webview);

		this.configWatcher.onConfigChange(() => {
			this.sendConfig();
			if (this.configWatcher.config.agents?.length) {
				void this.handleReady();
			} else {
				this.showConfigRequired();
			}
		});

		webviewView.webview.onDidReceiveMessage((message) => {
			this._messageHandler.handleMessage(message);
		});
	}

	// ------------------------------------------------------------------
	// Active session (proxy access for WebviewMessageHandler / StreamThrottle)
	// ------------------------------------------------------------------

	get session(): SessionRuntime | null {
		if (!this._activeSessionId) {
			return null;
		}
		return this.sessions.get(this._activeSessionId) ?? null;
	}

	get activeSessionId(): string | null {
		return this._activeSessionId;
	}

	/** cwd of the active session (fallback: pinned workspace root). */
	get cwd(): string {
		return this.session?.cwd ?? this._workspaceRoot;
	}

	get messages(): ChatMessage[] {
		const runtime = this.session;
		if (runtime) {
			return runtime.messages;
		}
		return this.activePendingNewSession?.queuedMessages ?? [];
	}

	/** The active session when it's an in-flight `new` op (optimistic input target). */
	get activePendingNewSession(): PendingSession | null {
		const id = this._activeSessionId;
		if (!id) {
			return null;
		}
		const pending = this._pendingSessions.get(id);
		return pending && pending.mode === 'new' ? pending : null;
	}

	get streamingIndex(): number | null {
		return this.session?.streamingIndex ?? null;
	}

	set streamingIndex(v: number | null) {
		if (this.session) this.session.streamingIndex = v;
	}

	get streamThrottle(): StreamThrottle | null {
		return this.session?.streamThrottle ?? null;
	}

	get toolCallInfos(): Map<string, ToolCallInfo> {
		return this.session?.toolCallInfos ?? new Map();
	}

	get isStreaming(): boolean {
		return this.session?.isStreaming ?? false;
	}

	set isStreaming(v: boolean) {
		if (this.session) this.session.isStreaming = v;
	}

	get agentRunning(): boolean {
		return this.session?.agentRunning ?? false;
	}

	set agentRunning(v: boolean) {
		if (this.session) this.session.agentRunning = v;
	}

	get stopped(): boolean {
		return this.session?.stopped ?? false;
	}

	set stopped(v: boolean) {
		if (this.session) this.session.stopped = v;
	}

	get pendingPermissions(): Map<string, PendingPermission> {
		return this.session?.pendingPermissions ?? new Map();
	}

	get currentPlan(): Plan | null {
		return this.session?.currentPlan ?? null;
	}

	get currentUsage(): { used: number; size: number } | null {
		return this.session?.currentUsage ?? null;
	}

	get availableCommands(): AvailableCommand[] {
		return this.session?.availableCommands ?? [];
	}

	get mode(): string {
		return this.session?.mode ?? '';
	}

	set mode(v: string) {
		if (this.session) this.session.mode = v;
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	/** Palette command: focus + open the session picker (new/recent menu). */
	public async openSessionPicker(): Promise<void> {
		await vscode.commands.executeCommand('exo.chatView.focus');
		this.sendSessionList();
		this.view?.webview.postMessage({ type: 'showSessionPicker' });
	}

	/**
	 * True when the window must be opened as the managed Exo workspace before
	 * any session UI is shown: a single-folder, trusted, git window that is not
	 * already our `.code-workspace`. Deliberately NOT dismissible — the webview
	 * renders a blocking screen with a single "switch" action (see
	 * WorkspaceModeRequired). Non-git folders, user-owned multi-root workspaces
	 * and untrusted windows are structurally exempt (nothing to follow / cannot
	 * be made trustworthy).
	 */
	public async isWorkspaceModeRequired(): Promise<boolean> {
		try {
			// A window still open on OUR managed `.code-workspace` file whose file
			// was deleted is broken (no folders, "NO FOLDER OPENED"). Route it
			// through the blocking screen — its button recreates the file and
			// reloads the window.
			const wsFile = vscode.workspace.workspaceFile;
			if (wsFile && wsFile.scheme === 'file' && wsFile.fsPath === managedWorkspacePath(this._workspaceRoot)) {
				try {
					await fs.promises.stat(wsFile.fsPath);
				} catch {
					return true;
				}
			}
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length !== 1 || wsFile) {
				return false; // empty window or already a workspace (ours or the user's)
			}
			if (!vscode.workspace.isTrusted) {
				return false;
			}
			if (folders[0].uri.fsPath !== this._workspaceRoot) {
				return false;
			}
			return await isGitRepository(this._workspaceRoot);
		} catch (err) {
			console.error('[Exo] workspace-mode check failed:', err);
			return false;
		}
	}

	/** The webview must render the blocking workspace-mode screen (no chat UI). */
	private showWorkspaceModeRequired(): void {
		this._activeSessionId = null;
		this.persistUiStateSoon();
		this.view?.webview.postMessage({ type: 'showWorkspaceModeRequired' });
	}

	/** Blocking-screen button: pin the root, then migrate to the managed workspace. */
	public async enterWorkspaceMode(): Promise<void> {
		try {
			// Pin BEFORE the reload — workspaceState dies with the workspace id.
			pinRoot(this.globalState, this._workspaceRoot);
			await enterManagedWorkspace(this._workspaceRoot);
		} catch (err) {
			console.error('[Exo] enter workspace mode failed:', err);
			vscode.window.showErrorMessage('Exo: failed to open the Exo workspace.');
		}
	}

	/** Webview ready: eager connect to the persisted active tab; tabs load lazily. */
	public async handleReady(): Promise<void> {
		this._workspaceRoot = this.resolveWorkspaceRoot();
		// Defensive: make sure `.exo/` is hidden from git. If the root repo's
		// status ran before the exclude was applied (e.g. the one-time workspace
		// migration), the worktree files could otherwise show as untracked.
		void ensureGitExclude(this._workspaceRoot);
		if (!this._readyHandled) {
			this._readyHandled = true;
			this.restorePersistedUiState();
			// Self-healing after restore: drop any registry entry whose worktree
			// folder no longer exists (manually deleted, or a past bug's leftover).
			void this.pruneDeadRegistryEntries();
		}
		this.postDraftState();
		if (!this.configWatcher.config.agents?.length) {
			this.showConfigRequired();
			return;
		}
		if (await this.isWorkspaceModeRequired()) {
			this.showWorkspaceModeRequired();
			return;
		}
		try {
			this.sendTabs();
			this.sendSessionList();
			if (this._activeSessionId) {
				await this.switchSession(this._activeSessionId);
				return;
			}
			this.showEmpty();
		} catch (err) {
			console.error('[Exo ACP] eager connect failed:', err);
			vscode.window.showErrorMessage(`Exo: ${err instanceof Error ? err.message : String(err)}`);
			this.showEmpty();
		}
	}

	// ------------------------------------------------------------------
	// Session lifecycle
	// ------------------------------------------------------------------

	/**
	 * Kick off a brand-new session optimistically: the empty chat + input is
	 * rendered IMMEDIATELY (before any worktree/agent work), and messages typed
	 * meanwhile are queued on the pending op (dispatched by
	 * `completeNewSession` once the runtime exists). Returns `{ created: true }`
	 * with a fresh pending op, or `{ created: false }` when a create is already
	 * in flight (repeated click / concurrent first message) — the caller should
	 * queue into that pending instead of starting another one. `null` when no
	 * agent is configured.
	 */
	public beginNewSession(): { pending: PendingSession; created: boolean } | null {
		if (!this.acpAgentConfig()) {
			return null;
		}
		for (const p of this._pendingSessions.values()) {
			if (p.mode === 'new') {
				return { pending: p, created: false };
			}
		}
		const pending = this.addPendingSession('new', 'New Chat', this._activeSessionId ?? undefined);
		this.postPendingView(pending);
		return { pending, created: true };
	}

	/**
	 * Back the optimistic pending op with a real session: worktree (or shared
	 * root) cwd, terminal, agent spawn. The chat is already visible (see
	 * `beginNewSession`); this just wires up the runtime and resolves the op.
	 */
	public async completeNewSession(pending: PendingSession): Promise<SessionRuntime | null> {
		let cwd = this.getWorkspaceRoot();
		try {
			const wt = await createWorktree(this.getWorkspaceRoot());
			if (wt) {
				cwd = wt.path;
				void registerWorktreeInScm(cwd);
				// Surface the worktree in the Explorer + SCM immediately, while
				// the agent is still booting — don't wait for session activation.
				this.followSessionFolder(cwd);
				void refreshScmStatus(cwd);
				// The worktree owns the number (first free `exo-<N>` on disk):
				// align the session badge/terminal with the folder/branch name.
				if (wt.number !== pending.number) {
					// The provisional number was never claimed by a real session —
					// return it so the allocator doesn't lose it.
					this.freeNumber(pending.number);
					pending.number = wt.number;
					this._nextSessionNumber = Math.max(this._nextSessionNumber, wt.number + 1);
					this.sendTabs();
				}
			}
		} catch (err) {
			console.error('[Exo] worktree creation failed, using shared root:', err);
		}
		// Remember the chosen cwd so a cancelled/failed create can clean up the
		// orphan worktree (see `disposePendingWorktree`).
		pending.cwd = cwd;
		try {
			// Create + show the terminal NOW (before the agent spawn — the slow
			// part), so its shell starts while the agent boots and the session
			// activation below never waits on it.
			await this.createPendingTerminal(pending, cwd);
			const runtime = await this.spawnSession(pending.number, cwd, 'new');
			this.resolvePendingSession(pending, runtime, 'New Chat');
			return runtime;
		} catch (err) {
			console.error('[Exo ACP] newSession failed:', err);
			this.failPendingSession(pending);
			vscode.window.showErrorMessage(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Create a brand-new session: optimistic begin + background completion. Returns the runtime or null. */
	public async newSession(): Promise<SessionRuntime | null> {
		const res = this.beginNewSession();
		if (!res) {
			return null;
		}
		if (!res.created) {
			// A create is already in flight (repeated click) — nothing to start.
			return null;
		}
		return this.completeNewSession(res.pending);
	}

	/**
	 * Switch to a session (tab click or menu click). If the runtime is already
	 * alive — show it. If it's only a persisted tab/registry entry — spawn a
	 * fresh agent (session/load or session/resume) lazily.
	 */
	public async switchSession(tabId: string): Promise<void> {
		const existing = this.sessions.get(tabId);
		if (existing && existing.acpClient.connected) {
			this.showSessionRuntime(existing);
			return;
		}
		// Never spawn a second agent for the same session while one is already
		// in flight (handleReady can fire twice: webview `ready` + config change).
		for (const p of this._pendingSessions.values()) {
			if (p.mode === 'load' && tabIdForNumber(p.number) === tabId) {
				return;
			}
		}
		// Lazy spawn: recreate the agent process and reload the session.
		const tab = this._tabList.find((t) => t.tabId === tabId);
		const reg = this._sessionRegistry.get(tabId);
		if (!tab && !reg) {
			// Unknown id (e.g. a stale persisted active session) — start fresh.
			void this.newSession();
			return;
		}
		const number = tab?.number ?? sessionNumberFromTabId(reg!.tabId);
		const agentSessionId = tab?.agentSessionId ?? reg?.agentSessionId ?? '';
		const title = tab?.title ?? reg?.title ?? 'Chat';
		const cwd = tab?.cwd ?? reg?.cwd ?? this.getWorkspaceRoot();
		const pending = this.addPendingSession('load', title, this._activeSessionId ?? undefined, number, agentSessionId);
		if (cwd !== this.getWorkspaceRoot()) {
			void registerWorktreeInScm(cwd);
		}
		try {
			await this.createPendingTerminal(pending, cwd);
			this.postPendingView(pending);
			const runtime = await this.spawnSession(number, cwd, 'load', agentSessionId);
			this.resolvePendingSession(pending, runtime, title);
		} catch (err) {
			console.error('[Exo ACP] switchSession failed:', err);
			// Session load failed — restart it (agent may have lost the session).
			try {
				const runtime = await this.spawnSession(number, cwd, 'new');
				this.resolvePendingSession(pending, runtime, 'New Chat');
			} catch (err2) {
				console.error('[Exo ACP] fallback newSession failed:', err2);
				this.failPendingSession(pending);
				vscode.window.showErrorMessage(`Failed to open session ${tabId}`);
			}
		}
	}

	/** Close the tab: kill the agent process. Session stays in the recent menu. */
	public async closeTab(tabId: string): Promise<void> {
		// Cancel an in-flight create/load if its loading tab is closed.
		this.cancelPending(tabId);

		// Optimistic: remove the tab from the UI immediately.
		this._tabList = this._tabList.filter((t) => t.tabId !== tabId);
		this.persistUiStateSoon();
		this.sendTabs();
		if (this._activeSessionId === tabId) {
			const next = this._tabList[this._tabList.length - 1];
			if (next) {
				await this.switchSession(next.tabId);
			} else {
				this.showEmpty();
			}
		}
		this.sendSessionList();

		// Background: close + kill the agent (best-effort, no UI wait).
		const runtime = this.sessions.get(tabId);
		if (runtime) {
			void (async () => {
				try {
					if (runtime.acpClient.canClose) {
						await runtime.acpClient.closeSession(runtime.agentSessionId);
					}
				} catch (err) {
					console.error('[Exo ACP] closeSession failed (best-effort):', err);
				}
				try {
					runtime.acpClient.disconnect();
				} catch { /* ignore */ }
				this.stopTitlePolling(runtime);
				cancelAllPermissions(this.permissionContext(runtime));
				this.sessions.delete(tabId);
				this.sendTabs();
			})();
		}
		this.disposeSessionTerminal(tabId);
	}

	/** Permanently delete a session (from the recent menu). Optimistic UI; worktree handling in background. */
	public async deleteSession(tabId: string): Promise<void> {
		// Cancel an in-flight create/load if its loading tab is deleted.
		this.cancelPending(tabId);

		const entry = this._sessionRegistry.get(tabId);
		const listEntry = this._tabList.find((t) => t.tabId === tabId);
		const cwd = listEntry?.cwd ?? entry?.cwd;
		const agentSessionId = listEntry?.agentSessionId ?? entry?.agentSessionId ?? '';
		// The number the deleted session owns; freed once the teardown below is done.
		const freedNumber = sessionNumberFromTabId(tabId);

		// Only our own worktrees are ever removed; the shared root never is.
		const isWorktree = !!cwd && cwd !== this.getWorkspaceRoot() && isExoWorktreePath(cwd);
		let confirmed = false;

		if (isWorktree) {
			// Warn before destroying work that only lives here (uncommitted
			// changes or commits absent from main).
			try {
				const dirty = await sessionHasUncommittedWork(cwd);
				if (dirty) {
					const choice = await vscode.window.showWarningMessage(
						'This session has uncommitted changes or commits not in main. Delete the session and its worktree anyway?',
						{ modal: true },
						'Delete',
						'Cancel',
					);
					if (choice !== 'Delete') {
						return;
					}
					confirmed = true;
				}
			} catch (err) {
				console.error('[Exo] worktree dirty-check failed (deleting anyway):', err);
			}
		}

		// The agent is still alive and could tick the title poller or push a
		// `session_info_update` that re-adds the entry we're about to delete.
		// Stop the poller immediately; the background teardown below re-deletes
		// (idempotent) after disconnect, so no late update can resurrect it.
		const deletingRuntime = this.sessions.get(tabId);
		if (deletingRuntime) {
			this.stopTitlePolling(deletingRuntime);
		}

		// Optimistic: remove from tabs/registry immediately.
		this._tabList = this._tabList.filter((t) => t.tabId !== tabId);
		this._sessionRegistry.delete(tabId);
		// The registry is persistent — persist the deletion NOW, otherwise a
		// restart resurrects the deleted session in the recent menu.
		this.persistRegistrySoon();
		this._drafts.delete(tabId);
		this.persistDrafts();
		this.persistUiStateSoon();
		this.sendTabs();
		this.sendSessionList();
		if (this._activeSessionId === tabId) {
			const next = this._tabList[this._tabList.length - 1];
			if (next) {
				void this.switchSession(next.tabId);
			} else {
				this.showEmpty();
			}
		}

		// Background: delete on the agent + remove the worktree folder.
		void (async () => {
			try {
				this.disposeSessionTerminal(tabId);
				const runtime = this.sessions.get(tabId);
				try {
					if (runtime) {
						try {
							if (runtime.acpClient.canDelete) {
								await runtime.acpClient.deleteSession(runtime.agentSessionId);
							}
						} finally {
							try { runtime.acpClient.disconnect(); } catch { /* ignore */ }
							this.stopTitlePolling(runtime);
							this.sessions.delete(tabId);
						}
					} else if (cwd && agentSessionId) {
						await this.deleteSessionViaTempAgent(agentSessionId, cwd);
					}
				} catch (err) {
					console.error('[Exo ACP] deleteSession failed (session may persist on agent):', err);
					vscode.window.showWarningMessage('Exo: failed to delete the session on the agent.');
				}
				if (cwd && cwd !== this.getWorkspaceRoot()) {
					try {
						const removed = await removeWorktree(cwd, { confirmed });
						if (!removed) {
							vscode.window.showWarningMessage(
								'Exo: the session\'s worktree was kept — it may contain uncommitted changes (nothing was force-deleted).',
							);
						}
					} catch (err) {
						console.error('[Exo] worktree removal failed:', err);
					}
				}
			} finally {
				// Idempotent: a late `session_info_update` (pre-disconnect) could
				// have re-added the entry — delete again so a restart can never
				// resurrect the deleted session, then release the number.
				this._sessionRegistry.delete(tabId);
				this.persistRegistrySoon();
				this.freeNumber(freedNumber);
			}
		})();
	}

	private async deleteSessionViaTempAgent(agentSessionId: string, cwd: string): Promise<void> {
		const cfg = this.acpAgentConfig();
		if (!cfg) {
			return;
		}
		const client = new AcpClient(cfg, NOOP_ACP_CALLBACKS);
		try {
			await client.connect(cwd);
			if (client.canDelete) {
				await client.deleteSession(agentSessionId);
			}
		} catch (err) {
			console.error('[Exo ACP] temp delete failed:', err);
		} finally {
			try {
				client.disconnect();
			} catch { /* ignore */ }
		}
	}

	// ------------------------------------------------------------------
	// Runtime creation & callbacks
	// ------------------------------------------------------------------

	// --- Pending (in-flight create/load) sessions ---

	/**
	 * Allocate the next ordinal session number: smallest freed number first
	 * (compact, so badges/terminals don't keep climbing), else the monotonic
	 * counter. The ONLY mint site for fresh session numbers (`load` reuses a
	 * persisted entry's number without going through here).
	 */
	private takeNumber(): number {
		if (this._freeNumbers.size > 0) {
			let best = Infinity;
			for (const n of this._freeNumbers) {
				if (n < best) {
					best = n;
				}
			}
			this._freeNumbers.delete(best);
			return best;
		}
		return this._nextSessionNumber++;
	}

	/** Return `n` to the free pool — call only once every reference to `exo-<N>` is gone. */
	private freeNumber(n: number): void {
		if (n > 0) {
			this._freeNumbers.add(n);
		}
	}

	/**
	 * Cancel an in-flight create/load for a tab being closed/deleted: mark it
	 * cancelled so a late resolve/fail becomes a no-op, drop its draft, and
	 * release the number a `new` pending provisionally held.
	 */
	private cancelPending(tabId: string): void {
		const pending = this._pendingSessions.get(tabId);
		if (!pending) {
			return;
		}
		pending.cancelled = true;
		this._pendingSessions.delete(tabId);
		this._drafts.delete(tabId);
		if (pending.mode === 'new') {
			this.freeNumber(pending.number);
		}
	}

	/**
	 * Start an in-flight session op: show a loading tab + the pending view
	 * immediately, resolve it when the real runtime exists. `new` sessions are
	 * optimistic — an empty chat + input is shown and messages typed meanwhile
	 * are queued; `load` sessions keep the full-area loading view (content
	 * comes from agent replay, nothing to interact with).
	 */
	private addPendingSession(mode: 'new' | 'load', title: string, prevActiveId?: string, number?: number, agentSessionId?: string): PendingSession {
		const pending: PendingSession = {
			id: `pending-${++this._pendingCounter}`,
			title,
			mode,
			agentSessionId: mode === 'load' ? agentSessionId ?? null : null,
			number: number ?? this.takeNumber(),
			cwd: null,
			prevActiveId: prevActiveId ?? null,
			cancelled: false,
			queuedMessages: [],
		};
		this._pendingSessions.set(pending.id, pending);
		// Close diff editors for the previous session.
		if (this._activeSessionId && this._activeSessionId !== pending.id) {
			const prev = this.sessions.get(this._activeSessionId);
			if (prev) {
				this.closeSessionDiffs(prev);
			}
		}
		this._activeSessionId = pending.id;
		this.sendTabs();
		return pending;
	}

	/** Render the pending session in the webview (chat view for `new`, loading view for `load`). */
	private postPendingView(pending: PendingSession): void {
		if (pending.mode === 'new') {
			this.view?.webview.postMessage({ type: 'showChat', sessionId: pending.id, messages: this.messages, plan: null, configPending: true });
			// Never let a stale `agentRunning` from the previous session disable the input.
			this.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
			// A fresh session starts with an empty draft (not the previous session's text).
			this.postDraftState();
		} else {
			this.view?.webview.postMessage({ type: 'showChatLoading', sessionId: pending.id, title: pending.title, mode: 'load', configPending: true });
		}
	}

	/** Swap a pending loading tab for the real runtime (or dispose if cancelled). */
	private resolvePendingSession(pending: PendingSession, runtime: SessionRuntime, title: string): void {
		this._pendingSessions.delete(pending.id);
		if (pending.cancelled) {
			// Tab was closed while loading — don't leak the spawned agent, the
			// terminal or an orphan worktree.
			this.disposePendingWorktree(pending);
			this.disposeSessionTerminal(pending.id);
			try {
				runtime.acpClient.disconnect();
			} catch { /* ignore */ }
			return;
		}
		// The runtime already carries the pending-phase number (tab id `exo-<N>`);
		// re-key the terminal created during the pending phase onto it.
		this.transferSessionTerminal(pending.id, runtime.id);
		// Optimistic `new`: messages typed during the spawn become the start of
		// the real session, still rendered `isQueued` until dispatched below.
		if (pending.queuedMessages.length > 0) {
			runtime.messages = [...pending.queuedMessages];
			pending.queuedMessages = [];
		}
		// Move the draft typed while spawning onto the real session id.
		const pendingDraft = this._drafts.get(pending.id);
		if (pendingDraft) {
			this._drafts.delete(pending.id);
			this._drafts.set(runtime.id, pendingDraft);
			this.persistDrafts();
		}
		// Only steal the view if the user hasn't navigated away meanwhile.
		this.finishSessionOpen(runtime, title, this._activeSessionId === pending.id);
		if (runtime.messages.some((m) => m.isQueued)) {
			const first = runtime.messages.find((m) => m.isQueued);
			if (first) {
				const text = messageText(first);
				this.ensureSessionTitle(runtime, text);
				void this._messageHandler.handleUserMessage(text, first.images, {
					preQueued: true,
					runtime,
					queuedMessage: first,
				});
			}
		}
	}

	/**
	 * A `new` create that failed or was cancelled after its worktree was
	 * created would otherwise leave an orphan worktree + branch on disk forever.
	 * Safe by construction: `removeWorktree` refuses non-Exo paths and dirty
	 * worktrees (no `confirmed` here), so no real work can be destroyed.
	 */
	private disposePendingWorktree(pending: PendingSession): void {
		if (pending.mode !== 'new') {
			return;
		}
		const cwd = pending.cwd;
		if (!cwd || cwd === this.getWorkspaceRoot() || !isExoWorktreePath(cwd)) {
			return;
		}
		void removeWorktree(cwd).catch((err) => {
			console.error('[Exo] orphan worktree cleanup failed:', err);
		});
	}

	/** A pending op failed: restore the previous active view (or show empty). */
	private failPendingSession(pending: PendingSession): void {
		this._pendingSessions.delete(pending.id);
		this._drafts.delete(pending.id);
		this.disposeSessionTerminal(pending.id);
		this.disposePendingWorktree(pending);
		// A `new` pending never became a session — its number is free again.
		// (`load` numbers belong to persisted entries and must be kept.)
		if (pending.mode === 'new') {
			this.freeNumber(pending.number);
		}
		if (pending.cancelled) {
			return;
		}
		const prev = pending.prevActiveId;
		const prevRuntime = prev ? this.sessions.get(prev) : undefined;
		if (prevRuntime) {
			this.showSessionRuntime(prevRuntime);
		} else if (prev && this._pendingSessions.has(prev)) {
			// The previous "active" was another in-flight op — show it instead.
			const prevPending = this._pendingSessions.get(prev)!;
			this._activeSessionId = prev;
			this.persistUiStateSoon();
			this.sendTabs();
			this.postPendingView(prevPending);
		} else {
			this.showEmpty();
		}
	}

	private spawnSession(
		number: number,
		cwd: string,
		mode: 'new' | 'load',
		agentSessionId?: string,
	): Promise<SessionRuntime> {
		const cfg = this.acpAgentConfig();
		if (!cfg) {
			return Promise.reject(new Error('No ACP agent configured in config.yml (expected agents[0])'));
		}

		const runtime: SessionRuntime = new SessionRuntime(number, cwd, this.buildRuntimeCallbacks(tabIdForNumber(number)));
		runtime.acpClient = new AcpClient(cfg, this.buildAcpCallbacks(runtime));

		return (async () => {
			await runtime.acpClient.connect(cwd);
			if (mode === 'new') {
				await runtime.acpClient.sessionNew(cwd);
				// The agent picked the default mode (usually "plan") — restore the
				// (model, effort) the user last used with this mode, if any. Runs
				// before the session becomes visible, so the pending-view skeletons
				// hide the apply and the selectors appear already configured.
				const agentId = cfg.id;
				if (agentId) {
					const { currentModeId } = buildConfigSelectors(runtime.acpClient.configOptions ?? null, runtime.acpClient.clientSelection);
					if (currentModeId) {
						this._applyingConfig = true;
						try {
							await this.applyRememberedSetup(runtime.acpClient, agentId, currentModeId);
						} catch (e) {
							console.error('[Exo ACP] restoring remembered setup failed:', e);
						} finally {
							this._applyingConfig = false;
						}
					}
				}
			} else if (runtime.acpClient.canLoadSession) {
				this.startReplay(runtime);
				await runtime.acpClient.sessionLoad(agentSessionId ?? '', cwd);
				this.endReplay(runtime);
			} else if (runtime.acpClient.canResume) {
				await runtime.acpClient.sessionResume(agentSessionId ?? '', cwd);
				runtime.messages = [];
				this.endReplay(runtime);
			} else {
				throw new Error('Agent cannot load or resume sessions');
			}
			runtime.agentSessionId = runtime.acpClient.sessionId ?? agentSessionId ?? '';
			return runtime;
		})();
	}

	/** Register the runtime in sessions + tabs + registry, save state, optionally show it. */
	private finishSessionOpen(runtime: SessionRuntime, title: string, activate = true): void {
		this.sessions.set(runtime.id, runtime);
		runtime.title = title;
		// Upsert: a lazy-load tab entry already exists (persisted) — refresh its
		// agent session id (a load may have fallen back to a fresh session) and title.
		const existing = this._tabList.find((t) => t.tabId === runtime.id);
		if (existing) {
			existing.agentSessionId = runtime.agentSessionId;
			existing.title = title;
			existing.cwd = runtime.cwd;
			existing.number = runtime.number;
		} else {
			this._tabList.push({ tabId: runtime.id, agentSessionId: runtime.agentSessionId, title, cwd: runtime.cwd, number: runtime.number });
		}
		this.upsertSessionRegistry(runtime.id, runtime.agentSessionId, title, runtime.cwd);
		this.persistUiStateSoon();
		void this.ensureSessionTerminal(runtime);
		if (activate) {
			this.showSessionRuntime(runtime);
		}
		this.sendTabs();
		this.sendSessionList();
	}

	/**
	 * Create a terminal named `exo-<N>` rooted in `cwd` (worktree). Created
	 * hidden and transient: it only surfaces when the user is in the terminal
	 * panel. A terminal that survived a window reload / extension-host restart
	 * is reused by `ensureSessionTerminal` instead of creating a second one.
	 */
	private createSessionTerminal(number: number, cwd: string): vscode.Terminal {
		return vscode.window.createTerminal({
			name: formatTerminalName(number),
			cwd,
			iconPath: new vscode.ThemeIcon('git-branch'),
			color: new vscode.ThemeColor(SESSION_COLOR_KEYS[sessionColorNumber(number)]),
			isTransient: true,
		});
	}

	/** Create the pending-phase terminal BEFORE the agent spawn (so it never
	 *  pops up mid-typing); keyed by the pending id until the runtime resolves.
	 *  Reuses a live `exo-<N>` terminal that survived a window reload /
	 *  extension-host restart (this is the path a restored session takes, so
	 *  the reuse MUST happen here, not only in `ensureSessionTerminal`).
	 *  Shows it immediately: showing is what starts the shell process, so the
	 *  session-activation `show(true)` below becomes instant instead of
	 *  spawning bash/zsh on the spot. `preserveFocus` keeps the chat input. */
	private async createPendingTerminal(pending: PendingSession, cwd: string): Promise<vscode.Terminal> {
		const terminal = await this.getOrCreateSessionTerminal(pending.id, pending.number, cwd);
		terminal.show(true);
		return terminal;
	}

	/** Get the runtime's terminal (usually created during the pending phase).
	 *  Reuses a live `exo-<N>` terminal that survived a window reload /
	 *  extension-host restart (found in `vscode.window.terminals`) instead of
	 *  creating a second instance. */
	private async ensureSessionTerminal(runtime: SessionRuntime): Promise<vscode.Terminal> {
		return this.getOrCreateSessionTerminal(runtime.id, runtime.number, runtime.cwd);
	}

	/** Shared terminal acquisition: existing (keyed) → live `exo-<N>` survivor → create. */
	private async getOrCreateSessionTerminal(key: string, number: number, cwd: string): Promise<vscode.Terminal> {
		const existing = this._sessionTerminals.get(key);
		if (existing) {
			return existing;
		}
		const live = await this.findLiveSessionTerminal(number);
		if (live) {
			this._sessionTerminals.set(key, live);
			return live;
		}
		const terminal = this.createSessionTerminal(number, cwd);
		this._sessionTerminals.set(key, terminal);
		return terminal;
	}

	/** Re-key a pending-phase terminal onto the resolved runtime's id. */
	private transferSessionTerminal(fromId: string, toId: string): void {
		const terminal = this._sessionTerminals.get(fromId);
		if (!terminal) {
			return;
		}
		this._sessionTerminals.delete(fromId);
		this._sessionTerminals.set(toId, terminal);
	}

	/**
	 * Find a live `exo-<N>` terminal already open in this window. A terminal
	 * whose creating extension host was restarted can linger in
	 * `vscode.window.terminals` with a stale `exitStatus`, so liveness is judged
	 * by `processId` (undefined = no process), not by `exitStatus`.
	 */
	private async findLiveSessionTerminal(number: number): Promise<vscode.Terminal | undefined> {
		const name = formatTerminalName(number);
		for (const t of vscode.window.terminals) {
			if (t.name !== name) {
				continue;
			}
			if (await t.processId !== undefined) {
				return t;
			}
		}
		const dump = await Promise.all(
			vscode.window.terminals.map(async (t) => ({
				name: t.name,
				pid: await t.processId,
				exitStatus: t.exitStatus ? `${t.exitStatus.code}` : 'running',
			})),
		);
		console.log(`[Exo] no live terminal ${name}; all terminals:`, JSON.stringify(dump));
		return undefined;
	}

	/** Kill a session's terminal (tab close / session delete). */
	private disposeSessionTerminal(tabId: string): void {
		const terminal = this._sessionTerminals.get(tabId);
		if (!terminal) {
			return;
		}
		this._sessionTerminals.delete(tabId);
		try {
			terminal.dispose();
		} catch { /* ignore */ }
	}

	private buildRuntimeCallbacks(tabId: string): SessionRuntimeCallbacks {
		return {
			sendPlan: () => {
				if (this._activeSessionId !== tabId) return;
				this.view?.webview.postMessage({ type: 'updatePlan', plan: this.currentPlan });
			},
			sendMessages: () => this.updateMessages(),
			sendTokenUsage: () => {
				if (this._activeSessionId !== tabId) return;
				this.sendTokenUsageFor(tabId);
			},
			sendConfig: () => this.sendConfig(),
			sendCommands: () => {
				if (this._activeSessionId !== tabId) return;
				this.sendAvailableCommandsFor(tabId);
			},
			sendTabs: () => this.sendTabs(),
			sendAgentRunning: (running: boolean) => {
				if (this._activeSessionId !== tabId) return;
				this.view?.webview.postMessage({ type: 'updateAgentRunning', running });
			},
			isActive: () => this._activeSessionId === tabId,
			sendStreamChunk: (index, blocks) => {
				if (this._activeSessionId !== tabId) return;
				this.view?.webview.postMessage({ type: 'streamChunk', sessionId: tabId, index, blocks });
			},
		};
	}

	private buildAcpCallbacks(runtime: SessionRuntime): AcpClientCallbacks {
		return {
			onAgentMessageChunk: (_msgId, content) => {
				if (content.type !== 'text') return;
				if (runtime.replaying) {
					const msgId = _msgId ?? null;
					if (msgId !== runtime.lastReplayMsgId) {
						runtime.messages.push({ role: 'assistant', blocks: [], isStreaming: true });
						runtime.streamingIndex = runtime.messages.length - 1;
						runtime.lastReplayMsgId = msgId;
					}
					runtime.appendStreamChunk(content.text);
					this.scheduleReplayUpdate(runtime);
				} else {
					runtime.appendStreamChunk(content.text);
				}
			},
			onAgentThoughtChunk: (_msgId, content) => {
				if (content.type !== 'text') return;
				if (runtime.replaying) {
					if (runtime.streamingIndex === null) {
						runtime.messages.push({ role: 'assistant', blocks: [], isStreaming: true });
						runtime.streamingIndex = runtime.messages.length - 1;
						runtime.lastReplayMsgId = _msgId ?? null;
					}
					runtime.appendThoughtChunk(content.text);
					this.scheduleReplayUpdate(runtime);
				} else {
					runtime.appendThoughtChunk(content.text);
				}
			},
			onUserMessageChunk: (msgId, content) => {
				if (!runtime.replaying || content.type !== 'text') return;
				const id = msgId ?? null;
				if (id !== runtime.lastReplayMsgId) {
					runtime.messages.push({ role: 'user', blocks: [{ type: 'text', content: '' }] });
					runtime.lastReplayMsgId = id;
				}
				const last = runtime.messages[runtime.messages.length - 1];
				const lastBlock = last.blocks[last.blocks.length - 1];
				if (lastBlock && lastBlock.type === 'text') {
					lastBlock.content += content.text;
				} else {
					last.blocks.push({ type: 'text', content: content.text });
				}
				this.scheduleReplayUpdate(runtime);
			},
			onToolCallCreate: (update) => {
				// Upsert: the tool call may already be known (request_permission can
				// arrive before tool_call). Patch it in place — never create a second
				// object for the same id (that would drop permissionRequestId and
				// push a duplicate card).
				const existing = runtime.toolCallInfos.get(update.toolCallId);
				if (existing) {
					applyToolCallPatch(existing, update);
					runtime.maybeSyncPlanFromTool(existing);
					if (runtime.replaying) {
						this.scheduleReplayUpdate(runtime);
					} else {
						this.updateMessages();
					}
					return;
				}
				const tc = createToolCallInfo(update.toolCallId, update.title, update.kind);
				tc.status = mapToolStatus(update.status);
				applyToolCallPatch(tc, update);
				runtime.pushToolCallToStreaming(tc);
				runtime.toolCallInfos.set(update.toolCallId, tc);
				runtime.maybeSyncPlanFromTool(tc);
				if (runtime.replaying) {
					this.scheduleReplayUpdate(runtime);
				} else {
					this.updateMessages();
				}
			},
			onToolCallUpdate: (update) => {
				const tc = runtime.toolCallInfos.get(update.toolCallId);
				if (!tc) return;
				applyToolCallPatch(tc, update);
				if (update.status) {
					tc.status = mapToolStatus(update.status);
					if (tc.status === 'error') {
						tc.isError = true;
					}
				}
				runtime.maybeSyncPlanFromTool(tc);
				if (runtime.replaying) {
					this.scheduleReplayUpdate(runtime);
				} else {
					this.updateMessages();
				}
			},
			onPlan: (entries: PlanEntry[]) => {
				runtime.currentPlan = runtime.mapPlanEntries(entries);
				runtime.callbacks.sendPlan();
			},
			onUsageUpdate: (update) => {
				runtime.currentUsage = { used: update.used, size: update.size };
				runtime.callbacks.sendTokenUsage();
			},
			onCurrentModeUpdate: (modeId) => {
				runtime.mode = modeId;
				runtime.callbacks.sendConfig();
			},
			onConfigOptionUpdate: () => {
				if (!this._applyingConfig) {
					runtime.callbacks.sendConfig();
				}
			},
			onAvailableCommandsUpdate: (commands) => {
				runtime.availableCommands = commands;
				runtime.callbacks.sendCommands();
			},
			onSessionInfoUpdate: (title, updatedAt) => {
				if (title) {
					this.applySessionTitle(runtime.id, title, updatedAt ? new Date(updatedAt).getTime() : undefined);
					if (!isPlaceholderTitle(title)) {
						this.stopTitlePolling(runtime);
					}
				}
			},
			onReadTextFile: (p) => handleReadTextFile(p, this.fsContext(runtime)),
			onWriteTextFile: (p) => handleWriteTextFile(p, this.fsContext(runtime)),
			onRequestPermission: (p) => handleRequestPermission(p, this.permissionContext(runtime)),
			onError: (e) => console.error('[Exo ACP] error:', e),
			onDisconnect: () => {
				this.stopTitlePolling(runtime);
				cancelAllPermissions(this.permissionContext(runtime));
				this.disposeSessionTerminal(runtime.id);
				runtime.isStreaming = false;
				runtime.agentRunning = false;
				if (this.sessions.get(runtime.id) === runtime) {
					this.sessions.delete(runtime.id);
				}
				if (this._activeSessionId === runtime.id) {
					this.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
				}
				this.sendTabs();
			},
		};
	}

	// ------------------------------------------------------------------
	// Session titles
	// ------------------------------------------------------------------

	/**
	 * Persist an owned session title through the whole pipeline (runtime, tab
	 * list, registry) and refresh the UI. Used by `session_info_update`, the
	 * `session/list` poller and the client-side fallback title alike.
	 */
	private applySessionTitle(tabId: string, title: string, updatedAt?: number): void {
		const runtime = this.sessions.get(tabId);
		if (!runtime) {
			return;
		}
		runtime.title = title;
		const t = this._tabList.find((x) => x.tabId === tabId);
		if (t) {
			t.title = title;
		}
		this.upsertSessionRegistry(tabId, runtime.agentSessionId, title, runtime.cwd, updatedAt);
		this.persistUiStateSoon();
		this.sendTabs();
		this.sendSessionList();
	}

	/**
	 * On the first real user message: if the session still carries a generic
	 * title, show a client-side fallback (start of the message) and start
	 * polling `session/list` so a real agent-generated title can replace it.
	 * Re-start polling on later messages if the previous window expired
	 * (agents generate titles lazily — the first window may be too short).
	 */
	public ensureSessionTitle(runtime: SessionRuntime, messageText: string): void {
		if (this.sessions.get(runtime.id) !== runtime) {
			return;
		}
		if (!runtime.titlePollStarted) {
			const fallback = isPlaceholderTitle(runtime.title) ? makeFallbackTitle(messageText) : '';
			if (fallback) {
				this.applySessionTitle(runtime.id, fallback);
			}
		}
		if (runtime.acpClient.canList) {
			this.startTitlePolling(runtime);
		}
	}

	/** Poll `session/list` every 5s (max 5 min) until a real title appears. */
	private startTitlePolling(runtime: SessionRuntime): void {
		if (runtime.titlePollTimer || !runtime.acpClient.canList) {
			return;
		}
		runtime.titlePollStarted = true;
		runtime.titlePollStart = Date.now();
		const tick = () => {
			if (Date.now() - runtime.titlePollStart >= TITLE_POLL_MAX_MS) {
				this.stopTitlePolling(runtime);
				return;
			}
			void this.pollTitleTick(runtime).catch((err) => {
				console.error('[Exo ACP] title poll failed (giving up):', err);
				this.stopTitlePolling(runtime);
			});
		};
		runtime.titlePollTimer = setInterval(tick, TITLE_POLL_INTERVAL_MS);
		tick();
	}

	private async pollTitleTick(runtime: SessionRuntime): Promise<void> {
		const resp = await runtime.acpClient.listSessions(runtime.cwd);
		const entry = resp.sessions.find((s) => s.sessionId === runtime.agentSessionId);
		if (entry?.title && !isPlaceholderTitle(entry.title) && entry.title !== runtime.title) {
			this.applySessionTitle(runtime.id, entry.title, entry.updatedAt ? new Date(entry.updatedAt).getTime() : undefined);
			this.stopTitlePolling(runtime);
		}
	}

	private stopTitlePolling(runtime: SessionRuntime): void {
		if (runtime.titlePollTimer) {
			clearInterval(runtime.titlePollTimer);
			runtime.titlePollTimer = null;
		}
	}

	// ------------------------------------------------------------------
	// Replay (session/load)
	// ------------------------------------------------------------------

	private startReplay(runtime: SessionRuntime): void {
		runtime.replaying = true;
		runtime.lastReplayMsgId = null;
		runtime.messages = [];
		runtime.streamingIndex = null;
		runtime.toolCallInfos.clear();
		runtime.currentPlan = null;
		runtime.currentUsage = null;
		if (runtime.replayUpdateTimer) {
			clearTimeout(runtime.replayUpdateTimer);
			runtime.replayUpdateTimer = null;
		}
	}

	private endReplay(runtime: SessionRuntime): void {
		runtime.replaying = false;
		runtime.lastReplayMsgId = null;
		if (runtime.replayUpdateTimer) {
			clearTimeout(runtime.replayUpdateTimer);
			runtime.replayUpdateTimer = null;
		}
		// Replay machinery marks every assistant message `isStreaming: true`;
		// clear them ALL, or the loaded history "blinks" like it's live.
		for (const msg of runtime.messages) {
			msg.isStreaming = false;
			msg._lastChunkKind = null;
		}
		runtime.streamingIndex = null;
		runtime.isStreaming = false;
		this.updateMessages();
	}

	private scheduleReplayUpdate(runtime: SessionRuntime): void {
		if (runtime.replayUpdateTimer) {
			return;
		}
		runtime.replayUpdateTimer = setTimeout(() => {
			runtime.replayUpdateTimer = null;
			this.updateMessages();
		}, 50);
	}

	// ------------------------------------------------------------------
	// Webview updates
	// ------------------------------------------------------------------

	public showEmpty(): void {
		// Close diff editors for the previous session.
		if (this._activeSessionId) {
			const prev = this.sessions.get(this._activeSessionId);
			if (prev) {
				this.closeSessionDiffs(prev);
			}
		}
		this._activeSessionId = null;
		this._workspaceSwitcher.showRoot(this._workspaceRoot);
		this.persistUiStateSoon();
		this.view?.webview.postMessage({ type: 'showEmpty' });
		this.sendTabs();
	}

	/** Ask the Explorer to show the given cwd (no-op unless in managed workspace mode). */
	private followSessionFolder(cwd: string): void {
		this._workspaceSwitcher.follow(this._workspaceRoot, cwd);
	}

	/** Show a runtime's chat in the webview. */
	private showSessionRuntime(runtime: SessionRuntime): void {
		// Close diff editors for the previous session before switching.
		if (this._activeSessionId && this._activeSessionId !== runtime.id) {
			const prev = this.sessions.get(this._activeSessionId);
			if (prev) {
				this.closeSessionDiffs(prev);
			}
		}
		this._activeSessionId = runtime.id;
		this.followSessionFolder(runtime.cwd);
		// Force the worktree repo to refresh in the SCM view right away — the
		// git extension's file watcher is debounced (~1s), so without this its
		// changes could look stale until the next auto-refresh.
		void refreshScmStatus(runtime.cwd);
		this.persistUiStateSoon();
		this.view?.webview.postMessage({
			type: 'showChat',
			sessionId: runtime.id,
			messages: runtime.messages,
			plan: runtime.currentPlan,
			configPending: false,
		});
		this.sendAgentInfo();
		this.sendConfig();
		this.sendAvailableCommandsFor(runtime.id);
		this.sendPromptCapabilities();
		this.sendColorTheme();
		this.view?.webview.postMessage({ type: 'updateAgentRunning', running: runtime.agentRunning });
		this.view?.webview.postMessage({ type: 'updateAutoAllowPermissions', value: this._autoAllowPermissions });
		this.sendTokenUsageFor(runtime.id);
		this.postDraftState();
		this.refreshMergeState();
		this.sendTabs();
		// Bring the session's terminal forward WITHOUT stealing focus from the
		// chat input (`show(true)` preserves focus; `false` would yank it).
		void this.ensureSessionTerminal(runtime).then((t) => t.show(true));
		// Open deferred diff editors for pending edit-permissions.
		void this.openDeferredDiffs(runtime);
	}

	public updateMessages(): void {
		this.view?.webview.postMessage({ type: 'updateMessages', messages: this.messages });
	}

	/** Tab strip: title + status per open tab. Pending (in-flight) tabs trail the real ones. */
	public sendTabs(): void {
		const pendingTabs = [...this._pendingSessions.values()].map((p) => ({
			sessionId: p.id,
			title: p.title,
			status: 'loading' as const,
			number: p.number,
			colorIndex: sessionColorNumber(p.number),
		}));
		const tabs = [
			...this._tabList.map((t) => {
				const runtime = this.sessions.get(t.tabId);
				return {
					sessionId: t.tabId,
					title: runtime?.title || t.title,
					status: runtime ? runtime.status : 'idle',
					number: t.number,
					colorIndex: sessionColorNumber(t.number),
				};
			}),
			...pendingTabs,
		];
		this.view?.webview.postMessage({ type: 'updateTabs', tabs, activeSessionId: this._activeSessionId });
	}

	/** Recent-sessions menu data (registry, newest first, capped). */
	public sendSessionList(): void {
		const sessions = [...this._sessionRegistry.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_RECENT_SESSIONS)
			.map((e) => ({
				sessionId: e.tabId,
				title: e.title || 'Untitled',
				updatedAt: e.updatedAt,
				active: this.sessions.has(e.tabId),
			}));
		this.view?.webview.postMessage({ type: 'updateSessions', sessions });
	}

	public sendAgentInfo(): void {
		this.view?.webview.postMessage({
			type: 'updateAgentInfo',
			agentInfo: this.acpAgentConfig() ? this.activeClientInfo() : null,
		});
	}

	private activeClientInfo(): { name: string; title?: string; version?: string } | null {
		const client = this.session?.acpClient;
		if (!client) return null;
		const info = client.agentInfo;
		if (!info) return null;
		return info;
	}

	public sendPromptCapabilities(): void {
		this.view?.webview.postMessage({
			type: 'updatePromptCapabilities',
			image: this.session?.acpClient.canPromptImage ?? false,
		});
	}

	public sendColorTheme(): void {
		const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') ?? null;
		this.view?.webview.postMessage({ type: 'updateColorTheme', name });
	}

	public sendTokenUsageFor(_sessionId: string): void {
		const usage = this.session?.currentUsage;
		if (!usage) return;
		this.view?.webview.postMessage({
			type: 'updateTokenUsage',
			usage: { prompt_tokens: usage.used },
			tokenLimit: usage.size,
		});
	}

	public sendAvailableCommandsFor(_sessionId: string): void {
		this.view?.webview.postMessage({ type: 'updateCommands', commands: this.availableCommands });
	}

	// ------------------------------------------------------------------
	// Config
	// ------------------------------------------------------------------

	public acpAgentConfig() {
		return this.configWatcher.config.agents?.[0];
	}

	public sendConfig(): void {
		const client = this.session?.acpClient;
		if (!client) {
			this.view?.webview.postMessage({ type: 'updateConfig', selectors: [], modeColorIndex: {} });
			return;
		}
		const { selectors, currentModeId } = buildConfigSelectors(client.configOptions ?? null, client.clientSelection);
		if (currentModeId && this.session) {
			this.session.mode = currentModeId;
		}

		// Mode color palette: assign each modeId a stable index 0..9 (persisted).
		let modeColorIndex: Record<string, number> = {};
		const modeSel = selectors.find((s) => s.category === 'mode');
		if (modeSel) {
			const ids = modeSel.options.map((o) => o.value);
			if (currentModeId && !ids.includes(currentModeId)) {
				ids.push(currentModeId);
			}
			modeColorIndex = this.assignModeColors(ids);
		}

		this.view?.webview.postMessage({ type: 'updateConfig', selectors, modeColorIndex });
	}

	/** Change a config option (mode/model/thought_level) via configOptions. */
	public async selectConfigOption(configId: string, value: string): Promise<void> {
		const client = this.session?.acpClient;
		if (!client) {
			return;
		}
		this._applyingConfig = true;
		try {
			await client.setConfigOption(configId, value);
			const agentId = this.acpAgentConfig()?.id;
			if (agentId) {
				// Mode switch → pull the (model, effort) last used with this mode
				// (from any session). Best-effort; invalid values are skipped.
				const { selectors } = buildConfigSelectors(client.configOptions ?? null, client.clientSelection);
				const modeSel = selectors.find((s) => s.category === 'mode');
				if (modeSel && modeSel.id === configId) {
					await this.applyRememberedSetup(client, agentId, modeSel.currentValue);
				}
				// Snapshot the final state last, so the current mode's record is
				// never clobbered with the previous mode's (model, effort).
				this.rememberSetup(agentId);
			}
		} catch (e) {
			console.error(`[Exo ACP] selectConfigOption(${configId}) failed:`, e);
		} finally {
			this._applyingConfig = false;
			this.sendConfig();
		}
	}

	/** Snapshot the active session's (mode, model, effort) into lastSetupByMode. */
	private rememberSetup(agentId: string): void {
		const client = this.session?.acpClient;
		if (!client) {
			return;
		}
		const { selectors } = buildConfigSelectors(client.configOptions ?? null, client.clientSelection);
		const modeSel = selectors.find((s) => s.category === 'mode');
		if (!modeSel) {
			return;
		}
		const model = selectors.find((s) => s.category === 'model')?.currentValue ?? '';
		const effort = selectors.find((s) => s.category === 'thought_level')?.currentValue ?? '';
		if (!model && !effort) {
			return;
		}
		const map = this.lastSetupByMode();
		const byMode = map[agentId] ?? (map[agentId] = {});
		byMode[modeSel.currentValue] = { model, effort };
		void this.globalState.update(LAST_SETUP_BY_MODE_KEY, map);
	}

	/**
	 * Apply the remembered (model, effort) for a given mode on a given client.
	 * Used both when the user switches modes in a live session and on session
	 * create, where the agent picked the default mode. Best-effort: values that
	 * are empty or no longer present in the fresh `configOptions` are skipped;
	 * values already set are not re-sent.
	 */
	private async applyRememberedSetup(client: AcpClient, agentId: string, modeId: string): Promise<void> {
		const setup = this.lastSetupByMode()[agentId]?.[modeId];
		if (!setup) {
			return;
		}
		for (const [category, value] of [
			['model', setup.model],
			['thought_level', setup.effort],
		] as const) {
			if (!value) {
				continue;
			}
			// Re-read options each iteration — setConfigOption returns fresh ones.
			const sel = buildConfigSelectors(client.configOptions ?? null, client.clientSelection).selectors.find((s) => s.category === category);
			if (!sel || !sel.options.some((o) => o.value === value)) {
				continue;
			}
			if (sel.currentValue === value) {
				continue;
			}
			await client.setConfigOption(sel.id, value);
		}
	}

	private lastSetupByMode(): LastSetupByMode {
		return this.globalState.get<LastSetupByMode>(LAST_SETUP_BY_MODE_KEY) ?? {};
	}

	/** modeId → stable color index 0..9 (persisted in globalState). */
	private modeColorMap(): Record<string, number> {
		return this.globalState.get<Record<string, number>>('exo.modeColorIndex') ?? {};
	}

	private assignModeColors(modeIds: string[]): Record<string, number> {
		const map = this.modeColorMap();
		let changed = false;
		const used = new Set(Object.values(map));
		for (const id of modeIds) {
			if (map[id] === undefined) {
				let idx = 0;
				while (idx < 10 && used.has(idx)) {
					idx++;
				}
				if (idx > 9) {
					idx = modeIds.indexOf(id) % 10;
				}
				map[id] = idx;
				used.add(idx);
				changed = true;
			}
		}
		if (changed) {
			void this.globalState.update('exo.modeColorIndex', map);
		}
		return map;
	}

	// ------------------------------------------------------------------
	// Permissions
	// ------------------------------------------------------------------

	public get autoAllowPermissions(): boolean {
		return this._autoAllowPermissions;
	}

	public setAutoAllowPermissions(value: boolean): void {
		this._autoAllowPermissions = value;
		this.view?.webview.postMessage({ type: 'updateAutoAllowPermissions', value });
	}

	/** Apply the user's decision from the webview (postMessage `permissionDecision`). */
	public resolvePermission(
		requestId: string,
		decision: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' },
		followUpText?: string,
	): void {
		const runtime = this.session;
		if (!runtime) {
			return;
		}
		resolvePermissionImpl(this.permissionContext(runtime), requestId, decision);
		if (followUpText && followUpText.trim()) {
			const queued: ChatMessage = {
				role: 'user',
				blocks: [{ type: 'text', content: followUpText.trim() }],
				isQueued: true,
			};
			runtime.pendingFollowUpMessage = queued;
			runtime.messages.push(queued);
		}
		this.updateMessages();
		this.sendTabs();
	}

	public cancelPendingOperations(): void {
		const runtime = this.session;
		if (!runtime) {
			return;
		}
		runtime.stopped = true;
		runtime.acpClient.cancel();
		runtime.isStreaming = false;
		cancelAllPermissions(this.permissionContext(runtime));
		this.sendTabs();
	}

	// ------------------------------------------------------------------
	// Commit & merge to main (worktree sessions)
	// ------------------------------------------------------------------

	/**
	 * "Commit & merge to main" button: instruct the active agent (as a normal
	 * user message) to commit its work and merge `main` into its own branch,
	 * resolving any conflicts in its own worktree. The final merge of the
	 * branch into main is then performed host-side as a safe `--ff-only`
	 * (see `mergeWorktreeToMain`). The agent cannot switch to `main` from a
	 * linked worktree, but can merge `main` into the checked-out branch. The
	 * button is gated on `canMerge` (see `refreshMergeState`), so it only
	 * fires when there is unmerged work.
	 */
	public async mergeToMain(): Promise<void> {
		const runtime = this.session;
		if (!runtime || runtime.agentRunning || runtime.isStreaming) {
			return;
		}
		if (runtime.cwd === this.getWorkspaceRoot()) {
			return;
		}
		const main = await resolveMainBranch(runtime.cwd);
		if (!main) {
			vscode.window.showWarningMessage('Exo: could not determine the repository main branch — merge cancelled.');
			return;
		}
		void this._messageHandler.handleUserMessage(buildCommitAndMergePrompt(main), undefined, { mergeIntent: true });
	}

	/**
	 * Recompute whether the active session has work to merge (worktree session
	 * with uncommitted changes or commits absent from main) and push it to the
	 * webview — drives the "commit & merge" button visibility. Called on
	 * session show and whenever the agent goes idle (turn end).
	 */
	public refreshMergeState(): void {
		const runtime = this.session;
		const cwd = runtime?.cwd;
		if (!runtime || !cwd || cwd === this.getWorkspaceRoot()) {
			this.view?.webview.postMessage({ type: 'updateMergeState', canMerge: false });
			return;
		}
		void sessionHasUncommittedWork(cwd).then(
			(canMerge) => {
				// Only apply if this runtime is still the active session.
				if (this._activeSessionId === runtime.id) {
					this.view?.webview.postMessage({ type: 'updateMergeState', canMerge });
				}
			},
			() => {
				if (this._activeSessionId === runtime.id) {
					this.view?.webview.postMessage({ type: 'updateMergeState', canMerge: false });
				}
			},
		);
	}

	/** Context for the fs handlers (per-runtime cwd + Files). */
	private fsContext(runtime: SessionRuntime): FsHandlerContext {
		return {
			getWorkspaceRoot: () => runtime.cwd,
			files: runtime.files,
			// The git extension's file watcher is debounced (~1s), so nudge the
			// worktree repo after each agent write to keep the SCM view fresh.
			onFileWritten: () => refreshScmStatus(runtime.cwd),
		};
	}

	/** Context for the permission handler (per-runtime pendingPermissions + diff). */
	public permissionContext(runtime: SessionRuntime): PermissionHandlerContext {
		return {
			toolCallInfos: runtime.toolCallInfos,
			pendingPermissions: runtime.pendingPermissions,
			autoAllow: () => this._autoAllowPermissions,
			isActive: () => this._activeSessionId === runtime.id,
			allocatePermissionRequestId: () => runtime.allocatePermissionRequestId(),
			postUpdateMessages: () => {
				if (this._activeSessionId === runtime.id) {
					this.updateMessages();
				}
				this.sendTabs();
			},
			onToolCallCreated: (tc) => runtime.pushToolCallToStreaming(tc),
			openEditDiff: (spec) => this.openEditDiff(spec),
			closeDiff: (diffKey) => this.closeDiffTabs(diffKey),
			readFileText: async (rawPath) => {
				const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(runtime.cwd, rawPath);
				try {
					const data = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
					return Buffer.from(data).toString('utf8');
				} catch {
					return null;
				}
			},
		};
	}

	/**
	 * Open the VS Code Diff Editor for an edit-permission request.
	 * Uses original/proposed content straight from the ACP `type: "diff"` block.
	 */
	public async openEditDiff(spec: EditSpec): Promise<string | undefined> {
		const original = spec.original ?? '';
		const proposed = spec.proposed ?? '';

		const diffKey = `perm-diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const relPath = path.relative(this.getWorkspaceRoot(), spec.filePath) || path.basename(spec.filePath);
		const originalUri = vscode.Uri.parse(`exo-diff:original/${diffKey}/${relPath}`);
		const proposedUri = vscode.Uri.parse(`exo-diff:proposed/${diffKey}/${relPath}`);
		this.diffContents.set(originalUri.toString(), original);
		this.diffContents.set(proposedUri.toString(), proposed);
		const activeColumn = vscode.window.tabGroups.activeTabGroup?.viewColumn ?? vscode.ViewColumn.Active;
		try {
			await vscode.commands.executeCommand(
				'vscode.diff',
				originalUri,
				proposedUri,
				`Review: ${relPath}`,
				{ preserveFocus: true, viewColumn: activeColumn },
			);
		} catch (err) {
			console.error('[Exo ACP] openEditDiff failed:', err);
		}
		return diffKey;
	}

	/** Close the Diff Editor by diffKey + clear diffContents. */
	public closeDiffTabs(diffKey: string): void {
		for (const k of [...this.diffContents.keys()]) {
			if (k.includes(`/${diffKey}/`)) {
				this.diffContents.delete(k);
			}
		}
		void (async () => {
			try {
				for (const group of vscode.window.tabGroups.all) {
					for (const tab of group.tabs) {
						if (tab.input instanceof vscode.TabInputTextDiff) {
							const o = tab.input.original;
							const m = tab.input.modified;
							if (o.scheme === 'exo-diff' && o.path.includes(diffKey)) {
								await vscode.window.tabGroups.close(tab);
							} else if (m.scheme === 'exo-diff' && m.path.includes(diffKey)) {
								await vscode.window.tabGroups.close(tab);
							}
						}
					}
				}
			} catch (err) {
				console.error('[Exo ACP] closeDiffTabs error:', err);
			}
		})();
	}

	/** Close all open Diff Editors for a runtime's pending permissions. Clears diffKey. */
	public closeSessionDiffs(runtime: SessionRuntime): void {
		for (const pending of runtime.pendingPermissions.values()) {
			if (pending.diffKey) {
				this.closeDiffTabs(pending.diffKey);
				pending.diffKey = undefined;
			}
		}
	}

	/** Open deferred Diff Editors for a runtime's pending permissions that have editSpec but no diffKey. */
	public async openDeferredDiffs(runtime: SessionRuntime): Promise<void> {
		for (const pending of runtime.pendingPermissions.values()) {
			if (pending.editSpec && !pending.diffKey) {
				try {
					pending.diffKey = await this.openEditDiff(pending.editSpec);
				} catch (e) {
					console.error('[Exo ACP] openDeferredDiff failed:', e);
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// Draft / persistence
	// ------------------------------------------------------------------

	public updateDraftState(text: string): void {
		if (!this._activeSessionId) {
			return;
		}
		this._drafts.set(this._activeSessionId, { text });
		this.persistDrafts();
	}

	public showConfigRequired(): void {
		this._activeSessionId = null;
		this.view?.webview.postMessage({ type: 'showConfigRequired', configPath: getConfigPath() });
	}

	/** Full disconnect (extension deactivate / config change). Best-effort close + kill all. */
	public disconnectAcp(): void {
		this._pendingSessions.clear();
		for (const [sessionId, terminal] of this._sessionTerminals) {
			try {
				terminal.dispose();
			} catch { /* ignore */ }
			this._sessionTerminals.delete(sessionId);
		}
		for (const runtime of this.sessions.values()) {
			try {
				runtime.acpClient.disconnect();
			} catch { /* ignore */ }
			this.stopTitlePolling(runtime);
			cancelAllPermissions(this.permissionContext(runtime));
			runtime.endStreaming();
		}
		this.sessions.clear();
	}

	/** Pinned repo root — the Explorer may follow the active session, this never moves. */
	public getWorkspaceRoot(): string {
		return this._workspaceRoot;
	}

	/** Validate dropped paths: return valid files and the rejected count (folders/errors). */
	public async validateDroppedFiles(paths: string[]): Promise<{ files: string[]; rejected: number }> {
		const files: string[] = [];
		let rejected = 0;
		for (const p of paths) {
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
				if ((stat.type & vscode.FileType.File) !== 0) {
					files.push(p);
				} else {
					rejected++;
				}
			} catch {
				rejected++;
			}
		}
		return { files, rejected };
	}

	// ------------------------------------------------------------------
	// Persistence
	// ------------------------------------------------------------------

	private restorePersistedUiState(): void {
		const persisted = this.workspaceState.get<PersistedChatUiState>('exo.chatUiState');
		if (persisted && Array.isArray(persisted.tabs)) {
			// Only entries with a valid client-owned tab id (`exo-<N>`) are
			// restored. Anything else (legacy formats, malformed state) is
			// dropped — an entry without a valid id can never be selected,
			// closed or deleted, so it must not resurface in the UI.
			this._tabList = persisted.tabs
				.filter((t): t is TabEntry => isValidTabId(t.tabId))
				.map((t) => ({
					tabId: t.tabId,
					agentSessionId: typeof t.agentSessionId === 'string' ? t.agentSessionId : '',
					title: t.title,
					cwd: t.cwd,
					number: t.number,
				}));
			const active = persisted.activeSessionId;
			this._activeSessionId =
				isValidTabId(active) && this._tabList.some((t) => t.tabId === active) ? active : null;
		}
		const draft = this.workspaceState.get<Record<string, DraftState>>('exo.chatDraft');
		if (draft && typeof draft === 'object') {
			for (const [tabId, entry] of Object.entries(draft)) {
				if (!isValidTabId(tabId)) {
					continue;
				}
				this._drafts.set(tabId, {
					text: entry?.text ?? '',
				});
			}
		}
		const registry = this.workspaceState.get<SessionRegistryEntry[]>('exo.sessionRegistry');
		if (Array.isArray(registry)) {
			this._sessionRegistry = new Map(
				registry
					.filter((e): e is SessionRegistryEntry => isValidTabId(e.tabId))
					.map((e) => [e.tabId, e]),
			);
		}
		// Numbers stay unique across ALL persisted state (tabs + registry), so a
		// fresh session's `exo-<N>` tab id can never collide with an existing
		// entry — tab ids are client-owned and must stay unique. Every number
		// below the high-water mark that no persisted entry holds is free, so
		// after a restart deleted numbers are immediately reusable again.
		const persistedNumbers = [
			...this._tabList.map((t) => t.number),
			...[...this._sessionRegistry.values()].map((e) => sessionNumberFromTabId(e.tabId)),
		];
		const maxNumber = Math.max(...persistedNumbers, 0);
		const used = new Set(persistedNumbers);
		this._freeNumbers.clear();
		for (let n = 1; n <= maxNumber; n++) {
			if (!used.has(n)) {
				this._freeNumbers.add(n);
			}
		}
		this._nextSessionNumber = maxNumber + 1;
	}

	/**
	 * Self-healing: drop recent-session entries whose worktree folder no longer
	 * exists on disk (deleted manually, or a leftover from a past bug). The
	 * registry is a cache — it must never point at a dead path. Runs once at
	 * startup, right after restore.
	 */
	private async pruneDeadRegistryEntries(): Promise<void> {
		const root = this.getWorkspaceRoot();
		let changed = false;
		for (const [tabId, entry] of this._sessionRegistry) {
			if (!entry.cwd || entry.cwd === root || !isExoWorktreePath(entry.cwd)) {
				continue;
			}
			try {
				await fs.promises.access(entry.cwd);
			} catch {
				// Folder gone — the entry is dead. Drop it everywhere.
				this._sessionRegistry.delete(tabId);
				this._drafts.delete(tabId);
				this._tabList = this._tabList.filter((t) => t.tabId !== tabId);
				changed = true;
			}
		}
		if (changed) {
			this.persistRegistrySoon();
			this.persistUiStateSoon();
			this.sendSessionList();
			this.sendTabs();
		}
	}

	private persistUiStateSoon(): void {
		if (this._persistUiTimer) {
			clearTimeout(this._persistUiTimer);
		}
		this._persistUiTimer = setTimeout(() => {
			this._persistUiTimer = null;
			// Never persist a pending (`pending-<n>`) id as the active session.
			const active = this._activeSessionId && !this._pendingSessions.has(this._activeSessionId)
				? this._activeSessionId
				: null;
			void this.workspaceState.update('exo.chatUiState', {
				tabs: this._tabList,
				activeSessionId: active,
			} satisfies PersistedChatUiState);
		}, 50);
	}

	private upsertSessionRegistry(
		tabId: string,
		agentSessionId: string,
		title: string,
		cwd: string,
		updatedAt?: number,
	): void {
		const prev = this._sessionRegistry.get(tabId);
		this._sessionRegistry.set(tabId, {
			tabId,
			agentSessionId,
			title: title || prev?.title || 'Untitled',
			updatedAt: updatedAt ?? prev?.updatedAt ?? Date.now(),
			cwd,
		});
		this.persistRegistrySoon();
	}

	private persistRegistrySoon(): void {
		this._persistRegistryDirty = true;
		if (this._persistRegistryTimer) {
			return;
		}
		this._persistRegistryTimer = setTimeout(() => {
			this._persistRegistryTimer = null;
			if (!this._persistRegistryDirty) {
				return;
			}
			this._persistRegistryDirty = false;
			void this.workspaceState.update(
				'exo.sessionRegistry',
				[...this._sessionRegistry.values()],
			);
		}, 200);
	}

	private postDraftState(): void {
		const draft = this._activeSessionId ? this._drafts.get(this._activeSessionId) : undefined;
		this.view?.webview.postMessage({
			type: 'restoreDraft',
			text: draft?.text ?? '',
		});
	}

	/** Persist non-pending drafts to workspace state. */
	private persistDrafts(): void {
		const record: Record<string, DraftState> = {};
		for (const [tabId, draft] of this._drafts) {
			if (tabId.startsWith('pending-')) {
				continue;
			}
			record[tabId] = draft;
		}
		void this.workspaceState.update('exo.chatDraft', record);
	}
}

// --- ACP tool_call helpers ---

/** Map ACP ToolCallStatus → ToolCallInfo.status. */
function mapToolStatus(s: string | null | undefined): ToolCallInfo['status'] {
	switch (s) {
		case 'completed':
			return 'success';
		case 'failed':
			return 'error';
		case 'pending':
		case 'in_progress':
		default:
			return 'pending';
	}
}

/** First text block's content of a user message ("" when none). */
function messageText(msg: ChatMessage): string {
	const block = msg.blocks.find((b) => b.type === 'text');
	return block && block.type === 'text' ? block.content : '';
}

/** Our own placeholder titles (incl. empty and agent defaults) — never real. */
function isPlaceholderTitle(title: string): boolean {
	return !title || title === 'New Chat' || title === 'Chat' || title === 'Untitled' || DEFAULT_TITLE_PATTERN.test(title);
}

/** Client-side fallback tab title: first non-empty line of the message, clamped. */
function makeFallbackTitle(text: string): string {
	const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
	if (!line) {
		return '';
	}
	return line.length > FALLBACK_TITLE_MAX_LEN
		? `${line.slice(0, FALLBACK_TITLE_MAX_LEN - 1).trimEnd()}…`
		: line;
}

/** No-op ACP callbacks for a throwaway agent (e.g. temp session/delete). */
const NOOP_ACP_CALLBACKS: AcpClientCallbacks = {
	onAgentMessageChunk: () => {},
	onAgentThoughtChunk: () => {},
	onUserMessageChunk: () => {},
	onToolCallCreate: () => {},
	onToolCallUpdate: () => {},
	onPlan: () => {},
	onUsageUpdate: () => {},
	onCurrentModeUpdate: () => {},
	onConfigOptionUpdate: () => {},
	onAvailableCommandsUpdate: () => {},
	onSessionInfoUpdate: () => {},
	onReadTextFile: () => Promise.reject(new Error('no fs in temp agent')),
	onWriteTextFile: () => Promise.resolve(),
	onRequestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
	onError: (e) => console.error('[Exo ACP] temp agent error:', e),
	onDisconnect: () => {},
};
