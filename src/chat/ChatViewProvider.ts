import * as vscode from 'vscode';
import * as path from 'path';
import { getConfigPath } from '../config';
import type { ConfigWatcher } from '../configWatcher';
import { Files } from '../files/Files';
import type { ChatMessage, PendingPermission, ToolCallInfo } from './types';
import type { Plan, PlanItem } from '../tools/types';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { HtmlProvider } from './HtmlProvider';
import { StreamThrottle } from './StreamThrottle';
import { AcpClient, type AcpClientCallbacks } from '../acp/AcpClient';
import { buildConfigSelectors } from './configSelectors';
import { handleReadTextFile, handleWriteTextFile, type FsHandlerContext } from '../acp/handlers/fs';
import { applyToolCallPatch, extractPlanFromToolArgs, type EditSpec } from '../acp/handlers/util';
import {
	handleRequestPermission,
	resolvePermission as resolvePermissionImpl,
	cancelAllPermissions,
	type PermissionHandlerContext,
} from '../acp/handlers/permission';
import type { PlanEntry, ContentBlock } from '@agentclientprotocol/sdk';
import type { AvailableCommand } from '@agentclientprotocol/sdk';

interface PersistedChatUiState {
	activeSessionId: string | null;
	view: 'list' | 'chat';
	sessionTitle: string;
}

interface DraftState {
	text: string;
	attachedFiles: string[];
}

/**
 * ChatViewProvider — thin ACP client (push-model).
 *
 * No local session/history storage — the agent is the source of truth.
 * Eager connect on ready → session/list → UI. Sessions are created/loaded
 * via ACP (session/new|load|resume|close|delete). Session/load replay flows
 * through onNotification → _dispatchUpdate → callbacks (same as prompt).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'exo.chatView';

	public view?: vscode.WebviewView;
	public messages: ChatMessage[] = [];
	public isStreaming = false;
	public agentRunning = false;
	public stopped = false;

	/** Shared content store for the `exo-diff:` scheme (edit-permission Diff Editor). */
	public readonly diffContents = new Map<string, string>();

	// Permission flow (ACP session/request_permission)
	public readonly pendingPermissions = new Map<string, PendingPermission>();
	private _permissionRequestIdCounter = 0;
	private _autoAllowPermissions = false;

	/** Follow-up message pending after a reject-with-response (sent when turn ends). */
	private _pendingFollowUpMessage: string | null = null;

	/** Current mode id from ACP (onCurrentModeUpdate) */
	public mode = '';

	// File cache (used by fs/read_text_file and replaceFull)
	public readonly files = new Files();

	// ACP
	public acpClient: AcpClient | null = null;

	/** ACP toolCallId → ToolCallInfo (for updates via tool_call_update). Cleared on new turn start. */
	public readonly toolCallInfos = new Map<string, ToolCallInfo>();

	// Streaming state
	public streamingIndex: number | null = null;
	public streamThrottle: StreamThrottle | null = null;

	/** Current plan (ACP session/update 'plan') + usage (context bar). */
	public currentPlan: Plan | null = null;
	public currentUsage: { used: number; size: number } | null = null;
	public availableCommands: AvailableCommand[] = [];

	// Replay state (session/load history reconstruction)
	private _replaying = false;
	private _lastReplayMsgId: string | null = null;
	private _replayUpdateTimer: ReturnType<typeof setTimeout> | null = null;

	// Current session (runtime, not persisted)
	private _currentTitle = '';

	/** Title cache from session/list (for openSession). */
	private readonly _sessionTitles = new Map<string, string>();

	private readonly _messageHandler: WebviewMessageHandler;
	private readonly _htmlProvider: HtmlProvider;
	private readonly _extensionUri: vscode.Uri;
	private _viewMode: 'list' | 'chat' = 'list';
	private _readyHandled = false;
	private _activeSessionIdOverride: string | null = null;
	private _draftState: DraftState = { text: '', attachedFiles: [] };
	private _persistUiTimer: ReturnType<typeof setTimeout> | null = null;

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

	/** Palette command: new session. */
	public async handleNewSessionCommand(): Promise<void> {
		await vscode.commands.executeCommand('exo.chatView.focus');
		try {
			await this.connectAcp(this.getWorkspaceRoot());
			await this.newSession();
		} catch (err) {
			console.error('[Exo ACP] newSession command failed:', err);
		}
	}

	/** Webview ready: eager connect + session/list. */
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
			await this.connectAcp(this.getWorkspaceRoot());
			await this.refreshSessionList();
			const activeSessionId = this.activeSessionId;
			if (activeSessionId) {
				await this.openSession(activeSessionId);
				return;
			}
			if (this._viewMode === 'chat') {
				this.showChat();
			} else {
				this.showSessionList();
			}
		} catch (err) {
			console.error('[Exo ACP] eager connect failed:', err);
			vscode.window.showErrorMessage(`Exo: ${err instanceof Error ? err.message : String(err)}`);
			this.view?.webview.postMessage({ type: 'updateSessionList', sessions: [] });
		}
	}

	// --- Session lifecycle (agent-driven) ---

	/** Open a session from the agent's list (load with replay OR resume without replay). */
	public async openSession(sessionId: string): Promise<void> {
		if (!this.acpClient) {
			return;
		}
		const cwd = this.getWorkspaceRoot();
		try {
			if (this.acpClient.canLoadSession) {
				this._startReplay();
				this._currentTitle = this._sessionTitles.get(sessionId) ?? 'Chat';
				await this.acpClient.sessionLoad(sessionId, cwd);
				this._endReplay();
			} else if (this.acpClient.canResume) {
				await this.acpClient.sessionResume(sessionId, cwd);
				this.messages = [];
				this._currentTitle = this._sessionTitles.get(sessionId) ?? 'Chat';
			} else {
				vscode.window.showWarningMessage('Agent cannot load or resume sessions');
				return;
			}
			this.toolCallInfos.clear();
			this.currentPlan = null;
			this.currentUsage = null;
			this.stopped = false;
			this._activeSessionIdOverride = null;
			this.showChat();
		} catch (err) {
			console.error('[Exo ACP] openSession failed, starting new:', err);
			this._endReplay();
			await this.newSession();
		}
	}

	/** New session (session/new). */
	public async newSession(): Promise<void> {
		if (!this.acpClient) {
			return;
		}
		const cwd = this.getWorkspaceRoot();
		try {
			await this.acpClient.sessionNew(cwd);
			this.messages = [];
			this.toolCallInfos.clear();
			this.currentPlan = null;
			this.currentUsage = null;
			this._currentTitle = 'New Chat';
			this.stopped = false;
			this._activeSessionIdOverride = null;
			this.showChat();
		} catch (err) {
			console.error('[Exo ACP] newSession failed:', err);
			vscode.window.showErrorMessage(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Delete session on the agent + refresh the list. */
	public async deleteSession(sessionId: string): Promise<void> {
		if (!this.acpClient) {
			return;
		}
		try {
			if (this.acpClient.canDelete) {
				await this.acpClient.deleteSession(sessionId);
			}
		} catch (err) {
			console.error('[Exo ACP] deleteSession failed:', err);
		}
		if (this.acpClient.sessionId === sessionId) {
			await this.closeCurrentSession();
		}
		await this.refreshSessionList();
	}

	/** Close the current session (session/close) + return to the list. */
	public async closeCurrentSession(): Promise<void> {
		if (this.acpClient) {
			const sid = this.acpClient.sessionId;
			if (sid && this.acpClient.canClose) {
				await this.acpClient.closeSession(sid);
			}
		}
		this.messages = [];
		this.currentPlan = null;
		this.currentUsage = null;
		this._currentTitle = '';
		this._activeSessionIdOverride = null;
		this.toolCallInfos.clear();
		await this.refreshSessionList();
		this.showSessionList();
	}

	public showSessionList(): void {
		this._viewMode = 'list';
		this.persistUiStateSoon();
		this.view?.webview.postMessage({ type: 'showSessionList' });
	}

	/** Show the "no agent configured" onboarding screen in the webview. */
	public showConfigRequired(): void {
		this._viewMode = 'list';
		this.view?.webview.postMessage({ type: 'showConfigRequired', configPath: getConfigPath() });
	}

	/** Refresh the session list from the agent (session/list). */
	public async refreshSessionList(): Promise<void> {
		if (!this.acpClient || !this.acpClient.canList) {
			this.view?.webview.postMessage({ type: 'updateSessionList', sessions: [] });
			return;
		}
		try {
			const cwd = this.getWorkspaceRoot();
			const resp = await this.acpClient.listSessions(cwd);
			this._sessionTitles.clear();
			for (const s of resp.sessions) {
				if (s.title) {
					this._sessionTitles.set(s.sessionId, s.title);
				}
			}
			this.view?.webview.postMessage({ type: 'updateSessionList', sessions: resp.sessions });
		} catch (err) {
			console.error('[Exo ACP] listSessions failed:', err);
			this.view?.webview.postMessage({ type: 'updateSessionList', sessions: [] });
		}
	}

	// --- Replay (session/load) ---

	private _startReplay(): void {
		this._replaying = true;
		this._lastReplayMsgId = null;
		this.messages = [];
		this.streamingIndex = null;
		this.toolCallInfos.clear();
		this.currentPlan = null;
		this.currentUsage = null;
		if (this._replayUpdateTimer) {
			clearTimeout(this._replayUpdateTimer);
			this._replayUpdateTimer = null;
		}
	}

	private _endReplay(): void {
		this._replaying = false;
		this._lastReplayMsgId = null;
		if (this._replayUpdateTimer) {
			clearTimeout(this._replayUpdateTimer);
			this._replayUpdateTimer = null;
		}
		// Replay machinery marks every assistant message `isStreaming: true`;
		// clear them ALL, or the loaded history "blinks" like it's live.
		for (const msg of this.messages) {
			msg.isStreaming = false;
			msg._lastChunkKind = null;
			this._setReasoningActive(msg, false);
		}
		this.streamingIndex = null;
		this.isStreaming = false;
		this.updateMessages();
	}

	private _scheduleReplayUpdate(): void {
		if (this._replayUpdateTimer) {
			return;
		}
		this._replayUpdateTimer = setTimeout(() => {
			this._replayUpdateTimer = null;
			this.updateMessages();
		}, 50);
	}

	// --- Config ---

	public sendConfig(): void {
		const client = this.acpClient;
		if (!client) {
			this.view?.webview.postMessage({ type: 'updateConfig', selectors: [], modeColorIndex: {} });
			return;
		}
const { selectors, currentModeId } = buildConfigSelectors(
		client.configOptions ?? null,
	);
	if (currentModeId) {
		this.mode = currentModeId;
	}

		// Mode color palette: assign each modeId a stable index 0..9 (persisted).
		let modeColorIndex: Record<string, number> = {};
		const modeSel = selectors.find((s) => s.category === 'mode');
		if (modeSel) {
			const ids = modeSel.options.map((o) => o.value);
			if (currentModeId && !ids.includes(currentModeId)) {
				ids.push(currentModeId);
			}
			modeColorIndex = this._assignModeColors(ids);
		}

		this.view?.webview.postMessage({ type: 'updateConfig', selectors, modeColorIndex });
	}

	/** modeId → stable color index 0..9 (persisted in globalState). */
	private _modeColorMap(): Record<string, number> {
		return this.globalState.get<Record<string, number>>('exo.modeColorIndex') ?? {};
	}

	private _assignModeColors(modeIds: string[]): Record<string, number> {
		const map = this._modeColorMap();
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

	/** Change a config option (mode/model/thought_level) via configOptions. */
	public async selectConfigOption(configId: string, value: string): Promise<void> {
		if (!this.acpClient) {
			return;
		}
		try {
			await this.acpClient.setConfigOption(configId, value);
			this.sendConfig();
		} catch (e) {
			console.error(`[Exo ACP] selectConfigOption(${configId}) failed:`, e);
		}
	}

	public sendPlan(): void {
		this.view?.webview.postMessage({ type: 'updatePlan', plan: this.currentPlan });
	}

	public sendTokenUsage(): void {
		if (!this.currentUsage) {
			return;
		}
		this.view?.webview.postMessage({
			type: 'updateTokenUsage',
			usage: { prompt_tokens: this.currentUsage.used },
			tokenLimit: this.currentUsage.size,
		});
	}

	public sendAvailableCommands(): void {
		this.view?.webview.postMessage({ type: 'updateCommands', commands: this.availableCommands });
	}

	public sendAgentInfo(): void {
		this.view?.webview.postMessage({ type: 'updateAgentInfo', agentInfo: this.acpClient?.agentInfo ?? null });
	}

	public sendPromptCapabilities(): void {
		this.view?.webview.postMessage({
			type: 'updatePromptCapabilities',
			image: this.acpClient?.canPromptImage ?? false,
		});
	}

	public sendColorTheme(): void {
		const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') ?? null;
		this.view?.webview.postMessage({ type: 'updateColorTheme', name });
	}

	public get autoAllowPermissions(): boolean {
		return this._autoAllowPermissions;
	}

	public setAutoAllowPermissions(value: boolean): void {
		this._autoAllowPermissions = value;
		this.view?.webview.postMessage({ type: 'updateAutoAllowPermissions', value });
	}

	public updateDraftState(text: string, attachedFiles: string[]): void {
		this._draftState = { text, attachedFiles: [...attachedFiles] };
		void this.workspaceState.update('exo.chatDraft', this._draftState);
	}

	/** Map ACP PlanEntry[] → UI Plan (content→title, completed→done, id by index). */
	private mapPlanEntries(entries: PlanEntry[]): Plan {
		const items: PlanItem[] = entries.map((e, i) => ({
			id: `step-${i}`,
			title: e.content,
			description: '',
			status: e.status === 'completed' ? 'done' : e.status,
		}));
		return { items };
	}

	/**
	 * Accommodation: if the tool-call carries a plan in args (opencode `{todos:[...]}`),
	 * sync currentPlan. The standard ACP plan (onPlan) takes priority — it is called
	 * directly. This only fires when args really look like a plan (shape detection).
	 */
	private _maybeSyncPlanFromTool(tc: ToolCallInfo): void {
		const entries = extractPlanFromToolArgs(tc.args);
		if (!entries) {
			return;
		}
		this.currentPlan = this.mapPlanEntries(entries);
		this.sendPlan();
	}

	public updateMessages(): void {
		this.view?.webview.postMessage({ type: 'updateMessages', messages: this.messages });
	}

	// --- ACP lifecycle ---

	/** Connect to the agent (spawn + initialize). Idempotent. Does NOT create a session. */
	public async connectAcp(cwd: string): Promise<void> {
		if (this.acpClient) {
			return;
		}
		const agentCfg = this.configWatcher.config.agents?.[0];
		if (!agentCfg) {
			throw new Error('No ACP agent configured in config.yml (expected agents[0])');
		}

		const callbacks: AcpClientCallbacks = {
			onAgentMessageChunk: (_msgId, content) => {
				if (content.type !== 'text') {
					return;
				}
				if (this._replaying) {
					const msgId = _msgId ?? null;
					if (msgId !== this._lastReplayMsgId) {
						this.messages.push({ role: 'assistant', blocks: [], isStreaming: true });
						this.streamingIndex = this.messages.length - 1;
						this._lastReplayMsgId = msgId;
					}
					this.appendStreamChunk(content.text);
					this._scheduleReplayUpdate();
				} else {
					this.appendStreamChunk(content.text);
				}
			},
			onAgentThoughtChunk: (_msgId, content) => {
				if (content.type !== 'text') {
					return;
				}
				if (this._replaying) {
					if (this.streamingIndex === null) {
						this.messages.push({ role: 'assistant', blocks: [], isStreaming: true });
						this.streamingIndex = this.messages.length - 1;
						this._lastReplayMsgId = _msgId ?? null;
					}
					this.appendThoughtChunk(content.text);
					this._scheduleReplayUpdate();
				} else {
					this.appendThoughtChunk(content.text);
				}
			},
			onUserMessageChunk: (msgId, content) => {
				if (!this._replaying || content.type !== 'text') {
					return;
				}
				const id = msgId ?? null;
				if (id !== this._lastReplayMsgId) {
					this.messages.push({ role: 'user', blocks: [{ type: 'text', content: '' }] });
					this._lastReplayMsgId = id;
				}
				const last = this.messages[this.messages.length - 1];
				const lastBlock = last.blocks[last.blocks.length - 1];
				if (lastBlock && lastBlock.type === 'text') {
					lastBlock.content += content.text;
				} else {
					last.blocks.push({ type: 'text', content: content.text });
				}
				this._scheduleReplayUpdate();
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
				this.pushToolCallToStreaming(tc);
				this.toolCallInfos.set(update.toolCallId, tc);
				this._maybeSyncPlanFromTool(tc);
				if (this._replaying) {
					this._scheduleReplayUpdate();
				} else {
					this.updateMessages();
				}
			},
			onToolCallUpdate: (update) => {
				const tc = this.toolCallInfos.get(update.toolCallId);
				if (!tc) {
					return;
				}
				applyToolCallPatch(tc, update);
				if (update.status) {
					tc.status = mapToolStatus(update.status);
					if (tc.status === 'error') {
						tc.isError = true;
					}
				}
				this._maybeSyncPlanFromTool(tc);
				if (this._replaying) {
					this._scheduleReplayUpdate();
				} else {
					this.updateMessages();
				}
			},
			onPlan: (entries) => {
				this.currentPlan = this.mapPlanEntries(entries);
				this.sendPlan();
			},
			onUsageUpdate: (update) => {
				this.currentUsage = { used: update.used, size: update.size };
				this.sendTokenUsage();
			},
			onCurrentModeUpdate: (modeId) => {
				this.mode = modeId;
				this.sendConfig();
			},
			onConfigOptionUpdate: () => {
				this.sendConfig();
			},
			onAvailableCommandsUpdate: (commands) => {
				this.availableCommands = commands;
				this.sendAvailableCommands();
			},
			onSessionInfoUpdate: (title) => {
				if (title) {
					this._currentTitle = title;
					const sid = this.acpClient?.sessionId;
					if (sid) {
						this._sessionTitles.set(sid, title);
					}
					this.view?.webview.postMessage({ type: 'sessionTitleUpdate', title });
					this.persistUiStateSoon();
				}
			},
			onReadTextFile: (p) => handleReadTextFile(p, this.fsContext()),
			onWriteTextFile: (p) => handleWriteTextFile(p, this.fsContext()),
			onRequestPermission: (p) => handleRequestPermission(p, this.permissionContext()),
			onError: (e) => console.error('[Exo ACP] error:', e),
			onDisconnect: () => {
				this.acpClient = null;
				cancelAllPermissions(this.permissionContext());
				this.endStreaming();
				this.agentRunning = false;
				this.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
				this.showSessionList();
			},
		};

		this.acpClient = new AcpClient(agentCfg, callbacks);
		await this.acpClient.connect(cwd);
		this.availableCommands = this.acpClient.availableCommands ?? [];
		this.sendAgentInfo();
		this.sendAvailableCommands();
		this.sendPromptCapabilities();
		this.sendColorTheme();
		console.error(`[Exo ACP] connected: agent=${this.acpClient.agentInfo?.name ?? 'unknown'} canList=${this.acpClient.canList} canLoad=${this.acpClient.canLoadSession} canResume=${this.acpClient.canResume} canClose=${this.acpClient.canClose} canDelete=${this.acpClient.canDelete} canPromptImage=${this.acpClient.canPromptImage}`);
	}

	/** Full disconnect (extension deactivate / config change). Best-effort session/close + kill. */
	public disconnectAcp(): void {
		try {
			this.acpClient?.disconnect();
		} catch { /* ignore */ }
		this.acpClient = null;
		cancelAllPermissions(this.permissionContext());
		this.endStreaming();
	}

	public cancelPendingOperations(): void {
		this.stopped = true;
		this.acpClient?.cancel();
		this.isStreaming = false;

		cancelAllPermissions(this.permissionContext());
	}

	public showChat(): void {
		this._viewMode = 'chat';
		this.persistUiStateSoon();
		this.view?.webview.postMessage({
			type: 'showChat',
			messages: this.messages,
			mode: this.mode,
			plan: this.currentPlan,
			title: this._currentTitle || 'Chat',
			sessionId: this.activeSessionId,
		});
		this.sendAgentInfo();
		this.sendConfig();
		this.sendAvailableCommands();
		this.sendPromptCapabilities();
		this.sendColorTheme();
		this.view?.webview.postMessage({ type: 'updateAgentRunning', running: this.agentRunning });
		this.view?.webview.postMessage({ type: 'updateAutoAllowPermissions', value: this._autoAllowPermissions });
		this.postDraftState();
	}

	public get activeSessionId(): string | null {
		return this.acpClient?.sessionId ?? this._activeSessionIdOverride;
	}

	private restorePersistedUiState(): void {
		const persisted = this.workspaceState.get<PersistedChatUiState>('exo.chatUiState');
		if (persisted) {
			this._viewMode = persisted.view;
			this._currentTitle = persisted.sessionTitle;
			this._activeSessionIdOverride = persisted.activeSessionId;
		}
		const draft = this.workspaceState.get<DraftState>('exo.chatDraft');
		if (draft) {
			this._draftState = {
				text: draft.text ?? '',
				attachedFiles: Array.isArray(draft.attachedFiles) ? draft.attachedFiles : [],
			};
		}
	}

	private persistUiStateSoon(): void {
		if (this._persistUiTimer) {
			clearTimeout(this._persistUiTimer);
		}
		this._persistUiTimer = setTimeout(() => {
			this._persistUiTimer = null;
			void this.workspaceState.update('exo.chatUiState', {
				activeSessionId: this.activeSessionId,
				view: this._viewMode,
				sessionTitle: this._currentTitle,
			} satisfies PersistedChatUiState);
		}, 50);
	}

	private postDraftState(): void {
		this.view?.webview.postMessage({
			type: 'restoreDraft',
			text: this._draftState.text,
			attachedFiles: this._draftState.attachedFiles,
		});
	}

	/** Context for the fs handlers. */
	private fsContext(): FsHandlerContext {
		return {
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			files: this.files,
			toolCallInfos: this.toolCallInfos,
			postUpdateMessages: () => {
				this.updateMessages();
			},
			onToolCallCreated: (tc) => this.pushToolCallToStreaming(tc),
		};
	}

	/** Context for the permission handler (ACP session/request_permission). */
	public permissionContext(): PermissionHandlerContext {
		return {
			toolCallInfos: this.toolCallInfos,
			pendingPermissions: this.pendingPermissions,
			autoAllow: () => this._autoAllowPermissions,
			allocatePermissionRequestId: () => `perm-${++this._permissionRequestIdCounter}`,
			postUpdateMessages: () => {
				this.updateMessages();
			},
			onToolCallCreated: (tc) => this.pushToolCallToStreaming(tc),
			openEditDiff: (spec) => this.openEditDiff(spec),
			closeDiff: (diffKey) => this.closeDiffTabs(diffKey),
		};
	}

	/** Apply the user's decision from the webview (postMessage `permissionDecision`). */
	public resolvePermission(
		requestId: string,
		decision: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' },
		followUpText?: string,
	): void {
		resolvePermissionImpl(this.permissionContext(), requestId, decision);
		if (followUpText && followUpText.trim()) {
			this._pendingFollowUpMessage = followUpText.trim();
			this.messages.push({
				role: 'user',
				blocks: [{ type: 'text', content: followUpText.trim() }],
				isQueued: true,
			});
		}
		this.updateMessages();
	}

	/** Take and clear the pending follow-up message (called after the turn ends). */
	public consumePendingFollowUp(): string | null {
		const msg = this._pendingFollowUpMessage;
		this._pendingFollowUpMessage = null;
		return msg;
	}

	/** Current streaming assistant message (where chunks/tool calls are appended). */
	public currentStreamingAssistant(): ChatMessage | undefined {
		if (this.streamingIndex === null) {
			return undefined;
		}
		const msg = this.messages[this.streamingIndex];
		return msg && msg.role === 'assistant' && msg.isStreaming ? msg : undefined;
	}

	/**
	 * Add a ToolCallInfo to the current streaming assistant. If there is no
	 * streaming assistant (replay: tool_call arrives before agent_message_chunk),
	 * one is auto-created.
	 */
	public pushToolCallToStreaming(tc: ToolCallInfo): void {
		let assistant = this.currentStreamingAssistant();
		if (!assistant) {
			assistant = { role: 'assistant', blocks: [], isStreaming: true };
			this.messages.push(assistant);
			this.streamingIndex = this.messages.length - 1;
		}
		const lastBlock = assistant.blocks[assistant.blocks.length - 1];
		if (lastBlock && lastBlock.type === 'activity') {
			lastBlock.toolCalls.push(tc);
		} else {
			assistant.blocks.push({ type: 'activity', toolCalls: [tc], reasoning: '', reasoningPhases: 0 });
		}
		assistant._lastChunkKind = 'tool';
		this._setReasoningActive(assistant, false);
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

	/** Append a text chunk to the current streaming assistant message. */
	public appendStreamChunk(text: string): void {
		const msg = this.currentStreamingAssistant();
		if (!msg) {
			return;
		}
		const lastBlock = msg.blocks[msg.blocks.length - 1];
		if (lastBlock && lastBlock.type === 'text') {
			lastBlock.content += text;
		} else {
			msg.blocks.push({ type: 'text', content: text });
		}
		msg._lastChunkKind = 'text';
		this._setReasoningActive(msg, false);
		this.streamThrottle?.update();
	}

	/** Append a reasoning chunk (thought) to the current streaming assistant message. */
	public appendThoughtChunk(text: string): void {
		const msg = this.currentStreamingAssistant();
		if (!msg) {
			return;
		}
		const lastBlock = msg.blocks[msg.blocks.length - 1];
		if (lastBlock && lastBlock.type === 'activity') {
			if (msg._lastChunkKind === 'reasoning') {
				lastBlock.reasoning += text;
			} else {
				lastBlock.reasoning = lastBlock.reasoning
					? lastBlock.reasoning + '\n---\n' + text
					: text;
				lastBlock.reasoningPhases++;
			}
		} else {
			msg.blocks.push({ type: 'activity', toolCalls: [], reasoning: text, reasoningPhases: 1 });
		}
		msg._lastChunkKind = 'reasoning';
		this._setReasoningActive(msg, true);
		this.streamThrottle?.update();
	}

	/**
	 * Set reasoningActive on the last activity block of the message, clearing the
	 * flag on all others (guard against stuck `true`). `value=false` clears everywhere.
	 */
	private _setReasoningActive(msg: ChatMessage | undefined, value: boolean): void {
		if (!msg) {
			return;
		}
		let lastActivityIdx = -1;
		for (let i = 0; i < msg.blocks.length; i++) {
			const b = msg.blocks[i];
			if (b.type === 'activity') {
				b.reasoningActive = false;
				lastActivityIdx = i;
			}
		}
		if (value && lastActivityIdx >= 0) {
			const b = msg.blocks[lastActivityIdx];
			if (b.type === 'activity') {
				b.reasoningActive = true;
			}
		}
	}

	/** End streaming (flush + dispose throttle). */
	public endStreaming(): void {
		if (this.streamingIndex !== null) {
			const msg = this.messages[this.streamingIndex];
			if (msg) {
				msg._lastChunkKind = null;
				this._setReasoningActive(msg, false);
			}
		}
		this.streamThrottle?.flush();
		this.streamThrottle?.dispose();
		this.streamThrottle = null;
		this.streamingIndex = null;
		this.isStreaming = false;
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
