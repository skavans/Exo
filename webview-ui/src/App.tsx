import { useState, useCallback, useEffect, useRef, useMemo } from 'preact/hooks';
import type { ChatMessage, Plan, AcpSessionInfo, ConfigState, MessageBlock, CommandInfo, AgentInfo, AttachedImage } from './types';
import { formatCompactNumber, formatAgentLabel, useActiveModeColor } from './types';
import { vscode } from './vscode';
import { MessageList } from './components/MessageList';
import { MessageInput } from './components/MessageInput';
import { TodoList } from './components/TodoList';
import { SessionList } from './components/SessionList';
import { ConfigRequired } from './components/ConfigRequired';
import { resolveThemeId, setTheme, getThemeVersion, type ThemeKind } from './shiki';

type ViewMode = 'list' | 'chat';

function readThemeKind(): ThemeKind {
	const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
	return kind === 'vscode-light' || kind === 'vscode-high-contrast-light' ? 'light' : 'dark';
}
function formatTokens(n: number): string {
	return formatCompactNumber(n) + ' tok';
}

export function App() {
	const [view, setView] = useState<ViewMode>('list');
	const [sessionList, setSessionList] = useState<AcpSessionInfo[] | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [config, setConfig] = useState<ConfigState | null>(null);
	const [plan, setPlan] = useState<Plan | null>(null);
	const [sessionTitle, setSessionTitle] = useState<string>('');
	const [sessionId, setSessionId] = useState<string | null>(null);
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

	const handleBack = useCallback(() => {
		vscode.postMessage({ type: 'showSessionList' });
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
					setMessages(message.messages);
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
			case 'updateSessionList': {
				setSessionList(message.sessions as AcpSessionInfo[]);
				setView('list');
				setConfigRequired(false);
				break;
			}
			case 'showChat': {
				setMessages(message.messages as ChatMessage[]);
				setPlan(message.plan as Plan | null);
				setSessionTitle(message.title as string);
				setSessionId((message.sessionId as string | null) ?? null);
				setTokenUsage(null);
				setTokenLimit(null);
				setView('chat');
				setConfigRequired(false);
				break;
			}
			case 'showSessionList': {
				setView('list');
				break;
			}
			case 'showConfigRequired': {
				setConfigRequired(true);
				setConfigPath(typeof message.configPath === 'string' ? message.configPath : null);
				setView('list');
				break;
			}
				case 'sessionTitleUpdate': {
					setSessionTitle(message.title as string);
					break;
				}
				case 'updateTokenUsage': {
					setTokenUsage(message.usage as { prompt_tokens: number } | null);
					setTokenLimit((message.tokenLimit as number | undefined) ?? null);
					break;
				}
				case 'searchFilesResult': {
					// Forward to MessageInput via custom event
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
		case 'updatePromptCapabilities': {
			setPromptCapabilities({ image: Boolean(message.image) });
			break;
		}
		case 'updateColorTheme': {
			setColorThemeName((message.name as string | null) ?? null);
			break;
		}
			case 'streamChunk': {
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
	// changes. Both events fire on a theme switch, in unpredictable order;
	// applyTheme reads fresh values via refs so either one produces the
	// correct result and bumps themeVersion to trigger a re-render.
	useEffect(() => {
		applyTheme();
		const observer = new MutationObserver(() => applyTheme());
		observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
		return () => observer.disconnect();
	}, [applyTheme]);

	if (configRequired) {
		return <ConfigRequired configPath={configPath} />;
	}

	if (view === 'list') {
		return <SessionList sessions={sessionList} agentInfo={agentInfo} />;
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
					if (tc.status === 'awaiting_permission' && tc.permissionRequestId && tc.permissionOptions) {
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
				<button class="back-btn" onClick={handleBack} title="Back to sessions" aria-label="Back to sessions">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
						<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</button>
				<div class="chat-header-title">
					<span class="chat-header-title-text">{sessionTitle}</span>
					{agentLabel && <span class="chat-header-agent" title={agentLabel}>{agentLabel}</span>}
				</div>
				{tokenUsage && (
					<span class="chat-header-tokens">
						{tokenLimit
							? `${formatTokens(tokenUsage.prompt_tokens)} / ${formatTokens(tokenLimit)}`
							: formatTokens(tokenUsage.prompt_tokens)
						}
					</span>
				)}
				{tokenUsage && tokenLimit && (
					<div class="chat-header-bar" title={`${Math.round((tokenUsage.prompt_tokens / tokenLimit) * 100)}% context used`}>
						<div
							class={`chat-header-bar-fill${tokenUsage.prompt_tokens / tokenLimit > 0.75 ? ' warning' : ''}${tokenUsage.prompt_tokens / tokenLimit > 0.9 ? ' danger' : ''}`}
							style={{ width: `${Math.min(100, (tokenUsage.prompt_tokens / tokenLimit) * 100)}%` }}
						/>
					</div>
				)}
			</div>
			<MessageList key={sessionId ?? 'empty'} messages={messages} themeVersion={themeVersion} />
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
				pendingReject={pendingReject}
			/>
		</div>
	);
}
