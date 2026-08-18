import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

/**
 * ACP agent configuration. The agent runs as a subprocess speaking over stdin/stdout.
 */
export interface AgentConfig {
	/** Unique identifier for this agent entry */
	id: string;
	/** Transport type — 'stdio' for local subprocess */
	type: 'stdio';
	/** Command to execute (e.g. "node", "npx") */
	command: string;
	/** Arguments to pass to the command */
	args?: string[];
	/** Environment variables for the subprocess */
	env?: Record<string, string>;
}

/** Root Exo configuration: list of ACP agents. */
export interface ExoConfig {
	agents?: AgentConfig[];
	[key: string]: unknown;
}

const CONFIG_DIR_NAME = 'exo';
const CONFIG_FILE_NAME = 'config.yml';

const DEFAULT_CONFIG_COMMENT = `# Exo configuration
# Configure ACP agents here.
# Example:
#
# agents:
#   - id: claude
#     type: stdio
#     command: npx
#     args: ["-y", "@anthropic/claude-code-acp"]
`;

/** Config directory. Honors `$XDG_CONFIG_HOME`, defaults to `~/.config/exo`. */
export function getConfigDir(): string {
	const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
	const base = xdgConfigHome || path.join(os.homedir(), '.config');
	return path.join(base, CONFIG_DIR_NAME);
}

/** Full path to `config.yml`. */
export function getConfigPath(): string {
	return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

/** Empty default — the user configures agents themselves. */
export function getDefaultConfig(): ExoConfig {
	return {};
}

function ensureConfigDir(): void {
	const dir = getConfigDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Load config from YAML. Missing file → default; parse error → thrown. */
export function loadConfig(): ExoConfig {
	const configPath = getConfigPath();

	if (!fs.existsSync(configPath)) {
		return getDefaultConfig();
	}

	const raw = fs.readFileSync(configPath, 'utf-8');
	const parsed = yaml.load(raw);

	if (parsed === null || parsed === undefined) {
		return getDefaultConfig();
	}

	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Invalid config format in ${configPath}: expected an object`);
	}

	return parsed as ExoConfig;
}

/** Ensure `config.yml` exists, creating it with default content if missing. */
export function ensureConfigFile(): void {
	const configPath = getConfigPath();
	if (!fs.existsSync(configPath)) {
		ensureConfigDir();
		fs.writeFileSync(configPath, DEFAULT_CONFIG_COMMENT, 'utf-8');
	}
}