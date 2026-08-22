/**
 * worktree.ts — git worktree helper.
 *
 * Each Exo session (tab) runs its own agent subprocess rooted in its own
 * working copy. When the workspace is a git repository, new sessions get a
 * freshly created worktree (own folder + local-only branch). When it isn't,
 * sessions share the workspace root (no isolation).
 *
 * Worktrees live INSIDE the repo at `.exo/worktrees/exo-<N>` (not as a sibling
 * as before), `N` being the session's ordinal number — the same one used for the
 * terminal name (`exo-<N>`), the header badge and the folder/branch name, so
 * they all read identically. That keeps them under the trusted repo root: VS
 * Code's workspace
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
	/** Ordinal number `N` — the worktree dir/branch is `exo-<N>`. */
	number: number;
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

/** Parse `.exo/worktrees/exo-<N>` dir names into their numbers. */
async function usedWorktreeNumbers(root: string): Promise<Set<number>> {
	const numbers = new Set<number>();
	try {
		const entries = await fs.promises.readdir(path.join(root, '.exo', 'worktrees'), { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const m = /^exo-(\d+)$/.exec(entry.name);
			if (m) {
				numbers.add(Number(m[1]));
			}
		}
	} catch {
		// `.exo/worktrees/` doesn't exist yet — nothing used.
	}
	return numbers;
}

/**
 * Create a worktree for a new session. Worktrees live inside the repo under
 * `.exo/worktrees/exo-<N>` (branch `exo-<N>`, local-only, never pushed), `N`
 * being the first free number on disk — so the folder/branch name always
 * matches the session's ordinal number (`exo-<N>` terminal, header badge).
 * Being a child of the trusted repo root keeps them workspace-trusted when the
 * Explorer follows the active session. Returns null when not a git repository
 * (shared root).
 */
export async function createWorktree(root: string): Promise<WorktreeInfo | null> {
	if (!(await isGitRepository(root))) {
		return null;
	}
	const used = await usedWorktreeNumbers(root);
	let number = 1;
	while (used.has(number)) {
		number++;
	}
	const name = `exo-${number}`;
	const target = path.join(root, '.exo', 'worktrees', name);
	try {
		await ensureGitExclude(root);
		await runGit(['worktree', 'add', '-b', name, target], root);
	} catch (err) {
		console.error('[Exo worktree] create failed:', err);
		return null;
	}
	return { path: target, branch: name, number };
}

/**
 * True when the worktree has uncommitted changes worth protecting: tracked
 * modifications (staged or not) or non-empty untracked files. Zero-byte
 * untracked files are treated as tool artifacts (e.g. opencode's stray `-`)
 * and ignored — they must not block a merge or a session delete.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
	try {
		const out = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], worktreePath);
		for (const record of out.split('\0')) {
			if (!record) {
				continue;
			}
			if (!record.startsWith('?? ')) {
				return true; // tracked change (staged/working-tree/rename)
			}
			const file = path.resolve(worktreePath, record.slice(3));
			try {
				if ((await fs.promises.stat(file)).size > 0) {
					return true;
				}
			} catch {
				return true; // can't stat — treat as dirty to be safe
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Resolve the "main" branch of the shared repository: the local branch
 * pointed to by origin's default (`origin/HEAD`), or a local `main`/`master`.
 * Returns null when undeterminable (bare repo, no remote, unusual branch
 * name). The result is a LOCAL branch name — Exo merges into the local branch,
 * and comparing against the remote-tracking ref (`origin/main`) would always
 * look unmerged until a fetch.
 */
async function resolveMainBranch(worktreePath: string): Promise<string | null> {
	try {
		const head = (await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], worktreePath)).trim();
		if (head) {
			// `--short` yields `origin/main`; strip the remote prefix so the
			// comparison targets the local branch (e.g. `main`), not `origin/main`.
			const name = head.replace(/^[^/]+\//, '');
			if (name) {
				return name;
			}
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
		// Drop the now-unlinked branch too. Safe: `-d` only deletes when the
		// branch is fully merged (or via its upstream) — otherwise it fails and
		// the branch stays.
		const branch = path.basename(worktreePath);
		try {
			await runGit(['branch', '-d', branch], path.dirname(worktreePath));
		} catch {
			// branch unmerged or already gone — keep it.
		}
		return true;
	} catch (err) {
		console.error('[Exo worktree] remove failed:', err);
		return false;
	}
}

export type MergeWorktreeStatus =
	| { status: 'clean-merged' }
	| { status: 'merged-dirty' }
	| { status: 'uncommitted' }
	| { status: 'conflict'; detail: string };

/**
 * Merge the worktree's branch into the repository's main branch. The agent
 * runs in a linked worktree where `main` is checked out in the primary
 * worktree, so `git checkout main` is impossible there — the host performs the
 * merge where main is checked out (the root worktree). Only commits are moved:
 * uncommitted files in the worktree don't block the merge. Idempotent —
 * returns `clean-merged` when the branch is already fully in main.
 */
export async function mergeWorktreeToMain(worktreePath: string, root: string): Promise<MergeWorktreeStatus> {
	try {
		const main = await resolveMainBranch(worktreePath);
		if (!main) {
			return { status: 'conflict', detail: 'main branch is not resolvable' };
		}
		const ahead = parseInt((await runGit(['rev-list', '--count', `${main}..HEAD`], worktreePath)).trim(), 10);
		if (ahead === 0) {
			return (await hasUncommittedChanges(worktreePath)) ? { status: 'uncommitted' } : { status: 'clean-merged' };
		}
		const branch = path.basename(worktreePath);
		try {
			await runGit(['merge', '--no-edit', branch], root);
		} catch (err) {
			return { status: 'conflict', detail: err instanceof Error ? err.message : String(err) };
		}
		return (await hasUncommittedChanges(worktreePath)) ? { status: 'merged-dirty' } : { status: 'clean-merged' };
	} catch (err) {
		return { status: 'conflict', detail: err instanceof Error ? err.message : String(err) };
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