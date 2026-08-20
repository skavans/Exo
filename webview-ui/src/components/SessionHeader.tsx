import { useEffect, useRef } from 'preact/hooks';
import { MODE_COLORS } from '../types';
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

interface MergedSession {
	sessionId: string;
	title: string;
	isOpen: boolean;
	status: 'idle' | 'running' | 'awaiting' | 'loading' | 'closed';
	colorIndex: number;
	number?: number;
	updatedAt?: number;
}

/**
 * Session title bar: trigger (chevron + live-session count, warning-tinted
 * with a pulsing badge while any session awaits permission) + centered current
 * session (status dot, title, agent caption) + unified dropdown with open and
 * recent sessions.
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

	const merged: MergedSession[] = [
		...tabs.map((t) => ({
			sessionId: t.sessionId,
			title: t.title,
			isOpen: true,
			status: t.status,
			colorIndex: t.colorIndex,
			number: t.number,
		})),
		...(recentSessions ?? [])
			.filter((s) => !openIds.has(s.sessionId))
			.map((s) => ({
				sessionId: s.sessionId,
				title: s.title,
				isOpen: false,
				status: 'closed' as const,
				colorIndex: 0,
				updatedAt: s.updatedAt,
			})),
	];

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
					<span
						class={`session-number session-status-${activeTab.status}`}
						style={{ '--dot-color': MODE_COLORS[activeTab.colorIndex % MODE_COLORS.length] } as preact.JSX.CSSProperties}
						aria-hidden="true"
					>
						{activeTab.number}
					</span>
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
					<div class="session-menu-list">
						{merged.length === 0 ? (
							<div class="session-menu-empty">No sessions</div>
						) : (
							merged.map((s) => {
								const isActive = s.sessionId === activeSessionId;
								const tooltip = agentLabel ? `${s.title} — ${agentLabel}` : s.title;
								const statusLabel = s.isOpen
									? s.status === 'loading'
										? ' — starting…'
										: s.status === 'awaiting'
											? ' — waiting for approval'
											: s.status === 'running'
												? ' — working'
												: ''
									: '';
								const dotClass = s.isOpen
									? `session-status-${s.status}`
									: 'session-status-idle';
								const dotStyle = s.isOpen
									? { '--dot-color': MODE_COLORS[s.colorIndex % MODE_COLORS.length] } as preact.JSX.CSSProperties
									: {};
								return (
									<div
										key={s.sessionId}
										class={`session-menu-item${isActive ? ' active' : ''}${s.status === 'loading' ? ' loading' : ''}`}
										onClick={
											s.status === 'loading'
												? undefined
												: s.isOpen
													? () => onSelect(s.sessionId)
													: () => onOpen(s.sessionId)
										}
										title={`${tooltip}${statusLabel}`}
									>
										{s.isOpen && s.number != null ? (
											<span
												class={`session-number ${dotClass}`}
												style={dotStyle}
												aria-hidden="true"
											>
												{s.number}
											</span>
										) : (
											<span
												class={`session-status ${dotClass} on`}
												style={dotStyle}
												aria-hidden="true"
											/>
										)}
										<span class="session-menu-title">{s.title}</span>
										{s.updatedAt != null && (
											<span class="session-menu-time">{formatRelativeTime(s.updatedAt)}</span>
										)}
										<div class="session-menu-actions">
											{s.isOpen && (
												<button
													class="session-menu-close"
													onClick={(e) => {
														e.stopPropagation();
														onClose(s.sessionId);
													}}
													title="Close session"
													aria-label={`Close session ${s.title}`}
												>
													<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
														<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
													</svg>
												</button>
											)}
											<button
												class="session-menu-delete"
												onClick={(e) => {
													e.stopPropagation();
													onDelete(s.sessionId);
												}}
												title="Delete session"
												aria-label={`Delete session ${s.title}`}
											>
												<svg width="11" height="11" viewBox="0 0 16 16" fill="none">
													<path d="M5 3V2.5A.5.5 0 015.5 2h5a.5.5 0 01.5.5V3M11 4v8.5a.5.5 0 01-.5.5h-5a.5.5 0 01-.5-.5V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
												</svg>
											</button>
										</div>
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
				</div>
			)}
		</div>
	);
}
