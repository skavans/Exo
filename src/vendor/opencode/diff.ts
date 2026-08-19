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
 */

import { parsePatch, applyPatch } from 'diff';
import type { EditSpec } from '../../acp/handlers/util';

/**
 * Detect opencode's edit-tool rawInput shape: `{ filepath|filePath|path, diff }`
 * where `diff` is a (possibly indentation-trimmed) unified diff.
 */
export function isOpenCodeEditArgs(args: unknown): args is Record<string, unknown> & { diff: string } {
	if (!args || typeof args !== 'object') {
		return false;
	}
	const a = args as Record<string, unknown>;
	if (typeof a.diff !== 'string' || a.diff.length === 0) {
		return false;
	}
	return pickPath(a) !== null;
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
	const filePath = pickPath(args);
	if (!filePath) {
		return null;
	}
	const content = await readFileText(filePath);
	if (content === null) {
		return null;
	}
	const next = applyWithRetry(content, args.diff);
	if (next === null) {
		return null;
	}
	return { filePath, original: content, proposed: next };
}

/**
 * Apply the patch directly; if that fails (indentation trimmed by opencode),
 * recover the trimmed offset from the file and reapply.
 */
function applyWithRetry(content: string, diff: string): string | null {
	const direct = applyPatch(content, diff);
	if (typeof direct === 'string') {
		return direct;
	}
	const delta = computeTrimOffset(content, diff);
	if (delta === null) {
		return null;
	}
	const restored = applyPatch(content, reindentDiff(diff, delta));
	return typeof restored === 'string' ? restored : null;
}

/**
 * Recover the indentation offset opencode's `trimDiff` stripped from the
 * patch. Each hunk carries `oldStart` (1-based); for its first context or
 * removed line, the file's line at that offset gives the original indent.
 * diff — so their difference is exactly the trimmed prefix (works for tabs too:
 * we push the same leading chars back that were sliced off).
 */
function computeTrimOffset(content: string, diff: string): number | null {
	let parsed;
	try {
		parsed = parsePatch(diff);
	} catch {
		return null;
	}
	const fileLines = content.split('\n');
	for (const fileDiff of parsed) {
		for (const hunk of fileDiff.hunks) {
			const idx = hunk.lines.findIndex((l) => l.startsWith(' ') || l.startsWith('-'));
			if (idx === -1) {
				continue;
			}
			const patchIndent = leadingWs(hunk.lines[idx].slice(1)).length;
			const fileIdx = hunk.oldStart - 1 + idx;
			const fileLine = fileLines[fileIdx];
			if (fileLine === undefined) {
				continue;
			}
			const delta = leadingWs(fileLine).length - patchIndent;
			if (Number.isInteger(delta) && delta > 0) {
				return delta;
			}
		}
	}
	return null;
}

/** Push `delta` leading chars back onto every diff content line (inverse of trimDiff). */
function reindentDiff(diff: string, delta: number): string {
	if (delta <= 0) {
		return diff;
	}
	const pad = ' '.repeat(delta);
	return diff
		.split('\n')
		.map((line) =>
			(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
			!line.startsWith('---') &&
			!line.startsWith('+++')
				? line[0] + pad + line.slice(1)
				: line,
		)
		.join('\n');
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