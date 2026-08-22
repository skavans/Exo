import { vscode } from '../vscode';

/**
 * Blocking onboarding screen: the window is a single-folder git project that
 * must be reopened as the managed Exo workspace before sessions can be used
 * (prerequisite for reload-free Explorer-follow). No dismiss — the only action
 * is "Switch", which reloads the window once into the managed workspace.
 */
export function WorkspaceModeRequired() {
	const handleEnter = () => {
		vscode.postMessage({ type: 'enterWorkspaceMode' });
	};

	return (
		<div class="onboarding-view">
			<div class="onboarding-card">
				<div class="onboarding-icon">
					<svg width="32" height="32" viewBox="0 0 16 16" fill="none">
						<path d="M2 6l6-4 6 4v8H2V6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
						<path d="M5.5 14v-4.5h5V14" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
					</svg>
				</div>
				<div class="onboarding-title">Open as Exo workspace</div>
				<div class="onboarding-hint">
					To keep the Explorer in sync with the active session, Exo needs
					to open this project as a workspace (.code-workspace). Your
					window will reload once — afterwards, switching sessions
					switches the Explorer folder without reloading.
				</div>
				<button class="onboarding-btn" onClick={handleEnter}>
					Switch to Exo workspace
				</button>
			</div>
		</div>
	);
}
