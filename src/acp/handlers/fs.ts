/**
 * fs/* client handlers.
 *
 * The write path is unusual: opencode (and most agents) write files themselves,
 * and fs/write_text_file arrives as a sync notification after an own write
 * (RFd v2 client-filesystem-terminal-capabilities — agents moved to own sandboxing).
 * Edit-consent lives on the permission layer (`session/request_permission`,
 * see permission.ts + ChatViewProvider.openEditDiff), not here.
 *
 * NOTE: ACP sends `path` as an ABSOLUTE path — convert to relative from the
 * workspace root (the Files cache is keyed by relative paths).
 */

import * as fs from 'fs';
import * as path from 'path';
import { RequestError } from '@agentclientprotocol/sdk';
import type {
	ReadTextFileRequest,
	ReadTextFileResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { Files } from '../../files/Files';
import type { ToolCallRegistryContext } from './util';
import { collectDiagnostics } from '../../tools/diagnostics';

/**
 * Context ChatViewProvider supplies to the fs handlers.
 * Tool-call registry exists for future integrations (potentially showing fs
 * operations as chips); read/write don't use it yet.
 */
export interface FsHandlerContext extends ToolCallRegistryContext {
	/** Absolute path to the workspace root */
	getWorkspaceRoot(): string;
	/** Single file cache (used for both reading and refresh-after-write) */
	files: Files;
}

// --- Utilities ---

/**
 * Convert an absolute path to workspace-relative. Returns null if the path is
 * outside the workspace (or points at the root itself).
 */
function toRelativePath(absPath: string, workspaceRoot: string): string | null {
	const rel = path.relative(workspaceRoot, absPath);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
		return null;
	}
	return rel;
}

/** Absolute path from relative (no validation — done in toRelativePath) */
function toAbsolutePath(relPath: string, workspaceRoot: string): string {
	return path.resolve(workspaceRoot, relPath);
}

// --- read_text_file ---

/**
 * fs/read_text_file — read a file through the Files cache.
 *
 * params: { sessionId, path (absolute), line? (1-based start), limit? (max lines) }
 * returns: { content }
 *
 * Errors:
 *   - path outside workspace   → RequestError.invalidParams
 *   - file not found           → RequestError.resourceNotFound
 *   - path is a directory      → RequestError.invalidParams
 */
export async function handleReadTextFile(
	params: ReadTextFileRequest,
	ctx: FsHandlerContext,
): Promise<ReadTextFileResponse> {
	const workspaceRoot = ctx.getWorkspaceRoot();
	const relPath = toRelativePath(params.path, workspaceRoot);
	if (relPath === null) {
		throw RequestError.invalidParams(
			{ path: params.path },
			`Path is outside the workspace: ${params.path}`,
		);
	}

	// ACP: line — 1-based start, limit — max number of lines.
	// Files.read: from/end — 1-based inclusive.
	const from = params.line ?? 1;
	const end = params.limit != null ? from + params.limit - 1 : undefined;

	const result = await ctx.files.read(relPath, workspaceRoot, from, end);
	if (!result.ok) {
		throw mapReadError(result.error, params.path);
	}

	return { content: result.content };
}

/** Map Files.read errors to RequestError */
function mapReadError(error: string, absPath: string): RequestError {
	if (error.startsWith('File not found')) {
		return RequestError.resourceNotFound(absPath);
	}
	if (error.startsWith('Path is a directory')) {
		return RequestError.invalidParams({ path: absPath }, error);
	}
	if (error.startsWith('Path is outside the workspace')) {
		return RequestError.invalidParams({ path: absPath }, error);
	}
	return RequestError.internalError({ error }, `Failed to read file: ${error}`);
}

// --- write_text_file ---

/**
 * fs/write_text_file — write a file (sync after the agent's own write) + refresh the cache.
 *
 * params: { sessionId, path (absolute), content }
 * returns: void (undefined)
 *
 * Edit-consent is NOT here — it lives on the permission layer (see permission.ts).
 * This handler fires AFTER the agent already wrote the file itself.
 */
export async function handleWriteTextFile(
	params: WriteTextFileRequest,
	ctx: FsHandlerContext,
): Promise<WriteTextFileResponse | void> {
	const workspaceRoot = ctx.getWorkspaceRoot();
	const relPath = toRelativePath(params.path, workspaceRoot);
	if (relPath === null) {
		throw RequestError.invalidParams(
			{ path: params.path },
			`Path is outside the workspace: ${params.path}`,
		);
	}

	const absolutePath = toAbsolutePath(relPath, workspaceRoot);

	// Write the file (mkdir recursive for new directories).
	try {
		const dir = path.dirname(absolutePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(absolutePath, params.content, 'utf-8');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw RequestError.internalError({ error: msg }, `Failed to write file: ${msg}`);
	}

	// Refresh the Files cache (replaceFull re-reads the whole file).
	const refreshResult = await ctx.files.replaceFull(relPath, workspaceRoot);
	if (!refreshResult.ok) {
		console.error(`[Exo ACP] Files.replaceFull failed after write: ${refreshResult.error}`);
		// Don't fail — the file is already on disk
	}

	// collectDiagnostics — let the LSP process the change.
	try {
		await collectDiagnostics(relPath, workspaceRoot);
	} catch {
		// ignore — diagnostics are optional
	}

	return undefined;
}
