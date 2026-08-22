import * as vscode from 'vscode';
import * as path from 'path';
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
import { applyToolCallPatch, type EditSpec } from '../acp/handlers/util';
import { createWorktree, isGitRepository, registerWorktreeInScm, removeWorktree, sessionHasUncommittedWork } from '../worktree';
import {
	WorkspaceFolderSwitcher,
	dismissWorkspaceModePrompt,
	enterManagedWorkspace,
	getPinnedRoot,
	isExoWorktreePath,
	isWorkspaceModePromptDismissed,
	pinRoot,
} from '../workspaceMode';
import { StreamThrottle } from './StreamThrottle';
import type { AvailableCommand, PlanEntry } from '@agentclientprotocol/sdk';

interface PersistedChatUiState {
	tabs: Array<{ sessionId: string; title: string; cwd: string; number: number }>;
	activeSessionId: string | null;
}

/**
 * Per-agent remembered config setup, keyed by mode: which (model, effort) was
 * last selected with each mode. Applied when the user switches modes — the
 * agent still picks the default mode/model on session creation.
 * Persisted in globalState under `exo.lastSetupByMode`.
 */
interface LastSetupByMode {
	[agentId: string]: Record<string, { model: string; effort: string }>;
}

/** globalState key for `LastSetupByMode`. */
const LAST_SETUP_BY_MODE_KEY = 'exo.lastSetupByMode';

interface DraftState {
	text: string;
	attachedFiles: string[];
}

/** Session registry entry (the "recent sessions" menu source). Persistent. */
interface SessionRegistryEntry {
	sessionId: string;
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
	/** Ordinal session number — already assigned at pending time, carried to the runtime. */
	number: number;
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
 * User-message sent by the "commit & merge to main" button. Kept terse — the
 * agent generates the commit message itself, in the conversation's language.
 */
const COMMIT_AND_MERGE_PROMPT = 'Commit all your changes and merge them into the main branch.';

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

/** Terminal label: `exo: #N` — the session's ordinal number (matches the header badge). */
function formatTerminalName(number: number): string {
	return `exo: #${number}`;
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
	private _tabList: Array<{ sessionId: string; title: string; cwd: string; number: number }> = [];

	/** Next ordinal session number to hand out (monotonic; resets when no tabs are open). */
	private _nextSessionNumber = 1;

	/** Recent-sessions registry (persistent) — drives the "+" menu. */
	private _sessionRegistry = new Map<string, SessionRegistryEntry>();

	/** In-flight create/load operations (loading tabs). Not persisted. */
	private _pendingSessions = new Map<string, PendingSession>();
	private _pendingCounter = 0;

	private _autoAllowPermissions = false;
	private _readyHandled = false;

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
	 * managed workspace may reopen on the last active session's folder), in
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
	 * One-time onboarding: in a single-folder window, offer reopening the
	 * project as the managed Exo workspace — the prerequisite for reload-free
	 * Explorer-follow (see workspaceMode.ts). Prompted on extension activation.
	 */
	public async maybePromptWorkspaceMode(): Promise<void> {
		try {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length !== 1 || vscode.workspace.workspaceFile) {
				return; // empty window or already a workspace (ours or the user's)
			}
			if (!vscode.workspace.isTrusted) {
				return;
			}
			if (isWorkspaceModePromptDismissed(this.globalState)) {
				return;
			}
			if (!vscode.workspace.getConfiguration('exo').get<boolean>('followSessionFolder', true)) {
				return;
			}
			if (folders[0].uri.fsPath !== this._workspaceRoot) {
				return;
			}
			if (!(await isGitRepository(this._workspaceRoot))) {
				return;
			}
			const choice = await vscode.window.showInformationMessage(
				'Exo: чтобы Explorer автоматически следовал за активной сессией, открой проект как воркспейс Exo.',
				'Переоткрыть как воркспейс Exo',
				'Не сейчас',
				'Больше не спрашивать',
			);
			if (choice === 'Переоткрыть как воркспейс Exo') {
				// Pin BEFORE the reload — workspaceState dies with the workspace id.
				pinRoot(this.globalState, this._workspaceRoot);
				await enterManagedWorkspace(this._workspaceRoot);
			} else if (choice === 'Больше не спрашивать') {
				dismissWorkspaceModePrompt(this.globalState);
			}
		} catch (err) {
			console.error('[Exo] workspace mode prompt failed:', err);
		}
	}

	/** Webview ready: eager connect to the persisted active tab; tabs load lazily. */
	public async handleReady(): Promise<void> {
		this._workspaceRoot = this.resolveWorkspaceRoot();
		if (!this._readyHandled) {
			this._readyHandled = true;
			this.restorePersistedUiState();
		}
		this.postDraftState();
		if (!this.configWatcher.config.agents?.length) {
			this.showConfigRequired();
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

	/** Create a brand-new session: worktree (or shared root) cwd + session/new. Returns the runtime or null. */
	public async newSession(): Promise<SessionRuntime | null> {
		if (!this.acpAgentConfig()) {
			return null;
		}
		// Ignore repeated clicks while a create is already in flight.
		for (const p of this._pendingSessions.values()) {
			if (p.mode === 'new') {
				return null;
			}
		}
		const pending = this.addPendingSession('new', 'New Chat', this._activeSessionId ?? undefined);
		let cwd = this.getWorkspaceRoot();
		try {
			const wt = await createWorktree(this.getWorkspaceRoot());
			if (wt) {
				cwd = wt.path;
				void registerWorktreeInScm(cwd);
			}
		} catch (err) {
			console.error('[Exo] worktree creation failed, using shared root:', err);
		}
		try {
			// Create the terminal NOW (before the agent spawn — the slow part),
			// so it never pops up while the user is already typing; the chat
			// view and input autofocus come after it.
			this.createPendingTerminal(pending, cwd);
			this.postPendingView(pending);
			const runtime = await this.spawnSession('', cwd, 'new');
			this.resolvePendingSession(pending, runtime, 'New Chat');
			return runtime;
		} catch (err) {
			console.error('[Exo ACP] newSession failed:', err);
			this.failPendingSession(pending);
			vscode.window.showErrorMessage(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/**
	 * Switch to a session (tab click or menu click). If the runtime is already
	 * alive — show it. If it's only a persisted tab/registry entry — spawn a
	 * fresh agent (session/load or session/resume) lazily.
	 */
	public async switchSession(sessionId: string): Promise<void> {
		const existing = this.sessions.get(sessionId);
		if (existing && existing.acpClient.connected) {
			this.showSessionRuntime(existing);
			return;
		}
		// Lazy spawn: recreate the agent process and reload the session.
		const tab = this._tabList.find((t) => t.sessionId === sessionId);
		const meta = tab
			?? { sessionId, title: this._sessionRegistry.get(sessionId)?.title ?? 'Chat', cwd: this._sessionRegistry.get(sessionId)?.cwd };
		const cwd = meta.cwd ?? this.getWorkspaceRoot();
		const pending = this.addPendingSession('load', meta.title, this._activeSessionId ?? undefined, tab?.number);
		if (cwd !== this.getWorkspaceRoot()) {
			void registerWorktreeInScm(cwd);
		}
		try {
			this.createPendingTerminal(pending, cwd);
			this.postPendingView(pending);
			const runtime = await this.spawnSession(sessionId, cwd, 'load');
			this.resolvePendingSession(pending, runtime, meta.title);
		} catch (err) {
			console.error('[Exo ACP] switchSession failed:', err);
			// Session load failed — restart it (agent may have lost the session).
			try {
				const runtime = await this.spawnSession(sessionId, cwd, 'new');
				this.resolvePendingSession(pending, runtime, 'New Chat');
			} catch (err2) {
				console.error('[Exo ACP] fallback newSession failed:', err2);
				this.failPendingSession(pending);
				vscode.window.showErrorMessage(`Failed to open session ${sessionId}`);
			}
		}
	}

	/** Close the tab: kill the agent process. Session stays in the recent menu. */
	public async closeTab(sessionId: string): Promise<void> {
		// Cancel an in-flight create/load if its loading tab is closed.
		const pending = this._pendingSessions.get(sessionId);
		if (pending) {
			pending.cancelled = true;
			this._pendingSessions.delete(sessionId);
			this._drafts.delete(sessionId);
		}

		// Optimistic: remove the tab from the UI immediately.
		this._tabList = this._tabList.filter((t) => t.sessionId !== sessionId);
		if (this._tabList.length === 0) {
			this._nextSessionNumber = 1;
		}
		this.persistUiStateSoon();
		this.sendTabs();
		if (this._activeSessionId === sessionId) {
			const next = this._tabList[this._tabList.length - 1];
			if (next) {
				await this.switchSession(next.sessionId);
			} else {
				this.showEmpty();
			}
		}
		this.sendSessionList();

		// Background: close + kill the agent (best-effort, no UI wait).
		const runtime = this.sessions.get(sessionId);
		if (runtime) {
			void (async () => {
				try {
					if (runtime.acpClient.canClose) {
						await runtime.acpClient.closeSession(sessionId);
					}
				} catch (err) {
					console.error('[Exo ACP] closeSession failed (best-effort):', err);
				}
				try {
					runtime.acpClient.disconnect();
				} catch { /* ignore */ }
				this.stopTitlePolling(runtime);
				cancelAllPermissions(this.permissionContext(runtime));
				this.sessions.delete(sessionId);
				this.sendTabs();
			})();
		}
		this.disposeSessionTerminal(sessionId);
	}

	/** Permanently delete a session (from the recent menu). Optimistic UI; worktree handling in background. */
	public async deleteSession(sessionId: string): Promise<void> {
		const entry = this._sessionRegistry.get(sessionId);
		const listEntry = this._tabList.find((t) => t.sessionId === sessionId);
		const cwd = listEntry?.cwd ?? entry?.cwd;

		// A git worktree session: warn before destroying work that only lives
		// here (uncommitted changes or commits absent from main). Non-git
		// sessions (cwd === workspace root) delete silently.
		if (cwd && cwd !== this.getWorkspaceRoot()) {
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
				}
			} catch (err) {
				console.error('[Exo] worktree dirty-check failed (deleting anyway):', err);
			}
		}

		// Optimistic: remove from tabs/registry immediately.
		this._tabList = this._tabList.filter((t) => t.sessionId !== sessionId);
		if (this._tabList.length === 0) {
			this._nextSessionNumber = 1;
		}
		this._sessionRegistry.delete(sessionId);
		this._drafts.delete(sessionId);
		this.persistDrafts();
		this.persistUiStateSoon();
		this.sendTabs();
		this.sendSessionList();
		if (this._activeSessionId === sessionId) {
			const next = this._tabList[this._tabList.length - 1];
			if (next) {
				void this.switchSession(next.sessionId);
			} else {
				this.showEmpty();
			}
		}

		// Background: delete on the agent + remove the worktree folder.
		void (async () => {
			this.disposeSessionTerminal(sessionId);
			const runtime = this.sessions.get(sessionId);
			try {
				if (runtime) {
					try {
						if (runtime.acpClient.canDelete) {
							await runtime.acpClient.deleteSession(sessionId);
						}
					} finally {
						try { runtime.acpClient.disconnect(); } catch { /* ignore */ }
						this.stopTitlePolling(runtime);
						this.sessions.delete(sessionId);
					}
				} else if (cwd) {
					await this.deleteSessionViaTempAgent(sessionId, cwd);
				}
			} catch (err) {
				console.error('[Exo ACP] deleteSession failed (session may persist on agent):', err);
				vscode.window.showWarningMessage('Exo: failed to delete the session on the agent.');
			}
			if (cwd && cwd !== this.getWorkspaceRoot()) {
				try {
					await removeWorktree(cwd);
				} catch (err) {
					console.error('[Exo] worktree removal failed:', err);
				}
			}
		})();
	}

	private async deleteSessionViaTempAgent(sessionId: string, cwd: string): Promise<void> {
		const cfg = this.acpAgentConfig();
		if (!cfg) {
			return;
		}
		const client = new AcpClient(cfg, {
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
		});
		try {
			await client.connect(cwd);
			if (client.canDelete) {
				await client.deleteSession(sessionId);
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
	 * Start an in-flight session op: show a loading tab + the pending view
	 * immediately, resolve it when the real runtime exists. `new` sessions are
	 * optimistic — an empty chat + input is shown and messages typed meanwhile
	 * are queued; `load` sessions keep the full-area loading view (content
	 * comes from agent replay, nothing to interact with).
	 */
	private addPendingSession(mode: 'new' | 'load', title: string, prevActiveId?: string, number?: number): PendingSession {
		const pending: PendingSession = {
			id: `pending-${++this._pendingCounter}`,
			title,
			mode,
			number: number ?? this._nextSessionNumber++,
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
			this.view?.webview.postMessage({ type: 'showChat', sessionId: pending.id, messages: this.messages, plan: null });
			// Never let a stale `agentRunning` from the previous session disable the input.
			this.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
			// A fresh session starts with an empty draft (not the previous session's text).
			this.postDraftState();
		} else {
			this.view?.webview.postMessage({ type: 'showChatLoading', sessionId: pending.id, title: pending.title, mode: 'load' });
		}
	}

	/** Swap a pending loading tab for the real runtime (or dispose if cancelled). */
	private resolvePendingSession(pending: PendingSession, runtime: SessionRuntime, title: string): void {
		this._pendingSessions.delete(pending.id);
		if (pending.cancelled) {
			// Tab was closed while loading — don't leak the spawned agent or the terminal.
			this.disposeSessionTerminal(pending.id);
			try {
				runtime.acpClient.disconnect();
			} catch { /* ignore */ }
			return;
		}
		// Adopt the number + terminal created during the pending phase.
		runtime.number = pending.number;
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
				void this._messageHandler.handleUserMessage(text, first.attachedFiles, first.images, {
					preQueued: true,
					runtime,
					queuedMessage: first,
				});
			}
		}
	}

	/** A pending op failed: restore the previous active view (or show empty). */
	private failPendingSession(pending: PendingSession): void {
		this._pendingSessions.delete(pending.id);
		this._drafts.delete(pending.id);
		this.disposeSessionTerminal(pending.id);
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
		sessionId: string,
		cwd: string,
		mode: 'new' | 'load',
	): Promise<SessionRuntime> {
		const cfg = this.acpAgentConfig();
		if (!cfg) {
			return Promise.reject(new Error('No ACP agent configured in config.yml (expected agents[0])'));
		}

		const runtime: SessionRuntime = new SessionRuntime(sessionId, cwd, this.buildRuntimeCallbacks(() => runtime.id));
		runtime.acpClient = new AcpClient(cfg, this.buildAcpCallbacks(runtime));

		return (async () => {
			await runtime.acpClient.connect(cwd);
			if (mode === 'new') {
				await runtime.acpClient.sessionNew(cwd);
			} else if (runtime.acpClient.canLoadSession) {
				this.startReplay(runtime);
				await runtime.acpClient.sessionLoad(sessionId, cwd);
				this.endReplay(runtime);
			} else if (runtime.acpClient.canResume) {
				await runtime.acpClient.sessionResume(sessionId, cwd);
				runtime.messages = [];
				this.endReplay(runtime);
			} else {
				throw new Error('Agent cannot load or resume sessions');
			}
			runtime.id = runtime.acpClient.sessionId ?? sessionId;
			return runtime;
		})();
	}

	/** Register the runtime in sessions + tabs + registry, save state, optionally show it. */
	private finishSessionOpen(runtime: SessionRuntime, title: string, activate = true): void {
		this.sessions.set(runtime.id, runtime);
		runtime.title = title;
		if (!this._tabList.some((t) => t.sessionId === runtime.id)) {
			this._tabList.push({ sessionId: runtime.id, title, cwd: runtime.cwd, number: runtime.number });
		}
		this.upsertSessionRegistry(runtime.id, title, runtime.cwd);
		this.persistUiStateSoon();
		this.ensureSessionTerminal(runtime);
		if (activate) {
			this.showSessionRuntime(runtime);
		}
		this.sendTabs();
		this.sendSessionList();
	}

	/**
	 * Create a terminal named `exo: #N` rooted in `cwd` (worktree). Created
	 * hidden and transient: it only surfaces when the user is in the terminal
	 * panel, and is never resurrected after a VS Code restart.
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
	 *  pops up mid-typing); keyed by the pending id until the runtime resolves. */
	private createPendingTerminal(pending: PendingSession, cwd: string): vscode.Terminal {
		const existing = this._sessionTerminals.get(pending.id);
		if (existing) {
			return existing;
		}
		const terminal = this.createSessionTerminal(pending.number, cwd);
		this._sessionTerminals.set(pending.id, terminal);
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

	/** Get the runtime's terminal (usually created during the pending phase). */
	private ensureSessionTerminal(runtime: SessionRuntime): vscode.Terminal {
		const existing = this._sessionTerminals.get(runtime.id);
		if (existing) {
			return existing;
		}
		const terminal = this.createSessionTerminal(runtime.number, runtime.cwd);
		this._sessionTerminals.set(runtime.id, terminal);
		return terminal;
	}

	/** Kill a session's terminal (tab close / session delete). */
	private disposeSessionTerminal(sessionId: string): void {
		const terminal = this._sessionTerminals.get(sessionId);
		if (!terminal) {
			return;
		}
		this._sessionTerminals.delete(sessionId);
		try {
			terminal.dispose();
		} catch { /* ignore */ }
	}

	private buildRuntimeCallbacks(getId: () => string): SessionRuntimeCallbacks {
		return {
			sendPlan: () => {
				if (this._activeSessionId !== getId()) return;
				this.view?.webview.postMessage({ type: 'updatePlan', plan: this.currentPlan });
			},
			sendMessages: () => this.updateMessages(),
			sendTokenUsage: () => {
				if (this._activeSessionId !== getId()) return;
				this.sendTokenUsageFor(getId());
			},
			sendConfig: () => this.sendConfig(),
			sendCommands: () => {
				if (this._activeSessionId !== getId()) return;
				this.sendAvailableCommandsFor(getId());
			},
			sendTabs: () => this.sendTabs(),
			sendAgentRunning: (running: boolean) => {
				if (this._activeSessionId !== getId()) return;
				this.view?.webview.postMessage({ type: 'updateAgentRunning', running });
			},
			isActive: () => this._activeSessionId === getId(),
			sendStreamChunk: (index, blocks) => {
				if (this._activeSessionId !== getId()) return;
				this.view?.webview.postMessage({ type: 'streamChunk', sessionId: getId(), index, blocks });
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
				const tc: ToolCallInfo = {
					name: 'other',
					args: {},
					status: mapToolStatus(update.status),
					summary: update.title ?? update.kind ?? '',
					toolCallId: update.toolCallId,
				};
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
				runtime.callbacks.sendConfig();
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
	private applySessionTitle(sessionId: string, title: string, updatedAt?: number): void {
		const runtime = this.sessions.get(sessionId);
		if (!runtime) {
			return;
		}
		runtime.title = title;
		const t = this._tabList.find((x) => x.sessionId === sessionId);
		if (t) {
			t.title = title;
		}
		this.upsertSessionRegistry(sessionId, title, runtime.cwd, updatedAt);
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
		const entry = resp.sessions.find((s) => s.sessionId === runtime.id);
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
		this.persistUiStateSoon();
		this.view?.webview.postMessage({
			type: 'showChat',
			sessionId: runtime.id,
			messages: runtime.messages,
			plan: runtime.currentPlan,
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
		this.ensureSessionTerminal(runtime).show(true);
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
				const runtime = this.sessions.get(t.sessionId);
				return {
					sessionId: t.sessionId,
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
				sessionId: e.sessionId,
				title: e.title || 'Untitled',
				updatedAt: e.updatedAt,
				active: this.sessions.has(e.sessionId),
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
		try {
			await client.setConfigOption(configId, value);
			const agentId = this.acpAgentConfig()?.id;
			if (agentId) {
				// Mode switch → pull the (model, effort) last used with this mode
				// (from any session). Best-effort; invalid values are skipped.
				const { selectors } = buildConfigSelectors(client.configOptions ?? null, client.clientSelection);
				const modeSel = selectors.find((s) => s.category === 'mode');
				if (modeSel && modeSel.id === configId) {
					await this.applyRememberedSetup(agentId, modeSel.currentValue);
				}
				// Snapshot the final state last, so the current mode's record is
				// never clobbered with the previous mode's (model, effort).
				this.rememberSetup(agentId);
			}
			this.sendConfig();
		} catch (e) {
			console.error(`[Exo ACP] selectConfigOption(${configId}) failed:`, e);
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

	/** Apply the remembered (model, effort) for a freshly-selected mode (best-effort). */
	private async applyRememberedSetup(agentId: string, modeId: string): Promise<void> {
		const client = this.session?.acpClient;
		if (!client) {
			return;
		}
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
	 * user message) to commit its work and merge the worktree branch into main.
	 * Host-side git is intentionally avoided — the agent picks the commit
	 * message in the conversation's language. The button is gated on
	 * `canMerge` (see `refreshMergeState`), so it only fires when there is
	 * unmerged work.
	 */
	public mergeToMain(): void {
		const runtime = this.session;
		if (!runtime || runtime.agentRunning || runtime.isStreaming) {
			return;
		}
		if (runtime.cwd === this.getWorkspaceRoot()) {
			return;
		}
		void this._messageHandler.handleUserMessage(COMMIT_AND_MERGE_PROMPT, undefined, undefined, { mergeIntent: true });
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
			toolCallInfos: runtime.toolCallInfos,
			postUpdateMessages: () => this.updateMessages(),
			onToolCallCreated: (tc) => runtime.pushToolCallToStreaming(tc),
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

	public updateDraftState(text: string, attachedFiles: string[]): void {
		if (!this._activeSessionId) {
			return;
		}
		this._drafts.set(this._activeSessionId, { text, attachedFiles: [...attachedFiles] });
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
		const persisted = this.workspaceState.get<PersistedChatUiState | {
			activeSessionId?: string | null;
			view?: 'list' | 'chat';
			sessionTitle?: string;
		}>('exo.chatUiState');
		if (persisted) {
			if (Array.isArray((persisted as PersistedChatUiState).tabs)) {
				// Restore per-session numbers (older state without them gets fresh ones).
				let next = 1;
				this._tabList = ((persisted as PersistedChatUiState).tabs as Array<{
					sessionId: string;
					title: string;
					cwd: string;
					number?: number;
				}>).map((t) => ({
					sessionId: t.sessionId,
					title: t.title,
					cwd: t.cwd,
					number: typeof t.number === 'number' && t.number > 0 ? t.number : next++,
				}));
				this._activeSessionId = (persisted as PersistedChatUiState).activeSessionId;
			} else {
				// Migrate legacy shape ({ activeSessionId, view, sessionTitle }).
				const legacy = persisted as { activeSessionId?: string | null; sessionTitle?: string };
				if (legacy.activeSessionId) {
					this._tabList = [{
						sessionId: legacy.activeSessionId,
						title: legacy.sessionTitle ?? 'Chat',
						cwd: this.getWorkspaceRoot(),
						number: 1,
					}];
					this._activeSessionId = legacy.activeSessionId;
				}
			}
		}
		const maxNumber = this._tabList.reduce((m, t) => Math.max(m, t.number), 0);
		this._nextSessionNumber = maxNumber + 1;
		const draft = this.workspaceState.get<DraftState | Record<string, DraftState>>('exo.chatDraft');
		if (draft) {
			if (Array.isArray(draft.attachedFiles) || typeof draft.text === 'string') {
				// Legacy single-draft shape — attribute to the restored active session.
				const legacy = draft as DraftState;
				if (this._activeSessionId) {
					this._drafts.set(this._activeSessionId, {
						text: legacy.text ?? '',
						attachedFiles: Array.isArray(legacy.attachedFiles) ? legacy.attachedFiles : [],
					});
				}
			} else {
				for (const [sessionId, entry] of Object.entries(draft)) {
					if (sessionId.startsWith('pending-')) {
						continue;
					}
					this._drafts.set(sessionId, {
						text: entry?.text ?? '',
						attachedFiles: Array.isArray(entry?.attachedFiles) ? entry.attachedFiles : [],
					});
				}
			}
		}
		const registry = this.workspaceState.get<SessionRegistryEntry[]>('exo.sessionRegistry');
		if (Array.isArray(registry)) {
			this._sessionRegistry = new Map(registry.map((e) => [e.sessionId, e]));
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
		sessionId: string,
		title: string,
		cwd: string,
		updatedAt?: number,
	): void {
		const prev = this._sessionRegistry.get(sessionId);
		this._sessionRegistry.set(sessionId, {
			sessionId,
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
			attachedFiles: draft?.attachedFiles ?? [],
		});
	}

	/** Persist non-pending drafts to workspace state. */
	private persistDrafts(): void {
		const record: Record<string, DraftState> = {};
		for (const [sessionId, draft] of this._drafts) {
			if (sessionId.startsWith('pending-')) {
				continue;
			}
			record[sessionId] = draft;
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
