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
import { createWorktree, registerWorktreeInScm, removeWorktree, hasUncommittedChanges } from '../worktree';
import { StreamThrottle } from './StreamThrottle';
import type { AvailableCommand, PlanEntry } from '@agentclientprotocol/sdk';

interface PersistedChatUiState {
	tabs: Array<{ sessionId: string; title: string; cwd: string }>;
	activeSessionId: string | null;
}

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

const MAX_RECENT_SESSIONS = 10;

/** Poll interval for discovering the agent-generated session title via `session/list`. */
const TITLE_POLL_INTERVAL_MS = 5000;
/** Give up discovering a real title after this long (agent may not title sessions). */
const TITLE_POLL_MAX_MS = 60000;
/** Client-side fallback title: first message line, clamped. */
const FALLBACK_TITLE_MAX_LEN = 48;
/** Default agent titles (e.g. opencode's) — not real, don't read them back. */
const DEFAULT_TITLE_PATTERN = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
	private _tabList: Array<{ sessionId: string; title: string; cwd: string }> = [];

	/** Recent-sessions registry (persistent) — drives the "+" menu. */
	private _sessionRegistry = new Map<string, SessionRegistryEntry>();

	private _autoAllowPermissions = false;
	private _readyHandled = false;
	private _draftState: DraftState = { text: '', attachedFiles: [] };
	private _persistUiTimer: ReturnType<typeof setTimeout> | null = null;
	private _persistRegistryTimer: ReturnType<typeof setTimeout> | null = null;
	private _persistRegistryDirty = false;

	private readonly _messageHandler: WebviewMessageHandler;
	private readonly _htmlProvider: HtmlProvider;
	private readonly _extensionUri: vscode.Uri;

	constructor(
		extensionUri: vscode.Uri,
		public readonly configWatcher: ConfigWatcher,
		public readonly globalState: vscode.Memento,
		private readonly workspaceState: vscode.Memento,
	) {
		this._extensionUri = extensionUri;
		this._messageHandler = new WebviewMessageHandler(this);
		this._htmlProvider = new HtmlProvider(extensionUri);
	}

	public register(context: vscode.ExtensionContext): void {
		const contents = this.diffContents;
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider('exo-diff', {
				provideTextDocumentContent(uri: vscode.Uri): string {
					return contents.get(uri.toString()) ?? '';
				},
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

	/** cwd of the active session (fallback: workspace root). */
	get cwd(): string {
		return this.session?.cwd ?? this.getWorkspaceRoot();
	}

	get messages(): ChatMessage[] {
		return this.session?.messages ?? [];
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

	/** Webview ready: eager connect to the persisted active tab; tabs load lazily. */
	public async handleReady(): Promise<void> {
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

	/** Create a brand-new session: worktree (or shared root) cwd + session/new. */
	public async newSession(): Promise<void> {
		if (!this.acpAgentConfig()) {
			return;
		}
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
		const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		try {
			const runtime = await this.spawnSession(sessionId, cwd, 'new');
			this.finishSessionOpen(runtime, 'New Chat');
		} catch (err) {
			console.error('[Exo ACP] newSession failed:', err);
			vscode.window.showErrorMessage(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
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
		const meta = this._tabList.find((t) => t.sessionId === sessionId)
			?? { sessionId, title: this._sessionRegistry.get(sessionId)?.title ?? 'Chat', cwd: this._sessionRegistry.get(sessionId)?.cwd };
		const cwd = meta.cwd ?? this.getWorkspaceRoot();
		if (cwd !== this.getWorkspaceRoot()) {
			void registerWorktreeInScm(cwd);
		}
		try {
			const runtime = await this.spawnSession(sessionId, cwd, 'load');
			this.finishSessionOpen(runtime, meta.title);
		} catch (err) {
			console.error('[Exo ACP] switchSession failed:', err);
			// Session load failed — restart it (agent may have lost the session).
			try {
				const runtime = await this.spawnSession(sessionId, cwd, 'new');
				this.finishSessionOpen(runtime, 'New Chat');
			} catch (err2) {
				console.error('[Exo ACP] fallback newSession failed:', err2);
				vscode.window.showErrorMessage(`Failed to open session ${sessionId}`);
			}
		}
	}

	/** Close the tab: kill the agent process. Session stays in the recent menu. */
	public async closeTab(sessionId: string): Promise<void> {
		const runtime = this.sessions.get(sessionId);
		if (runtime) {
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
		}
		this._tabList = this._tabList.filter((t) => t.sessionId !== sessionId);
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
	}

	/** Permanently delete a session (from the recent menu). Optimistic UI; worktree handling in background. */
	public async deleteSession(sessionId: string): Promise<void> {
		const entry = this._sessionRegistry.get(sessionId);
		const listEntry = this._tabList.find((t) => t.sessionId === sessionId);
		const cwd = listEntry?.cwd ?? entry?.cwd;

		// 1. Delete on the agent — from the live runtime or a temp process.
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
			console.error('[Exo ACP] deleteSession failed (optimistic — continuing):', err);
		}

		// 2. Remove from tabs/registry.
		this._tabList = this._tabList.filter((t) => t.sessionId !== sessionId);
		this._sessionRegistry.delete(sessionId);
		if (this._activeSessionId === sessionId) {
			const next = this._tabList[this._tabList.length - 1];
			if (next) {
				await this.switchSession(next.sessionId);
			} else {
				this.showEmpty();
			}
		}
		this.persistUiStateSoon();

		// 3. Worktree cleanup (background-ish, may prompt).
		if (cwd && cwd !== this.getWorkspaceRoot()) {
			try {
				const dirty = await hasUncommittedChanges(cwd);
				if (dirty) {
					const choice = await vscode.window.showWarningMessage(
						'This session\'s worktree has uncommitted changes. Delete the worktree anyway?',
						{ modal: true },
						'Delete worktree',
						'Keep worktree',
					);
					if (choice !== 'Delete worktree') {
						this.sendTabs();
						this.sendSessionList();
						return;
					}
				}
				await removeWorktree(cwd);
			} catch (err) {
				console.error('[Exo] worktree removal failed:', err);
			}
		}
		this.sendTabs();
		this.sendSessionList();
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

	private spawnSession(
		sessionId: string,
		cwd: string,
		mode: 'new' | 'load',
	): Promise<SessionRuntime> {
		const cfg = this.acpAgentConfig();
		if (!cfg) {
			return Promise.reject(new Error('No ACP agent configured in config.yml (expected agents[0])'));
		}

		const runtime = new SessionRuntime(sessionId, cwd, this.buildRuntimeCallbacks(sessionId));
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
			return runtime;
		})();
	}

	/** Register the runtime in sessions + tabs + registry, save state, show it. */
	private finishSessionOpen(runtime: SessionRuntime, title: string): void {
		this.sessions.set(runtime.id, runtime);
		runtime.title = title;
		if (!this._tabList.some((t) => t.sessionId === runtime.id)) {
			this._tabList.push({ sessionId: runtime.id, title, cwd: runtime.cwd });
		}
		this.upsertSessionRegistry(runtime.id, title, runtime.cwd);
		this.persistUiStateSoon();
		this.showSessionRuntime(runtime);
		this.sendTabs();
		this.sendSessionList();
	}

	private buildRuntimeCallbacks(sessionId: string): SessionRuntimeCallbacks {
		return {
			sendPlan: () => {
				if (this._activeSessionId !== sessionId) return;
				this.view?.webview.postMessage({ type: 'updatePlan', plan: this.currentPlan });
			},
			sendMessages: () => this.updateMessages(),
			sendTokenUsage: () => {
				if (this._activeSessionId !== sessionId) return;
				this.sendTokenUsageFor(sessionId);
			},
			sendConfig: () => this.sendConfig(),
			sendCommands: () => {
				if (this._activeSessionId !== sessionId) return;
				this.sendAvailableCommandsFor(sessionId);
			},
			sendTabs: () => this.sendTabs(),
			sendAgentRunning: (running: boolean) => {
				if (this._activeSessionId !== sessionId) return;
				this.view?.webview.postMessage({ type: 'updateAgentRunning', running });
			},
			isActive: () => this._activeSessionId === sessionId,
			sendStreamChunk: (index, blocks) => {
				if (this._activeSessionId !== sessionId) return;
				this.view?.webview.postMessage({ type: 'streamChunk', sessionId, index, blocks });
			},
		};
	}

	private buildAcpCallbacks(runtime: SessionRuntime): AcpClientCallbacks {
		const sessionId = runtime.id;
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
					this.applySessionTitle(sessionId, title, updatedAt ? new Date(updatedAt).getTime() : undefined);
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
				runtime.isStreaming = false;
				runtime.agentRunning = false;
				if (this.sessions.get(sessionId) === runtime) {
					this.sessions.delete(sessionId);
				}
				if (this._activeSessionId === sessionId) {
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
	 */
	public ensureSessionTitle(runtime: SessionRuntime, messageText: string): void {
		if (runtime.titlePollStarted || this.sessions.get(runtime.id) !== runtime) {
			return;
		}
		const fallback = isPlaceholderTitle(runtime.title) ? makeFallbackTitle(messageText) : '';
		if (fallback) {
			this.applySessionTitle(runtime.id, fallback);
		}
		if (runtime.acpClient.canList) {
			this.startTitlePolling(runtime);
		}
	}

	/** Poll `session/list` every 5s (max 1 min) until a real title appears. */
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
		this._activeSessionId = null;
		this.persistUiStateSoon();
		this.view?.webview.postMessage({ type: 'showEmpty' });
		this.sendTabs();
	}

	/** Show a runtime's chat in the webview. */
	private showSessionRuntime(runtime: SessionRuntime): void {
		this._activeSessionId = runtime.id;
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
		this.sendTabs();
	}

	public updateMessages(): void {
		this.view?.webview.postMessage({ type: 'updateMessages', messages: this.messages });
	}

	/** Tab strip: title + status per open tab. */
	public sendTabs(): void {
		const tabs = this._tabList.map((t) => {
			const runtime = this.sessions.get(t.sessionId);
			return {
				sessionId: t.sessionId,
				title: runtime?.title || t.title,
				status: runtime ? runtime.status : 'idle',
			};
		});
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
		const { selectors, currentModeId } = buildConfigSelectors(client.configOptions ?? null);
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
			this.sendConfig();
		} catch (e) {
			console.error(`[Exo ACP] selectConfigOption(${configId}) failed:`, e);
		}
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
			runtime.pendingFollowUpMessage = followUpText.trim();
			runtime.messages.push({
				role: 'user',
				blocks: [{ type: 'text', content: followUpText.trim() }],
				isQueued: true,
			});
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
			allocatePermissionRequestId: () => runtime.allocatePermissionRequestId(),
			postUpdateMessages: () => {
				this.updateMessages();
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

	// ------------------------------------------------------------------
	// Draft / persistence
	// ------------------------------------------------------------------

	public updateDraftState(text: string, attachedFiles: string[]): void {
		this._draftState = { text, attachedFiles: [...attachedFiles] };
		void this.workspaceState.update('exo.chatDraft', this._draftState);
	}

	public showConfigRequired(): void {
		this._activeSessionId = null;
		this.view?.webview.postMessage({ type: 'showConfigRequired', configPath: getConfigPath() });
	}

	/** Full disconnect (extension deactivate / config change). Best-effort close + kill all. */
	public disconnectAcp(): void {
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

	public getWorkspaceRoot(): string {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			return folders[0].uri.fsPath;
		}
		return process.cwd();
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
				this._tabList = (persisted as PersistedChatUiState).tabs;
				this._activeSessionId = (persisted as PersistedChatUiState).activeSessionId;
			} else {
				// Migrate legacy shape ({ activeSessionId, view, sessionTitle }).
				const legacy = persisted as { activeSessionId?: string | null; sessionTitle?: string };
				if (legacy.activeSessionId) {
					this._tabList = [{
						sessionId: legacy.activeSessionId,
						title: legacy.sessionTitle ?? 'Chat',
						cwd: this.getWorkspaceRoot(),
					}];
					this._activeSessionId = legacy.activeSessionId;
				}
			}
		}
		const draft = this.workspaceState.get<DraftState>('exo.chatDraft');
		if (draft) {
			this._draftState = {
				text: draft.text ?? '',
				attachedFiles: Array.isArray(draft.attachedFiles) ? draft.attachedFiles : [],
			};
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
			void this.workspaceState.update('exo.chatUiState', {
				tabs: this._tabList,
				activeSessionId: this._activeSessionId,
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
		this.view?.webview.postMessage({
			type: 'restoreDraft',
			text: this._draftState.text,
			attachedFiles: this._draftState.attachedFiles,
		});
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
