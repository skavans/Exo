import { useState, useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import type { ChatMessage, Plan, MessageBlock, CommandInfo, AgentInfo, AttachedImage, TabInfo, RecentSessionInfo, ChatLoadingInfo } from './types';
import { formatAgentLabel, useActiveModeColor } from './types';
import { vscode } from './vscode';
import { MessageList } from './components/MessageList';
import { MessageInput } from './components/MessageInput';
import { TodoList } from './components/TodoList';
import { SessionHeader } from './components/SessionHeader';
import { ChatLoading } from './components/ChatLoading';
import { ConfigRequired } from './components/ConfigRequired';
import { resolveThemeId, setTheme, getThemeVersion, type ThemeKind } from './shiki';

function readThemeKind(): ThemeKind {
	const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
	return kind === 'vscode-light' || kind === 'vscode-high-contrast-light' ? 'light' : 'dark';
}
/** Context pill color by fill: <50% green, ≤70% yellow, >70% red. */
function ctxPillClass(used: number, limit: number | null): string {
	if (!limit || limit <= 0) return '';
	const ratio = used / limit;
	if (ratio < 0.5) return 'green';
	if (ratio <= 0.7) return 'yellow';
	return 'red';
}

/** Token count, compact: 500 → "500", 200k → "200k", 1m → "1m". */
function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1e6) return `${Math.round(n / 1000)}k`;
	if (n < 1e9) return `${Math.round(n / 1e6)}m`;
	return `${Math.round(n / 1e9)}b`;
}

export function App() {
	const [tabs, setTabs] = useState<TabInfo[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const [recentSessions, setRecentSessions] = useState<RecentSessionInfo[]>([]);
	const [chatLoading, setChatLoading] = useState<ChatLoadingInfo | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [config, setConfig] = useState<ConfigState | null>(null);
	const [plan, setPlan] = useState<Plan | null>(null);
	const [tokenUsage, setTokenUsage] = useState<{ prompt_tokens: number } | null>(null);
	const [tokenLimit, setTokenLimit] = useState<number | null>(null);
	const [isAgentRunning, setIsAgentRunning] = useState(false);
	const [commands, setCommands] = useState<CommandInfo[]>([]);
	const [autoAllowPermissions, setAutoAllowPermissions] = useState(false);
	const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
	const [promptCapabilities, setPromptCapabilities] = useState<{ image: boolean }>({ image: false });
	const [colorThemeName, setColorThemeName] = useState<string | null>(null);
	const [themeVersion, setThemeVersion] = useState(() => getThemeVersion());
	const [configRequired, setConfigRequired] = useState(false);
	const [configPath, setConfigPath] = useState<string | null>(null);
	const [canMerge, setCanMerge] = useState(false);

	// Guard against streamChunk for a session that isn't the active one.
	const activeSessionIdRef = useRef(activeSessionId);
	activeSessionIdRef.current = activeSessionId;

	// Keep a ref to the latest theme name so applyTheme always reads a fresh
	// value, never a stale closure (the host message and the MutationObserver
	// fire independently and in unpredictable order on theme switch).
	const colorThemeNameRef = useRef(colorThemeName);
	colorThemeNameRef.current = colorThemeName;

	const applyTheme = useCallback(() => {
		setTheme(resolveThemeId(colorThemeNameRef.current, readThemeKind()));
		setThemeVersion(getThemeVersion());
	}, []);

	const handleSend = useCallback((text: string, attachedFiles?: string[], images?: AttachedImage[]) => {
		vscode.postMessage({ type: 'sendMessage', text, attachedFiles, images });
	}, []);

	const handleSelectConfigOption = useCallback((configId: string, value: string) => {
		vscode.postMessage({ type: 'selectConfigOption', configId, value });
	}, []);

	const handleStop = useCallback(() => {
		vscode.postMessage({ type: 'stopGeneration' });
	}, []);

	const handleToggleAutoAllowPermissions = useCallback(() => {
		vscode.postMessage({ type: 'toggleAutoAllowPermissions' });
	}, []);

	const handleNew = useCallback(() => {
		setMenuOpen(false);
		vscode.postMessage({ type: 'newSession' });
	}, []);

	const handleSelectTab = useCallback((sessionId: string) => {
		setMenuOpen(false);
		if (sessionId !== activeSessionIdRef.current && !sessionId.startsWith('pending-')) {
			vscode.postMessage({ type: 'switchSession', sessionId });
		}
	}, []);

	const handleCloseTab = useCallback((sessionId: string) => {
		setMenuOpen(false);
		vscode.postMessage({ type: 'closeTab', sessionId });
	}, []);

	const handleOpenRecent = useCallback((sessionId: string) => {
		setMenuOpen(false);
		if (sessionId !== activeSessionIdRef.current) {
			vscode.postMessage({ type: 'switchSession', sessionId });
		}
	}, []);

	const handleToggleMenu = useCallback(() => {
		setMenuOpen((v) => !v);
	}, []);

	const handleCloseMenu = useCallback(() => {
		setMenuOpen(false);
	}, []);

	const handleDeleteRecent = useCallback((sessionId: string) => {
		vscode.postMessage({ type: 'deleteSession', sessionId });
	}, []);

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data;
			switch (message.type) {
				case 'updateAgentInfo': {
					setAgentInfo((message.agentInfo as AgentInfo | undefined) ?? null);
					break;
				}
				case 'updateMessages':
					if (message.sessionId === undefined || message.sessionId === activeSessionIdRef.current) {
						setMessages(message.messages);
					}
					break;
				case 'updateConfig': {
					setConfig(message as ConfigState);
					break;
				}
				case 'updatePlan':
					setPlan(message.plan as Plan | null);
					break;
				case 'updateCommands': {
					setCommands((message.commands as CommandInfo[] | undefined) ?? []);
					break;
				}
				case 'updateAutoAllowPermissions': {
					setAutoAllowPermissions(Boolean(message.value));
					break;
				}
				case 'restoreDraft': {
					window.dispatchEvent(new CustomEvent('exo-restoreDraft', {
						detail: {
							text: typeof message.text === 'string' ? message.text : '',
							attachedFiles: Array.isArray(message.attachedFiles) ? message.attachedFiles : [],
						},
					}));
					break;
				}
				case 'updateTabs': {
					setTabs((message.tabs as TabInfo[] | undefined) ?? []);
					const active = (message.activeSessionId as string | null) ?? null;
					activeSessionIdRef.current = active;
					setActiveSessionId(active);
					if (!active) {
						setMessages([]);
						setPlan(null);
						setTokenUsage(null);
						setTokenLimit(null);
						setChatLoading(null);
						setCanMerge(false);
					}
					break;
				}
				case 'updateSessions': {
					setRecentSessions((message.sessions as RecentSessionInfo[] | undefined) ?? []);
					break;
				}
				case 'showChatLoading': {
					const sid = (message.sessionId as string | null) ?? null;
					activeSessionIdRef.current = sid;
					setActiveSessionId(sid);
					setMessages([]);
					setPlan(null);
					setTokenUsage(null);
					setTokenLimit(null);
					setCanMerge(false);
					setConfigRequired(false);
					setChatLoading({
						title: (message.title as string | undefined) ?? '',
						mode: message.mode === 'new' ? 'new' : 'load',
					});
					break;
				}
				case 'showChat': {
					const sid = (message.sessionId as string | null) ?? null;
					activeSessionIdRef.current = sid;
					setActiveSessionId(sid);
					setMessages(message.messages as ChatMessage[]);
					setPlan(message.plan as Plan | null);
					setTokenUsage(null);
					setTokenLimit(null);
					setCanMerge(false);
					setConfigRequired(false);
					setChatLoading(null);
					break;
				}
				case 'showEmpty': {
					activeSessionIdRef.current = null;
					setActiveSessionId(null);
					setMessages([]);
					setPlan(null);
					setTokenUsage(null);
					setTokenLimit(null);
					setCanMerge(false);
					setConfigRequired(false);
					setChatLoading(null);
					break;
				}
				case 'showSessionPicker': {
					setMenuOpen(true);
					break;
				}
				case 'showConfigRequired': {
					setConfigRequired(true);
					setConfigPath(typeof message.configPath === 'string' ? message.configPath : null);
					setActiveSessionId(null);
					setChatLoading(null);
					setCanMerge(false);
					break;
				}
				case 'updateTokenUsage': {
					setTokenUsage(message.usage as { prompt_tokens: number } | null);
					setTokenLimit((message.tokenLimit as number | undefined) ?? null);
					break;
				}
				case 'searchFilesResult': {
					window.dispatchEvent(new CustomEvent('exo-searchFilesResult', { detail: message.results }));
					break;
				}
				case 'resolveFileLinksResult': {
					window.dispatchEvent(new CustomEvent('exo-resolveFileLinksResult', { detail: message }));
					break;
				}
				case 'addDroppedFilesResult': {
					window.dispatchEvent(new CustomEvent('exo-addDroppedFilesResult', { detail: { files: message.files, rejected: message.rejected } }));
					break;
				}
				case 'updateAgentRunning': {
					setIsAgentRunning(message.running as boolean);
					break;
				}
				case 'updateMergeState': {
					setCanMerge(Boolean(message.canMerge));
					break;
				}
				case 'updatePromptCapabilities': {
					setPromptCapabilities({ image: Boolean(message.image) });
					break;
				}
				case 'updateColorTheme': {
					setColorThemeName((message.name as string | null) ?? null);
					break;
				}
				case 'streamChunk': {
					if (message.sessionId && message.sessionId !== activeSessionIdRef.current) {
						break;
					}
					const idx = message.index as number;
					const chunkBlocks = message.blocks as MessageBlock[] | undefined;
					setMessages((prev) => {
						if (idx < 0 || idx >= prev.length) { return prev; }
						const msg = prev[idx];
						if (!msg.isStreaming) { return prev; }
						const next = prev.slice();
						next[idx] = {
							...msg,
							blocks: chunkBlocks ?? msg.blocks,
						};
						return next;
					});
					break;
				}
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	// Notify extension that webview is ready
	useEffect(() => {
		vscode.postMessage({ type: 'ready' });
	}, []);

	// Apply Shiki theme on startup and whenever the VS Code color-theme name
	// (from the host) or the theme kind (from body[data-vscode-theme-kind])
	// changes.
	useEffect(() => {
		applyTheme();
		const observer = new MutationObserver(() => applyTheme());
		observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
		return () => observer.disconnect();
	}, [applyTheme]);

	if (configRequired) {
		return <ConfigRequired configPath={configPath} />;
	}

	const activeModeColor = useActiveModeColor(config);
	const chatViewStyle = activeModeColor ? { '--ct-mode': activeModeColor } as preact.JSX.CSSProperties : undefined;
	const agentLabel = formatAgentLabel(agentInfo);

	const pendingReject = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== 'assistant') continue;
			for (let j = msg.blocks.length - 1; j >= 0; j--) {
				const block = msg.blocks[j];
				if (block.type !== 'activity') continue;
				for (let k = block.toolCalls.length - 1; k >= 0; k--) {
					const tc = block.toolCalls[k];
					if (tc.permissionRequestId && tc.permissionOptions) {
						const reject = tc.permissionOptions.find(o => o.kind === 'reject_once') ?? tc.permissionOptions.find(o => o.kind === 'reject_always');
						if (reject) {
							return { requestId: tc.permissionRequestId, optionId: reject.optionId };
						}
					}
				}
			}
		}
		return null;
	}, [messages]);

	return (
		<div class="chat-view" style={chatViewStyle}>
			<div class="chat-header">
				<SessionHeader
					tabs={tabs}
					activeSessionId={activeSessionId}
					agentLabel={agentLabel || undefined}
					recentSessions={recentSessions}
					open={menuOpen}
					onToggle={handleToggleMenu}
					onDismiss={handleCloseMenu}
					onSelect={handleSelectTab}
					onClose={handleCloseTab}
					onNew={handleNew}
					onOpen={handleOpenRecent}
					onDelete={handleDeleteRecent}
				/>
				{tokenUsage && (
					<div
						class={`ctx-pill ${ctxPillClass(tokenUsage.prompt_tokens, tokenLimit)}`}
						title={tokenLimit
							? `${Math.round((tokenUsage.prompt_tokens / tokenLimit) * 100)}% context used`
							: `${tokenUsage.prompt_tokens} tokens used`}
					>
						{tokenLimit
							? `${fmtTokens(tokenUsage.prompt_tokens)}/${fmtTokens(tokenLimit)}`
							: fmtTokens(tokenUsage.prompt_tokens)
						}
					</div>
				)}
			</div>
			{chatLoading ? (
				<ChatLoading title={chatLoading.title} mode={chatLoading.mode} />
			) : activeSessionId ? (
				<>
					<MessageList key={activeSessionId} messages={messages} themeVersion={themeVersion} />
					{plan && <TodoList plan={plan} />}
					<MessageInput
						onSend={handleSend}
						commands={commands}
						config={config}
						onSelectConfigOption={handleSelectConfigOption}
						isAgentRunning={isAgentRunning}
						autoAllowPermissions={autoAllowPermissions}
						onToggleAutoAllowPermissions={handleToggleAutoAllowPermissions}
						onStop={handleStop}
						canPromptImage={promptCapabilities.image}
						canMerge={canMerge}
						pendingReject={pendingReject}
					/>
				</>
			) : (
				<div class="empty-state session-empty">
					<div class="empty-state-icon">💬</div>
					<div class="empty-state-text">No active session</div>
					<div class="empty-state-hint">Click + to start a new chat</div>
					<button class="empty-new-btn" onClick={handleNew}>New session</button>
				</div>
			)}
		</div>
	);
}

// Local import to keep the config-state typing in one place.
type ConfigState = import('./types').ConfigState;