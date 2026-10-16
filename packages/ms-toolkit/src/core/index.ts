import { wrap, type Remote } from 'comlink';
import type { MsApi } from './wasm.ts';

export type { AtomCount, FormulaResult, IonResult, MassSplitResult } from './types.ts';
export type { MsApi } from './wasm.ts';
export {
  formatAtomHtml,
  formatFormulaHtml,
  formatIsotopeLabelHtml,
  renormalizeIntensities,
} from './utils.ts';

let client: Remote<MsApi> | undefined;

/** Returns a shared client that runs the wasm calculator in a web worker. */
export function getClient(): Remote<MsApi> {
  client ??= wrap<MsApi>(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  return client;
}
