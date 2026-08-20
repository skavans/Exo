import { useEffect, useRef } from 'preact/hooks';
import type { RecentSessionInfo, TabInfo } from '../types';

interface Props {
	tabs: TabInfo[];
	activeSessionId: string | null;
	agentLabel?: string;
	recentSessions: RecentSessionInfo[] | null;
	open: boolean;
	onToggle: () => void;
	onDismiss: () => void;
	onSelect: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onNew: () => void;
	onOpen: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
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

/**
 * Session title bar: trigger (chevron + live-session count, warning-tinted
 * with a pulsing badge while any session awaits permission) + centered current
 * session (status dot, title, agent caption) + dropdown with open sessions,
 * "New session" entry and recent history.
 */
export function SessionHeader({
	tabs,
	activeSessionId,
	agentLabel,
	recentSessions,
	open,
	onToggle,
	onDismiss,
	onSelect,
	onClose,
	onNew,
	onOpen,
	onDelete,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	const activeTab = tabs.find((t) => t.sessionId === activeSessionId) ?? null;
	const awaitingCount = tabs.filter((t) => t.status === 'awaiting').length;
	const openIds = new Set(tabs.map((t) => t.sessionId));
	const recents = (recentSessions ?? []).filter((s) => !openIds.has(s.sessionId));

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				onDismiss();
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismiss();
			}
		};
		document.addEventListener('mousedown', onMouseDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onMouseDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open, onDismiss]);

	return (
		<div class="session-header" ref={rootRef}>
			<button
				class={`session-trigger${open ? ' open' : ''}${awaitingCount > 0 ? ' awaiting' : ''}`}
				onClick={onToggle}
				title={awaitingCount > 0
					? `${awaitingCount} session${awaitingCount > 1 ? 's' : ''} waiting for approval`
					: 'Sessions'}
				aria-label="Sessions menu"
				aria-expanded={open}
			>
				<svg class="session-trigger-chevron" width="9" height="9" viewBox="0 0 16 16" fill="none">
					<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
				<span class="session-count">{tabs.length}</span>
				{awaitingCount > 0 && (
					<span class="session-awaiting-badge">{awaitingCount}</span>
				)}
			</button>

			{activeTab ? (
				<div
					class="session-current"
					title={agentLabel ? `${activeTab.title} — ${agentLabel}` : activeTab.title}
				>
					<span class={`session-status session-status-${activeTab.status}`} aria-hidden="true" />
					<div class="session-current-text">
						<span class="session-current-title">{activeTab.title}</span>
						{agentLabel && <span class="session-current-agent">{agentLabel}</span>}
					</div>
				</div>
			) : (
				agentLabel && <span class="session-current-agent solo">{agentLabel}</span>
			)}

			{open && (
				<div class="session-menu">
					<div class="session-menu-section">Sessions</div>
					<div class="session-menu-list">
						{tabs.length === 0 ? (
							<div class="session-menu-empty">No open sessions</div>
						) : (
							tabs.map((tab) => {
								const isActive = tab.sessionId === activeSessionId;
								const tooltip = agentLabel ? `${tab.title} — ${agentLabel}` : tab.title;
								return (
									<div
										key={tab.sessionId}
										class={`session-menu-item${isActive ? ' active' : ''}${tab.status === 'loading' ? ' loading' : ''}`}
										onClick={tab.status === 'loading' ? undefined : () => onSelect(tab.sessionId)}
										title={isActive
											? tooltip
											: tab.status === 'loading'
												? `${tooltip} — starting…`
												: tab.status === 'awaiting'
													? `${tooltip} — waiting for approval`
													: tab.status === 'running'
														? `${tooltip} — working`
														: tooltip
										}
									>
										<span class={`session-status session-status-${tab.status}`} aria-hidden="true" />
										<span class="session-menu-title">{tab.title}</span>
										<button
											class="session-menu-close"
											onClick={(e) => {
												e.stopPropagation();
												onClose(tab.sessionId);
											}}
											title="Close session"
											aria-label={`Close session ${tab.title}`}
										>
											<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
												<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
											</svg>
										</button>
									</div>
								);
							})
						)}
					</div>

					<button class="session-menu-new" onClick={onNew}>
						<span class="session-menu-new-icon">
							<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
								<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
							</svg>
						</span>
						<span class="session-menu-new-title">New session</span>
						{agentLabel && <span class="session-menu-new-agent" title={agentLabel}>{agentLabel}</span>}
					</button>

					{recents.length > 0 && (
						<>
							<div class="session-menu-separator" />
							<div class="session-menu-section">Recent</div>
							<div class="session-menu-list">
								{recents.map((session) => (
									<div
										key={session.sessionId}
										class="session-menu-item"
										onClick={() => onOpen(session.sessionId)}
									>
										<span
											class={`session-status session-status-idle${session.active ? ' on' : ''}`}
											aria-hidden="true"
										/>
										<span class="session-menu-title">{session.title}</span>
										<span class="session-menu-time">{formatRelativeTime(session.updatedAt)}</span>
										<button
											class="session-menu-delete"
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
								))}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
