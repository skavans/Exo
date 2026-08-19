import type { ChatMessage } from './types';

/**
 * Buffers streaming chunks and forwards a lightweight `streamChunk` message to
 * the webview (50ms throttled) with the current snapshot of `message.blocks`
 * (mutated in-place by the owning SessionRuntime).
 *
 * `getMessage` returns the live streaming message; `emit` gates emission
 * (runtimes that aren't the active tab don't push intermediate snapshots —
 * their full state is sent by `showChat` on switch). On stream end `flush()`
 * sends the final chunk plus a full `updateMessages`.
 */
export class StreamThrottle {
	private readonly _index: number;
	private readonly _getMessage: () => ChatMessage | void;
	private readonly _onStreamChunk: (index: number, blocks: ChatMessage['blocks']) => void;
	private readonly _onFlush: () => void;
	private readonly _emit: () => boolean;
	private _throttleTimer?: ReturnType<typeof setTimeout>;
	private _dirty = false;

	private readonly _throttleMs = 50;

	constructor(
		messageIndex: number,
		getMessage: () => ChatMessage | void,
		onStreamChunk: (index: number, blocks: ChatMessage['blocks']) => void,
		onFlush: () => void,
		emit: () => boolean,
	) {
		this._index = messageIndex;
		this._getMessage = getMessage;
		this._onStreamChunk = onStreamChunk;
		this._onFlush = onFlush;
		this._emit = emit;
	}

	/** Called on EVERY chunk from the LLM (text/reasoning) and on tool_call. */
	public update(): void {
		if (!this._emit()) {
			return;
		}
		this._dirty = true;

		// Throttle streamChunk — no more than once per 50ms
		if (!this._throttleTimer) {
			this._sendChunk();
			this._throttleTimer = setTimeout(() => {
				this._throttleTimer = undefined;
				if (this._dirty) {
					this._sendChunk();
				}
			}, this._throttleMs);
		}
	}

	/** Force-flush the buffer and send the full state */
	public flush(): void {
		clearTimeout(this._throttleTimer);
		this._throttleTimer = undefined;

		if (this._dirty && this._emit()) {
			this._sendChunk();
		}
		this._onFlush();
	}

	public dispose(): void {
		clearTimeout(this._throttleTimer);
	}

	/** Send a snapshot of message.blocks to the webview (structured clone). */
	private _sendChunk(): void {
		this._dirty = false;
		const msg = this._getMessage();
		if (!msg) {
			return;
		}
		this._onStreamChunk(this._index, msg.blocks);
	}
}