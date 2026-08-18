import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { ensureConfigFile, getConfigPath } from './config';
import { ConfigWatcher } from './configWatcher';

export function activate(context: vscode.ExtensionContext) {
	// Ensure config file exists
	ensureConfigFile();

	// Create watcher for config (tracks changes, shows toast)
	const configWatcher = new ConfigWatcher();
	context.subscriptions.push(configWatcher);

	const chatProvider = new ChatViewProvider(
		context.extensionUri,
		configWatcher,
		context.globalState,
		context.workspaceState,
	);
	chatProvider.register(context);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveColorTheme(() => {
			chatProvider.sendColorTheme();
		}),
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ChatViewProvider.viewType,
			chatProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exo.openChat', () => {
			vscode.commands.executeCommand('exo.chatView.focus');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exo.newSession', () => {
			chatProvider.handleNewSessionCommand();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exo.openConfig', async () => {
			const configPath = getConfigPath();
			ensureConfigFile();
			// Restart watcher — file may have just been created
			configWatcher.restartWatching();
		const doc = await vscode.workspace.openTextDocument(configPath);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active });
		}),
	);

}

export function deactivate() {}
