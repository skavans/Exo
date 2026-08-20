import { useRef, useEffect, useState, useCallback, useMemo } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { VNode, CSSProperties } from 'preact';
import { marked, type TokenizerAndRendererExtension } from 'marked';
import markedKatex from 'marked-katex-extension';
import DOMPurify from 'dompurify';
import type { ChatMessage, ToolCallInfo, ActivityBlock } from '../types';
import { EMPTY_RESPONSE } from '../types';
import { vscode } from '../vscode';
import { highlightCode } from '../shiki';

// Configure marked: GFM + soft line breaks (models emit single newlines as
// visual breaks; breaks:true keeps them instead of collapsing to spaces).
marked.setOptions({
	gfm: true,
	breaks: true,
});

// Syntax highlighting via Shiki (TextMate grammars + active-theme token
// colors). The renderer runs synchronously inside marked.parse, producing
// <pre class="shiki ..."> with inline style colors that match the editor.
marked.use({
	renderer: {
		code({ text, lang }: { text: string; lang?: string }) {
			return highlightCode(text, lang);
		},
	},
});

marked.use(markedKatex({ throwOnError: false }));

function fallbackCopy(text: string): void {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();
	try { document.execCommand('copy'); } catch { /* ignore */ }
	document.body.removeChild(ta);
}

/* ============================================================
   File-path links
   ------------------------------------------------------------
   Bare paths emitted by the agent (e.g. `src/foo.ts:12`, `/abs/path`,
   `AGENTS.md`) become clickable links — but only after the extension
   host confirms the file exists in the workspace.

   Implemented as a marked inline token extension (not a regex over
   generated HTML). This keeps links out of fenced/inline code: marked
   escapes code content before inline tokenizers run, so a path inside
   a `<code>`/`<pre>` is never re-tokenized as a link.
   ============================================================ */

const FILE_LINK_REQUEST_EVENT = 'exo-resolveFileLinksResult';
const resolvedFileLinks = new Map<string, string>();
const pendingFileLinkRequests = new Map<string, (resolved: Array<{ source: string; path: string }>) => void>();
let nextFileLinkRequestId = 1;

// A path-like token at the start of a string. Two shapes:
//   1. Has at least one path separator: `a/b`, `./x`, `/abs`, `~/y`, `a\b`.
//   2. Bare filename with a short extension: `name.ts`, `AGENTS.md`.
// Trailing `:line` or `:start-end` optional.
const PATH_TOKEN = /^(?:~\/|\.\/|\/)?(?:[\w.\-]+[\/\\])+[\w.\-]+(?::\d+(?:-\d+)?)?|^[\w.\-]+\.[A-Za-z]{2,5}(?::\d+(?:-\d+)?)?/;
const PATH_TOKEN_GLOBAL = new RegExp(PATH_TOKEN.source.replace(/\^/g, ''), 'g');

function parsePathToken(raw: string): { text: string; lookupPath: string; line?: number; endLine?: number } | null {
	// Strip wrapping quotes / trailing sentence punctuation before resolving.
	const text = raw.replace(/^[('"`]+/, '').replace(/[.,;!?)]+$/, '');
	if (!text || /^\d+$/.test(text)) return null;
	const colon = text.lastIndexOf(':');
	let lookupPath = text;
	let line: number | undefined;
	let endLine: number | undefined;
	if (colon !== -1) {
		const suffix = text.slice(colon + 1);
		const range = /^(\d+)(?:-(\d+))?$/.exec(suffix);
		if (range) {
			lookupPath = text.slice(0, colon);
			line = parseInt(range[1], 10);
			endLine = range[2] ? parseInt(range[2], 10) : undefined;
		}
	}
	if (!lookupPath || lookupPath === '.' || lookupPath === '..') return null;
	return { text, lookupPath, line, endLine };
}

function renderFileLink(resolved: string, text: string, line?: number, endLine?: number): string {
	const lineAttr = line ? ` data-line="${line}"` : '';
	const endLineAttr = endLine ? ` data-end-line="${endLine}"` : '';
	return `<a class="file-link" data-path="${escapeHtml(resolved)}"${lineAttr}${endLineAttr}><i class="fas fa-file-lines" aria-hidden="true"></i>&#x2060;${escapeHtml(text)}</a>`;
}

function extractCandidateFileLinks(content: string): string[] {
	const candidates = new Set<string>();
	const stripped = content.replace(/```[\s\S]*?```/g, ' ');
	for (const match of stripped.matchAll(PATH_TOKEN_GLOBAL)) {
		const parsed = parsePathToken(match[0]);
		if (parsed) candidates.add(parsed.lookupPath);
	}
	return Array.from(candidates);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * marked-katex treats any `$...$` as inline math by default and feeds it to
 * KaTeX, which chokes on code containing dollars (PHP, shell vars, JS template
 * literals). Escape single `$...$` spans that contain no LaTeX command
 * (backslash), so katex leaves them alone — marked renders `\$` as a literal `$`.
 * `$$` (display math), code blocks, and inline code are untouched.
 */
function sanitizeInlineMath(markdown: string): string {
	const codeSegments = /(```[\s\S]*?```|`[^`]*`)/g;
	let out = '';
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = codeSegments.exec(markdown)) !== null) {
		out += escapeNonLatexDollars(markdown.slice(last, m.index));
		out += m[0];
		last = m.index + m[0].length;
	}
	out += escapeNonLatexDollars(markdown.slice(last));
	return out;
}

function escapeNonLatexDollars(prose: string): string {
	const span = /(^|(?<=\s))\$(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\$(?=[\s?!\.,:？！。，：]|$)/g;
	return prose.replace(span, (full, _lead, content) =>
		/\\/.test(content) ? full : full.replace(/\$/g, '\\$&'),
	);
}

const barePathLinkExtension: TokenizerAndRendererExtension = {
	name: 'barePathLink',
	level: 'inline',
	start(src) { return PATH_TOKEN.test(src) ? 0 : -1; },
	tokenizer(src) {
		const match = PATH_TOKEN.exec(src);
		if (!match) return;
		const parsed = parsePathToken(match[0]);
		if (!parsed) return;
		return {
			type: 'barePathLink',
			raw: match[0],
			text: parsed.text,
			lookupPath: parsed.lookupPath,
			line: parsed.line,
			tokens: [],
		};
	},
		renderer(token) {
			const t = token as Tokens.Generic & { text: string; lookupPath: string; line?: number; endLine?: number };
			const resolved = resolvedFileLinks.get(t.lookupPath);
			if (!resolved) return t.raw;
			return renderFileLink(resolved, t.text, t.line, t.endLine);
		},
	};
marked.use({ extensions: [barePathLinkExtension] });

// Override codespan renderer: inline code (`src/foo.ts`) that resolves to a
// real workspace file becomes a link. Fenced code blocks use renderer.code,
// not codespan, so large blocks are never touched.
marked.use({
	renderer: {
		codespan(token) {
			const text = (token as Tokens.Codespan).text;
			const trimmed = text.trim();
			if (PATH_TOKEN.test(trimmed)) {
				const parsed = parsePathToken(trimmed);
				if (parsed) {
					const resolved = resolvedFileLinks.get(parsed.lookupPath);
					if (resolved) {
						return renderFileLink(resolved, parsed.text, parsed.line, parsed.endLine);
					}
				}
			}
			return `<code>${escapeHtml(text)}</code>`;
		},
	},
});

async function resolveFileLinks(paths: string[]): Promise<void> {
	const unresolved = paths.filter((candidate) => !resolvedFileLinks.has(candidate));
	if (unresolved.length === 0) return;
	const requestId = `file-links-${nextFileLinkRequestId++}`;
	const promise = new Promise<Array<{ source: string; path: string }>>((resolve) => {
		pendingFileLinkRequests.set(requestId, resolve);
	});
	vscode.postMessage({ type: 'resolveFileLinks', requestId, paths: unresolved });
	const resolved = await promise;
	for (const match of resolved) {
		resolvedFileLinks.set(match.source, match.path);
	}
}

window.addEventListener(FILE_LINK_REQUEST_EVENT, ((event: Event) => {
	const detail = (event as CustomEvent).detail as { requestId?: string; resolved?: Array<{ source: string; path: string }> };
	if (!detail?.requestId) return;
	const resolver = pendingFileLinkRequests.get(detail.requestId);
	if (!resolver) return;
	pendingFileLinkRequests.delete(detail.requestId);
	resolver(detail.resolved ?? []);
}) as EventListener);

interface Props {
	message: ChatMessage;
	themeVersion: number;
}

/** Render markdown with file links support */
function renderMarkdown(content: string, onClick: (e: MouseEvent) => void, isStreaming: boolean) {
	if (!content.trim() || content === EMPTY_RESPONSE) return null;
	let rawHtml: string;
	try {
		rawHtml = marked.parse(sanitizeInlineMath(content)) as string;
	} catch {
		return <div class="md-content" onClick={onClick}>{escapeHtml(content)}</div>;
	}
	// Sanitize before injecting: marked v18 does not strip HTML by default.
	// Allow our own data-* attrs used by file links and the copy button
	// (DOMPurify's default whitelist does not include <button>).
	const cleanHtml = DOMPurify.sanitize(rawHtml, {
		ADD_TAGS: ['button'],
		ADD_ATTR: ['data-path', 'data-line', 'data-end-line', 'data-lang', 'type'],
	});
	// Wrap each <pre> in a .code-block with a header bar (lang badge left,
	// icon copy button right) sitting above the code. Safe to regex: Shiki
	// emits a single <pre class="shiki ..." ...>; plaintext fallback emits
	// bare <pre>. We preserve the opening tag's attributes so theme colors +
	// data-lang stay intact, and only inject the wrapper + chrome.
	const withCopy = cleanHtml
		.replace(/<pre(\s[^>]*)?>/g, (_, attrs: string | undefined) => {
			const langMatch = attrs?.match(/data-lang="([^"]*)"/);
			const lang = langMatch ? langMatch[1] : '';
			const badge = lang ? `<span class="code-lang">${lang}</span>` : '<span class="code-lang"></span>';
			return `<div class="code-block"><div class="code-block-bar">${badge}<button class="copy-btn" type="button" aria-label="Copy code"><i class="fas fa-copy"></i></button></div><pre${attrs ?? ''}>`;
		})
		.replace(/<\/pre>/g, '</pre></div>');
	const html = withCopy + (isStreaming ? '<span class="streaming-cursor"></span>' : '');
	return (
		<div
			class="md-content"
			onClick={onClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/* ============================================================
   SVG Icons
   ============================================================ */

/** FontAwesome icon (glyph → falls under the activity-bar text-shimmer) */
function Fa(name: string): VNode {
	return <i class={`fas ${name}`} aria-hidden="true" />;
}

/** Tool icon by ACP kind (read|edit|delete|move|search|execute|think|fetch|switch_mode|other) */
function getToolIcon(name: string): VNode {
	switch (name) {
		case 'read':
			return Fa('fa-file-lines');
		case 'edit':
			return Fa('fa-pen');
		case 'search':
			return Fa('fa-magnifying-glass');
		case 'execute':
			return Fa('fa-terminal');
		case 'delete':
			return Fa('fa-trash');
		case 'move':
			return Fa('fa-up-down-left-right');
		case 'fetch':
			return Fa('fa-download');
		case 'switch_mode':
			return Fa('fa-toggle-on');
		case 'think':
			return BrainIcon();
		default:
			return Fa('fa-circle-dot');
	}
}

/**
 * Extract the "operation object" from args to display on the approval card.
 * Looks up common field names by priority; for unknown tools — fall back to the
 * first short scalar string (skipping code/content fields).
 */
function extractToolTarget(tc: ToolCallInfo): { icon: string; text: string } | null {
	const args = tc.args;
	const pickStr = (...keys: string[]): string | undefined => {
		for (const k of keys) {
			const v = args[k];
			if (typeof v === 'string' && v) return v;
		}
		return undefined;
	};

	const filePath = pickStr('filePath', 'filepath', 'path', 'file', 'filename');
	if (filePath) return { icon: 'fa-file-lines', text: filePath };

	const command = pickStr('command', 'cmd', 'script');
	if (command) {
		return { icon: 'fa-terminal', text: command.length > 100 ? command.slice(0, 100) + '…' : command };
	}

	const url = pickStr('url', 'uri');
	if (url) return { icon: 'fa-link', text: url };

	const query = pickStr('query', 'pattern', 'search', 'regex');
	if (query) {
		return { icon: 'fa-magnifying-glass', text: query.length > 100 ? query.slice(0, 100) + '…' : query };
	}

	const skip = new Set(['oldString', 'newString', 'diff', 'content', 'newText', 'oldText', 'result', 'output', 'patch', 'rawInput']);
	for (const [key, val] of Object.entries(args)) {
		if (skip.has(key)) continue;
		if (typeof val === 'string' && val.length > 0 && val.length < 100) {
			return { icon: 'fa-circle-dot', text: val };
		}
	}

	return null;
}

/** Brain icon for the ActivityBar */
function BrainIcon(): VNode {
	return Fa('fa-brain');
}

/** Arrow separator for "incoming tokens" — glyph, falls under the shimmer */
function TokensSepIcon(): VNode {
	return Fa('fa-arrow-down');
}

/* ============================================================
   StatusBadge — minimal outlined status icons
   ============================================================ */

function StatusBadge({ status }: { status: ToolCallInfo['status'] }) {
	if (status === 'success') return null;

	const icon: VNode = (() => {
		switch (status) {
			case 'pending':
				return (
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
						<circle cx="8" cy="8" r="5" class="status-pending-ring" />
					</svg>
				);
			case 'error':
				return (
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<line x1="4.5" y1="4.5" x2="11.5" y2="11.5" />
						<line x1="11.5" y1="4.5" x2="4.5" y2="11.5" />
					</svg>
				);
			case 'rejected':
				return (
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<circle cx="8" cy="8" r="6" opacity="0.4" />
						<line x1="5.5" y1="8" x2="10.5" y2="8" />
					</svg>
				);
			case 'cancelled':
				return (
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
						<line x1="4" y1="8" x2="12" y2="8" />
					</svg>
				);
			default:
				return (
					<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
						<circle cx="8" cy="8" r="5" />
					</svg>
				);
		}
	})();

	return (
		<span class={`status-icon status-${status}`}>
			{icon}
		</span>
	);
}

/* ============================================================
   ToolGroup — groups tool calls in the bar
   ============================================================ */

/** Virtual empty activity block: rendered during the initial gap
 *  (user sent a message → first chunk hasn't arrived yet), so the
 *  activity bar shows the shimmer + timer right away. */
const EMPTY_ACTIVITY: ActivityBlock = {
	type: 'activity',
	toolCalls: [],
	reasoning: '',
	reasoningPhases: 0,
};

/** Sentinel for activeName while reasoning is active (brain). */
const ACTIVE_REASONING = '__reasoning__' as const;

interface ToolGroup {
	name: string;
	icon: VNode;
	total: number;
	success: number;
	errors: number;
	pending: number;
	calls: ToolCallInfo[];
}

/* ============================================================
   ActivityBar — the agent's unified activity bar
   ============================================================ */

function formatTime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function ActivityBar({ activity, isStreaming, isLast }: { activity: ActivityBlock; isStreaming: boolean; isLast: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const reasoningContentRef = useRef<HTMLDivElement>(null);
	const centerRef = useRef<HTMLDivElement>(null);
	const [elapsed, setElapsed] = useState(0);
	const [autoCollapsed, setAutoCollapsed] = useState(false);

	const { toolCalls, reasoning, reasoningPhases } = activity;
	const hasReasoning = !!reasoning;
	const reasoningActive = !!activity.reasoningActive;

	// Permission cards stand alone — keyed on a pending request, NOT on status
	// (status stays ACP-owned: a tool_call_update can't hide the card mid-approval).
	const cardCalls = toolCalls.filter(tc => tc.permissionRequestId && tc.permissionOptions);
	const barCalls = toolCalls.filter(tc => !tc.permissionRequestId || !tc.permissionOptions);

	// Group barCalls by tool name
	const groups = useMemo(() => {
		const map = new Map<string, ToolGroup>();
		for (const tc of barCalls) {
			const existing = map.get(tc.name);
			if (existing) {
				existing.calls.push(tc);
				existing.total++;
				if (tc.status === 'success') existing.success++;
				if (tc.status === 'error') existing.errors++;
				if (tc.status === 'pending') existing.pending++;
			} else {
				map.set(tc.name, {
					name: tc.name,
					icon: getToolIcon(tc.kind ?? tc.name),
					total: 1,
					success: tc.status === 'success' ? 1 : 0,
					errors: tc.status === 'error' ? 1 : 0,
					pending: tc.status === 'pending' ? 1 : 0,
					calls: [tc],
				});
			}
		}
		return Array.from(map.values());
	}, [barCalls]);

	// The block stays active (shimmer + running timer) while it is the last block
	// of a streaming message — i.e. the agent hasn't started writing the final text yet.
	// As soon as a text chunk arrives, the text block becomes last and this block stops.
	// If reasoning/tool chunks follow later, a NEW activity block is pushed (→ new line).
	const blockActive = isStreaming && isLast;

	// Single active focus: only the current work is lit (accent, no blinking).
	// Priority: reasoningActive → brain; else the last pending tool → its group;
	// else (while the block is active) the last tool of any status — so the chip
	// doesn't go dark between consecutive same-kind calls or on errors.
	// A work change flips the lit chip; while the work is the same, the same chip stays lit.
	const lastPending = [...barCalls].reverse().find(tc => tc.status === 'pending');
	const lastTool = barCalls.length > 0 ? barCalls[barCalls.length - 1] : null;
	let activeName: string | null;
	if (reasoningActive) activeName = ACTIVE_REASONING;
	else if (lastPending) activeName = lastPending.name;
	else if (blockActive && lastTool) activeName = lastTool.name;
	else activeName = null;

	// Show the reasoning signal only when there's real reasoning.
	const showReasoning = hasReasoning || reasoningActive || reasoningPhases > 0;

	// Timer: accumulates the block's lifetime while it is active (last + streaming).
	// On block end (text started) or stop — freeze and fixate it.
	const accumulatedRef = useRef(0);
	const startRef = useRef<number | null>(null);
	useEffect(() => {
		if (!blockActive) {
			return;
		}
		startRef.current = Date.now();
		const id = setInterval(() => {
			if (startRef.current !== null) {
				setElapsed(accumulatedRef.current + Math.floor((Date.now() - startRef.current) / 1000));
			}
		}, 250);
		return () => {
			clearInterval(id);
			if (startRef.current !== null) {
				accumulatedRef.current += Math.floor((Date.now() - startRef.current) / 1000);
				startRef.current = null;
			}
			setElapsed(accumulatedRef.current);
		};
	}, [blockActive]);

	// Shimmer — a sequential "scanner": the wave sweeps over the chips in turn,
	// back and forth (~133ms per chip in each direction), then a 5000ms pause,
	// then repeats. Progress 0..N is written straight into style (centerRef)
	// (no setState → 0 re-renders); the CSS var is inherited by each chip's ::after,
	// which subtracts its own --chip-index. When progress decreases, the strip
	// moves right-to-left on its own (the CSS formula is direction-invariant).
	// chipCount is read from the DOM every frame → new streaming chips join the
	// queue without restarting the effect.
	useEffect(() => {
		const el = centerRef.current;
		const reset = () => {
			if (el) el.style.setProperty('--ct-shimmer-progress', '0');
		};
		if (!blockActive) {
			reset();
			return;
		}
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		if (media.matches) {
			reset();
			return;
		}
		const PAUSE_MS = 5000;
		const PER_CHIP_MS = 133;
		let frame = 0;
		const start = performance.now();
		const tick = (now: number) => {
			const chipCount = el?.children.length ?? 0;
			if (chipCount > 0 && el) {
				const sweep = PER_CHIP_MS * chipCount;
				const cycle = PAUSE_MS + sweep * 2;
				const elapsed = (now - start) % cycle;
				let progress;
				if (elapsed < sweep) progress = (elapsed / sweep) * chipCount;
				else if (elapsed < sweep * 2) progress = ((sweep * 2 - elapsed) / sweep) * chipCount;
				else progress = 0;
				el.style.setProperty('--ct-shimmer-progress', progress.toFixed(3));
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [blockActive]);

	// Auto-collapse when streaming finishes
	useEffect(() => {
		if (!isStreaming && hasReasoning && !autoCollapsed) {
			setAutoCollapsed(true);
			setExpanded(false);
		}
	}, [isStreaming, hasReasoning, autoCollapsed]);

	// Auto-scroll reasoning content while streaming
	useEffect(() => {
		if (expanded && isStreaming && reasoningContentRef.current) {
			reasoningContentRef.current.scrollTop = reasoningContentRef.current.scrollHeight;
		}
	});

	const hasExpandableContent = hasReasoning || barCalls.length > 0;

	return (
		<div class={`activity-bar${blockActive ? ' active' : ''}`}>
			<div class="activity-bar-header" onClick={() => hasExpandableContent && setExpanded(v => !v)}>
				<div class="activity-bar-center" ref={centerRef}>
					{(() => {
						let chipIdx = 0;
						return (
							<>
								{showReasoning && (
									<span
										class={`activity-bar-reasoning-signal${activeName === ACTIVE_REASONING ? ' is-active' : ''}`}
										style={{ '--chip-index': chipIdx++ } as CSSProperties}
									>
										<span class="activity-bar-brain">
											<BrainIcon />
										</span>
										{reasoningPhases > 1 && (
											<span class="activity-bar-phases">{reasoningPhases}</span>
										)}
									{hasReasoning && (
										<span class="activity-bar-tokens">
											<span class="activity-bar-tokens-sep"><TokensSepIcon /></span>
											<span class="activity-bar-tokens-num">{Math.ceil(reasoning.length / 4)}</span>
										</span>
									)}
									</span>
								)}
								{groups.map(g => (
									<span
										key={g.name}
										class={`activity-bar-tool${activeName === g.name ? ' is-active' : ''}`}
										title={`${g.name}: ${g.success}/${g.total}${g.errors > 0 ? ` (${g.errors} error${g.errors > 1 ? 's' : ''})` : ''}`}
										style={{ '--chip-index': chipIdx++ } as CSSProperties}
									>
										<span class="activity-bar-tool-icon">{g.icon}</span>
										<span class="activity-bar-tool-count">
											{g.errors > 0 ? `${g.success}/${g.total}` : `${g.success}`}
										</span>
									</span>
								))}
							</>
						);
					})()}
				</div>

				<div class="activity-bar-right">
					{/* Timer */}
					{(blockActive || elapsed > 0) && (
						<span class="activity-bar-timer">{formatTime(elapsed)}</span>
					)}

					{/* Expand chevron */}
					{hasExpandableContent && (
						<span class={`activity-bar-chevron${expanded ? ' expanded' : ''}`} />
					)}
				</div>
			</div>

			{/* Expanded content */}
			{expanded && (
				<div class="activity-bar-content">
					{hasReasoning && (
						<div class="activity-bar-reasoning" ref={reasoningContentRef}>
							{reasoning}
						</div>
					)}
					{barCalls.length > 0 && (
						<div class="activity-bar-tools">
							{barCalls.map((tc, i) => (
								<CompactToolLine key={tc.toolCallId ?? tc.permissionRequestId ?? `tc-${i}`} tc={tc} />
							))}
						</div>
					)}
				</div>
			)}

			{/* Permission cards — always visible, outside the collapse */}
			{cardCalls.map((tc, i) => (
				<PermissionCard key={tc.permissionRequestId ?? tc.toolCallId ?? `p-${i}`} tc={tc} />
			))}
		</div>
	);
}

/* ============================================================
   CompactToolLine — one line for non-review tool calls
   ============================================================ */

function ToolDebugInfo({ tc }: { tc: ToolCallInfo }) {
	return (
		<div class="tool-debug">
			<div class="tool-debug-section">
				<div class="tool-debug-label">Args</div>
				<pre class="tool-debug-content">{JSON.stringify(tc.args, null, 2)}</pre>
			</div>
			{tc.result && (
				<div class="tool-debug-section">
					<div class="tool-debug-label">{tc.isError ? 'Error' : 'Result'}</div>
					<pre class={`tool-debug-content${tc.isError ? ' tool-debug-error' : ''}`}>{tc.result}</pre>
				</div>
			)}
		</div>
	);
}

function CompactToolLine({ tc }: { tc: ToolCallInfo }) {
	const [showDebug, setShowDebug] = useState(false);

	return (
		<div>
			<div class="tool-compact" onClick={() => setShowDebug(v => !v)}>
				<span class="tool-compact-icon">{getToolIcon(tc.kind ?? tc.name)}</span>
				{tc.summary && <span class="tool-compact-summary">{tc.summary}</span>}
				<span class="tool-compact-badge"><StatusBadge status={tc.status} /></span>
			</div>
			{showDebug && <ToolDebugInfo tc={tc} />}
		</div>
	);
}

/* ============================================================
   PermissionCard — the ACP session/request_permission approval card
   ============================================================ */

function PermissionCard({ tc }: { tc: ToolCallInfo }) {
	const active = !!tc.permissionRequestId && !!tc.permissionOptions && tc.permissionOptions.length > 0;
	const options = tc.permissionOptions ?? [];
	const [showDebug, setShowDebug] = useState(false);
	const target = useMemo(() => extractToolTarget(tc), [tc]);

	const handleSelect = useCallback((optionId: string) => {
		if (!tc.permissionRequestId) return;
		vscode.postMessage({
			type: 'permissionDecision',
			requestId: tc.permissionRequestId,
			optionId,
		});
	}, [tc.permissionRequestId]);

	const allowOptions = useMemo(() =>
		options
			.filter((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
			.sort((a, b) => (a.kind === 'allow_once' ? 0 : 1) - (b.kind === 'allow_once' ? 0 : 1)),
	[options]);

	return (
		<div class="tool-perm-card">
			<div class="tool-perm-row" onClick={() => setShowDebug(v => !v)}>
				<span class="tool-perm-icon">{getToolIcon(tc.kind ?? tc.name)}</span>
				<span class="tool-perm-label">{target ? target.text : (tc.summary || tc.name)}</span>
				{active ? (
					<span class="tool-perm-actions" onClick={(e) => e.stopPropagation()}>
						{allowOptions.map((o) => (
							<button
								key={o.optionId}
								class="tool-perm-btn tool-permission-allow"
								onClick={() => handleSelect(o.optionId)}
							>
								<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="3 7 6 10 11 4" />
								</svg>
								{o.name}
							</button>
						))}
					</span>
				) : (
					<span class="tool-perm-resolved">{tc.status === 'rejected' ? 'Rejected' : tc.status === 'cancelled' ? 'Cancelled' : 'Allowed'}</span>
				)}
			</div>
			{showDebug && <ToolDebugInfo tc={tc} />}
		</div>
	);
}

/* ============================================================
   MessageBubble
   ============================================================ */

export const MessageBubble = memo(function MessageBubble({ message, themeVersion }: Props) {
	const isStreaming = message.isStreaming ?? false;
	const [, setFileLinkVersion] = useState(0);
	const resolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const textBlocks = message.blocks.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text');
		const candidates = textBlocks.flatMap((block) => extractCandidateFileLinks(block.content));
		if (resolveTimerRef.current) {
			clearTimeout(resolveTimerRef.current);
			resolveTimerRef.current = null;
		}
		if (candidates.length === 0) return;
		// Debounce: during streaming the blocks change on every chunk.
		// Resolve once, 300ms after the last change.
		resolveTimerRef.current = setTimeout(() => {
			void resolveFileLinks(candidates).then(() => {
				setFileLinkVersion((version) => version + 1);
			});
		}, 300);
		return () => {
			if (resolveTimerRef.current) {
				clearTimeout(resolveTimerRef.current);
				resolveTimerRef.current = null;
			}
		};
	}, [message.blocks]);

	const handleContentClick = useCallback((e: MouseEvent) => {
		const target = e.target as HTMLElement;
		// Copy button: copy the code text from the sibling <code>.
		const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
		if (copyBtn) {
			const code = copyBtn.closest('.code-block')?.querySelector('code');
			const text = code?.textContent ?? '';
			if (text) {
				const done = () => {
					copyBtn.classList.add('copied');
					const icon = copyBtn.querySelector('i');
					if (icon) { icon.className = 'fas fa-check'; }
					setTimeout(() => {
						copyBtn.classList.remove('copied');
						if (icon) { icon.className = 'fas fa-copy'; }
					}, 1500);
				};
				if (navigator.clipboard?.writeText) {
					navigator.clipboard.writeText(text).then(done).catch(() => {
						fallbackCopy(text);
						done();
					});
				} else {
					fallbackCopy(text);
					done();
				}
			}
			return;
		}
		// File link: open in editor at line. Use closest() so clicks on any
		// inner element (e.g. a former <code> wrapper) still resolve to the <a>.
		const linkEl = target.closest('.file-link') as HTMLElement | null;
		if (linkEl) {
			e.preventDefault();
			const path = linkEl.getAttribute('data-path');
			const line = linkEl.getAttribute('data-line');
			const endLine = linkEl.getAttribute('data-end-line');
			if (path) {
				vscode.postMessage({
					type: 'openFile',
					path,
					line: line ? parseInt(line, 10) : undefined,
					endLine: endLine ? parseInt(endLine, 10) : undefined,
				});
			}
		}
	}, []);

	const classes = `message ${message.role}${message.isError ? ' error' : ''}${message.isQueued ? ' queued' : ''}`;

	// Initial gap: the streaming assistant has no blocks yet → render an empty
	// activity block so the shimmer/timer start right on send.
	const renderBlocks = (message.blocks && message.blocks.length > 0)
		? message.blocks
		: (isStreaming && message.role === 'assistant' ? [EMPTY_ACTIVITY] : []);
	const lastIndex = renderBlocks.length - 1;

	return (
		<div class={classes}>
			<div class="message-blocks">
				{renderBlocks.map((block, i) => {
					if (block.type === 'text') {
						if (message.isError) {
							return <div key={i} class="error-text">{block.content}</div>;
						}
						if (message.role === 'user') {
							return <div key={i} class="user-text">{block.content}</div>;
						}
						const isLastAndStreaming = isStreaming && i === lastIndex;
						return renderMarkdown(block.content, handleContentClick, isLastAndStreaming);
					}
					if (block.type === 'activity') {
						return <ActivityBar key={i} activity={block} isStreaming={isStreaming} isLast={i === lastIndex} />;
					}
					return null;
				})}
			</div>
			{message.isQueued && (
				<div class="queued-badge" title="Will be sent automatically">
					<svg class="queued-spinner" width="12" height="12" viewBox="0 0 12 12" fill="none">
						<circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 3" />
					</svg>
					<span>queued</span>
				</div>
			)}
			{message.role === 'user' && message.attachedFiles && message.attachedFiles.length > 0 && (
				<div class="message-attached-files">
					{message.attachedFiles.map((filePath) => {
						const fileName = filePath.split('/').pop()!;
						return (
							<span class="file-chip file-chip-readonly" key={filePath} title={filePath}>
								<span class="file-chip-icon">📄</span>
								<span class="file-chip-name">{fileName}</span>
							</span>
						);
					})}
				</div>
			)}
			{message.role === 'user' && message.images && message.images.length > 0 && (
				<div class="message-attached-images">
					{message.images.map((img, i) => (
						<span class="image-chip-readonly" key={img.id ?? i} title={img.name ?? `image ${i + 1}`}>
							<span class="image-chip-icon">🖼</span>
							<span class="image-chip-name">{img.name ?? `image ${i + 1}`}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
});
