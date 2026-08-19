/**
 * worktree.ts — git worktree helper.
 *
 * Each Exo session (tab) runs its own agent subprocess rooted in its own
 * working copy. When the workspace is a git repository, new sessions get a
 * freshly created worktree (own folder + local-only branch). When it isn't,
 * sessions share the workspace root (no isolation).
 *
 * Pure `git worktree` CLI — no dependency on the VS Code git extension API or
 * version, so it stays aligned with `engines.vscode: ^1.73.0`.
 */
import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export interface WorktreeInfo {
	/** Absolute path to the worktree (agent cwd). */
	path: string;
	/** Local branch the worktree was created on (never pushed). */
	branch: string;
}

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile('git', args, { cwd }, (err, stdout) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(stdout.toString());
		});
	});
}

/** True when `root` (or any parent) is inside a git working tree. */
export async function isGitRepository(root: string): Promise<boolean> {
	try {
		const out = await runGit(['rev-parse', '--is-inside-work-tree'], root);
		return out.trim() === 'true';
	} catch {
		return false;
	}
}

/**
 * Create a worktree for a new session. Worktrees live in a sibling
 * `.exo-worktrees/<slug>` directoy; branch is `exo/<slug>` (local-only).
 * Returns null when not a git repository (fall back to the shared root).
 */
export async function createWorktree(root: string): Promise<WorktreeInfo | null> {
	if (!(await isGitRepository(root))) {
		return null;
	}
	const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const branch = `exo/${slug}`;
	const target = path.join(path.dirname(root), '.exo-worktrees', slug);
	try {
		await runGit(['worktree', 'add', '-b', branch, target], root);
	} catch (err) {
		console.error('[Exo worktree] create failed:', err);
		return null;
	}
	return { path: target, branch };
}

/** True when the worktree has uncommitted changes (staged, working tree or untracked). */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
	try {
		const out = await runGit(['status', '--porcelain'], worktreePath);
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/** Delete the worktree (force — the caller is responsible for dirty state). */
export async function removeWorktree(worktreePath: string): Promise<boolean> {
	try {
		await runGit(['worktree', 'remove', '--force', worktreePath], worktreePath);
		return true;
	} catch (err) {
		console.error('[Exo worktree] remove failed:', err);
		return false;
	}
}

/**
 * Register a worktree in VS Code's Source Control view via the built-in git
 * extension API (`api.openRepository`). This makes the worktree appear in the
 * Source Control repositories list regardless of `git.detectWorktrees` timing
 * and even though its folder lives outside the workspace.
 */
export async function registerWorktreeInScm(worktreePath: string): Promise<void> {
	try {
		const gitExt = vscode.extensions.getExtension('vscode.git');
		if (!gitExt) {
			return;
		}
		const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
		const api = (exports as { getAPI?: (version: 1) => { getRepository: (uri: vscode.Uri) => unknown; openRepository: (root: vscode.Uri) => Promise<unknown> } } | undefined);
		if (!api?.getAPI) {
			return;
		}
		const gitApi = api.getAPI(1);
		if (gitApi.getRepository(vscode.Uri.file(worktreePath))) {
			return; // already registered
		}
		await gitApi.openRepository(vscode.Uri.file(worktreePath));
	} catch (err) {
		console.error('[Exo worktree] SCM registration failed:', err);
	}
}