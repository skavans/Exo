import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';

/** Permission option from ACP session/request_permission (agent-provided). */
export interface PermissionOptionInfo {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface ToolCallInfo {
	name: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	/** ACP execution status (agent-owned) or the client-side finalization after a permission decision. */
	status: 'pending' | 'success' | 'error' | 'rejected' | 'cancelled';
	summary: string;
	/** ACP tool call id (for updates via tool_call_update) */
	toolCallId?: string;
	/** ACP tool kind */
	kind?: string;
	/** ACP locations (follow-along) — paths/ranges */
	locations?: Array<{ path?: string; line?: number; endLine?: number } | Record<string, unknown>>;
	/** ACP content-diff block (standard: path/oldText/newText) — for the Diff Editor on edit-permissions. */
	diffContent?: { path: string; oldText?: string | null; newText: string };
	/** ACP permission request id — presence marks a pending approval (renders the card). */
	permissionRequestId?: string;
	/** ACP permission options (agent-provided) — render the approval card */
	permissionOptions?: PermissionOptionInfo[];
}

export type MessageBlock = 
	| { type: 'text'; content: string }
	| { type: 'activity'; toolCalls: ToolCallInfo[]; reasoning: string; reasoningPhases: number; reasoningActive?: boolean };

export interface ChatMessage {
	role: 'user' | 'assistant';
	blocks: MessageBlock[];
	isError?: boolean;
	isStreaming?: boolean;
	isQueued?: boolean;
	images?: Array<{ mimeType: string; data: string; name?: string }>;
	/** Runtime-only: kind of the last chunk, for the reasoningPhases counter. Not serialized. */
	_lastChunkKind?: 'text' | 'reasoning' | 'tool' | null;
}

export interface PendingPermission {
	requestId: string;
	toolCallId: string;
	resolve: (response: RequestPermissionResponse) => void;
	/** If the Diff Editor was opened for this permission (edit) — the cleanup key. */
	diffKey?: string;
	/** Deferred edit spec for non-active sessions (opened on tab switch). */
	editSpec?: { filePath: string; original?: string; proposed?: string };
}


