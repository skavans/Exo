/**
 * worktree.ts — git worktree helper.
 *
 * Each Exo session (tab) runs its own agent subprocess rooted in its own
 * working copy. When the workspace is a git repository, new sessions get a
 * freshly created worktree (own folder + local-only branch). When it isn't,
 * sessions share the workspace root (no isolation).
 *
 * Worktrees live INSIDE the repo at `.exo/worktrees/<slug>` (not as a sibling
 * as before). That keeps them under the trusted repo root: VS Code's workspace
 * trust is path-based and parent-inclusive, so the managed Exo workspace can
 * switch the Explorer folder to a session's worktree without dropping the
 * window into Restricted Mode. `.exo/` is hidden from git via `info/exclude`
 * (never committed, never shows in `git status`).
 *
 * Pure `git worktree` CLI — no dependency on the VS Code git extension API or
 * version, so it stays aligned with `engines.vscode: ^1.73.0`.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
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
 * The repo's common git dir (absolute), or null when not resolvable. Works for
 * plain clones (`.git` dir), worktrees and submodules (`.git` file) alike.
 */
async function gitCommonDir(root: string): Promise<string | null> {
	try {
		const out = await runGit(['rev-parse', '--git-common-dir'], root);
		const dir = out.trim();
		if (!dir) {
			return null;
		}
		return path.isAbsolute(dir) ? dir : path.resolve(root, dir);
	} catch {
		return null;
	}
}

/**
 * Hide `.exo/` from git: append `/.exo/` to the repo's `info/exclude` so the
 * managed workspace file and worktree copies never show up in `git status` and
 * are never committed. Best-effort — any failure only means the dir is visible.
 */
export async function ensureGitExclude(root: string): Promise<void> {
	try {
		const common = await gitCommonDir(root);
		if (!common) {
			return;
		}
		const excludePath = path.join(common, 'info', 'exclude');
		let content = '';
		try {
			content = await fs.promises.readFile(excludePath, 'utf8');
		} catch {
			// info/exclude may not exist yet
		}
		if (content.split(/\r?\n/).some((line) => line.trim() === '/.exo/')) {
			return;
		}
		const line = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
		await fs.promises.writeFile(excludePath, content + line + '/.exo/\n', 'utf8');
	} catch (err) {
		console.error('[Exo worktree] git exclude failed:', err);
	}
}

/**
 * Create a worktree for a new session. Worktrees live inside the repo under
 * `.exo/worktrees/<slug>` (branch `exo/<slug>`, local-only). Being a child of
 * the trusted repo root keeps them workspace-trusted when the Explorer follows
 * the active session. Returns null when not a git repository (shared root).
 */
export async function createWorktree(root: string): Promise<WorktreeInfo | null> {
	if (!(await isGitRepository(root))) {
		return null;
	}
	const slug = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const branch = `exo/${slug}`;
	const target = path.join(root, '.exo', 'worktrees', slug);
	try {
		await ensureGitExclude(root);
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

/**
 * Resolve the "main" branch of the shared repository: origin's default branch
 * (`origin/HEAD`) or, failing that, a local `main`/`master`. Returns null when
 * undeterminable (bare repo, no remote, unusual branch name).
 */
async function resolveMainBranch(worktreePath: string): Promise<string | null> {
	try {
		const head = (await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], worktreePath)).trim();
		if (head) {
			return head;
		}
	} catch {
		// fall through to local main/master
	}
	for (const branch of ['main', 'master']) {
		try {
			await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], worktreePath);
			return branch;
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * True when the worktree would lose valuable work on removal: uncommitted/
 * untracked changes, or commits reachable from its HEAD but absent from the
 * main branch (i.e. agent work not merged anywhere else). Best-effort — any
 * git failure is treated as "clean" except the check itself being relevant.
 */
export async function sessionHasUncommittedWork(worktreePath: string): Promise<boolean> {
	if (await hasUncommittedChanges(worktreePath)) {
		return true;
	}
	const main = await resolveMainBranch(worktreePath);
	if (!main) {
		return false;
	}
	try {
		const out = await runGit(['rev-list', '--count', `${main}..HEAD`], worktreePath);
		return parseInt(out.trim(), 10) > 0;
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