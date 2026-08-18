import type { AcpSessionInfo, AgentInfo } from '../types';
import { formatAgentLabel } from '../types';
import { vscode } from '../vscode';

interface Props {
	sessions: AcpSessionInfo[] | null;
	agentInfo: AgentInfo | null;
}

function formatRelativeTime(iso: string | null | undefined): string {
	if (!iso) return '';
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return '';
	const now = Date.now();
	const diff = now - ts;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {return 'just now';}
	if (minutes < 60) {return `${minutes}m ago`;}
	if (hours < 24) {return `${hours}h ago`;}
	if (days < 7) {return `${days}d ago`;}
	return new Date(ts).toLocaleDateString();
}

export function SessionList({ sessions, agentInfo }: Props) {
	const handleOpen = (sessionId: string) => {
		vscode.postMessage({ type: 'openSession', sessionId });
	};

	const handleDelete = (e: MouseEvent, sessionId: string) => {
		e.stopPropagation();
		vscode.postMessage({ type: 'deleteSession', sessionId });
	};

	const handleNew = () => {
		vscode.postMessage({ type: 'newSession' });
	};

	const agentLabel = formatAgentLabel(agentInfo);

	return (
		<div class="session-list-view">
			<div class="session-list-header">
				<div class="session-list-heading">
					<span class="session-list-title">Chats</span>
					{agentLabel && <span class="session-list-subtitle" title={agentLabel}>{agentLabel}</span>}
				</div>
				<button class="session-new-btn" onClick={handleNew} title="New chat" aria-label="New chat">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
						<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
			{sessions === null ? (
				<div class="session-list-loading">
					<div class="session-list-spinner" />
				</div>
			) : sessions.length === 0 ? (
				<div class="empty-state">
					<div class="empty-state-icon">💬</div>
					<div class="empty-state-text">No sessions yet</div>
					<div class="empty-state-hint">Click + to start a new chat</div>
				</div>
			) : (
				<div class="session-list">
					{sessions.map((session) => (
						<div
							key={session.sessionId}
							class="session-item"
							onClick={() => handleOpen(session.sessionId)}
						>
							<div class="session-item-title">{session.title || 'Untitled'}</div>
							<div class="session-item-time">{formatRelativeTime(session.updatedAt)}</div>
							<button
								class="session-item-delete"
								onClick={(e) => handleDelete(e as unknown as MouseEvent, session.sessionId)}
								title="Delete session"
							aria-label={`Delete session ${session.title || 'Untitled'}`}
							>
								<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
									<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
								</svg>
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
