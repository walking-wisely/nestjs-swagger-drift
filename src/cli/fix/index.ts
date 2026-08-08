export type { FixEntry, FixPlan, FixSkipped } from './plan.js';
export { buildFixPlan, groupEntriesByFile } from './plan.js';

export type { FileFixResult } from './apply.js';
export { applyFixesToFile } from './apply.js';

export { formatFileDiff } from './format-diff.js';
