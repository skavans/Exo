/**
 * Pure functions building UI selectors from ACP `configOptions`.
 *
 * Mode is taken from `configOptions` `category:'mode'` (modern ACP). The legacy
 * `modes` field (`session/set_mode`) is not supported. `model_config` is hidden (UX).
 * Grouped options are flattened into a flat list.
 */

import type {
	SessionConfigOption,
	SessionConfigOptionCategory,
	SessionConfigSelectOption,
	SessionConfigSelectOptions,
} from '@agentclientprotocol/sdk';

/** Selector wire format for the webview (one dropdown). */
export interface ConfigSelectorWire {
	id: string;
	label: string;
	category: string;
	currentValue: string;
	options: ConfigOptionWire[];
}

export interface ConfigOptionWire {
	value: string;
	name: string;
	description?: string;
}

export interface ConfigBuildResult {
	selectors: ConfigSelectorWire[];
	currentModeId: string | null;
}

function flatten(opts: SessionConfigSelectOptions | undefined): ConfigOptionWire[] {
	if (!opts || opts.length === 0) {
		return [];
	}
	// Grouped vs flat — detect by the presence of a `group` field on the first option.
	const first = opts[0] as { group?: unknown };
	if (first && typeof first.group === 'string') {
		const out: ConfigOptionWire[] = [];
		for (const g of opts as unknown as Array<{ options: SessionConfigSelectOption[] }>) {
			for (const o of g.options) {
				out.push(toWire(o));
			}
		}
		return out;
	}
	return (opts as SessionConfigSelectOption[]).map(toWire);
}

function toWire(o: SessionConfigSelectOption): ConfigOptionWire {
	return { value: o.value, name: o.name, description: o.description ?? undefined };
}

function firstSelectByCategory(
	opts: SessionConfigOption[] | null | undefined,
	category: SessionConfigOptionCategory,
): Extract<SessionConfigOption, { type: 'select' }> | undefined {
	if (!opts) {
		return undefined;
	}
	const found = opts.find((o) => o.category === category && o.type === 'select');
	return found as Extract<SessionConfigOption, { type: 'select' }> | undefined;
}

/** Build the UI selector list. Order: mode (always first, if present),
 *  then model, then thought_level — as they appear in configOptions.
 *  `clientSelection` (configId → value, client-owned) overrides the
 *  agent-reported `currentValue` per selector — agent pushes refresh the option
 *  lists but never flip a selection the client has committed. */
export function buildConfigSelectors(
	configOptions: SessionConfigOption[] | null | undefined,
	clientSelection?: Record<string, string> | null,
): ConfigBuildResult {
	const selectors: ConfigSelectorWire[] = [];
	let currentModeId: string | null = null;
	const selected = (id: string, currentValue: string): string =>
		clientSelection?.[id] ?? currentValue;

	// 1. Mode: configOptions category 'mode'.
	const modeOpt = firstSelectByCategory(configOptions, 'mode');
	if (modeOpt) {
		currentModeId = selected(modeOpt.id, modeOpt.currentValue);
		selectors.push({
			id: modeOpt.id,
			label: modeOpt.name,
			category: 'mode',
			currentValue: currentModeId,
			options: flatten(modeOpt.options),
		});
	}

	// 2. Model, thought_level — first select per category (order as in configOptions).
	for (const category of ['model', 'thought_level'] as const) {
		const o = firstSelectByCategory(configOptions, category);
		if (o) {
			selectors.push({
				id: o.id,
				label: o.name,
				category,
				currentValue: selected(o.id, o.currentValue),
				options: flatten(o.options),
			});
		}
	}

	return { selectors, currentModeId };
}
