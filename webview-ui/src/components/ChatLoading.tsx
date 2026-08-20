interface Props {
	title: string;
	mode: 'new' | 'load';
}

/**
 * Full-area loading view shown while a session is being created/loaded
 * (host-side pending operation). Replaces the chat until `showChat` arrives.
 */
export function ChatLoading({ title, mode }: Props) {
	return (
		<div class="chat-loading">
			<div class="chat-loading-spinner" aria-hidden="true" />
			<div class="chat-loading-title">
				{mode === 'new' ? 'Creating session…' : 'Loading session…'}
			</div>
			{title && <div class="chat-loading-sub">{title}</div>}
		</div>
	);
}
