import type { ChatViewProvider } from '../ChatViewProvider';
import * as vscode from 'vscode';
import * as path from 'path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ChatMessage } from '../types';
import { StreamThrottle } from '../StreamThrottle';

/**
 * WebviewMessageHandler — thin handlers for the ACP client.
 * Sessions are managed by the agent (session/new|load|resume|close|delete) through ChatViewProvider.
 * handleUserMessage: text → ContentBlock[] → acpClient.prompt() → streaming via callbacks.
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
			case 'openSession': {
				const sessionId = message.sessionId as string;
				if (sessionId) {
					void this.provider.openSession(sessionId);
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
			case 'showSessionList': {
				this.provider.showSessionList();
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
								: path.resolve(this.provider.getWorkspaceRoot(), filePath);
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
	 * The session must already be created/loaded (openSession/newSession). If not — create one.
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
		// Guarantee a connection + session
		if (!this.provider.acpClient) {
			try {
				await this.provider.connectAcp(this.provider.getWorkspaceRoot());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.pushAssistantError(`ACP connect failed: ${msg}`);
				return;
			}
		}
		if (!this.provider.acpClient!.sessionId) {
			await this.provider.newSession();
		}
		if (!this.provider.acpClient || !this.provider.acpClient.sessionId) {
			this.pushAssistantError('No active session');
			return;
		}

		// User message
		if (opts?.preQueued) {
			for (let i = this.provider.messages.length - 1; i >= 0; i--) {
				const m = this.provider.messages[i];
				if (m.role === 'user' && m.isQueued) {
					m.isQueued = false;
					break;
				}
			}
		} else {
			this.provider.messages.push({
				role: 'user',
				blocks: [{ type: 'text', content: text }],
				attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
				images: images && images.length > 0 ? images.map((i) => ({ mimeType: i.mimeType, data: i.data, name: i.name })) : undefined,
			});
		}
		this.provider.updateMessages();

		const blocks: ContentBlock[] = [];
		if (text) {
			blocks.push({ type: 'text', text });
		}
		const workspaceRoot = this.provider.getWorkspaceRoot();
		for (const relPath of attachedFiles ?? []) {
			const abs = path.isAbsolute(relPath) ? relPath : path.resolve(workspaceRoot, relPath);
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
		this.provider.messages.push(assistantMsg);
		this.provider.updateMessages();

		const idx = this.provider.messages.length - 1;
		this.provider.streamingIndex = idx;
		this.provider.streamThrottle = new StreamThrottle(this.provider, idx);
		this.provider.toolCallInfos.clear();
		this.provider.isStreaming = true;
		this.provider.agentRunning = true;
		this.provider.stopped = false;
		this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: true });

		try {
			const stopReason = await this.provider.acpClient.prompt(blocks);
			// ACP stopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled.
			// cancelled = user-initiated, end_turn = normal. The rest are worth surfacing.
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
			const wasStopped = this.provider.stopped;
			this.provider.endStreaming();
			assistantMsg.isStreaming = false;

			// Follow-up (reject-with-response): the message is already rendered as `isQueued`.
			// Consume it BEFORE clearing agentRunning to avoid lock/unlock flicker:
			// the agent stays "running" and starts a new turn without the input blinking.
			const followUp = !wasStopped ? this.provider.consumePendingFollowUp() : null;
			if (!followUp) {
				this.provider.agentRunning = false;
				this.provider.stopped = false;
				this.provider.view?.webview.postMessage({ type: 'updateAgentRunning', running: false });
			}
			this.provider.updateMessages();

			if (followUp) {
				await this.handleUserMessage(followUp, undefined, undefined, { preQueued: true });
			}
		}
	}

	private pushAssistantError(text: string): void {
		this.provider.messages.push({
			role: 'assistant',
			blocks: [{ type: 'text', content: text }],
			isError: true,
		});
		this.provider.updateMessages();
	}

	private async handleSearchFiles(query: string): Promise<void> {
		const workspaceRoot = this.provider.getWorkspaceRoot();
		const fileUris = await vscode.workspace.findFiles('**/*', undefined, 2000);
		const queryLower = query.toLowerCase();
		const matches: Array<{ path: string; score: number }> = [];
		for (const uri of fileUris) {
			const relativePath = vscode.workspace.asRelativePath(uri, false);
			if (relativePath.startsWith('.git/') || relativePath.includes('node_modules/')) continue;
			const pathLower = relativePath.toLowerCase();
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
			if (!allCharsMatch) continue;
			const fileName = relativePath.split('/').pop()!;
			if (fileName.toLowerCase().includes(queryLower)) score += 10;
			score -= relativePath.length * 0.01;
			matches.push({ path: relativePath, score });
		}
		matches.sort((a, b) => b.score - a.score);
		const results = matches.slice(0, 20).map((m) => m.path);
		this.provider.view?.webview.postMessage({ type: 'searchFilesResult', results });
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
			candidates.add(path.resolve(this.provider.getWorkspaceRoot(), trimmed));
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
