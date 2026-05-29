/* tslint:disable */
/* eslint-disable */

export class MbComp {
    free(): void;
    [Symbol.dispose](): void;
    gain_reduction_db(): number;
    constructor(sample_rate: number);
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * Per-band threshold in dB (each -40..0) and shared ratio (1..10).
     */
    set_params(lo_thresh_db: number, mid_thresh_db: number, hi_thresh_db: number, ratio: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mbcomp_free: (a: number, b: number) => void;
    readonly mbcomp_gain_reduction_db: (a: number) => number;
    readonly mbcomp_new: (a: number) => number;
    readonly mbcomp_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly mbcomp_reset: (a: number) => void;
    readonly mbcomp_set_bypassed: (a: number, b: number) => void;
    readonly mbcomp_set_params: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
