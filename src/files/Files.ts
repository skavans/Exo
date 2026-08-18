/**
 * Files — line cache of read files for ACP fs/read_text_file / fs/write_text_file.
 *
 * Stores file contents line-by-line (line-based reads per ACP `line`/`limit` params).
 * Handlers live in `src/acp/handlers/fs.ts`; the agent assembles its own context.
 */
import * as fs from 'fs';
import { splitLines, resolveAndValidatePath } from '../tools/utils';

interface FileEntry {
	lines: string[];
	totalLines: number;
}

function clampRange(start: number, end: number, totalLines: number): { start: number; end: number } | null {
	if (totalLines <= 0) {
		return null;
	}
	const clampedStart = Math.max(0, Math.min(start, totalLines - 1));
	const clampedEnd = Math.max(0, Math.min(end, totalLines - 1));
	if (clampedStart > clampedEnd) {
		return null;
	}
	return { start: clampedStart, end: clampedEnd };
}

function formatFileView(lines: string[], range: { start: number; end: number }): string {
	const parts: string[] = [];
	for (let i = range.start; i <= range.end; i++) {
		parts.push(`${i + 1} | ${lines[i] ?? ''}`);
	}
	return parts.join('\n');
}

export class Files {
	private readonly _files = new Map<string, FileEntry>();

	/** Read a file range (`from`..`end`, 1-based, inclusive). */
	async read(
		filePath: string,
		workspaceRoot: string,
		from?: number,
		end?: number,
	): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
		const readResult = this._readFileContent(filePath, workspaceRoot);
		if (!readResult.ok) {
			return readResult;
		}

		const entry = this._ensureEntry(filePath, readResult.content);
		const from0 = (from ?? 1) - 1;
		const end0 = (end ?? entry.totalLines) - 1;
		const range = clampRange(from0, end0, entry.totalLines);
		if (!range) {
			return { ok: true, content: '(empty file)' };
		}

		return { ok: true, content: formatFileView(entry.lines, range) };
	}

	/** Re-read the whole file and refresh the cache (after an agent write). */
	async replaceFull(
		filePath: string,
		workspaceRoot: string,
	): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
		const readResult = this._readFileContent(filePath, workspaceRoot);
		if (!readResult.ok) {
			return readResult;
		}

		const entry = this._ensureEntry(filePath, readResult.content);
		return {
			ok: true,
			content: entry.totalLines > 0
				? formatFileView(entry.lines, { start: 0, end: entry.totalLines - 1 })
				: '(empty file)',
		};
	}

	private _readFileContent(
		filePath: string,
		workspaceRoot: string,
	): { ok: true; content: string } | { ok: false; error: string } {
		const pathResult = resolveAndValidatePath(filePath, workspaceRoot);
		if (!pathResult.ok) {
			return { ok: false, error: pathResult.error };
		}

		try {
			const content = fs.readFileSync(pathResult.absolutePath, 'utf-8');
			return { ok: true, content };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return { ok: false, error: `File not found: ${filePath}` };
			}
			if ((err as NodeJS.ErrnoException).code === 'EISDIR') {
				return { ok: false, error: `Path is a directory, not a file: ${filePath}` };
			}
			return { ok: false, error: `Failed to read file: ${(err as Error).message}` };
		}
	}

	private _ensureEntry(filePath: string, content: string): FileEntry {
		const lines = splitLines(content);
		const totalLines = lines.length;
		const entry: FileEntry = { lines, totalLines };
		this._files.set(filePath, entry);
		return entry;
	}
}