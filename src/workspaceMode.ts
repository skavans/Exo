/**
 * workspaceMode.ts — managed `.code-workspace` for Explorer-follow.
 *
 * VS Code can change the current workspace folder set WITHOUT a window reload
 * only while the window is already a multi-root workspace (a `.code-workspace`
 * file is open). From a single-folder window, any root change forces a reload
 * (the workbench re-enters workspace mode via `openWindow(forceReuseWindow)`).
 *
 * Exo therefore manages its own workspace file inside the repo —
 * `<root>/.exo/exo.code-workspace` — and live-switches its only folder to the
 * active session's worktree via `workspace.updateWorkspaceFolders` (no reload).
 * Worktrees live under `<root>/.exo/worktrees/`, children of the trusted repo
 * root, so workspace trust never drops the window into Restricted Mode when the
 * folder is swapped.
 *
 * User-owned multi-root workspaces are never touched: every operation is
 * guarded on "is this OUR managed workspace file". The original repo root is
 * pinned in `globalState` (survives the one-time migration reload) and drives
 * `getWorkspaceRoot()` — it must NOT follow the Explorer folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureGitExclude } from './worktree';

export const EXO_DIR_NAME = '.exo';
const WORKSPACE_FILE_NAME = 'exo.code-workspace';
/** globalState key for the pinned repo root. */
const WORKSPACE_ROOT_KEY = 'exo.workspaceRoot';
/** globalState key for "don't ask about reopening as a workspace again". */
const WORKSPACE_MODE_PROMPT_DISMISSED_KEY = 'exo.workspaceModePromptDismissed';

/** Absolute path of our managed workspace file for `root`. */
export function managedWorkspacePath(root: string): string {
	return path.join(root, EXO_DIR_NAME, WORKSPACE_FILE_NAME);
}

/** True when a path is inside the repo under `.exo/worktrees/` (a session worktree). */
export function isExoWorktreePath(p: string): boolean {
	return p.includes(path.sep + EXO_DIR_NAME + path.sep + 'worktrees' + path.sep);
}

/** True when the window is open on OUR managed workspace file for `root`. */
export function isManagedWorkspace(root: string): boolean {
	const wsFile = vscode.workspace.workspaceFile;
	return !!wsFile && wsFile.scheme === 'file' && wsFile.fsPath === managedWorkspacePath(root);
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

export function isWorkspaceModePromptDismissed(globalState: vscode.Memento): boolean {
	return globalState.get<boolean>(WORKSPACE_MODE_PROMPT_DISMISSED_KEY) ?? false;
}

export function dismissWorkspaceModePrompt(globalState: vscode.Memento): void {
	void globalState.update(WORKSPACE_MODE_PROMPT_DISMISSED_KEY, true);
}

/**
 * Write the managed `.code-workspace` file (single folder = the repo root) and
 * reopen the SAME window on it. This is the one-time reload that unlocks
 * reload-free folder switching afterwards. Caller must `pinRoot` first.
 */
export async function enterManagedWorkspace(root: string): Promise<void> {
	const wsPath = managedWorkspacePath(root);
	await fs.promises.mkdir(path.dirname(wsPath), { recursive: true });
	const content = JSON.stringify(
		{
			folders: [{ path: root }],
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

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Serialized, coalescing driver for `updateWorkspaceFolders`. The API forbids
 * calling it again before `onDidChangeWorkspaceFolders` fires, so switches are
 * queued; rapid session clicks collapse onto the latest target.
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
		if (!vscode.workspace.getConfiguration('exo').get<boolean>('followSessionFolder', true)) {
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

	private isCurrent(fsPath: string): boolean {
		const folders = vscode.workspace.workspaceFolders;
		return !!folders && folders.length === 1 && folders[0].uri.fsPath === fsPath;
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
		this._inFlight = true;
		try {
			const ok = vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, {
				uri: vscode.Uri.file(target),
			});
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
