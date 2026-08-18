import * as esbuild from 'esbuild';
import * as fs from 'fs';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const exoVersion = pkg.version;

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
 	entryPoints: ['src/extension.ts'],
 	bundle: true,
 	outfile: 'out/extension.js',
 	external: ['vscode'],
 	format: 'cjs',
 	platform: 'node',
 	target: 'es2022',
 	sourcemap: !isProduction,
 	minify: isProduction,
 	define: {
 		EXO_VERSION: JSON.stringify(exoVersion),
 	},
 };

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
	entryPoints: ['webview-ui/src/main.tsx'],
	bundle: true,
	outfile: 'out/webview.js',
	format: 'esm',
	platform: 'browser',
	target: 'es2020',
	sourcemap: !isProduction,
	minify: isProduction,
	jsx: 'automatic',
	jsxImportSource: 'preact',
	loader: {
		'.ttf': 'dataurl',
		'.woff': 'dataurl',
		'.woff2': 'dataurl',
	},
};

async function build() {
	if (isWatch) {
		const [extCtx, webCtx] = await Promise.all([
			esbuild.context(extensionConfig),
			esbuild.context(webviewConfig),
		]);
		await Promise.all([extCtx.watch(), webCtx.watch()]);
		console.log('[esbuild] watching...');
	} else {
		await Promise.all([
			esbuild.build(extensionConfig),
			esbuild.build(webviewConfig),
		]);
		console.log('[esbuild] build complete');
	}
}

build().catch((e) => {
	console.error(e);
	process.exit(1);
});
