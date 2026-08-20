import type { ChatViewProvider } from '../ChatViewProvider';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ChatMessage } from '../types';
import { StreamThrottle } from '../StreamThrottle';

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
	 * `opts.preQueued` — the message is already rendered as `isQueued` (reject follow-up):
	 * don't push a new user message, just flip the flag on the existing one.
	 */
	public async handleUserMessage(
		text: string,
		attachedFiles?: string[],
		images?: Array<{ mimeType: string; data: string; name?: string }>,
		opts?: { preQueued?: boolean },
	): Promise<void> {
		// Guarantee an active session runtime.
		if (!this.provider.session) {
			await this.provider.newSession();
		}
		const runtime = this.provider.session;
		if (!runtime || !runtime.acpClient.sessionId) {
			this.pushAssistantError('No active session');
			return;
		}
		const cwd = runtime.cwd;

		// User message
		if (opts?.preQueued) {
			for (let i = runtime.messages.length - 1; i >= 0; i--) {
				const m = runtime.messages[i];
				if (m.role === 'user' && m.isQueued) {
					m.isQueued = false;
					break;
				}
			}
		} else {
			runtime.messages.push({
				role: 'user',
				blocks: [{ type: 'text', content: text }],
				attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
				images: images && images.length > 0 ? images.map((i) => ({ mimeType: i.mimeType, data: i.data, name: i.name })) : undefined,
			});
			this.provider.ensureSessionTitle(runtime, text);
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
		this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: true });

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

			const followUp = !wasStopped ? runtime.consumePendingFollowUp() : null;
			if (!followUp) {
				runtime.agentRunning = false;
				runtime.stopped = false;
				this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
			}
			this.provider.sendTabs();
			this.provider.updateMessages();

			if (followUp) {
				await this.handleUserMessage(followUp, undefined, undefined, { preQueued: true });
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
			if (rel.startsWith('.git/') || rel.includes('/node_modules/') || rel.startsWith('.exo-worktrees/')) {
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
			if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.exo-worktrees') {
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