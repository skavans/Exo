import * as vscode from 'vscode';
import * as fs from 'fs';
import { getConfigPath, loadConfig, type ExoConfig } from './config';

export type ConfigChangeListener = (config: ExoConfig) => void;

/** Watches `config.yml` for changes, notifies subscribers, shows a toast. */
export class ConfigWatcher implements vscode.Disposable {
	private watcher: fs.FSWatcher | null = null;
	private listeners: ConfigChangeListener[] = [];
	private currentConfig: ExoConfig;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		this.currentConfig = loadConfig();
		this.startWatching();
	}

	get config(): ExoConfig {
		return this.currentConfig;
	}

	onConfigChange(listener: ConfigChangeListener): void {
		this.listeners.push(listener);
	}

	private startWatching(): void {
		const configPath = getConfigPath();

		// fs.watch is OS-level — it needs an existing file.
		// If the file is missing we retry on the next reload attempt.
		try {
			this.watcher = fs.watch(configPath, (eventType) => {
				if (eventType === 'change' || eventType === 'rename') {
					this.scheduleReload();
				}
			});
		} catch {
			// File doesn't exist yet — that's fine, watch starts on first openConfig.
		}
	}

	private scheduleReload(): void {
		// Debounce: a save writes the file multiple times in quick succession.
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.reload();
		}, 300);
	}

	private reload(): void {
		try {
			this.currentConfig = loadConfig();
			vscode.window.showInformationMessage('Exo: Configuration updated');
			for (const listener of this.listeners) {
				listener(this.currentConfig);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Exo: Failed to load config — ${message}`);
		}
	}

	restartWatching(): void {
		this.stopWatching();
		this.startWatching();
	}

	private stopWatching(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	dispose(): void {
		this.stopWatching();
		this.listeners = [];
	}
}