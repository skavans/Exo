/** Shared utilities for ACP handlers (fs/terminal/permission). */

import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { ToolCallInfo } from '../../chat/types';

/**
 * Shared tool-call registry context: runtime map + updateMessages posting +
 * a hook to push a synthetic ToolCallInfo into the current streaming assistant.
 *
 * Used by both the permission handler (approval card) and the fs handler
 * (write-review card), so synthetic cards appear in the chat through a single
 * ToolCallInfo.status mechanism rather than ad-hoc postMessages.
 */
export interface ToolCallRegistryContext {
	/** Runtime map toolCallId → ToolCallInfo (to update the card status). */
	toolCallInfos: Map<string, ToolCallInfo>;
	/** Post updateMessages to the webview (after a ToolCallInfo update). */
	postUpdateMessages: () => void;
	/** Push a ToolCallInfo into the current streaming assistant (toolCalls[]). */
	onToolCallCreated?: (tc: ToolCallInfo) => void;
}

/**
 * Extract the concatenated text from ACP ToolCallContent[].
 * Collects `content` blocks holding text and joins them with newlines.
 * Accepts unknown — tolerant of unpatched types.
 */
export function extractToolText(content: unknown): string | undefined {
	if (!Array.isArray(content) || content.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	for (const c of content as Array<{ type: string; content?: { type: string; text?: string } }>) {
		if (c?.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string') {
			parts.push(c.content.text);
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Apply an upsert patch (ToolCallUpdate) to an existing ToolCallInfo
 * (fields title/kind/locations/content/rawInput). Does NOT touch status — that
 * is the caller's responsibility (onToolCallUpdate maps via mapToolStatus,
 * the permission handler sets 'awaiting_permission').
 *
 * Kept as a single function so the patch logic isn't duplicated (duplication in
 * the permission handler once dropped rawInput — the "card always shows the
 * first command" bug).
 */
export function applyToolCallPatch(tc: ToolCallInfo, u: ToolCallUpdate): void {
	if (u.title != null) tc.summary = u.title;
	if (u.kind != null) {
		tc.kind = u.kind ?? undefined;
		if (!tc.name || tc.name === 'other') tc.name = u.kind ?? 'other';
	}
	if (u.locations !== undefined && u.locations !== null) {
		tc.locations = (u.locations as unknown[]) ?? undefined;
	}
	if (u.content !== undefined && u.content !== null) {
		const resultText = extractToolText(u.content);
		if (resultText !== undefined) tc.result = resultText;
		const diffContent = extractDiffContent(u.content);
		if (diffContent) tc.diffContent = diffContent;
	}
	if (u.rawInput !== undefined && u.rawInput !== null) {
		tc.args = (u.rawInput as Record<string, unknown>) ?? {};
	}
}

/**
 * Extract the first `type:"diff"` block from ACP ToolCallContent[] — the standard
 * way edits are passed (path + oldText/original + newText/proposed). Returns
 * original/proposed directly, without reading the file or parsing a patch.
 */
export function extractDiffContent(content: unknown): { path: string; oldText?: string | null; newText: string } | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const c of content as Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>) {
		if (c?.type === 'diff' && typeof c.path === 'string' && typeof c.newText === 'string') {
			return { path: c.path, oldText: c.oldText, newText: c.newText };
		}
	}
	return undefined;
}

/** Edit spec for the Diff Editor: only the standard ACP content-diff block. */
export interface EditSpec {
	filePath: string;
	original?: string;
	proposed?: string;
}

/** Build an EditSpec from a standard ACP `type:'diff'` content block. null if absent. */
export function extractEditSpec(
	diffContent: { path: string; oldText?: string | null; newText: string } | undefined,
): EditSpec | null {
	if (!diffContent) {
		return null;
	}
	return { filePath: diffContent.path, original: diffContent.oldText ?? '', proposed: diffContent.newText };
}
