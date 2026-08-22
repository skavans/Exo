/**
 * OpenCode-specific edit-diff reconstruction.
 *
 * opencode trims the common indentation from unified diffs (`trimDiff` in
 * tool/edit.ts) for TUI readability, then reconstructs the ACP `type:"diff"`
 * content block via `applyPatch` (acp/permission.ts::diffContentForPatch).
 * For edits inside indented blocks the trimmed patch no longer matches the
 * file, `applyPatch` returns `false`, and opencode silently omits the
 * `type:"diff"` block — clients then have no preview next to the approval.
 * (https://github.com/anomalyco/opencode/issues/37266)
 *
 * This module is a client-side FALLBACK: when the standard ACP diff block is
 * missing, reconstruct the EditSpec from the tool's rawInput. The trimmed
 * indentation is recovered deterministically from the file itself (the patch
 * carries per-hunk line offsets), not by blind re-indent guessing.
 *
 * The edit tool's rawInput arrives in one of two shapes:
 *   - `{ filepath|filePath|path, diff }` — a (possibly trimmed) unified diff.
 *   - `{ filePath, oldString, newString }` — the raw replace pair; the most
 *     reliable source, since the EditSpec builds directly from it.
 */

import { parsePatch, applyPatch } from 'diff';
import type { EditSpec } from '../../acp/handlers/util';

/**
 * Detect opencode's edit-tool rawInput shape: either `{ filepath|filePath|path,
 * diff }` (a possibly indentation-trimmed unified diff) or `{ filePath,
 * oldString, newString }` (the raw replace pair).
 */
export function isOpenCodeEditArgs(args: unknown): args is Record<string, unknown> {
	if (!args || typeof args !== 'object') {
		return false;
	}
	const a = args as Record<string, unknown>;
	if (typeof a.diff === 'string' && a.diff.length > 0) {
		return pickPath(a) !== null;
	}
	return typeof a.oldString === 'string' && typeof a.newString === 'string' && pickPath(a) !== null;
}

/**
 * Reconstruct an EditSpec from opencode's edit-tool rawInput when the standard
 * ACP `type:"diff"` content block is missing (#37266).
 *
 * `readFileText` resolves an absolute-or-relative path to file contents
 * (returns null when the file can't be read). Returns null on any failure —
 * callers fall back to today's no-preview behavior.
 */
export async function restoreOpenCodeEditSpec(
	args: unknown,
	readFileText: (rawPath: string) => Promise<string | null>,
): Promise<EditSpec | null> {
	if (!isOpenCodeEditArgs(args)) {
		return null;
	}
	const a = args as Record<string, unknown>;
	const filePath = pickPath(a);
	if (!filePath) {
		return null;
	}
	const content = await readFileText(filePath);
	if (content === null) {
		return null;
	}

	// Shape 1: raw replace pair — build the EditSpec directly.
	if (typeof a.oldString === 'string' && typeof a.newString === 'string') {
		if (!content.includes(a.oldString)) {
			return null;
		}
		return { filePath, original: content, proposed: content.replace(a.oldString, a.newString) };
	}

	// Shape 2: unified diff — apply it, recovering trimmed indentation if needed.
	const next = applyWithRetry(content, a.diff as string);
	if (next === null) {
		return null;
	}
	return { filePath, original: content, proposed: next };
}

/**
 * Apply the patch directly; if that fails (indentation trimmed by opencode),
 * restore each hunk line's exact leading whitespace from the file and reapply.
 */
function applyWithRetry(content: string, diff: string): string | null {
	const direct = applyPatch(content, diff);
	if (typeof direct === 'string') {
		return direct;
	}
	const restored = reindentFromFile(content, diff);
	if (restored === null) {
		return null;
	}
	const next = applyPatch(content, restored);
	return typeof next === 'string' ? next : null;
}

/**
 * Rebuild the diff with exact leading whitespace recovered from the file —
 * the inverse of opencode's `trimDiff`. For each context/removed line the
 * file's line at the hunk offset yields the original indent; added lines
 * inherit the indent of the nearest preceding context/removed line. This is
 * robust to tabs, spaces and mixed indentation (unlike a character-count
 * re-pad, which would corrupt tab-indented files). Blank content lines keep
 * their trimmed form — `trimDiff` strips them fully, so re-padding would break
 * exact context matching on hunks that contain blank lines.
 */
function reindentFromFile(content: string, diff: string): string | null {
	let parsed;
	try {
		parsed = parsePatch(diff);
	} catch {
		return null;
	}
	const fileLines = content.split('\n');
	const out: string[] = [];
	for (const fileDiff of parsed) {
		out.push(
			`Index: ${fileDiff.index}`,
			'===================================================================',
			`--- ${fileDiff.oldFileName}`,
			`+++ ${fileDiff.newFileName}`,
		);
		for (const hunk of fileDiff.hunks) {
			out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
			let fileIdx = hunk.oldStart - 1;
			let lastWs = '';
			for (const line of hunk.lines) {
				const marker = line[0];
				// Strip whatever leading whitespace the trimmed patch still carries,
				// then re-apply the file's own indent.
				const body = line.slice(1).replace(/^\s*/, '');
				if (marker === ' ' || marker === '-') {
					const fileLine = fileLines[fileIdx];
					if (fileLine !== undefined) {
						const ws = leadingWs(fileLine);
						if (body.length > 0) {
							lastWs = ws;
							out.push(marker + ws + body);
						} else {
							out.push(marker);
						}
					} else {
						out.push(line);
					}
					fileIdx++;
				} else if (marker === '+') {
					out.push(body.length > 0 ? '+' + lastWs + body : '+');
				} else {
					out.push(line);
				}
			}
		}
	}
	return out.join('\n');
}

function leadingWs(line: string): string {
	const m = line.match(/^\s*/);
	return m ? m[0] : '';
}

/** First present path key (filepath/filePath/path) in opencode edit rawInput. */
function pickPath(args: Record<string, unknown>): string | null {
	for (const key of ['filepath', 'filePath', 'path'] as const) {
		const v = args[key];
		if (typeof v === 'string' && v.length > 0) {
			return v;
		}
	}
	return null;
}
