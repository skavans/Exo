/**
 * workspaceMode.ts — managed `.code-workspace` for Explorer-follow.
 *
 * VS Code can change workspace folders WITHOUT a window reload only while the
 * window is already a multi-root workspace (a `.code-workspace` is open). The
 * catch: the extension host may be restarted when the FIRST workspace folder
 * (`workspace.rootPath`) is added/removed/changed. So Exo keeps `folders[0]`
 * a stable, empty folder that NEVER changes and swaps only `folders[1]`:
 *
 *     [ <root>/.exo/workspace-stable , <active folder> ]
 *                 index 0                      index 1
 *
 * `rootPath` therefore never moves, and session switches stay reload-free.
 *
 * The stable folder lives INSIDE the repo (child of the trusted root) — a
 * sibling/cache folder would be untrusted and drop the window into Restricted
 * Mode the moment it's added as a workspace folder. Worktrees live under
 * `<root>/.exo/worktrees/` (also trusted children); `.exo/` is hidden from git
 * via `info/exclude`.
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
import { ensureGitExclude } from './worktree';

export const EXO_DIR_NAME = '.exo';
const WORKSPACE_FILE_NAME = 'exo.code-workspace';
/** The stable, never-changing first workspace folder (empty dir inside the repo). */
const STABLE_FOLDER_DIR = 'workspace-stable';
/** Display name of the stable folder in the Explorer (dot-name reads as hidden/internal). */
const STABLE_FOLDER_NAME = '.exo';
/** globalState key for the pinned repo root. */
const WORKSPACE_ROOT_KEY = 'exo.workspaceRoot';

/** Absolute path of our managed workspace file for `root`. */
export function managedWorkspacePath(root: string): string {
	return path.join(root, EXO_DIR_NAME, WORKSPACE_FILE_NAME);
}

/** Absolute path of the stable (index 0) workspace folder for `root`. */
export function stableWorkspacePath(root: string): string {
	return path.join(root, EXO_DIR_NAME, STABLE_FOLDER_DIR);
}

/** True when a path is inside the repo under `.exo/worktrees/` (a session worktree). */
export function isExoWorktreePath(p: string): boolean {
	return p.includes(path.sep + EXO_DIR_NAME + path.sep + 'worktrees' + path.sep);
}

/** True when a path is the stable workspace folder (never adopt it as the root). */
export function isExoStablePath(p: string): boolean {
	return p.includes(path.sep + EXO_DIR_NAME + path.sep + STABLE_FOLDER_DIR);
}

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when the window is open on OUR managed workspace file AND has our
 * folder shape `[stable, root | worktree]`. User-owned multi-root workspaces
 * never match.
 */
export function isManagedWorkspace(root: string): boolean {
	const wsFile = vscode.workspace.workspaceFile;
	if (!wsFile || wsFile.scheme !== 'file' || wsFile.fsPath !== managedWorkspacePath(root)) {
		return false;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length !== 2 || folders[0].uri.fsPath !== stableWorkspacePath(root)) {
		return false;
	}
	const second = folders[1].uri.fsPath;
	return second === root || isPathInside(second, root);
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
 * Write the managed `.code-workspace` file (`[stable, root]`) and reopen the
 * SAME window on it. This is the one-time reload that unlocks reload-free
 * folder switching afterwards. Caller must `pinRoot` first.
 */
export async function enterManagedWorkspace(root: string): Promise<void> {
	const wsPath = managedWorkspacePath(root);
	await fs.promises.mkdir(path.dirname(wsPath), { recursive: true });
	await fs.promises.mkdir(stableWorkspacePath(root), { recursive: true });
	const content = JSON.stringify(
		{
			folders: [
				{ path: stableWorkspacePath(root), name: STABLE_FOLDER_NAME },
				{ path: root },
			],
			name: `Exo · ${path.basename(root)}`,
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
 * (the active folder) is ever swapped — `folders[0]` stays the stable folder,
 * so `workspace.rootPath` never changes and the extension host is not restarted.
 */
export class WorkspaceFolderSwitcher {
	private _inFlight = false;
	private _pendingTarget: string | null = null;
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
		if (this.isCurrent(cwd)) {
			return;
		}
		this._pendingTarget = cwd;
		this._drain();
	}

	/** The Explorer should show the pinned root (no active session). */
	public showRoot(root: string): void {
		this.follow(root, root);
	}

	/** True when `folders[1]` is already `fsPath` (and the shape is ours). */
	private isCurrent(fsPath: string): boolean {
		const folders = vscode.workspace.workspaceFolders;
		return !!folders && folders.length === 2 && folders[1].uri.fsPath === fsPath;
	}

	private _drain(): void {
		if (this._inFlight) {
			return;
		}
		const target = this._pendingTarget;
		if (!target) {
			return;
		}
		this._pendingTarget = null;
		if (this.isCurrent(target)) {
			return;
		}
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length !== 2) {
			// Shape broken (user changed the workspace) — don't touch it.
			return;
		}
		this._inFlight = true;
		try {
			const ok = vscode.workspace.updateWorkspaceFolders(1, 1, { uri: vscode.Uri.file(target) });
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
