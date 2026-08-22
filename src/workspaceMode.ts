/**
 * workspaceMode.ts — managed `.code-workspace` for Explorer-follow.
 *
 * VS Code can change workspace folders WITHOUT a window reload only while the
 * window is already a multi-root workspace (a `.code-workspace` is open). The
 * catch: the extension host may be restarted when the FIRST workspace folder
 * (`workspace.rootPath`) is added/removed/changed. So Exo keeps `folders[0]`
 * the repo ROOT — the main worktree — and never changes it; the active
 * session's worktree is the only folder ever swapped:
 *
 *     [ <root> ]                     — idle (Explorer shows only the root)
 *     [ <root> , <root>/.exo/worktrees/exo-N ]   — active session
 *                 index 0                          index 1
 *
 * `folders[0]` therefore never moves, and session switches stay reload-free.
 * When nothing is open the second folder is dropped, leaving just `[root]`.
 *
 * The root is the repo the user opened, so it is already workspace-trusted;
 * worktrees live under `<root>/.exo/worktrees/` (children of the trusted root,
 * so they stay trusted) and `.exo/` is hidden from git via `info/exclude`.
 *
 * User-owned multi-root workspaces are never touched: every operation is
 * guarded on "is this OUR managed workspace file AND our folder shape". The
 * original repo root is pinned in `globalState` (survives the one-time
 * migration reload) and drives `getWorkspaceRoot()` — it must NOT follow the
 * Explorer folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureGitExclude, isExoWorktreePath } from './worktree';

export { isExoWorktreePath };

export const EXO_DIR_NAME = '.exo';
/** globalState key for the pinned repo root. */
const WORKSPACE_ROOT_KEY = 'exo.workspaceRoot';

/**
 * The workspace file is named after the project folder: VS Code titles a
 * `.code-workspace` window from the FILE's basename (`<name> (Workspace)`) and
 * ignores the `name` field, so the window shows the project name, not "exo".
 */
function workspaceFileName(root: string): string {
	const base = path.basename(root) || 'workspace';
	return `${base}.code-workspace`;
}

/** Absolute path of our managed workspace file for `root`. */
export function managedWorkspacePath(root: string): string {
	return path.join(root, EXO_DIR_NAME, workspaceFileName(root));
}

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when the window is open on OUR managed workspace file AND has our
 * folder shape: `[root]` (idle) or `[root, root | worktree]` (active session).
 * User-owned multi-root workspaces never match.
 */
export function isManagedWorkspace(root: string): boolean {
	const wsFile = vscode.workspace.workspaceFile;
	if (!wsFile || wsFile.scheme !== 'file' || wsFile.fsPath !== managedWorkspacePath(root)) {
		return false;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0 || folders.length > 2 || folders[0].uri.fsPath !== root) {
		return false;
	}
	if (folders.length === 2) {
		const second = folders[1].uri.fsPath;
		return second === root || isPathInside(second, root);
	}
	return true;
}

/** Persisted pinned repo root (survives the migration reload; machine-scoped). */
export function getPinnedRoot(globalState: vscode.Memento): string | undefined {
	return globalState.get<string>(WORKSPACE_ROOT_KEY);
}

export function pinRoot(globalState: vscode.Memento, root: string): void {
	if (globalState.get<string>(WORKSPACE_ROOT_KEY) !== root) {
		void globalState.update(WORKSPACE_ROOT_KEY, root);
	}
}

/**
 * Write the managed `.code-workspace` file (`[root]` only — the worktree is
 * added/removed live) and reopen the SAME window on it. This is the one-time
 * reload that unlocks reload-free folder switching afterwards. Caller must
 * `pinRoot` first.
 */
export async function enterManagedWorkspace(root: string): Promise<void> {
	const wsPath = managedWorkspacePath(root);
	await fs.promises.mkdir(path.dirname(wsPath), { recursive: true });
	const content = JSON.stringify(
		{
			folders: [{ path: root }],
		},
		null,
		'\t',
	);
	await fs.promises.writeFile(wsPath, content, 'utf8');
	// Hide `.exo/` from git before the reload (not just at first worktree).
	await ensureGitExclude(root);
	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), { forceReuseWindow: true });
}

/**
 * Serialized, coalescing driver for `updateWorkspaceFolders`. The API forbids
 * calling it again before `onDidChangeWorkspaceFolders` fires, so switches are
 * queued; rapid session clicks collapse onto the latest target. Only index 1
 * (the active session's worktree) is ever added/removed/swapped — `folders[0]`
 * stays the root, so `workspace.rootPath` never changes and the extension host
 * is not restarted.
 */
export class WorkspaceFolderSwitcher {
	private _inFlight = false;
	private _pending: { root: string; target: string } | null = null;
	private _timer: ReturnType<typeof setTimeout> | null = null;

	/** Feed from `vscode.workspace.onDidChangeWorkspaceFolders`. */
	public onWorkspaceFoldersChanged(): void {
		this._clearTimer();
		this._inFlight = false;
		this._drain();
	}

	/**
	 * Request the Explorer to show exactly `cwd`. No-ops unless the window is
	 * our managed workspace, the target is the root or inside it (legacy
	 * sibling worktrees are excluded) and the folder isn't already shown.
	 */
	public follow(root: string, cwd: string): void {
		if (!isManagedWorkspace(root)) {
			return;
		}
		if (cwd !== root && !isPathInside(cwd, root)) {
			return;
		}
		if (this.isCurrent(root, cwd)) {
			return;
		}
		this._pending = { root, target: cwd };
		this._drain();
	}

	/** The Explorer should show only the pinned root (no active session). */
	public showRoot(root: string): void {
		this.follow(root, root);
	}

	/** True when the workspace already shows `target`: root-only shape for the root, `folders[1]` for a worktree. */
	private isCurrent(root: string, target: string): boolean {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0 || folders.length > 2 || folders[0].uri.fsPath !== root) {
			return false;
		}
		if (target === root) {
			return folders.length === 1;
		}
		return folders.length === 2 && folders[1].uri.fsPath === target;
	}

	private _drain(): void {
		if (this._inFlight) {
			return;
		}
		const pending = this._pending;
		if (!pending) {
			return;
		}
		this._pending = null;
		if (this.isCurrent(pending.root, pending.target)) {
			return;
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0 || folders.length > 2 || folders[0].uri.fsPath !== pending.root) {
			// Shape broken (user changed the workspace) — don't touch it.
			return;
		}
		this._inFlight = true;
		try {
			let ok: boolean;
			if (pending.target === pending.root && folders.length === 1) {
				// Nothing to change (isCurrent should have caught this).
				this._inFlight = false;
				this._drain();
				return;
			} else if (pending.target === pending.root) {
				// Show root: drop the second folder.
				ok = vscode.workspace.updateWorkspaceFolders(1, 1);
			} else if (folders.length === 1) {
				// Insert the worktree as the second folder.
				ok = vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(pending.target) });
			} else {
				// Replace folders[1] with the newly active worktree.
				ok = vscode.workspace.updateWorkspaceFolders(1, 1, { uri: vscode.Uri.file(pending.target) });
			}
			if (!ok) {
				this._inFlight = false;
				this._drain();
				return;
			}
			// Safety net: if no folder-change event lands (target dropped by the
			// workbench), don't leave the switch stuck.
			this._timer = setTimeout(() => {
				this._clearTimer();
				this._inFlight = false;
				this._drain();
			}, 1000);
		} catch (err) {
			console.error('[Exo] workspace folder switch failed:', err);
			this._inFlight = false;
			this._drain();
		}
	}

	private _clearTimer(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}
}
