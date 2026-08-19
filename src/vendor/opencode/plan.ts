/**
 * OpenCode-specific plan detection.
 *
 * opencode doesn't use the standard ACP `plan` session-update surface — it
 * puts the plan in a tool-call's `rawInput` as `{todos:[{content,status,priority}]}`.
 *
 * IMPORTANT: this is a FALLBACK, not a competitor to the standard `plan`
 * update. The standard `plan` (ChatViewProvider.onPlan) stays authoritative;
 * this only fires when tool args really look like a plan (shape detection)
 * and no standard plan arrived for the same turn.
 */

import type { PlanEntry } from '@agentclientprotocol/sdk';

/**
 * Fallback plan detection for agents that don't emit the standard ACP `plan`
 * update (opencode). Detects a plan by the tool-args shape
 * `{todos:[{content,status,priority}]}`. The format matches PlanEntry 1:1.
 * Returns entries or null (if it doesn't look like a plan).
 */
export function extractPlanFromToolArgs(args: unknown): PlanEntry[] | null {
	if (!args || typeof args !== 'object') return null;
	const todos = (args as Record<string, unknown>).todos;
	if (!Array.isArray(todos) || todos.length === 0) return null;
	const entries: PlanEntry[] = [];
	for (const t of todos as Array<Record<string, unknown>>) {
		if (!t || typeof t.content !== 'string') continue;
		const status = t.status;
		if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
		const priority = t.priority;
		entries.push({
			content: t.content,
			status,
			priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium',
		});
	}
	return entries.length > 0 ? entries : null;
}