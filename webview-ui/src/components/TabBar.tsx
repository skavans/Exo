import { useEffect, useRef } from 'preact/hooks';
import type { TabInfo } from '../types';

interface Props {
	tabs: TabInfo[];
	activeSessionId: string | null;
	agentLabel?: string;
	onSelect: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
}

/**
 * Session tab bar. Horizontal scroll when many tabs; a sticky indicator shows
 * how many sessions are waiting for permission while off-screen. The active
 * tab is two-line (title + agent) and wider; inactive tabs are compact.
 */
export function TabBar({ tabs, activeSessionId, agentLabel, onSelect, onClose }: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const awaitingCount = tabs.filter((t) => t.status === 'awaiting').length;

	// Keep the active tab visible when tabs change (scroll into view, no smooth
	// — switching tabs shouldn't animate).
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const active = el.querySelector<HTMLElement>('.tab-item.active');
		if (!active) return;
		const rect = active.getBoundingClientRect();
		const container = el.getBoundingClientRect();
		if (rect.left < container.left || rect.right > container.right) {
			active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}, [activeSessionId, tabs]);

	const scrollToFirstAwaiting = () => {
		const el = scrollRef.current;
		if (!el) return;
		const target = el.querySelector<HTMLElement>('.tab-item.awaiting');
		target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	};

	return (
		<div class="tab-bar">
			{awaitingCount > 0 && (
				<button
					class="tab-awaiting-pin"
					onClick={scrollToFirstAwaiting}
					title={`${awaitingCount} session${awaitingCount > 1 ? 's' : ''} waiting for approval`}
				>
					<span class="tab-awaiting-dot" aria-hidden="true" />
					<span>{awaitingCount}</span>
				</button>
			)}
			<div class="tab-scroll" ref={scrollRef}>
				{tabs.map((tab) => {
					const isActive = tab.sessionId === activeSessionId;
					const tooltip = agentLabel
						? `${tab.title} — ${agentLabel}`
						: tab.title;
					return (
						<div
							key={tab.sessionId}
							class={`tab-item${isActive ? ' active' : ''}${tab.status === 'awaiting' ? ' awaiting' : ''}`}
							onClick={() => onSelect(tab.sessionId)}
							title={isActive
								? tooltip
								: (tab.status === 'awaiting'
									? `${tooltip} — waiting for approval`
									: tab.status === 'running'
										? `${tooltip} — working`
										: tooltip)
							}
						>
							<span class="tab-main">
								<span
									class={`tab-status tab-status-${tab.status}`}
									aria-hidden="true"
								/>
								<span class="tab-title">{tab.title}</span>
								<button
									class="tab-close"
									onClick={(e) => {
										e.stopPropagation();
										onClose(tab.sessionId);
									}}
									title="Close session"
									aria-label={`Close session ${tab.title}`}
								>
									<svg width="10" height="10" viewBox="0 0 16 16" fill="none">
										<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
									</svg>
								</button>
							</span>
							{isActive && agentLabel && (
								<span class="tab-agent" title={agentLabel}>{agentLabel}</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}