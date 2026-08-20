import { useMemo } from 'preact/hooks';

/** Attached image (paste/drop). data is base64 without the data: prefix. */
export interface AttachedImage {
	id: string;
	mimeType: string;
	data: string;
	name?: string;
}

export interface ToolCallInfo {
	name: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	status: 'pending' | 'success' | 'error' | 'awaiting_permission' | 'rejected' | 'cancelled';
	/** Short description for the compact view */
	summary: string;
	/** ACP tool call id (for updates via tool_call_update) */
	toolCallId?: string;
	/** ACP tool kind (read|edit|delete|move|search|execute|think|fetch|switch_mode|other) */
	kind?: string;
	/** ACP locations (follow-along) — paths/ranges */
	locations?: Array<{ path?: string; line?: number; endLine?: number } | Record<string, unknown>>;
	/** ACP content-diff block (standard: path/oldText/newText) — runtime-only, for the Diff Editor. */
	diffContent?: { path: string; oldText?: string | null; newText: string };
	/** ACP permission request id — to match the webview's decision (status=awaiting_permission) */
	permissionRequestId?: string;
	/** ACP permission options (agent-provided) — render the approval card */
	permissionOptions?: Array<{ optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>;
}

/** A plan step */
export interface PlanItem {
	id: string;
	title: string;
	description: string;
	status: 'pending' | 'in_progress' | 'done';
}

/** An execution plan */
export interface Plan {
	items: PlanItem[];
}

/** Agent session (from ACP session/list) — no local storage. */
export interface AcpSessionInfo {
	sessionId: string;
	title?: string | null;
	updatedAt?: string | null;
}

/** Tab lifecycle status (host-side, from updateTabs). */
export type TabStatus = 'idle' | 'running' | 'awaiting' | 'loading';

/** One open session tab. */
export interface TabInfo {
	sessionId: string;
	title: string;
	status: TabStatus;
}

/** In-flight session create/load — shown as a loading view until showChat arrives. */
export interface ChatLoadingInfo {
	title: string;
	mode: 'new' | 'load';
}

/** Recent-session item shown in the "+" dropdown. */
export interface RecentSessionInfo {
	sessionId: string;
	title: string;
	updatedAt: number;
	/** True when the session currently has a live runtime (tab or lazy). */
	active: boolean;
}

/** Activity block (the only block the ActivityBar renders). */
export type ActivityBlock = Extract<MessageBlock, { type: 'activity' }>;

export type MessageBlock = 
	| { type: 'text'; content: string }
	| { type: 'activity'; toolCalls: ToolCallInfo[]; reasoning: string; reasoningPhases: number; reasoningActive?: boolean };

export interface ChatMessage {
	role: 'user' | 'assistant';
	blocks: MessageBlock[];
	isError?: boolean;
	isStreaming?: boolean;
	isQueued?: boolean;
	attachedFiles?: string[];
	images?: AttachedImage[];
}

export interface CommandInfo {
	name: string;
	description: string;
	input?: { hint: string } | null;
}

export interface AgentInfo {
	name: string;
	title?: string;
	version?: string;
}

/** Human-readable agent label: `title || name`, with `v{version}` when present. */
export function formatAgentLabel(agentInfo: AgentInfo | null | undefined): string {
	if (!agentInfo) return '';
	const label = agentInfo.title || agentInfo.name;
	return agentInfo.version ? `${label} v${agentInfo.version}` : label;
}

/* ============================================================
   Shared constants & utilities (DRY — used in MessageBubble, App)
   ============================================================ */

/** Marker for an empty LLM response */
export const EMPTY_RESPONSE = '(empty response)';

/** Compact number formatting: 1 → "1", 1200 → "1.2K", 12000 → "12K" */
export function formatCompactNumber(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
	return `${Math.round(n / 1000)}K`;
}

/* ============================================================
   Session config (mode / model / thought_level) — ACP configOptions
   ============================================================ */

/** One session config dropdown. */
export interface ConfigSelector {
	id: string;
	label: string;
	category: string;
	currentValue: string;
	options: ConfigOption[];
}

export interface ConfigOption {
	value: string;
	name: string;
	description?: string;
}

/** Config state: selectors + modeId→color-index map. */
export interface ConfigState {
	selectors: ConfigSelector[];
	modeColorIndex: Record<string, number>;
}

/** Mode color palette — taken from the active theme's terminal ANSI tokens,
 *  so it follows the theme (dark/light/HC) and stays readable in both kinds.
 *  10 distinct shades out of the 14 available (black/white excluded — they blend with the background). */
export const MODE_COLORS = [
	'var(--vscode-terminal-ansiBlue)',
	'var(--vscode-terminal-ansiYellow)',
	'var(--vscode-terminal-ansiCyan)',
	'var(--vscode-terminal-ansiMagenta)',
	'var(--vscode-terminal-ansiGreen)',
	'var(--vscode-terminal-ansiRed)',
	'var(--vscode-terminal-ansiBrightYellow)',
	'var(--vscode-terminal-ansiBrightBlue)',
	'var(--vscode-terminal-ansiBrightMagenta)',
	'var(--vscode-terminal-ansiBrightCyan)',
];

export function modeColor(id: string | null | undefined, modeColorIndex: Record<string, number>): string | null {
	if (!id) return null;
	const idx = modeColorIndex[id];
	if (idx === undefined) return null;
	return MODE_COLORS[idx % MODE_COLORS.length];
}

/** Active mode → hex for --ct-mode (colors border/trigger/dots/activity-bar). */
export function useActiveModeColor(config: ConfigState | null): string | null {
	return useMemo(() => {
		if (!config) return null;
		const modeSel = config.selectors.find((s) => s.category === 'mode');
		if (!modeSel) return null;
		return modeColor(modeSel.currentValue, config.modeColorIndex);
	}, [config]);
}
