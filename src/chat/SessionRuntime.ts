/**
 * SessionRuntime — per-session state + ACP connection.
 *
 * One runtime per open tab: its own AcpClient subprocess, its own cwd (usually
 * a git worktree), message history, streaming/permission/plan state and file
 * cache. `ChatViewProvider` becomes a registry of runtimes.
 *
 * The runtime is intentionally dumb about vscode/webview details — everything
 * that touches the webview goes through `SessionRuntimeCallbacks`, supplied by
 * ChatViewProvider when the runtime is created.
 */

import type { AvailableCommand, PlanEntry } from '@agentclientprotocol/sdk';
import type { ChatMessage, PendingPermission, ToolCallInfo } from './types';
import type { Plan, PlanItem } from '../tools/types';
import { Files } from '../files/Files';
import { AcpClient } from '../acp/AcpClient';
import { StreamThrottle } from './StreamThrottle';
import { extractPlanFromToolArgs } from '../vendor/opencode';

export type RuntimeStatus = 'idle' | 'running' | 'awaiting';

export interface SessionRuntimeCallbacks {
	/** Push a plan update to the webview. */
	sendPlan: () => void;
	/** Push current messages to the webview. */
	sendMessages: () => void;
	/** Push token usage to the webview. */
	sendTokenUsage: () => void;
	/** Push config (mode selectors) to the webview. */
	sendConfig: () => void;
	/** Push the commands list to the webview. */
	sendCommands: () => void;
	/** Push the tab strip (titles + statuses) to the webview. */
	sendTabs: () => void;
	/** Post `updateAgentRunning` to the webview. */
	sendAgentRunning: (running: boolean) => void;
	/** Whether this runtime is the one the webview currently shows. */
	isActive: () => boolean;
	/** Send one `streamChunk` message for this runtime's streaming message. */
	sendStreamChunk: (index: number, blocks: ChatMessage['blocks']) => void;
}

export class SessionRuntime {
	id: string;
	readonly cwd: string;
	readonly files = new Files();
	/** Set by ChatViewProvider.spawnSession after construction (callbacks need the runtime). */
	acpClient!: AcpClient;
	callbacks: SessionRuntimeCallbacks;

	/** Display title (agent-owned, from session_info_update). */
	title = '';

	// --- Messages / tool calls ---
	messages: ChatMessage[] = [];
	toolCallInfos = new Map<string, ToolCallInfo>();
	streamingIndex: number | null = null;
	streamThrottle: StreamThrottle | null = null;

	// --- Turn state ---
	isStreaming = false;
	agentRunning = false;
	stopped = false;
	pendingFollowUpMessage: string | null = null;

	// --- Permission flow ---
	pendingPermissions = new Map<string, PendingPermission>();
	permissionRequestIdCounter = 0;

	// --- Plan / usage / config ---
	currentPlan: Plan | null = null;
	currentUsage: { used: number; size: number } | null = null;
	availableCommands: AvailableCommand[] = [];
	mode = '';

	// --- Replay (session/load) ---
	replaying = false;
	lastReplayMsgId: string | null = null;
	replayUpdateTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Title discovery (session/list polling) ---
	titlePollStarted = false;
	titlePollStart = 0;
	titlePollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(id: string, cwd: string, callbacks: SessionRuntimeCallbacks) {
		this.id = id;
		this.cwd = cwd;
		this.callbacks = callbacks;
	}

	get hasPendingPermission(): boolean {
		return this.pendingPermissions.size > 0;
	}

	get status(): RuntimeStatus {
		if (this.hasPendingPermission) {
			return 'awaiting';
		}
		if (this.agentRunning || this.isStreaming) {
			return 'running';
		}
		return 'idle';
	}

	/** Current streaming assistant message (chunks/tool calls are appended here). */
	currentStreamingAssistant(): ChatMessage | undefined {
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
	pushToolCallToStreaming(tc: ToolCallInfo): void {
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
		this.setReasoningActive(assistant, false);
	}

	/** Append a text chunk to the current streaming assistant message. */
	appendStreamChunk(text: string): void {
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
		this.setReasoningActive(msg, false);
		this.streamThrottle?.update();
	}

	/** Append a reasoning chunk (thought) to the current streaming assistant message. */
	appendThoughtChunk(text: string): void {
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
		this.setReasoningActive(msg, true);
		this.streamThrottle?.update();
	}

	/**
	 * Set reasoningActive on the last activity block of the message, clearing the
	 * flag on all others (guard against stuck `true`). `value=false` clears everywhere.
	 */
	private setReasoningActive(msg: ChatMessage | undefined, value: boolean): void {
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
	endStreaming(): void {
		if (this.streamingIndex !== null) {
			const msg = this.messages[this.streamingIndex];
			if (msg) {
				msg._lastChunkKind = null;
				this.setReasoningActive(msg, false);
			}
		}
		this.streamThrottle?.flush();
		this.streamThrottle?.dispose();
		this.streamThrottle = null;
		this.streamingIndex = null;
		this.isStreaming = false;
	}

	/** Take and clear the pending follow-up message (called after the turn ends). */
	consumePendingFollowUp(): string | null {
		const msg = this.pendingFollowUpMessage;
		this.pendingFollowUpMessage = null;
		return msg;
	}

	/** Allocate a unique permission request id. */
	allocatePermissionRequestId(): string {
		return `perm-${++this.permissionRequestIdCounter}`;
	}

	/** Map ACP PlanEntry[] → UI Plan (content→title, completed→done, id by index). */
	mapPlanEntries(entries: PlanEntry[]): Plan {
		const items: PlanItem[] = entries.map((e, i) => ({
			id: `step-${i}`,
			title: e.content,
			description: '',
			status: e.status === 'completed' ? 'done' : e.status,
		}));
		return { items };
	}

	/**
	 * Vendor fallback (opencode): if the tool-call carries a plan in args,
	 * sync currentPlan. The standard ACP plan update takes priority.
	 */
	maybeSyncPlanFromTool(tc: ToolCallInfo): void {
		const entries = extractPlanFromToolArgs(tc.args);
		if (!entries) {
			return;
		}
		this.currentPlan = this.mapPlanEntries(entries);
		this.callbacks.sendPlan();
	}
}