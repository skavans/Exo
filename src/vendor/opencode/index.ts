/**
 * Vendor-specific accommodations for agents whose behavior deviates from the
 * standard ACP spec. Each submodule is a self-contained fallback (never a
 * competitor to the spec'd surface).
 */
export { extractPlanFromToolArgs } from './plan';
export { isOpenCodeEditArgs, restoreOpenCodeEditSpec } from './diff';