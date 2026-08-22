import type { ChatViewProvider } from '../ChatViewProvider';
import type { SessionRuntime } from '../SessionRuntime';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ChatMessage } from '../types';
import { StreamThrottle } from '../StreamThrottle';
import { mergeWorktreeToMain } from '../../worktree';

/**
 * WebviewMessageHandler — thin handlers for the ACP client.
 * All actions target the ACTIVE session runtime (see ChatViewProvider.session).
 */
export class WebviewMessageHandler {
	constructor(private provider: ChatViewProvider) {}

	public handleMessage(message: any): void {
		switch (message.type) {
			case 'ready': {
				void this.provider.handleReady();
				break;
			}
			case 'sendMessage': {
				const text = (message.text ?? '').trim();
				const attachedFiles = message.attachedFiles as string[] | undefined;
				const images = message.images as Array<{ mimeType: string; data: string; name?: string }> | undefined;
				if (!text && (!attachedFiles || attachedFiles.length === 0) && (!images || images.length === 0)) {
					return;
				}
				void this.handleUserMessage(text, attachedFiles, images);
				break;
			}
			case 'selectConfigOption': {
				const configId = message.configId as string;
				const value = message.value as string;
				if (configId && value) {
					void this.provider.selectConfigOption(configId, value);
				}
				break;
			}
			case 'toggleAutoAllowPermissions': {
				this.provider.setAutoAllowPermissions(!this.provider.autoAllowPermissions);
				break;
			}
			case 'permissionDecision': {
				const requestId = message.requestId as string;
				if (!requestId) break;
				if (message.cancelled) {
					this.provider.resolvePermission(requestId, { outcome: 'cancelled' });
				} else {
					const optionId = message.optionId as string;
					const followUpText = typeof message.followUpText === 'string' ? message.followUpText : undefined;
					this.provider.resolvePermission(requestId, { outcome: 'selected', optionId }, followUpText);
				}
				break;
			}
			case 'newSession': {
				void this.provider.newSession();
				break;
			}
			case 'switchSession': {
				const sessionId = message.sessionId as string;
				if (sessionId) {
					void this.provider.switchSession(sessionId);
				}
				break;
			}
			case 'closeTab': {
				const sessionId = message.sessionId as string;
				if (sessionId) {
					void this.provider.closeTab(sessionId);
				}
				break;
			}
			case 'deleteSession': {
				const sessionId = message.sessionId as string;
				if (sessionId) {
					void this.provider.deleteSession(sessionId);
				}
				break;
			}
			case 'openConfig': {
				void vscode.commands.executeCommand('exo.openConfig');
				break;
			}
			case 'enterWorkspaceMode': {
				void this.provider.enterWorkspaceMode();
				break;
			}
			case 'updateDraftState': {
				const text = typeof message.text === 'string' ? message.text : '';
				const attachedFiles = Array.isArray(message.attachedFiles)
					? message.attachedFiles.filter((item: unknown): item is string => typeof item === 'string')
					: [];
				this.provider.updateDraftState(text, attachedFiles);
				break;
			}
			case 'searchFiles': {
				const searchQuery = ((message.query as string) || '').trim();
				this.handleSearchFiles(searchQuery);
				break;
			}
			case 'stopGeneration': {
				if (this.provider.agentRunning) {
					this.provider.cancelPendingOperations();
				}
				break;
			}
			case 'mergeToMain': {
				this.provider.mergeToMain();
				break;
			}
			case 'openFile': {
				const { path: filePath, line, endLine } = message;
				if (filePath) {
					(async () => {
						try {
							const absolutePath = path.isAbsolute(filePath)
								? filePath
								: path.resolve(this.provider.cwd, filePath);
							const doc = await vscode.workspace.openTextDocument(absolutePath);
							await vscode.window.showTextDocument(doc, {
								selection: line
									? new vscode.Range(line - 1, 0, (endLine ?? line) - 1, 0)
									: undefined,
							});
						} catch (err) {
							console.error(`[Exo] Failed to open file ${filePath}:`, err);
						}
					})();
				}
				break;
			}
			case 'resolveFileLinks': {
				const requestId = message.requestId as string | undefined;
				const rawPaths = Array.isArray(message.paths) ? message.paths : [];
				if (!requestId || rawPaths.length === 0) {
					break;
				}
				void this.handleResolveFileLinks(requestId, rawPaths);
				break;
			}
			case 'addDroppedFiles': {
				const rawPaths = Array.isArray(message.paths)
					? message.paths.filter((item: unknown): item is string => typeof item === 'string')
					: [];
				if (rawPaths.length === 0) {
					break;
				}
				void this.handleAddDroppedFiles(rawPaths);
				break;
			}
		}
	}

	/**
	 * Main flow: text → ACP prompt → streamed response via callbacks.
	 * Runs against the active session runtime; if none — creates one first.
	 *
	 * `opts.preQueued` — the message is already rendered as `isQueued` (reject
	 * follow-up, or an optimistic message typed while the new session spawned):
	 * don't push a new user message, just flip the flag on the existing one.
	 * `opts.queuedMessage` — which queued message to flip (default: first
	 * `isQueued` in history). `opts.runtime` — dispatch to a specific runtime
	 * even if the user navigated away while it was still spawning.
	 * `opts.mergeIntent` — this turn was triggered by the "commit & merge to
	 * main" button; the agent commits and integrates main into its branch, and
	 * after the turn the host fast-forwards main to the branch and reports the
	 * outcome.
	 */
	public async handleUserMessage(
		text: string,
		attachedFiles?: string[],
		images?: Array<{ mimeType: string; data: string; name?: string }>,
		opts?: { preQueued?: boolean; runtime?: SessionRuntime; queuedMessage?: ChatMessage; mergeIntent?: boolean },
	): Promise<void> {
		// Guarantee an active session runtime (capture it — the user may
		// navigate away while the new session is still spawning).
		let runtime = opts?.runtime ?? this.provider.session;
		if (!runtime) {
			// No active session yet: kick off an optimistic new one and queue
			// this message as `isQueued` — rendered immediately, dispatched by
			// resolvePendingSession once the agent is up. Covers both a
			// first-ever message on an empty chat and typing while a session is
			// already spawning (beginNewSession returns the in-flight pending).
			const begun = this.provider.beginNewSession();
			if (begun) {
				begun.pending.queuedMessages.push({
					role: 'user',
					blocks: [{ type: 'text', content: text }],
					attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
					images: images && images.length > 0 ? images.map((i) => ({ mimeType: i.mimeType, data: i.data, name: i.name })) : undefined,
					isQueued: true,
				});
				this.provider.updateMessages();
				return;
			}
			this.pushAssistantError('No active session');
			return;
		}
		if (!runtime || !runtime.acpClient.sessionId) {
			this.pushAssistantError('No active session');
			return;
		}
		const cwd = runtime.cwd;

		// User message
		if (opts?.preQueued) {
			const queued = opts.queuedMessage ?? runtime.messages.find((m) => m.isQueued);
			if (queued) {
				queued.isQueued = false;
			}
		} else {
			runtime.messages.push({
				role: 'user',
				blocks: [{ type: 'text', content: text }],
				attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
				images: images && images.length > 0 ? images.map((i) => ({ mimeType: i.mimeType, data: i.data, name: i.name })) : undefined,
			});
			// Title bookkeeping must never swallow the message: the push above
			// already happened, so any failure here is logged and the message
			// still gets displayed + sent below.
			try {
				this.provider.ensureSessionTitle(runtime, text);
			} catch (err) {
				console.error('[Exo] ensureSessionTitle failed (message sent anyway):', err);
			}
		}
		this.provider.updateMessages();

		const blocks: ContentBlock[] = [];
		if (text) {
			blocks.push({ type: 'text', text });
		}
		for (const relPath of attachedFiles ?? []) {
			const abs = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
			blocks.push({
				type: 'resource_link',
				uri: vscode.Uri.file(abs).toString(),
				name: vscode.workspace.asRelativePath(abs, false),
			});
		}
		for (const img of images ?? []) {
			blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
		}

		// Empty streaming assistant message
		const assistantMsg: ChatMessage = { role: 'assistant', blocks: [], isStreaming: true };
		runtime.messages.push(assistantMsg);
		this.provider.updateMessages();

		const idx = runtime.messages.length - 1;
		runtime.streamingIndex = idx;
		runtime.streamThrottle = new StreamThrottle(
			idx,
			() => runtime.messages[idx],
			(index, blocks) => runtime.callbacks.sendStreamChunk(index, blocks),
			() => this.provider.updateMessages(),
			() => runtime.callbacks.isActive(),
		);
		runtime.toolCallInfos.clear();
		runtime.isStreaming = true;
		runtime.agentRunning = true;
		runtime.stopped = false;
		this.provider.sendTabs();
		if (this.provider.activeSessionId === runtime.id) {
			this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: true });
		}

		try {
			const stopReason = await runtime.acpClient.prompt(blocks);
			// ACP stopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled.
			if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
				const label = stopReason === 'refusal' ? 'Agent refused to continue'
					: stopReason === 'max_tokens' ? 'Stopped: max tokens reached'
					: 'Stopped: max turn requests reached';
				vscode.window.showWarningMessage(`Exo: ${label}`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			assistantMsg.isError = true;
			const errText = `ACP error: ${msg}`;
			const lastBlock = assistantMsg.blocks[assistantMsg.blocks.length - 1];
			if (lastBlock && lastBlock.type === 'text') {
				lastBlock.content += (lastBlock.content ? '\n\n' : '') + errText;
			} else {
				assistantMsg.blocks.push({ type: 'text', content: errText });
			}
		} finally {
			const wasStopped = runtime.stopped;
			runtime.endStreaming();
			assistantMsg.isStreaming = false;

			// Dispatch the next queued message (reject follow-up, or an
			// optimistic message queued during the spawn) as a new turn —
			// BEFORE `agentRunning=false` is posted, so there's no
			// lock/unlock flicker. Multiple queued messages drain one per turn.
			let nextQueued: ChatMessage | null = null;
			if (!wasStopped) {
				nextQueued = runtime.consumePendingFollowUp() ?? runtime.messages.find((m) => m.isQueued) ?? null;
			}
			if (!nextQueued) {
				runtime.agentRunning = false;
				runtime.stopped = false;
				if (this.provider.activeSessionId === runtime.id) {
					this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
				}
				// Turn ended — refresh the "commit & merge" button state.
				this.provider.refreshMergeState();
				// Merge-triggered turn: the agent committed and integrated main
				// into its branch; fast-forward main to the branch host-side
				// (main is checked out in the root worktree, so the agent
				// cannot do this from a linked worktree) and report the outcome.
				if (opts?.mergeIntent && runtime.cwd !== this.provider.getWorkspaceRoot()) {
					void mergeWorktreeToMain(runtime.cwd, this.provider.getWorkspaceRoot()).then(
						(res) => {
							// Button state above was computed before the merge.
							this.provider.refreshMergeState();
							switch (res.status) {
								case 'clean-merged':
									void vscode.window
										.showInformationMessage(
											'Exo: changes merged into main. Delete the session branch and worktree?',
											'Delete',
										)
										.then((choice) => {
											if (choice === 'Delete') {
												void this.provider.deleteSession(runtime.id);
											}
										});
									break;
								case 'merged-dirty':
									vscode.window.showInformationMessage(
										'Exo: changes merged into main, but the session still has uncommitted files.',
									);
									break;
								case 'uncommitted':
									vscode.window.showWarningMessage(
										'Exo: changes were not merged into main — the session still has uncommitted work.',
									);
									break;
							case 'not-merged':
								vscode.window.showWarningMessage(
									`Exo: changes were not merged into main — ${res.detail}`,
								);
								break;
							}
						},
						() => { /* best-effort check */ },
					);
				}
			}
			this.provider.sendTabs();
			this.provider.updateMessages();

			if (nextQueued) {
				const nextText = nextQueued.blocks.find((b) => b.type === 'text')?.content ?? '';
				await this.handleUserMessage(nextText, nextQueued.attachedFiles, nextQueued.images, {
					preQueued: true,
					runtime,
					queuedMessage: nextQueued,
				});
			}
		}
	}

	private pushAssistantError(text: string): void {
		const runtime = this.provider.session;
		if (!runtime) {
			return;
		}
		runtime.messages.push({
			role: 'assistant',
			blocks: [{ type: 'text', content: text }],
			isError: true,
		});
		this.provider.updateMessages();
	}

	/** Fzf-style server-side file search relative to the active session cwd. */
	private async handleSearchFiles(query: string): Promise<void> {
		const cwd = this.provider.cwd;
		const queryLower = query.toLowerCase();
		const matches: Array<{ path: string; score: number }> = [];

		await this.walkFiles(cwd, cwd, (relPath, absPath) => {
			const rel = relPath.replace(/\\/g, '/');
			if (rel.startsWith('.git/') || rel.includes('/node_modules/') || rel.startsWith('.exo/') || rel.startsWith('.exo-worktrees/')) {
				return;
			}
			const pathLower = rel.toLowerCase();
			let score = 0;
			let lastMatchIdx = -1;
			let allCharsMatch = true;
			for (let ci = 0; ci < queryLower.length; ci++) {
				const idx = pathLower.indexOf(queryLower[ci], lastMatchIdx + 1);
				if (idx === -1) {
					allCharsMatch = false;
					break;
				}
				score += idx === lastMatchIdx + 1 ? 3 : 1;
				if (idx > 0 && (pathLower[idx - 1] === '/' || pathLower[idx - 1] === '.' || pathLower[idx - 1] === '_')) {
					score += 2;
				}
				lastMatchIdx = idx;
			}
			if (!allCharsMatch) return;
			const fileName = rel.split('/').pop()!;
			if (fileName.toLowerCase().includes(queryLower)) score += 10;
			score -= rel.length * 0.01;
			matches.push({ path: rel, score });
			void absPath;
		});

		matches.sort((a, b) => b.score - a.score);
		const results = matches.slice(0, 20).map((m) => m.path);
		this.provider.view?.webview.postMessage({ type: 'searchFilesResult', results });
	}

	/** Iterate files under `root`, calling cb(relativePath, absolutePath). Non-recursive-implementation, guarded. */
	private async walkFiles(
		root: string,
		current: string,
		cb: (rel: string, abs: string) => void,
		depth = 0,
		count = { n: 0 },
	): Promise<void> {
		if (depth > 8 || count.n >= 2000) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.exo' || entry.name === '.exo-worktrees') {
				continue;
			}
			const abs = path.join(current, entry.name);
			const rel = path.relative(root, abs);
			if (entry.isDirectory()) {
				await this.walkFiles(root, abs, cb, depth + 1, count);
			} else if (entry.isFile()) {
				cb(rel, abs);
				count.n++;
			}
		}
	}

	private async handleResolveFileLinks(requestId: string, rawPaths: unknown[]): Promise<void> {
		const uniquePaths = Array.from(new Set(rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));
		const resolved: Array<{ source: string; path: string }> = [];
		for (const rawPath of uniquePaths) {
			const match = await this.resolveFileLink(rawPath);
			if (match) {
				resolved.push({ source: rawPath, path: match });
			}
		}
		this.provider.view?.webview.postMessage({ type: 'resolveFileLinksResult', requestId, resolved });
	}

	private async handleAddDroppedFiles(paths: string[]): Promise<void> {
		const { files, rejected } = await this.provider.validateDroppedFiles(paths);
		this.provider.view?.webview.postMessage({ type: 'addDroppedFilesResult', files, rejected });
	}

	private async resolveFileLink(rawPath: string): Promise<string | null> {
		const trimmed = rawPath.trim().replace(/^file:/, '');
		if (!trimmed) return null;

		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const candidates = new Set<string>();

		if (path.isAbsolute(trimmed)) {
			candidates.add(path.normalize(trimmed));
		} else {
			for (const folder of workspaceFolders) {
				candidates.add(path.resolve(folder.uri.fsPath, trimmed));
			}
			candidates.add(path.resolve(this.provider.cwd, trimmed));
		}

		for (const candidate of candidates) {
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
				if ((stat.type & vscode.FileType.File) !== 0) {
					return vscode.workspace.asRelativePath(candidate, false);
				}
			} catch {
				// Ignore missing candidates.
			}
		}

		if (!trimmed.includes('/') && !trimmed.includes('\\')) {
			const matches = await vscode.workspace.findFiles(`**/${trimmed}`, undefined, 2);
			if (matches.length === 1) {
				return vscode.workspace.asRelativePath(matches[0], false);
			}
		}

		return null;
	}
}