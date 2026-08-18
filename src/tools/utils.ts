import * as path from 'path';

/** Split content into lines, dropping the trailing empty line from a final `\n`. */
export function splitLines(content: string): string[] {
	const lines = content.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Resolves relative path against workspace root and validates it's inside workspace.
 * Used by file operations for path security.
 */
export function resolveAndValidatePath(
	relativePath: string,
	workspaceRoot: string,
): { ok: true; absolutePath: string } | { ok: false; error: string } {
	const absolutePath = path.resolve(workspaceRoot, relativePath);
	if (!absolutePath.startsWith(workspaceRoot)) {
		return { ok: false, error: 'Path is outside the workspace' };
	}
	return { ok: true, absolutePath };
}
