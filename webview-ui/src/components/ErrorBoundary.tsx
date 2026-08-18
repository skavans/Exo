import { Component } from 'preact';
import type { ComponentChildren } from 'preact';

interface Props {
	children: ComponentChildren;
	fallback?: (error: Error, reset: () => void) => ComponentChildren;
}

interface State {
	error: Error | null;
}

/**
 * Preact error boundary. Catches render errors in its subtree so a single
 * malformed message / chunk can't white-screen the whole chat. `componentDidCatch`
 * + setState is the Preact-compatible way to surface fallback UI
 * (getDerivedStateFromError is not reliably supported).
 */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	componentDidCatch(error: Error, info: unknown) {
		console.error('[Exo] render error caught:', error, info);
		this.setState({ error });
	}

	reset = () => {
		this.setState({ error: null });
	};

	render() {
		if (this.state.error) {
			if (this.props.fallback) {
				return this.props.fallback(this.state.error, this.reset);
			}
			return (
				<div class="render-error">
					<div class="render-error-text">Something went wrong rendering this content.</div>
					<button class="render-error-retry" onClick={this.reset}>Retry</button>
				</div>
			);
		}
		return this.props.children;
	}
}
