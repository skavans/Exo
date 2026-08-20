/**
 * AcpClient — thin wrapper over @agentclientprotocol/sdk (push-model).
 *
 * Manages the ACP connection lifecycle:
 * 1. connect(cwd) — spawn subprocess, ndJsonStream, register notification/request handlers, initialize.
 *    Does NOT create a session — sessions are created/loaded by separate methods (sessionNew/Load/Resume).
 * 2. sessionNew/Load/Resume/List/Close/Delete — session lifecycle via agent.request.
 * 3. prompt(blocks) — session/prompt; updates pushed via onNotification(session.update) → _dispatchUpdate.
 * 4. cancel() — session/cancel notification.
 * 5. disconnect() — best-effort session/close + kill process.
 *
 * Push-model: clientApp.onNotification(session.update) is registered ONCE in connect(),
 * dispatching ALL updates (new/load/resume/prompt) to callbacks. No ActiveSession/nextUpdate loop.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
	ContentBlock,
	SessionUpdate,
	InitializeResponse,
	NewSessionResponse,
	LoadSessionResponse,
	ResumeSessionResponse,
	ListSessionsResponse,
	AgentCapabilities,
	WriteTextFileRequest,
	WriteTextFileResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	PlanEntry,
	UsageUpdate as UsageUpdateType,
	SessionConfigOption,
	McpServer,
	PromptResponse,
	AvailableCommand,
} from '@agentclientprotocol/sdk';
import type { AgentConfig } from '../config';

// --- Callbacks: UI mapping (AcpClient → ChatViewProvider) ---

export interface AcpClientCallbacks {
	// Session update callbacks (from session/update notifications — push model)
	onAgentMessageChunk(messageId: string | null | undefined, content: ContentBlock): void;
	onAgentThoughtChunk(messageId: string | null | undefined, content: ContentBlock): void;
	onUserMessageChunk(messageId: string | null | undefined, content: ContentBlock): void;
	onToolCallCreate(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): void;
	onToolCallUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>): void;
	/** plan update — full plan replacement (entries). */
	onPlan(entries: PlanEntry[]): void;
	onUsageUpdate(update: UsageUpdateType): void;
	onCurrentModeUpdate(modeId: string): void;
	onConfigOptionUpdate(configOptions: SessionConfigOption[]): void;
	onAvailableCommandsUpdate(commands: AvailableCommand[]): void;
	onSessionInfoUpdate(title: string | undefined, updatedAt: string | undefined): void;

	// Client request handlers (Agent → Client → Exo)
	onReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
	onWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse | void>;
	onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;

	// Lifecycle callbacks
	onError(error: Error): void;
	onDisconnect(): void;
}

// --- AcpClient ---

export class AcpClient {
	private _config: AgentConfig;
	private _callbacks: AcpClientCallbacks;
	private _process: ChildProcess | null = null;
	private _connection: acp.ClientConnection | null = null;
	private _initializeResult: InitializeResponse | null = null;
	private _sessionId: string | null = null;
	private _configOptions: SessionConfigOption[] | null | undefined = null;
	private _availableCommands: AvailableCommand[] | null = null;
	/**
	 * Client-owned config selections (configId → value). Written only by our own
	 * `setConfigOption`; agent-pushed `config_option_update` notifications never
	 * touch it, so the dropdown selection survives agent re-broadcasts.
	 */
	private _clientSelection: Record<string, string> = {};

	/** Agent capabilities (from initialize) */
	get agentCapabilities(): AgentCapabilities | undefined {
		return this._initializeResult?.agentCapabilities;
	}

	/** session/load supported */
	get canLoadSession(): boolean {
		return this.agentCapabilities?.loadSession === true;
	}

	/** session/resume supported */
	get canResume(): boolean {
		return !!this.agentCapabilities?.sessionCapabilities?.resume;
	}

	/** session/close supported */
	get canClose(): boolean {
		return !!this.agentCapabilities?.sessionCapabilities?.close;
	}

	/** session/list supported */
	get canList(): boolean {
		return !!this.agentCapabilities?.sessionCapabilities?.list;
	}

	/** session/delete supported */
	get canDelete(): boolean {
		return !!this.agentCapabilities?.sessionCapabilities?.delete;
	}

	/** promptCapabilities.image — agent accepts ContentBlock::Image in prompts. */
	get canPromptImage(): boolean {
		return this.agentCapabilities?.promptCapabilities?.image === true;
	}

	/** Agent info (from initialize) */
	get agentInfo(): { name: string; title?: string; version?: string } | undefined {
		const info = this._initializeResult?.agentInfo;
		if (!info) return undefined;
		return { name: info.name, title: info.title ?? undefined, version: info.version ?? undefined };
	}

	/** Session ID of the current ACP session (null if none active) */
	get sessionId(): string | null {
		return this._sessionId;
	}

	/** Latest list of available slash commands (from available_commands_update). */
	get availableCommands(): AvailableCommand[] | null {
		return this._availableCommands;
	}

	/** Current config options */
	get configOptions(): SessionConfigOption[] | null | undefined {
		return this._configOptions;
	}

	/** Client-owned config selections (see `_clientSelection`). */
	get clientSelection(): Record<string, string> {
		return this._clientSelection;
	}

	/** Connection established (process + connection alive) */
	get connected(): boolean {
		return this._connection !== null && this._process !== null;
	}

	constructor(config: AgentConfig, callbacks: AcpClientCallbacks) {
		this._config = config;
		this._callbacks = callbacks;
	}

	/**
	 * Connect to the agent: spawn → ndJsonStream → register handlers → initialize.
	 * Does NOT create a session. Use sessionNew/Load/Resume after connect().
	 */
	async connect(cwd: string): Promise<void> {
		if (this._process) {
			throw new Error('AcpClient already connected');
		}

		// 1. Spawn subprocess
		const env = { ...process.env, ...this._config.env };
		this._process = spawn(this._config.command, this._config.args ?? [], {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this._process.on('error', (err) => {
			this._callbacks.onError(err);
		});

		this._process.on('exit', (code, signal) => {
			console.error(`[Exo ACP] agent exited (code=${code}, signal=${signal})`);
			this._handleDisconnect();
		});

		// stderr — log, don't parse
		this._process.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8').trimEnd();
			if (text) {
				console.error(`[Exo ACP stderr] ${text}`);
			}
		});

		// 2. Create ndJsonStream from stdin/stdout
		const writable = Writable.toWeb(this._process.stdin!);
		const readable = Readable.toWeb(this._process.stdout!);
		const stream = acp.ndJsonStream(writable, readable);

		// 3. Build client app with handlers
		const clientApp = acp.client({ name: 'exo' });

		// Push-model: ALL session/update notifications → _dispatchUpdate.
		// Registered ONE time, works for new/load/resume/prompt.
		clientApp.onNotification(acp.methods.client.session.update, (ctx) => {
			// Session-id filter: only accept updates for our session once we have one.
			// During session/new _sessionId is null — no updates expected.
			if (this._sessionId !== null && ctx.params.sessionId !== this._sessionId) {
				return;
			}
			this._dispatchUpdate(ctx.params.update);
		});

		// Register client-side request handlers
		clientApp.onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
			this._callbacks.onReadTextFile(ctx.params),
		);
		clientApp.onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
			this._callbacks.onWriteTextFile(ctx.params),
		);
		clientApp.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
			this._callbacks.onRequestPermission(ctx.params),
		);

		// 4. Connect (persistent connection)
		this._connection = clientApp.connect(stream);

		// 5. Initialize
		this._initializeResult = await this._connection.agent.request(
			acp.methods.agent.initialize,
			{
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {
					fs: {
						readTextFile: true,
						writeTextFile: true,
					},
				},
				clientInfo: {
					name: 'exo',
					version: EXO_VERSION,
				},
			},
		);

		// 6. Authenticate if needed
		if (this._initializeResult.authMethods && this._initializeResult.authMethods.length > 0) {
			const method = this._initializeResult.authMethods[0];
			await this._connection.agent.request(acp.methods.agent.authenticate, {
				methodId: method.id,
			});
		}
	}

	// --- Session lifecycle ---

	/** session/new — create a new session. */
	async sessionNew(cwd: string, mcpServers: McpServer[] = []): Promise<NewSessionResponse> {
		this._requireConnection();
		this._sessionId = null; // no session yet, no updates expected
		const resp = await this._connection!.agent.request(acp.methods.agent.session.new, {
			cwd,
			mcpServers,
		});
		this._sessionId = resp.sessionId;
		this._configOptions = resp.configOptions ?? null;
		return resp;
	}

	/**
	 * session/load — load an existing session with history replay.
	 * Replay arrives via onNotification BEFORE the response. _sessionId is set
	 * AHEAD of time so the filter lets replay updates through.
	 */
	async sessionLoad(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<LoadSessionResponse> {
		this._requireConnection();
		this._sessionId = sessionId;
		const resp = await this._connection!.agent.request(acp.methods.agent.session.load, {
			sessionId,
			cwd,
			mcpServers,
		});
		this._configOptions = resp.configOptions ?? null;
		return resp;
	}

	/** session/resume — restore a session without replay. */
	async sessionResume(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<ResumeSessionResponse> {
		this._requireConnection();
		this._sessionId = sessionId;
		const resp = await this._connection!.agent.request(acp.methods.agent.session.resume, {
			sessionId,
			cwd,
			mcpServers,
		});
		this._configOptions = resp.configOptions ?? null;
		return resp;
	}

	/** session/list — list the agent's sessions (if canList). */
	async listSessions(cwd?: string): Promise<ListSessionsResponse> {
		this._requireConnection();
		return this._connection!.agent.request(
			acp.methods.agent.session.list,
			cwd ? { cwd } : {},
		);
	}

	/** session/close — close a session on the agent (if canClose). Best-effort. */
	async closeSession(sessionId: string): Promise<void> {
		if (!this._connection || !this.canClose) {
			return;
		}
		try {
			await this._connection.agent.request(acp.methods.agent.session.close, { sessionId });
		} catch (err) {
			console.error(`[Exo ACP] session/close failed (best-effort):`, err);
		}
	}

	/** session/delete — delete a session on the agent (if canDelete). */
	async deleteSession(sessionId: string): Promise<void> {
		this._requireConnection();
		if (!this.canDelete) {
			return;
		}
		await this._connection!.agent.request(acp.methods.agent.session.delete, { sessionId });
	}

	// --- Prompt ---

	/**
	 * Send a prompt to the current session.
	 * Updates are pushed via onNotification → callbacks. Response gives the stopReason.
	 */
	async prompt(blocks: ContentBlock[]): Promise<PromptResponse['stopReason']> {
		if (!this._connection || !this._sessionId) {
			throw new Error('AcpClient: no active session');
		}
		const result = await this._connection.agent.request(acp.methods.agent.session.prompt, {
			sessionId: this._sessionId,
			prompt: blocks,
		});
		return result.stopReason;
	}

	/** Cancel the current prompt turn (session/cancel notification). */
	cancel(): void {
		if (!this._connection || !this._sessionId) {
			return;
		}
		void this._connection.agent.notify(acp.methods.agent.session.cancel, {
			sessionId: this._sessionId,
		});
	}

	// --- Config ---

	/** Change a config option (model / thought_level / mode / ...).
	 * Returns the updated FULL set of configOptions.
	 */
	async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
		if (!this._connection || !this._sessionId) {
			throw new Error('AcpClient: no active session');
		}
		const result = await this._connection.agent.request(
			acp.methods.agent.session.setConfigOption,
			{
				sessionId: this._sessionId,
				configId,
				value,
			},
		);
		this._configOptions = result.configOptions ?? null;
		this._clientSelection[configId] = value;
		return result.configOptions ?? [];
	}

	// --- Lifecycle ---

	/** Close the connection and kill the process. Best-effort session/close before kill. */
	disconnect(): void {
		// Best-effort close of the current session (fire-and-forget, don't block kill)
		if (this._connection && this._sessionId && this.canClose) {
			void this._connection.agent.request(
				acp.methods.agent.session.close,
				{ sessionId: this._sessionId },
			).catch(() => { /* best-effort */ });
		}

		this._connection?.close();
		this._connection = null;

		// Kill subprocess
		if (this._process && !this._process.killed) {
			try {
				this._process.kill('SIGTERM');
			} catch {
				// already dead
			}
			// Force kill after 2s
			setTimeout(() => {
				if (this._process && !this._process.killed) {
					try {
						this._process.kill('SIGKILL');
					} catch { /* ignore */ }
				}
			}, 2000);
		}
		this._process = null;
		this._initializeResult = null;
		this._sessionId = null;
		this._configOptions = null;
		this._availableCommands = null;
		this._clientSelection = {};
	}

	// --- Internal ---

	private _requireConnection(): void {
		if (!this._connection) {
			throw new Error('AcpClient: not connected');
		}
	}

	/** Dispatch a session/update to callbacks (push-model — from onNotification). */
	private _dispatchUpdate(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
				this._callbacks.onAgentMessageChunk(u.messageId, u.content);
				break;
			}
			case 'user_message_chunk': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' }>;
				this._callbacks.onUserMessageChunk(u.messageId, u.content);
				break;
			}
			case 'tool_call': {
				this._callbacks.onToolCallCreate(update as Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>);
				break;
			}
			case 'tool_call_update': {
				this._callbacks.onToolCallUpdate(update as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>);
				break;
			}
			case 'plan': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'plan' }>;
				this._callbacks.onPlan(u.entries);
				break;
			}
			case 'plan_update':
			case 'plan_removed': {
				console.error(`[Exo ACP] ${update.sessionUpdate} (experimental, ignored)`);
				break;
			}
			case 'usage_update': {
				this._callbacks.onUsageUpdate(update as UsageUpdateType);
				break;
			}
			case 'current_mode_update': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'current_mode_update' }>;
				this._callbacks.onCurrentModeUpdate(u.currentModeId);
				break;
			}
		case 'available_commands_update': {
			const u = update as Extract<SessionUpdate, { sessionUpdate: 'available_commands_update' }>;
			this._availableCommands = u.availableCommands ?? null;
			this._callbacks.onAvailableCommandsUpdate(u.availableCommands);
			break;
		}
			case 'session_info_update': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'session_info_update' }>;
				this._callbacks.onSessionInfoUpdate(
					u.title ?? undefined,
					u.updatedAt ?? undefined,
				);
				break;
			}
			case 'config_option_update': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>;
				this._configOptions = u.configOptions ?? null;
				this._callbacks.onConfigOptionUpdate(u.configOptions);
				break;
			}
			case 'agent_thought_chunk': {
				const u = update as Extract<SessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
				this._callbacks.onAgentThoughtChunk(u.messageId, u.content);
				break;
			}
			default: {
				console.error('[Exo ACP] unhandled session update:', (update as { sessionUpdate: string }).sessionUpdate);
			}
		}
	}

	/** Disconnect handling (process exit). */
	private _handleDisconnect(): void {
		this._connection = null;
		this._sessionId = null;
		this._process = null;
		this._initializeResult = null;
		this._configOptions = null;
		this._availableCommands = null;
		this._clientSelection = {};
		this._callbacks.onDisconnect();
	}
}
