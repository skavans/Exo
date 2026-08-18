import { useRef, useEffect, useCallback, useState, useLayoutEffect } from 'preact/hooks';
import type { ChatMessage } from '../types';
import { MessageBubble } from './MessageBubble';
import { ErrorBoundary } from './ErrorBoundary';

interface Props {
	messages: ChatMessage[];
	themeVersion: number;
}

const STICKY_THRESHOLD = 48;
const ECHO_WINDOW_MS = 120;

export function MessageList({ messages, themeVersion }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [showScrollBtn, setShowScrollBtn] = useState(false);

	const isStickyRef = useRef(true);
	const programmaticUntilRef = useRef(0);
	const lastTargetTopRef = useRef(0);
	const pendingFrameRef = useRef<number | null>(null);

	const getDistanceFromBottom = useCallback(() => {
		const el = containerRef.current;
		if (!el) { return Infinity; }
		return el.scrollHeight - el.scrollTop - el.clientHeight;
	}, []);

	const stickToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
		const el = containerRef.current;
		if (!el) { return; }
		const target = el.scrollHeight;
		lastTargetTopRef.current = target;
		programmaticUntilRef.current = performance.now() + ECHO_WINDOW_MS;
		isStickyRef.current = true;
		el.scrollTo({ top: target, left: 0, behavior });
	}, []);

	const scrollToBottomSmooth = useCallback(() => {
		stickToBottom('smooth');
		setShowScrollBtn(false);
	}, [stickToBottom]);

	const syncStickyStateFromScroll = useCallback(() => {
		const el = containerRef.current;
		if (!el) { return; }

		const now = performance.now();
		if (now < programmaticUntilRef.current && el.scrollTop >= lastTargetTopRef.current - 2) {
			return;
		}

		const distance = getDistanceFromBottom();
		const sticky = distance <= STICKY_THRESHOLD;
		isStickyRef.current = sticky;
		setShowScrollBtn(!sticky);
	}, [getDistanceFromBottom]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) { return; }
		const onScroll = () => { syncStickyStateFromScroll(); };
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, [syncStickyStateFromScroll]);

	const scheduleStickToBottom = useCallback(() => {
		if (pendingFrameRef.current !== null) { return; }
		pendingFrameRef.current = requestAnimationFrame(() => {
			pendingFrameRef.current = null;
			if (isStickyRef.current) { stickToBottom('auto'); }
		});
	}, [stickToBottom]);

	useLayoutEffect(() => {
		if (isStickyRef.current) { stickToBottom('auto'); }
	}, [messages, stickToBottom]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || typeof ResizeObserver === 'undefined') { return; }

		let lastHeight = container.scrollHeight;
		const observer = new ResizeObserver(() => {
			const grew = container.scrollHeight > lastHeight;
			lastHeight = container.scrollHeight;
			if (grew) { scheduleStickToBottom(); }
		});

		observer.observe(container);
		return () => observer.disconnect();
	}, [scheduleStickToBottom]);

	useEffect(() => () => {
		if (pendingFrameRef.current !== null) {
			cancelAnimationFrame(pendingFrameRef.current);
			pendingFrameRef.current = null;
		}
	}, []);

	return (
		<div class="messages-container">
			<ErrorBoundary>
				<div id="messages" ref={containerRef}>
					{messages.length === 0 ? (
						<div class="empty-state">
							<div class="empty-state-icon">💬</div>
							<div class="empty-state-text">Start a conversation</div>
							<div class="empty-state-hint">Describe a task below to begin</div>
						</div>
					) : (
						messages.map((msg, i) => (
							<MessageBubble key={i} message={msg} themeVersion={themeVersion} />
						))
					)}
				</div>
			</ErrorBoundary>
			{showScrollBtn && (
				<button class="scroll-to-bottom" onClick={scrollToBottomSmooth} title="Scroll to bottom" aria-label="Scroll to bottom">
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
						<path d="M2 4.5L6 8.5L10 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</button>
			)}
		</div>
	);
}
