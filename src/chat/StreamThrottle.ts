import type { ChatViewProvider } from './ChatViewProvider';

/**
 * Buffers streaming chunks and forwards a lightweight `streamChunk` message to
 * the webview (50ms throttled) with the current snapshot of `message.blocks`
 * (mutated in-place in ChatViewProvider).
 *
 * On stream end `flush()` sends the final `streamChunk` plus a full
 * `updateMessages` + `persistSession`.
 */
export class StreamThrottle {
    private readonly _provider: ChatViewProvider;
    private readonly _index: number;
    private _throttleTimer?: ReturnType<typeof setTimeout>;
    private _dirty = false;

    private readonly _throttleMs = 50;

    constructor(provider: ChatViewProvider, messageIndex: number) {
        this._provider = provider;
        this._index = messageIndex;
    }

/** Called on EVERY chunk from the LLM (text/reasoning) and on tool_call. */
	public update(): void {
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

        if (this._dirty) {
            this._sendChunk();
        }
        this._provider.updateMessages();
    }

    public dispose(): void {
        clearTimeout(this._throttleTimer);
    }

/** Send a snapshot of message.blocks to the webview (structured clone). */
	private _sendChunk(): void {
        const webview = this._provider.view?.webview;
        if (!webview) { return; }
        const msg = this._provider.messages[this._index];
        if (!msg) { return; }

        this._dirty = false;

        webview.postMessage({
            type: 'streamChunk',
            index: this._index,
            blocks: msg.blocks,
        });
    }
}
