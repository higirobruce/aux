/* tslint:disable */
/* eslint-disable */

export class Limiter {
    free(): void;
    [Symbol.dispose](): void;
    gain_reduction_db(): number;
    /**
     * Look-ahead samples — useful for the host to report PDC.
     */
    latency_samples(): number;
    constructor(sample_rate: number);
    /**
     * Mono in place — same delay buffer used for both reads/writes via L.
     */
    process_mono(buffer: Float32Array): void;
    /**
     * Process stereo in place. L and R must be the same length.
     */
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * Set all three user-facing params at once.
     * - threshold_db: −24..0 dBFS (the peak ceiling).
     * - release_ms:   ≥ 10 ms.
     * - makeup_db:    −12..+24 dB (pre-limit gain).
     */
    set_params(threshold_db: number, release_ms: number, makeup_db: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_limiter_free: (a: number, b: number) => void;
    readonly limiter_gain_reduction_db: (a: number) => number;
    readonly limiter_latency_samples: (a: number) => number;
    readonly limiter_new: (a: number) => number;
    readonly limiter_process_mono: (a: number, b: number, c: number, d: number) => void;
    readonly limiter_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly limiter_reset: (a: number) => void;
    readonly limiter_set_bypassed: (a: number, b: number) => void;
    readonly limiter_set_params: (a: number, b: number, c: number, d: number) => void;
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
