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
 * Hide Exo-managed paths from git: append `/.exo/` and `/.vscode/` to the
 * repo's `info/exclude` so the managed workspace file, worktree copies and the
 * folder-scoped search settings never show up in `git status` and are never
 * committed. Best-effort — any failure only means the dir is visible.
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
		const lines = content.split(/\r?\n/).map((line) => line.trim());
		const missing = ['/.exo/', '/.vscode/'].filter((entry) => !lines.includes(entry));
		if (missing.length === 0) {
			return;
		}
		const line = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
		await fs.promises.writeFile(excludePath, content + line + missing.join('\n') + '\n', 'utf8');
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

/** True when a local branch `exo-<N>` exists (even with no worktree folder — a deleted session's branch may linger when unmerged). */
async function worktreeBranchExists(root: string, number: number): Promise<boolean> {
	try {
		await runGit(['show-ref', '--verify', '--quiet', `refs/heads/exo-${number}`], root);
		return true;
	} catch {
		return false;
	}
}

/**
 * The worktree's leaf folder name: the project folder name (basename of `root`)
 * VERBATIM. `docker compose` derives its project name from the cwd basename via
 * rules we must not imitate (it keeps `_`, strips `.`…), so the only way to get
 * an identical project name in every session is an identical input. On Linux
 * the basename needs no other sanitization (`/` cannot occur in it); a missing
 * basename falls back to `workspace`.
 */
export function projectLeafName(root: string): string {
	return path.basename(root) || 'workspace';
}

/**
 * Root-level compose glue files that are conventionally gitignored. A fresh
 * worktree lacks them, so `docker compose` there would lose env/ports config
 * (or derive a different project identity). We symlink them from the root
 * rather than copy: one source, secrets never duplicated, and the shared
 * compose stack means both checkouts describe the same services anyway.
 */
const COMPOSE_GLUE_FILES = ['.env', 'docker-compose.override.yml'];

async function linkComposeGlue(root: string, worktree: string): Promise<void> {
	for (const file of COMPOSE_GLUE_FILES) {
		const source = path.join(root, file);
		const dest = path.join(worktree, file);
		try {
			// Tracked in the worktree checkout or created by the agent — leave it.
			await fs.promises.lstat(dest);
			continue;
		} catch {
			// absent — link it below
		}
		try {
			await fs.promises.stat(source);
			await fs.promises.symlink(path.relative(path.dirname(dest), source), dest);
		} catch {
			// no such file at the root (or symlink unsupported) — nothing to glue
		}
	}
}

/**
 * The session branch (`exo-<N>`) for a worktree path. The worktree's leaf
 * folder is the project name, not `exo-<N>` (the number lives in the parent
 * dir), so callers that need the branch must extract it from the path rather
 * than use `path.basename`. Returns null when the path has no `exo-<N>` segment.
 */
export function worktreeBranchFromPath(p: string): string | null {
	const m = /(?:^|[\\/])exo-(\d+)(?:[\\/]|$)/.exec(p);
	return m ? `exo-${m[1]}` : null;
}

/**
 * Create a worktree for a new session. Worktrees live inside the repo under
 * `.exo/worktrees/exo-<N>/<project>` — the git worktree root is the project
 * leaf folder named after the main project VERBATIM (so `docker compose`
 * derives the exact same project name from either checkout, and `up` from a
 * session targets the same stack), while the session's ordinal number `N` lives
 * in the parent dir (so the folder stays unique per session and the branch
 * `exo-<N>` is local-only, never pushed). `N` is the first free number on disk
 * — so the parent dir/branch name always matches the session's ordinal number
 * (`exo-<N>` terminal, header badge). "Free" means no `exo-<N>` worktree dir
 * AND no lingering `exo-<N>` branch (a deleted session's unmerged branch may
 * outlive its folder). Being a child of the trusted repo root keeps them
 * workspace-trusted when the Explorer follows the active session. Returns null
 * when not a git repository (shared root).
 */
export async function createWorktree(root: string): Promise<WorktreeInfo | null> {
	if (!(await isGitRepository(root))) {
		return null;
	}
	const used = await usedWorktreeNumbers(root);
	let number = 1;
	while (used.has(number) || (await worktreeBranchExists(root, number))) {
		number++;
	}
	const name = `exo-${number}`;
	const target = path.join(root, '.exo', 'worktrees', name, projectLeafName(root));
	try {
		await ensureGitExclude(root);
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await runGit(['worktree', 'add', '-b', name, target], root);
		await linkComposeGlue(root, target);
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
export async function resolveMainBranch(worktreePath: string): Promise<string | null> {
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

/**
 * True when a path is inside the repo under `.exo/worktrees/` (a session
 * worktree created by Exo). Used to refuse removing anything outside our own
 * layout — a corrupted state must never be able to delete an arbitrary
 * directory.
 */
export function isExoWorktreePath(p: string): boolean {
	return p.includes(path.sep + '.exo' + path.sep + 'worktrees' + path.sep);
}

/**
 * Delete a worktree. Prefers git's own protection: `git worktree remove`
 * refuses a dirty worktree, so the folder survives unless the caller has
 * explicit user confirmation (`opts.confirmed`) to force past it. This closes
 * the race where a live agent writes a file after our dirty check ran, and
 * the case where the check itself failed silently. Only ever removes
 * Exo-owned worktrees (under `<root>/.exo/worktrees/`).
 */
export async function removeWorktree(worktreePath: string, opts?: { confirmed?: boolean }): Promise<boolean> {
	try {
		if (!isExoWorktreePath(worktreePath)) {
			console.error('[Exo worktree] refusing to remove non-Exo path:', worktreePath);
			return false;
		}
		try {
			await runGit(['worktree', 'remove', worktreePath], worktreePath);
		} catch (err) {
			if (opts?.confirmed !== true) {
				console.error('[Exo worktree] remove refused (worktree may be dirty), keeping it:', err);
				return false;
			}
			await runGit(['worktree', 'remove', '--force', worktreePath], worktreePath);
		}
		// Drop the now-unlinked branch too. Safe: `-d` only deletes when the
		// branch is fully merged (or via its upstream) — otherwise it fails and
		// the branch stays. The branch is `exo-<N>` (from the parent dir), not
		// the worktree's leaf folder (which is the project name).
		const branch = worktreeBranchFromPath(worktreePath);
		if (branch) {
			try {
				await runGit(['branch', '-d', branch], path.dirname(worktreePath));
			} catch {
				// branch unmerged or already gone — keep it.
			}
		}
		// Best-effort: remove the now-empty `exo-<N>` parent dir.
		try {
			await fs.promises.rmdir(path.dirname(worktreePath));
		} catch {
			// not empty or already gone — fine.
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
	| { status: 'not-merged'; detail: string };

/**
 * Fast-forward the repository's main branch to the worktree branch. The agent
 * has already integrated main into its own branch (see the merge prompt), so
 * this is a plain `--ff-only` merge in the root worktree where main is checked
 * out — no conflict can ever be left behind. Returns `not-merged` when the
 * branch isn't a strict descendant of main (the agent didn't integrate main,
 * or the root worktree had local changes). Idempotent — returns
 * `clean-merged` when the branch is already fully in main.
 */
export async function mergeWorktreeToMain(worktreePath: string, root: string): Promise<MergeWorktreeStatus> {
	try {
		const main = await resolveMainBranch(worktreePath);
		if (!main) {
			return { status: 'not-merged', detail: 'main branch is not resolvable' };
		}
		const ahead = parseInt((await runGit(['rev-list', '--count', `${main}..HEAD`], worktreePath)).trim(), 10);
		if (ahead === 0) {
			return (await hasUncommittedChanges(worktreePath)) ? { status: 'uncommitted' } : { status: 'clean-merged' };
		}
		const branch = worktreeBranchFromPath(worktreePath);
		if (!branch) {
			return { status: 'not-merged', detail: 'worktree branch is not resolvable' };
		}
		try {
			await runGit(['merge', '--ff-only', branch], root);
		} catch (err) {
			return { status: 'not-merged', detail: err instanceof Error ? err.message : String(err) };
		}
		return (await hasUncommittedChanges(worktreePath)) ? { status: 'merged-dirty' } : { status: 'clean-merged' };
	} catch (err) {
		return { status: 'not-merged', detail: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Register a worktree in VS Code's Source Control view via the built-in git
 * extension API (`api.openRepository`). This makes the worktree appear in the
 * Source Control repositories list regardless of `git.detectWorktrees` timing
 * and even though its folder lives outside the workspace.
 *
 * IMPORTANT: `API.getRepository(uri)` resolves to the MOST SPECIFIC open repo
 * that CONTAINS the path. Our worktrees live INSIDE the root repo (always open),
 * so a plain `getRepository(worktreePath)` returns the ROOT repo and the worktree
 * would never be opened as its own repository. We must compare the resolved
 * repo ROOT against the worktree path itself.
 */
export async function registerWorktreeInScm(worktreePath: string): Promise<void> {
	try {
		const gitExt = vscode.extensions.getExtension('vscode.git');
		if (!gitExt) {
			return;
		}
		const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
		const api = (exports as { getAPI?: (version: 1) => GitApiV1 } | undefined);
		if (!api?.getAPI) {
			return;
		}
		const gitApi = api.getAPI(1);
		const uri = vscode.Uri.file(worktreePath);
		const existing = gitApi.getRepository(uri);
		if (existing && existing.rootUri.fsPath === worktreePath) {
			return; // already registered as its own repository
		}
		// The worktree folder may not exist yet (we race `git worktree add`);
		// openRepository on a non-existent root fails. Wait for the `.git`
		// marker to appear (bounded — registration is best-effort anyway).
		await waitForFile(path.join(worktreePath, '.git'), 5000);
		await gitApi.openRepository(uri);
		const repo = gitApi.getRepository(uri);
		if (repo && repo.rootUri.fsPath === worktreePath) {
			// Force an immediate status so the SCM view isn't empty until the
			// extension's debounced file watcher fires.
			await repo.status();
		}
	} catch (err) {
		console.error('[Exo worktree] SCM registration failed:', err);
	}
}

/** Minimal git extension API v1 surface we rely on. */
interface GitApiV1 {
	getRepository(uri: vscode.Uri): { rootUri: vscode.Uri; status: () => Promise<void> } | null;
	openRepository(root: vscode.Uri): Promise<unknown>;
}

/**
 * Force the git extension to refresh a repository's status in the SCM view.
 * The built-in extension debounces its file watcher (~1s), so after a session
 * becomes active we nudge the worktree repo so its changes appear immediately.
 * Coalesces bursts of writes (agents write many files in a row) onto a single
 * trailing refresh.
 */
const scmRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function refreshScmStatus(worktreePath: string): Promise<void> {
	const existing = scmRefreshTimers.get(worktreePath);
	if (existing) {
		clearTimeout(existing);
	}
	scmRefreshTimers.set(
		worktreePath,
		setTimeout(() => {
			scmRefreshTimers.delete(worktreePath);
			void refreshScmStatusNow(worktreePath);
		}, 300),
	);
}

async function refreshScmStatusNow(worktreePath: string): Promise<void> {
	try {
		const gitExt = vscode.extensions.getExtension('vscode.git');
		if (!gitExt) {
			return;
		}
		const exports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
		const api = (exports as { getAPI?: (version: 1) => GitApiV1 } | undefined);
		if (!api?.getAPI) {
			return;
		}
		const repo = api.getAPI(1).getRepository(vscode.Uri.file(worktreePath));
		if (repo && repo.rootUri.fsPath === worktreePath) {
			await repo.status();
		}
	} catch (err) {
		console.error('[Exo worktree] SCM refresh failed:', err);
	}
}

/** Poll until `p` exists (or timeout). Best-effort for racing async git ops. */
async function waitForFile(p: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			if ((await fs.promises.stat(p)).isFile()) {
				return;
			}
		} catch {
			// not there yet — keep polling
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}