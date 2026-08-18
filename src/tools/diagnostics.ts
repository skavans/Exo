/** Collects VS Code language-server diagnostics (Problems) after an edit,
 *  so the agent can see errors right away. */
import * as vscode from 'vscode';
import * as path from 'path';

export interface DiagnosticsResult {
	/** Whether any error/warning was found */
	hasIssues: boolean;
	/** Formatted diagnostics text, appended to the tool result */
	text: string;
}

/** Waits for the language server to process the edit, then collects diagnostics.
 *  Event-driven: resolves on the first `onDidChangeDiagnostics` for the target file,
 *  with a 500ms timeout fallback.
 *
 *  @param filePath — path relative to the workspace root
 *  @param workspaceRoot — absolute workspace root path
 */
export async function collectDiagnostics(
	filePath: string,
	workspaceRoot: string,
): Promise<DiagnosticsResult> {
	const absolutePath = path.resolve(workspaceRoot, filePath);
	const uri = vscode.Uri.file(absolutePath);

	// Wait for fresh diagnostics after the edit
	await new Promise<void>((resolve) => {
		let resolved = false;
		const done = () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			}
		};

		const timeout = setTimeout(done, 500);

		const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
			const match = e.uris.some((u) => u.toString() === uri.toString());
			if (match) {
				done();
			}
		});
	});

	const diagnostics = vscode.languages.getDiagnostics(uri);
	return formatDiagnostics(diagnostics);
}

function formatDiagnostics(diagnostics: vscode.Diagnostic[]): DiagnosticsResult {
	if (!diagnostics || diagnostics.length === 0) {
		return { hasIssues: false, text: '' };
	}

	// Group by severity
	const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
	const warnings = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning);
	const others = diagnostics.filter(
		(d) => d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning,
	);

	const lines: string[] = [];
	lines.push(`\n--- VS Code Problems (${diagnostics.length}) ---`);

	if (errors.length > 0) {
		lines.push(`Errors (${errors.length}):`);
		for (const d of errors) {
			const line = d.range.start.line + 1;
			const msg = d.message.replace(/\n/g, ' ');
			lines.push(`  L${line}: ${msg}`);
	}
	}

	if (warnings.length > 0) {
		lines.push(`Warnings (${warnings.length}):`);
		for (const d of warnings) {
			const line = d.range.start.line + 1;
			const msg = d.message.replace(/\n/g, ' ');
			lines.push(`  L${line}: ${msg}`);
	}
	}

	if (others.length > 0) {
		lines.push(`Other (${others.length}):`);
		for (const d of others) {
			const line = d.range.start.line + 1;
			const msg = d.message.replace(/\n/g, ' ');
			lines.push(`  L${line}: ${msg}`);
	}
	}

	lines.push('--- End Problems ---');

	return { hasIssues: true, text: lines.join('\n') };
}
