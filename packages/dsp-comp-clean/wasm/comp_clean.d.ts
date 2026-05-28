/* tslint:disable */
/* eslint-disable */

export class CompClean {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Most recent gain reduction in dB (>= 0). Read by the host for meter
     * display; updates every block. Reset() clears.
     */
    gain_reduction_db(): number;
    constructor(sample_rate: number);
    /**
     * Mono convenience — peak detection on a single channel.
     */
    process_mono(buffer: Float32Array): void;
    /**
     * Process one block, stereo, in place. L and R MUST be the same length.
     * Mono callers can pass the same buffer for both args — peak detection
     * becomes a single-channel max which is correct for mono.
     */
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * Set all params at once. Validates + clamps. Cheap; safe to call per
     * pointer-drag.
     */
    set_params(threshold_db: number, ratio: number, attack_ms: number, release_ms: number, makeup_db: number, mix: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_compclean_free: (a: number, b: number) => void;
    readonly compclean_gain_reduction_db: (a: number) => number;
    readonly compclean_new: (a: number) => number;
    readonly compclean_process_mono: (a: number, b: number, c: number, d: number) => void;
    readonly compclean_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly compclean_reset: (a: number) => void;
    readonly compclean_set_bypassed: (a: number, b: number) => void;
    readonly compclean_set_params: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
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
