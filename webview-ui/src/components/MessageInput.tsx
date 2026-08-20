import { Fragment } from 'preact';
import { useRef, useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import type { ConfigState, ConfigSelector, ConfigOption, CommandInfo, AttachedImage } from '../types';
import { MODE_COLORS, modeColor, useActiveModeColor } from '../types';
import { vscode } from '../vscode';
import { fuzzyFilter, fuzzyMatch, type FuzzyMatch } from '../fuzzy';

type ActivePicker =
	| { type: 'mention'; query: string; start: number }
	| { type: 'command'; query: string; start: number };

interface MentionItem {
	path: string;
	match: FuzzyMatch;
}

interface CommandItem {
	command: CommandInfo;
	match: FuzzyMatch;
}

/** fuzzyMatch, but null → empty match (safety on server-side results). */
function safeFuzzyMatch(query: string, target: string): FuzzyMatch {
	return fuzzyMatch(query, target) ?? { score: 0, indices: [] };
}

interface Props {
	onSend: (text: string, attachedFiles?: string[], images?: AttachedImage[]) => void;
	commands: CommandInfo[];
	config: ConfigState | null;
	onSelectConfigOption: (configId: string, value: string) => void;
	isAgentRunning?: boolean;
	autoAllowPermissions: boolean;
	onToggleAutoAllowPermissions: () => void;
	onStop?: () => void;
	canPromptImage: boolean;
	canMerge?: boolean;
	pendingReject?: { requestId: string; optionId: string } | null;
}

export function MessageInput({ onSend, commands, config, onSelectConfigOption, isAgentRunning, autoAllowPermissions, onToggleAutoAllowPermissions, onStop, canPromptImage, canMerge, pendingReject }: Props) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState('');

	// Shared popup state for @-mentions and /-commands.
	const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
	const [images, setImages] = useState<AttachedImage[]>([]);
	const [activePicker, setActivePicker] = useState<ActivePicker | null>(null);
	const [rawSearchResults, setRawSearchResults] = useState<string[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// File list with match data (highlighting). The server already sorted it —
	// we only compute indices, without re-sorting.
	const mentionItems = useMemo<MentionItem[]>(() => {
		const query = activePicker?.type === 'mention' ? activePicker.query : '';
		return rawSearchResults.map((path) => ({
			path,
			match: query
				? safeFuzzyMatch(query, path)
				: { score: 0, indices: [] },
		}));
	}, [activePicker, rawSearchResults]);

	// Commands list with fuzzy filtering and ranking.
	const commandItems = useMemo<CommandItem[]>(() => {
		const query = activePicker?.type === 'command' ? activePicker.query : '';
		return fuzzyFilter(query || '', commands, (c) => c.name).map((r) => ({
			command: r.item,
			match: r.match,
		}));
	}, [activePicker, commands]);

	// Selectors grouped by position: mode (colored, left), model (center), thought_level (right)
	const modeSelector = useMemo(
		() => (config?.selectors ?? []).find((s) => s.category === 'mode') ?? null,
		[config],
	);
	const leftSelectors = useMemo(
		() => (config?.selectors ?? []).filter((s) => s.category !== 'mode' && s.category !== 'thought_level'),
		[config],
	);
	const thoughtSelector = useMemo(
		() => (config?.selectors ?? []).find((s) => s.category === 'thought_level') ?? null,
		[config],
	);

	const activeModeColor = useActiveModeColor(config);
	const modeName = useMemo(() => {
		if (!modeSelector) {
			return null;
		}
		const cur = modeSelector.options.find((o) => o.value === modeSelector.currentValue);
		return cur?.name ?? modeSelector.currentValue;
	}, [modeSelector]);

	// Debounced search
	const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const addFile = useCallback((filePath: string) => {
		setAttachedFiles((prev) => prev.includes(filePath) ? prev : [...prev, filePath]);
	}, []);

	const addImage = useCallback((img: AttachedImage) => {
		setImages((prev) => [...prev, img]);
	}, []);

	const removeImage = useCallback((id: string) => {
		setImages((prev) => prev.filter((i) => i.id !== id));
	}, []);

	const readFileAsImage = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== 'string') return;
			const match = /^data:([^;]+);base64,(.*)$/.exec(result);
			if (!match) return;
			const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			addImage({ id, mimeType: match[1], data: match[2], name: file.name });
		};
		reader.readAsDataURL(file);
	}, [addImage]);

	const showNotice = useCallback((text: string) => {
		setNotice(text);
		if (noticeTimerRef.current) {
			clearTimeout(noticeTimerRef.current);
		}
		noticeTimerRef.current = setTimeout(() => setNotice(null), 1800);
	}, []);

	const handleDropPaths = useCallback((paths: string[]) => {
		if (paths.length === 0) return;
		vscode.postMessage({ type: 'addDroppedFiles', paths });
	}, []);

	const triggerSearch = useCallback((query: string) => {
		if (searchTimeoutRef.current) {
			clearTimeout(searchTimeoutRef.current);
		}
		if (!query) {
			setRawSearchResults([]);
			return;
		}
		searchTimeoutRef.current = setTimeout(() => {
			vscode.postMessage({ type: 'searchFiles', query });
		}, 150);
	}, []);

	// Listen for search results
	useEffect(() => {
		const handler = (e: Event) => {
			const results = (e as CustomEvent<string[]>).detail as string[];
			setRawSearchResults(results || []);
			setSelectedIndex(0);
		};
		window.addEventListener('exo-searchFilesResult', handler);
		return () => window.removeEventListener('exo-searchFilesResult', handler);
	}, []);

	// Listen for dropped-files validation result (host-side stat).
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ files: string[]; rejected: number }>).detail;
			const files = detail?.files ?? [];
			const rejected = detail?.rejected ?? 0;
			if (files.length > 0) {
				setAttachedFiles((prev) => {
					const next = [...prev];
					for (const p of files) {
						if (!next.includes(p)) next.push(p);
					}
					return next;
				});
			}
			if (rejected > 0) {
				showNotice(rejected === 1 ? '1 folder ignored' : `${rejected} folders ignored`);
			}
		};
		window.addEventListener('exo-addDroppedFilesResult', handler);
		return () => window.removeEventListener('exo-addDroppedFilesResult', handler);
	}, [showNotice]);

	const removeFile = useCallback((filePath: string) => {
		setAttachedFiles((prev) => prev.filter((f) => f !== filePath));
	}, []);

	const closePicker = useCallback(() => {
		setActivePicker(null);
		setRawSearchResults([]);
		setSelectedIndex(0);
		if (searchTimeoutRef.current) {
			clearTimeout(searchTimeoutRef.current);
		}
	}, []);

	/** Resize textarea to fit content (reset → measure → set). */
	const autoResize = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) {return;}
		ta.style.height = 'auto';
		ta.style.height = ta.scrollHeight + 'px';
	}, []);

	const selectMentionItem = useCallback((filePath: string) => {
		const textarea = textareaRef.current;
		if (!textarea || activePicker?.type !== 'mention') { return; }
		const before = text.slice(0, activePicker.start);
		const after = text.slice(textarea.selectionStart);
		setText(before + after);
		addFile(filePath);
		closePicker();
		requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			textareaRef.current.selectionStart = activePicker.start;
			extareaRef.current.selectionEnd = activePicker.start;
			autoResize();
			extareaRef.current.focus({ preventScroll: true });
		});
	}, [activePicker, addFile, closePicker, text]);

	const selectCommandItem = useCallback((command: CommandInfo) => {
		const textarea = textareaRef.current;
		if (!textarea || activePicker?.type !== 'command') { return; }
		const before = text.slice(0, activePicker.start);
		const after = text.slice(textarea.selectionStart);
		const inserted = `/${command.name} `;
		setText(before + inserted + after);
		const nextCursor = before.length + inserted.length;
		closePicker();
		requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			textareaRef.current.selectionStart = nextCursor;
			extareaRef.current.selectionEnd = nextCursor;
			autoResize();
			extareaRef.current.focus({ preventScroll: true });
		});
	}, [activePicker, closePicker, text]);

	const handleSend = () => {
		const trimmed = text.trim();
		if (pendingReject) {
			vscode.postMessage({
				type: 'permissionDecision',
				requestId: pendingReject.requestId,
				optionId: pendingReject.optionId,
				followUpText: trimmed || undefined,
			});
			setAttachedFiles([]);
			setImages([]);
			setText('');
			closePicker();
			if (textareaRef.current) {
				textareaRef.current.style.height = 'auto';
			}
			return;
		}
		if (!trimmed && attachedFiles.length === 0 && images.length === 0) { return; }
		const files = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
		const imgs = images.length > 0 ? [...images] : undefined;
		onSend(trimmed || '', files, imgs);
		setAttachedFiles([]);
		setImages([]);
		setText('');
		closePicker();
		if (textareaRef.current) {
			extareaRef.current.style.height = 'auto';
			extareaRef.current.focus({ preventScroll: true });
		}
	};

	const handleMergeToMain = () => {
		vscode.postMessage({ type: 'mergeToMain' });
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		const items = activePicker?.type === 'mention' ? mentionItems : commandItems;
		if (activePicker && items.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedIndex((prev) => (prev + 1) % items.length);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				if (activePicker.type === 'mention') {
					selectMentionItem(mentionItems[selectedIndex].path);
				} else {
					selectCommandItem(commandItems[selectedIndex].command);
				}
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closePicker();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleInput = () => {
		const textarea = textareaRef.current;
		if (!textarea) { return; }
		setText(textarea.value);
		autoResize();

		const cursorPos = textarea.selectionStart;
		const text = textarea.value;
		const trigger = findActiveTrigger(text, cursorPos);
		if (!trigger || cursorPos <= trigger.start) {
			if (activePicker) {
				closePicker();
			}
			return;
		}
		const query = text.slice(trigger.start + 1, cursorPos);
		setSelectedIndex(0);
		if (trigger.type === 'mention') {
			setActivePicker({ type: 'mention', query, start: trigger.start });
			triggerSearch(query);
			return;
		}
		// command picker — the list is recomputed via useMemo over commands + query
		if (query.includes('/')) {
			closePicker();
			return;
		}
		setActivePicker({ type: 'command', query, start: trigger.start });
	};

	// Close popup on outside click
	useEffect(() => {
		if (!activePicker) { return; }
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
				textareaRef.current && !textareaRef.current.contains(e.target as Node)) {
				closePicker();
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [activePicker, closePicker]);

	// Focus textarea on mount and global click (excluding interactive elements & selection)
	useEffect(() => {
		textareaRef.current?.focus({ preventScroll: true });
		const handler = (e: MouseEvent) => {
			if (window.getSelection()?.toString()) { return; }
			const target = e.target as HTMLElement | null;
			if (target?.closest('button, a, input, select, textarea, [role="button"], .config-picker, .mention-dropdown')) { return; }
			textareaRef.current?.focus({ preventScroll: true });
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, []);

	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ text: string; attachedFiles: string[] }>).detail;
			setText(detail?.text ?? '');
			setAttachedFiles(Array.isArray(detail?.attachedFiles) ? detail.attachedFiles : []);
			requestAnimationFrame(() => autoResize());
		};
		window.addEventListener('exo-restoreDraft', handler);
		return () => window.removeEventListener('exo-restoreDraft', handler);
	}, []);

	useEffect(() => {
		vscode.postMessage({ type: 'updateDraftState', text, attachedFiles });
	}, [text, attachedFiles]);

	// Scroll selected item into view
	useEffect(() => {
		const hasItems = activePicker?.type === 'mention' ? mentionItems.length > 0 : commandItems.length > 0;
		if (!activePicker || !hasItems) { return; }
		const selected = dropdownRef.current?.querySelector('.mention-item.selected');
		selected?.scrollIntoView({ block: 'nearest' });
	}, [selectedIndex, activePicker, mentionItems, commandItems]);

	const commandHint = activePicker?.type === 'command'
		? commandItems[selectedIndex]?.command.input?.hint ?? null
		: null;
	const placeholder = pendingReject
		? 'Reject with response (optional)…'
		: commandHint
			? commandHint
			: modeName
				? `${modeName} mode — describe your task… (@ to attach files, / for commands)`
				: 'Describe your task… (@ to attach files, / for commands)';

	const [dragOver, setDragOver] = useState(false);
	const dragDepthRef = useRef(0);

	const handleDragEnter = useCallback((e: DragEvent) => {
		e.preventDefault();
		dragDepthRef.current++;
		setDragOver(true);
	}, []);

	const handleDragOver = useCallback((e: DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}, []);

	const handleDragLeave = useCallback((e: DragEvent) => {
		e.preventDefault();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) setDragOver(false);
	}, []);

	const handleDrop = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current = 0;
		setDragOver(false);
		const dt = e.dataTransfer;
		if (!dt) return;
		const filePaths: string[] = [];
		const imageFiles: File[] = [];

		// 1) VS Code Explorer drag → text/uri-list (file:// URIs) or text/plain (path).
		//    The sandboxed webview exposes no File.path, but string data is available synchronously.
		const uriList = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
		if (uriList) {
			for (const line of uriList.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				let p = trimmed;
				if (p.startsWith('file://')) {
					try { p = decodeURIComponent(new URL(p).pathname); }
					catch { p = p.slice('file://'.length); }
				}
				if (p) filePaths.push(p);
			}
		}

		// 2) OS drag → dt.files. File.path is usually empty in the sandbox,
		//    but images can be read as base64 (no path needed).
		if (dt.files && dt.files.length > 0) {
			for (let i = 0; i < dt.files.length; i++) {
				const f = dt.files[i];
				if (f.type.startsWith('image/')) {
					imageFiles.push(f);
				} else {
					const p = (f as File & { path?: string }).path;
					if (p) filePaths.push(p);
				}
			}
		}

		if (imageFiles.length > 0) {
			if (canPromptImage) {
				for (const f of imageFiles) readFileAsImage(f);
			} else {
				showNotice('images not supported');
			}
		}
		handleDropPaths(filePaths);
	}, [handleDropPaths, canPromptImage, showNotice, readFileAsImage]);

	const handlePaste = useCallback((e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		let imageFound = false;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				imageFound = true;
				if (canPromptImage) {
					const file = item.getAsFile();
					if (file) readFileAsImage(file);
				}
			}
		}
		if (imageFound) {
			e.preventDefault();
			if (!canPromptImage) showNotice('images not supported');
		}
	}, [canPromptImage, readFileAsImage, showNotice]);

	// The active mode's CSS var colors border/placeholder/trigger (inherited from .chat-view).
	const modeActiveClass = activeModeColor ? 'mode-active' : '';

	return (
		<div
			id="input-area"
			class={`${modeActiveClass}${dragOver ? ' drag-over' : ''}`}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{dragOver && (
				<div class="drag-overlay" aria-hidden="true">
					<span class="drag-overlay-text">
						{canPromptImage ? 'Drop files or images to attach' : 'Drop files to attach'}
					</span>
				</div>
			)}
			{notice && (
				<div class="input-notice">{notice}</div>
			)}
			{/* Image chips (paste/drop) */}
			{images.length > 0 && (
				<div class="image-chips">
					{images.map((img) => (
						<span class="image-chip" key={img.id} title={img.name ?? 'image'}>
							<img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? 'image'} />
							<button
								class="image-chip-remove"
								onClick={(e) => { e.preventDefault(); removeImage(img.id); }}
								title="Remove"
								aria-label="Remove image"
							>×</button>
						</span>
					))}
				</div>
			)}
			{/* File chips */}
			{attachedFiles.length > 0 && (
				<div class="file-chips">
					{attachedFiles.map((filePath) => {
						const fileName = filePath.split('/').pop()!;
						return (
							<span class="file-chip" key={filePath}>
								<span class="file-chip-icon">📄</span>
								<span class="file-chip-name" title={filePath}>{fileName}</span>
								<button
									class="file-chip-remove"
									onClick={(e) => { e.preventDefault(); removeFile(filePath); }}
									title="Remove"
									aria-label={`Remove ${fileName}`}
								>×</button>
							</span>
						);
					})}
				</div>
			)}
		<div class={`input-wrapper${pendingReject ? ' reject-mode' : ''}${canMerge && !isAgentRunning && !pendingReject ? ' merge-visible' : ''}`}>
			<textarea
				id="message-input"
				ref={textareaRef}
				value={text}
				rows={3}
				placeholder={placeholder}
				onKeyDown={handleKeyDown}
				onInput={handleInput}
				onPaste={handlePaste}
				disabled={isAgentRunning && !pendingReject}
			/>
			{/* Shared dropdown for @-files and /-commands */}
			{activePicker?.type === 'mention' && mentionItems.length > 0 && (
				<div class="mention-dropdown" ref={dropdownRef} role="listbox" aria-label="Files">
					{mentionItems.map(({ path, match }, idx) => {
						const fileStart = path.length - (path.split('/').pop()!.length);
						const fileName = path.slice(fileStart);
						const dirPath = path.slice(0, Math.max(0, fileStart - 1));
						const nameIdx = match.indices.filter((i) => i >= fileStart).map((i) => i - fileStart);
						const dirIdx = match.indices.filter((i) => i < fileStart - 1);
						return (
							<button
								key={path}
								class={`mention-item${idx === selectedIndex ? ' selected' : ''}`}
								onClick={(e) => { e.preventDefault(); selectMentionItem(path); }}
								role="option"
								aria-selected={idx === selectedIndex}
							>
								<span class="mention-item-icon">📄</span>
								<span class="mention-item-name"><Highlighted text={fileName} indices={nameIdx} /></span>
								{dirPath && <span class="mention-item-path"><Highlighted text={dirPath} indices={dirIdx} /></span>}
							</button>
						);
					})}
				</div>
			)}
			{activePicker?.type === 'command' && commandItems.length > 0 && (
				<div class="mention-dropdown" ref={dropdownRef} role="listbox" aria-label="Commands">
					{commandItems.map(({ command, match }, idx) => (
						<button
							key={command.name}
							class={`mention-item${idx === selectedIndex ? ' selected' : ''}`}
							onClick={(e) => { e.preventDefault(); selectCommandItem(command); }}
							role="option"
							aria-selected={idx === selectedIndex}
						>
							<span class="mention-item-icon">/</span>
							<span class="mention-item-name"><Highlighted text={command.name} indices={match.indices} /></span>
							<span class="mention-item-path">{command.description}</span>
						</button>
					))}
				</div>
			)}
			{canMerge && !isAgentRunning && !pendingReject && (
				<button id="merge-pill" onClick={handleMergeToMain} title="Ask the agent to commit and merge into main" aria-label="Commit and merge changes into the main branch">
					<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
						<path d="M4.5 2.5v5a3 3 0 0 0 3 3H12" />
						<path d="M4.5 13.5v-1.5" />
						<circle cx="4.5" cy="2.5" r="1.4" />
						<circle cx="4.5" cy="13.5" r="1.4" />
					</svg>
					<span>merge</span>
				</button>
			)}
			{pendingReject ? (
					<button id="send-btn" class="reject-btn" onClick={handleSend} title="Reject (Enter)" aria-label="Reject with response">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</button>
				) : isAgentRunning ? (
					<button id="stop-btn" onClick={onStop} title="Stop generation" aria-label="Stop generation">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
							<rect x="1" y="1" width="12" height="12" rx="2" />
						</svg>
					</button>
				) : (
					<button id="send-btn" onClick={handleSend} title="Send (Enter)" aria-label="Send message">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
							<path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</button>
				)}
			</div>
			<div id="controls-row">
				<button
					type="button"
					class={`auto-allow-lock${autoAllowPermissions ? ' unlocked' : ' locked'}`}
					onClick={onToggleAutoAllowPermissions}
					title={autoAllowPermissions
						? 'Auto-approve permission requests is on'
						: 'Permission confirmations are on'}
				>
				{autoAllowPermissions ? (
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" stroke-width="2"/>
						<path d="M7 11V7a5 5 0 0 1 9.9-1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
					</svg>
				) : (
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
						<rect x="4" y="11" width="16" height="10" rx="2" stroke="currentColor" stroke-width="2"/>
						<path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
					</svg>
				)}
					<span class="auto-allow-lock-label">{autoAllowPermissions ? 'auto' : 'safe'}</span>
				</button>
				{modeSelector && (
					<ConfigDropdown
						selector={modeSelector}
						modeColorIndex={config?.modeColorIndex ?? {}}
						onSelect={onSelectConfigOption}
						disabled={!!isAgentRunning}
						accent={activeModeColor}
						variant="mode"
					/>
				)}
				{leftSelectors.map((sel) => (
					<ConfigDropdown
						key={sel.id}
						selector={sel}
						modeColorIndex={{}}
						onSelect={onSelectConfigOption}
						disabled={!!isAgentRunning}
						variant={sel.category === 'model' ? 'model' : 'plain'}
					/>
				))}
				{thoughtSelector && <div class="controls-spacer" />}
				{thoughtSelector && (
					<ConfigDropdown
						selector={thoughtSelector}
						modeColorIndex={{}}
						onSelect={onSelectConfigOption}
						disabled={!!isAgentRunning}
						variant="plain"
					/>
				)}
			</div>
		</div>
	);
}

function findActiveTrigger(text: string, cursorPos: number): ActivePicker | null {
	for (let i = cursorPos - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === '@' || ch === '/') {
			if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n' || text[i - 1] === '\t') {
				return { type: ch === '@' ? 'mention' : 'command', query: text.slice(i + 1, cursorPos), start: i };
			}
			return null;
		}
		if (ch === ' ' || ch === '\n' || ch === '\t') {
			return null;
		}
	}
	return null;
}

/**
 * Renders text with fuzzy-match hits highlighted (indices).
 * Adjacent hit/non-hit chars are grouped into a single span/mark for a smaller DOM.
 */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
	if (indices.length === 0) {
		return <>{text}</>;
	}
	const set = new Set(indices);
	const nodes: preact.JSX.Element[] = [];
	let buf = '';
	let bufHit = false;
	let key = 0;
	const flush = () => {
		if (!buf) { return; }
		if (bufHit) {
			nodes.push(<mark class="fuzzy-hit" key={key++}>{buf}</mark>);
		} else {
			nodes.push(<span key={key++}>{buf}</span>);
		}
		buf = '';
	};
	for (let i = 0; i < text.length; i++) {
		const hit = set.has(i);
		if (i === 0) {
			bufHit = hit;
		} else if (hit !== bufHit) {
			flush();
			bufHit = hit;
		}
		buf += text[i];
	}
	flush();
	return <>{nodes}</>;
}

/* ============================================================
   ConfigDropdown — a reusable selector (mode/model/thought)
   ============================================================ */

interface DropdownProps {
	selector: ConfigSelector;
	modeColorIndex: Record<string, number>;
	onSelect: (configId: string, value: string) => void;
	disabled: boolean;
	accent?: string | null;
	variant: 'mode' | 'plain' | 'model';
}

/** Parse a model value: "openai:gpt-4o" → { provider:"openai", name:"gpt-4o" }
 *  Separator — the first of : or / (by indexOf, not by priority). */
function parseModelValue(value: string): { provider: string | null; name: string } {
	const colonIdx = value.indexOf(':');
	const slashIdx = value.indexOf('/');
	let splitAt = -1;
	if (colonIdx > 0 && slashIdx > 0) splitAt = Math.min(colonIdx, slashIdx);
	else if (colonIdx > 0) splitAt = colonIdx;
	else if (slashIdx > 0) splitAt = slashIdx;
	if (splitAt > 0) return { provider: value.slice(0, splitAt), name: value.slice(splitAt + 1) };
	return { provider: null, name: value };
}

function ConfigDropdown({ selector, modeColorIndex, onSelect, disabled, accent, variant }: DropdownProps) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	const current = selector.options.find((o) => o.value === selector.currentValue);
	const rawLabel = current?.name ?? selector.currentValue;
	const { provider, name: modelName } = variant === 'model' ? parseModelValue(rawLabel) : { provider: null, name: rawLabel };

	useEffect(() => {
		if (!open) { return; }
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	}, [open]);

	const handleSelect = (value: string) => {
		onSelect(selector.id, value);
		setOpen(false);
	};

	const renderPickerItem = (opt: ConfigOption, dotOverride?: string | null) => {
		const isCurrent = opt.value === selector.currentValue;
		const dotColor = dotOverride ?? (variant === 'mode' ? modeColor(opt.value, modeColorIndex) : null);
		return (
			<button
				key={opt.value}
				class={`config-picker-item${isCurrent ? ' current' : ''}`}
				onClick={(e) => { e.stopPropagation(); handleSelect(opt.value); }}
				title={opt.description}
			>
				{variant === 'mode' && (
					<span
						class="config-picker-dot"
						style={{ background: dotColor ?? MODE_COLORS[0] }}
					/>
				)}
				<span class="config-picker-name">{opt.name}</span>
				{isCurrent && (
					<svg class="config-check" width="12" height="12" viewBox="0 0 12 12" fill="none">
						<path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				)}
			</button>
		);
	};

	const renderModelGrouped = () => {
		const groups = new Map<string, typeof selector.options>();
		for (const opt of selector.options) {
			const { provider } = parseModelValue(opt.value);
			const key = provider ?? '';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(opt);
		}
		const entries = Array.from(groups.entries());
		// Sort: named providers first (alphabetically), unnamed last
		entries.sort(([a], [b]) => {
			if (!a && !b) return 0;
			if (!a) return 1;
			if (!b) return -1;
			return a.localeCompare(b);
		});
		return (
			<>
				{entries.map(([provider, opts]) => (
					<Fragment key={provider || '(other)'}>
						{provider && <div class="config-picker-group">{provider}</div>}
						{opts.map((opt) => {
							const { name: trimmedName } = parseModelValue(opt.value);
							return renderPickerItem({ ...opt, name: trimmedName });
						})}
					</Fragment>
				))}
			</>
		);
	};

	const triggerStyle = variant === 'mode' && accent
		? { color: accent } as preact.JSX.CSSProperties
		: undefined;

	return (
		<div class={`config-selector variant-${variant}`} ref={ref}>
			<button
				class="config-trigger"
				disabled={disabled}
				style={triggerStyle}
				title={selector.label}
				onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen(!open); }}
			>
				{variant === 'mode' && (
					<span
						class="config-mode-dot"
						style={{ background: accent ?? MODE_COLORS[0] }}
					/>
				)}
				{variant === 'model' && provider ? (
					<>
						<span class="config-trigger-provider">{provider}</span>
						<span class="config-trigger-label">{modelName}</span>
					</>
				) : (
					<span class="config-trigger-label">{modelName}</span>
				)}
				<svg class="config-caret" width="10" height="10" viewBox="0 0 10 10" fill="none">
					<path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</button>
			{open && (
				<div class="config-picker">
					<div class="config-picker-title">{selector.label}</div>
					{variant === 'model'
						? renderModelGrouped()
						: selector.options.map((opt) => renderPickerItem(opt))
					}
				</div>
			)}
		</div>
	);
}
