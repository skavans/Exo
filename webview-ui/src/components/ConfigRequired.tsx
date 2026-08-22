import { vscode } from '../vscode';

interface Props {
	configPath: string | null;
}

export function ConfigRequired({ configPath }: Props) {
	const handleOpenConfig = () => {
		vscode.postMessage({ type: 'openConfig' });
	};

	return (
		<div class="onboarding-view">
			<div class="onboarding-card">
				<div class="onboarding-icon">
					<svg width="32" height="32" viewBox="0 0 16 16" fill="none">
						<path d="M4 2h8M4 2l2 6-2 6M12 2l-2 6 2 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</div>
				<div class="onboarding-title">No agent configured</div>
				<div class="onboarding-hint">
					Exo is a client — it needs an ACP agent to talk to.
					Add one to your config file:
				</div>
				{configPath && <code class="onboarding-path">{configPath}</code>}
				<button class="onboarding-btn" onClick={handleOpenConfig}>
					Open config.yml
				</button>
			</div>
		</div>
	);
}