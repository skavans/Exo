import { useEffect, useRef } from 'preact/hooks';
import type { RecentSessionInfo, AgentInfo } from '../types';
import { formatAgentLabel } from '../types';

interface Props {
	sessions: RecentSessionInfo[] | null;
	agentInfo: AgentInfo | null;
	onNew: () => void;
	onOpen: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
	onClose: () => void;
}

function formatRelativeTime(updatedAt?: number): string {
	if (!updatedAt) return '';
	const now = Date.now();
	const diff = now - updatedAt;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return new Date(updatedAt).toLocaleDateString();
}

/** Dropdown shown by the "+" button: new-session entry on top, recent sessions below. */
export function SessionPicker({ sessions, agentInfo, onNew, onOpen, onDelete, onClose }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const agentLabel = formatAgentLabel(agentInfo);

	useEffect(() => {
		if (!sessions || sessions.length === 0) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [sessions, onClose]);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	}, [onClose]);

	return (
		<div class="session-picker" ref={ref}>
			<button class="session-picker-new" onClick={onNew}>
				<span class="session-picker-new-icon">
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
						<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					</svg>
				</span>
				<span class="session-picker-new-title">New session</span>
				{agentLabel && <span class="session-picker-new-agent" title={agentLabel}>{agentLabel}</span>}
			</button>
			<div class="session-picker-separator" />
			<div class="session-picker-list">
				{sessions === null ? (
					<div class="session-picker-empty">Loading…</div>
				) : sessions.length === 0 ? (
					<div class="session-picker-empty">No sessions yet</div>
				) : (
					sessions.map((session) => (
						<div
							key={session.sessionId}
							class={`session-picker-item${session.active ? ' active' : ''}`}
							onClick={() => onOpen(session.sessionId)}
						>
							<span
								class={`session-picker-status${session.active ? ' on' : ''}`}
								aria-hidden="true"
							/>
							<span class="session-picker-title">{session.title}</span>
							<span class="session-picker-time">{formatRelativeTime(session.updatedAt)}</span>
							<button
								class="session-picker-delete"
								onClick={(e) => {
									e.stopPropagation();
									onDelete(session.sessionId);
								}}
								title="Delete session"
								aria-label={`Delete session ${session.title}`}
							>
								<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
									<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
								</svg>
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
}