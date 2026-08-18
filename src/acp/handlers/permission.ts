/**
 * Client Handler: session/request_permission.
 *
 * The agent decides which operations need confirmation (agent's prerogative, not
 * the client's — see ACP docs/protocol/v1/draft/tool-calls.mdx, "Requesting Permission").
 * Our job as client: show the user the agent-provided options
 * (allow_once/allow_always/reject_once/reject_always) and return the choice:
 *   { outcome: 'selected', optionId }   — user picked an option
 *   { outcome: 'cancelled' }            — prompt turn cancelled (session/cancel)
 *
 * The card renders inline in the chat (like a file-edit review card) via
 * ToolCallInfo.status = 'awaiting_permission' + permissionOptions[]. The decision
 * arrives from the webview by postMessage `permissionDecision` and resolves a pending promise.
 *
 * Context (PermissionHandlerContext) provides access to the runtime toolCallInfos
 * map (to update ToolCallInfo by toolCallId), pendingPermissions (requestId → resolve),
 * and a method to post updateMessages to the webview.
 */

import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	PermissionOption,
} from '@agentclientprotocol/sdk';
import type {
	PermissionOptionInfo,
	PendingPermission,
	ToolCallInfo,
} from '../../chat/types';
import { applyToolCallPatch, extractEditSpec, type EditSpec, type ToolCallRegistryContext } from './util';

/** Context provided by ChatViewProvider. */
export interface PermissionHandlerContext extends ToolCallRegistryContext {
	/** Pending permission requests: requestId → resolver. */
	pendingPermissions: Map<string, PendingPermission>;
	/** Temporary override: auto-approve permission requests without a UI card. */
	autoAllow: () => boolean;
	/** Request-id generator (unique within a session). */
	allocatePermissionRequestId: () => string;
	/** For edit-permissions — open the VS Code Diff Editor. spec: standard ACP content-diff (original/proposed). Returns a diffKey for cleanup. */
	openEditDiff?: (spec: EditSpec) => Promise<string | undefined>;
	/** Close the Diff Editor by diffKey (on resolve/cancel). */
	closeDiff?: (diffKey: string) => void;
}

/**
 * session/request_permission handler.
 *
 * 1. Find (or create) the ToolCallInfo by toolCall.toolCallId.
 * 2. Apply the upsert tool-call patch to ToolCallInfo (title/kind/locations/content/status).
 * 3. Set status = 'awaiting_permission', store permissionOptions + requestId.
 * 4. Register a pending promise in pendingPermissions.
 * 5. Post updateMessages to the webview → the card renders.
 * 6. Await the decision (via the pending promise) — the webview sends `permissionDecision`.
 *
 * On session/cancel all pendingPermissions resolve with outcome:'cancelled'
 * (see ChatViewProvider.cancelPendingOperations).
 */
export async function handleRequestPermission(
	params: RequestPermissionRequest,
	ctx: PermissionHandlerContext,
): Promise<RequestPermissionResponse> {
	const requestId = ctx.allocatePermissionRequestId();
	const toolCallId = params.toolCall.toolCallId;
	const options: PermissionOptionInfo[] = (params.options ?? []).map((o: PermissionOption) => ({
		optionId: o.optionId,
		name: o.name,
		kind: o.kind,
	}));
	console.error(`[Exo ACP] permission requested: toolCallId=${toolCallId} kind=${params.toolCall.kind ?? '(none)'} title=${params.toolCall.title ?? '(none)'}`);

	// 1. Find or create the ToolCallInfo, then apply the unified upsert patch.
	let tc = ctx.toolCallInfos.get(toolCallId);
	if (!tc) {
		tc = {
			name: 'other',
			args: {},
			status: 'awaiting_permission',
			summary: params.toolCall.title ?? params.toolCall.kind ?? 'Permission requested',
			toolCallId,
		};
		ctx.toolCallInfos.set(toolCallId, tc);
		ctx.onToolCallCreated?.(tc);
	}
	applyToolCallPatch(tc, params.toolCall);
	tc.status = 'awaiting_permission';

	// 3. Store options + requestId
	tc.permissionOptions = options;
	tc.permissionRequestId = requestId;

	if (ctx.autoAllow()) {
		const allowOption = options.find((o) => o.kind === 'allow_once')
			?? options.find((o) => o.kind === 'allow_always');
		if (allowOption) {
			tc.status = 'success';
			tc.permissionRequestId = undefined;
			tc.permissionOptions = undefined;
			ctx.postUpdateMessages();
			console.error(
				`[Exo ACP] permission auto-approved: requestId=${requestId} toolCallId=${toolCallId} optionId=${allowOption.optionId}`,
			);
			return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
		}
	}

	// 4. Register the pending promise (create pending explicitly — diffKey assigned below)
	const pending: PendingPermission = { requestId, toolCallId, resolve: () => {} };
	ctx.pendingPermissions.set(requestId, pending);
	const responsePromise = new Promise<RequestPermissionResponse>((resolve) => {
		pending.resolve = resolve;
	});

	// 5. For edit-permissions — open the VS Code Diff Editor.
	//    Only the standard ACP content-diff block (type:'diff', path/oldText/newText) is used.
	if (params.toolCall.kind === 'edit' && ctx.openEditDiff) {
		const spec = extractEditSpec(tc.diffContent);
		if (spec) {
			try {
				pending.diffKey = await ctx.openEditDiff(spec);
			} catch (e) {
				console.error('[Exo ACP] openEditDiff failed:', e);
			}
		}
	}

	// 6. Post an update to the webview → the card appears
	ctx.postUpdateMessages();

	// 7. Wait for the user's decision (or cancel)
	return responsePromise;
}

/**
 * Apply the user's decision from the webview (postMessage `permissionDecision`).
 * Called by WebviewMessageHandler. Resolves the pending promise → the response goes to the agent.
 */
export function resolvePermission(
	ctx: PermissionHandlerContext,
	requestId: string,
	decision: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' },
): void {
	const pending = ctx.pendingPermissions.get(requestId);
	if (!pending) {
		return;
	}
	ctx.pendingPermissions.delete(requestId);

	// Close the Diff Editor if one was opened for the edit-permission
	if (pending.diffKey) {
		ctx.closeDiff?.(pending.diffKey);
	}

	// Update the ToolCallInfo status
	const tc = ctx.toolCallInfos.get(pending.toolCallId);
	if (tc) {
		if (decision.outcome === 'selected') {
			// allow_* → success, reject_* → rejected
			const option = tc.permissionOptions?.find((o) => o.optionId === decision.optionId);
			const isReject = option?.kind === 'reject_once' || option?.kind === 'reject_always';
			tc.status = isReject ? 'rejected' : 'success';
		} else {
			tc.status = 'cancelled';
		}
		tc.permissionRequestId = undefined;
		tc.permissionOptions = undefined;
	}

	pending.resolve({ outcome: decision });
	console.error(
		`[Exo ACP] permission resolved: requestId=${requestId} outcome=${decision.outcome}`
		+ (decision.outcome === 'selected' ? ` optionId=${decision.optionId}` : ''),
	);
}

/**
 * Cancel all pending permission requests (on session/cancel / stopGeneration / disconnect).
 * All resolve with outcome:'cancelled' (ACP requirement — Client must respond with cancelled).
 */
export function cancelAllPermissions(ctx: PermissionHandlerContext): void {
	for (const [, pending] of ctx.pendingPermissions) {
		const tc = ctx.toolCallInfos.get(pending.toolCallId);
		if (tc) {
			tc.status = 'cancelled';
			tc.permissionRequestId = undefined;
			tc.permissionOptions = undefined;
		}
		if (pending.diffKey) ctx.closeDiff?.(pending.diffKey);
		pending.resolve({ outcome: { outcome: 'cancelled' } });
	}
	ctx.pendingPermissions.clear();
}
