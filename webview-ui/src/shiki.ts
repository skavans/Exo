/* ============================================================
   Shiki — TextMate-based syntax highlighting that follows the
   active VS Code theme. Replaces highlight.js (which was mapped
   to the impoverished --vscode-symbolIcon-* palette and rendered
   only ~2 colors). Shiki uses the same TextMate grammars + theme
   token colors as the VS Code editor, giving rich, accurate
   highlighting.

   The highlighter is created synchronously at module load via
   createHighlighterCoreSync + the pure-JS regex engine (no
   oniguruma .wasm, no esbuild loader changes). codeToHtml() on
   the instance is synchronous, so it slots directly into the
   synchronous marked.parse pipeline without async gating.

   Theme tracking (Tier 1): the host pushes the active VS Code
   color-theme name via updateColorTheme; the webview reads the
   theme kind from body[data-vscode-theme-kind] (maintained by
   VS Code). The name+kind resolve to a bundled Shiki theme id
   via THEME_NAME_MAP. When the VS Code theme has a bundled
   twin (e.g. Default Dark+ → dark-plus), highlighting is 1:1
   with the editor. Otherwise we fall back by kind to
   dark-plus/light-plus.
   ============================================================ */

import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import { escapeHtml, escapeAttr } from './escape';

import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';
import oneDarkPro from '@shikijs/themes/one-dark-pro';
import dracula from '@shikijs/themes/dracula';
import nord from '@shikijs/themes/nord';
import monokai from '@shikijs/themes/monokai';
import materialTheme from '@shikijs/themes/material-theme';
import materialThemePalenight from '@shikijs/themes/material-theme-palenight';
import solarizedDark from '@shikijs/themes/solarized-dark';
import solarizedLight from '@shikijs/themes/solarized-light';
import tokyoNight from '@shikijs/themes/tokyo-night';
import ayuDark from '@shikijs/themes/ayu-dark';
import ayuLight from '@shikijs/themes/ayu-light';
import rosePine from '@shikijs/themes/rose-pine';
import rosePineDawn from '@shikijs/themes/rose-pine-dawn';
import catppuccinMocha from '@shikijs/themes/catppuccin-mocha';
import catppuccinLatte from '@shikijs/themes/catppuccin-latte';
import gruvboxDarkMedium from '@shikijs/themes/gruvbox-dark-medium';
import gruvboxLightMedium from '@shikijs/themes/gruvbox-light-medium';
import vitesseDark from '@shikijs/themes/vitesse-dark';
import vitesseLight from '@shikijs/themes/vitesse-light';

import bash from '@shikijs/langs/bash';
import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import csharp from '@shikijs/langs/csharp';
import css from '@shikijs/langs/css';
import diff from '@shikijs/langs/diff';
import dockerfile from '@shikijs/langs/dockerfile';
import go from '@shikijs/langs/go';
import html from '@shikijs/langs/html';
import ini from '@shikijs/langs/ini';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsonc from '@shikijs/langs/jsonc';
import jsx from '@shikijs/langs/jsx';
import less from '@shikijs/langs/less';
import markdown from '@shikijs/langs/markdown';
import php from '@shikijs/langs/php';
import python from '@shikijs/langs/python';
import ruby from '@shikijs/langs/ruby';
import rust from '@shikijs/langs/rust';
import scss from '@shikijs/langs/scss';
import shellsession from '@shikijs/langs/shellsession';
import sql from '@shikijs/langs/sql';
import svelte from '@shikijs/langs/svelte';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import vue from '@shikijs/langs/vue';
import xml from '@shikijs/langs/xml';
import yaml from '@shikijs/langs/yaml';

export type ThemeKind = 'dark' | 'light';

const ALL_THEMES = {
	'dark-plus': darkPlus,
	'light-plus': lightPlus,
	'github-dark': githubDark,
	'github-light': githubLight,
	'one-dark-pro': oneDarkPro,
	'dracula': dracula,
	'nord': nord,
	'monokai': monokai,
	'material-theme': materialTheme,
	'material-theme-palenight': materialThemePalenight,
	'solarized-dark': solarizedDark,
	'solarized-light': solarizedLight,
	'tokyo-night': tokyoNight,
	'ayu-dark': ayuDark,
	'ayu-light': ayuLight,
	'rose-pine': rosePine,
	'rose-pine-dawn': rosePineDawn,
	'catppuccin-mocha': catppuccinMocha,
	'catppuccin-latte': catppuccinLatte,
	'gruvbox-dark-medium': gruvboxDarkMedium,
	'gruvbox-light-medium': gruvboxLightMedium,
	'vitesse-dark': vitesseDark,
	'vitesse-light': vitesseLight,
};

const ALL_LANGS = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	html,
	ini,
	java,
	javascript,
	json,
	jsonc,
	jsx,
	less,
	markdown,
	php,
	python,
	ruby,
	rust,
	scss,
	shellsession,
	sql,
	svelte,
	tsx,
	typescript,
	vue,
	xml,
	yaml,
};

const highlighter = createHighlighterCoreSync({
	themes: Object.values(ALL_THEMES),
	langs: Object.values(ALL_LANGS),
	engine: createJavaScriptRegexEngine(),
});

const loadedLangs = new Set(Object.keys(ALL_LANGS));

const THEME_NAME_MAP: Record<string, string> = {
	'Default Dark+': 'dark-plus',
	'Default Light+': 'light-plus',
	'Dark+ (default dark)': 'dark-plus',
	'Light+ (default light)': 'light-plus',
	'Dark (Visual Studio)': 'dark-plus',
	'Light (Visual Studio)': 'light-plus',
	'GitHub Dark': 'github-dark',
	'GitHub Light': 'github-light',
	'GitHub Dark Default': 'github-dark',
	'GitHub Light Default': 'github-light',
	'One Dark Pro': 'one-dark-pro',
	'Dracula': 'dracula',
	'Nord': 'nord',
	'Monokai': 'monokai',
	'Monokai Pro': 'monokai',
	'Material Theme': 'material-theme',
	'Material Theme Palenight': 'material-theme-palenight',
	'Material-theme': 'material-theme',
	'Solarized Dark': 'solarized-dark',
	'Solarized Light': 'solarized-light',
	'Tokyo Night': 'tokyo-night',
	'Ayu Dark': 'ayu-dark',
	'Ayu Light': 'ayu-light',
	'Rose Pine': 'rose-pine',
	'Rosé Pine': 'rose-pine',
	'Rose Pine Dawn': 'rose-pine-dawn',
	'Rosé Pine Dawn': 'rose-pine-dawn',
	'Catppuccin Mocha': 'catppuccin-mocha',
	'Catppuccin Latte': 'catppuccin-latte',
	'Gruvbox Dark Medium': 'gruvbox-dark-medium',
	'Gruvbox Light Medium': 'gruvbox-light-medium',
	'Gruvbox': 'gruvbox-dark-medium',
	'Vitesse Dark': 'vitesse-dark',
	'Vitesse Light': 'vitesse-light',
};

const LANG_ALIASES: Record<string, string> = {
	js: 'javascript',
	jsx: 'jsx',
	ts: 'typescript',
	tsx: 'tsx',
	py: 'python',
	rb: 'ruby',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	fish: 'bash',
	yml: 'yaml',
	'c++': 'cpp',
	'h++': 'cpp',
	cc: 'cpp',
	cxx: 'cpp',
	cs: 'csharp',
	fs: 'fsharp',
	htaccess: 'ini',
	ini: 'ini',
	conf: 'ini',
	properties: 'ini',
	dockerfile: 'dockerfile',
	docker: 'dockerfile',
	'sh-session': 'shellsession',
	console: 'shellsession',
	text: 'plaintext',
	plaintext: 'plaintext',
	txt: 'plaintext',
};

const FALLBACK_BY_KIND: Record<ThemeKind, string> = {
	dark: 'dark-plus',
	light: 'light-plus',
};

let currentThemeId = 'dark-plus';
let themeVersion = 0;

function normalizeThemeName(name: string): string {
	return name.trim();
}

export function resolveThemeId(name: string | null, kind: ThemeKind): string {
	let resolved = FALLBACK_BY_KIND[kind];
	if (name) {
		const norm = normalizeThemeName(name);
		if (THEME_NAME_MAP[norm]) {
			resolved = THEME_NAME_MAP[norm];
		} else {
			const lower = norm.toLowerCase();
			const direct = Object.keys(ALL_THEMES).find((id) => lower === id || lower === id.replace(/-/g, ' '));
			if (direct) {
				resolved = direct;
			} else {
				for (const [vsName, id] of Object.entries(THEME_NAME_MAP)) {
					if (vsName.toLowerCase() === lower) { resolved = id; break; }
				}
			}
		}
	}
	return resolved;
}

export function setTheme(id: string): void {
	currentThemeId = id;
	themeVersion++;
}

export function getThemeVersion(): number {
	return themeVersion;
}

export function highlightCode(code: string, lang: string | undefined): string {
	let resolvedLang = lang ? (lang.toLowerCase().trim() || '') : '';
	if (LANG_ALIASES[resolvedLang]) resolvedLang = LANG_ALIASES[resolvedLang];
	if (!resolvedLang || (!loadedLangs.has(resolvedLang) && resolvedLang !== 'plaintext')) {
		return `<pre data-lang="${escapeAttr(resolvedLang || 'text')}"><code>${escapeHtml(code)}</code></pre>`;
	}
	try {
		const html = highlighter.codeToHtml(code, { lang: resolvedLang, theme: currentThemeId });
		return html.replace(/<pre /, `<pre data-lang="${escapeAttr(resolvedLang)}" `);
	} catch {
		return `<pre data-lang="${escapeAttr(resolvedLang)}"><code>${escapeHtml(code)}</code></pre>`;
	}
}