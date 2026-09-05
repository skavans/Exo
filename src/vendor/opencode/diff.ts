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
 * restore each context/removed line's exact leading whitespace from the file,
 * keep every added line's own relative indentation and re-pad what the trim
 * removed, then reapply.
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
 * file's line at the hunk offset yields the original indent. Added lines keep
 * their own relative indentation from the (trimmed) patch and get re-padded
 * with exactly what the trim removed (`trimDiff` slices the same character
 * count off every content line, so the delta measured on any anchor line is
 * the global trim amount). This preserves multi-level added blocks and is
 * exact for tabs too (the trim's character arithmetic matches ours). Blank
 * content lines keep their trimmed form — `trimDiff` strips them fully, so
 * re-padding would break exact context matching on hunks with blank lines.
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
			// How many whitespace chars `trimDiff` sliced off every content line
			// of this hunk; null when the hunk has no usable anchor line.
			const removed = hunkTrimmedIndent(hunk, fileLines);
			let fileIdx = hunk.oldStart - 1;
			// The file's own whitespace char (space or tab) for re-padding added lines.
			let padChar = ' ';
			for (const line of hunk.lines) {
				const marker = line[0];
				if (marker === ' ' || marker === '-') {
					const body = line.slice(1).replace(/^\s*/, '');
					const fileLine = fileLines[fileIdx];
					if (fileLine !== undefined) {
						const ws = leadingWs(fileLine);
						if (body.length > 0) {
							if (ws.length > 0) {
								padChar = ws.charAt(ws.length - 1);
							}
							out.push(marker + ws + body);
						} else {
							out.push(marker);
						}
					} else {
						out.push(line);
					}
					fileIdx++;
				} else if (marker === '+') {
					// Keep the added line's own indentation, re-pad the trimmed prefix.
					const own = line.slice(1);
					out.push(own.trim().length > 0 ? '+' + padChar.repeat(removed ?? 0) + own : '+');
				} else {
					out.push(line);
				}
			}
		}
	}
	return out.join('\n');
}

/**
 * The per-line number of whitespace characters `trimDiff` removed: measured on
 * the first usable anchor (context/removed) line as the difference between the
 * file line's leading whitespace and the patch line's leading whitespace as-is.
 * null when no anchor is usable (added lines keep their trimmed indentation).
 */
function hunkTrimmedIndent(hunk: { oldStart: number; lines: string[] }, fileLines: string[]): number | null {
	let fileIdx = hunk.oldStart - 1;
	for (const line of hunk.lines) {
		const marker = line[0];
		if (marker !== ' ' && marker !== '-') {
			continue;
		}
		const fileLine = fileLines[fileIdx];
		fileIdx++;
		if (fileLine === undefined) {
			continue;
		}
		const own = line.slice(1);
		if (own.trim().length === 0) {
			continue;
		}
		const removed = leadingWs(fileLine).length - leadingWs(own).length;
		if (removed >= 0) {
			return removed;
		}
	}
	return null;
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
