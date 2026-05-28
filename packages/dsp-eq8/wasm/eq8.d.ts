/* tslint:disable */
/* eslint-disable */

export enum BandType {
    Bypass = 0,
    HighPass = 1,
    LowShelf = 2,
    Peak = 3,
    HighShelf = 4,
    LowPass = 5,
}

/**
 * Eight-band parametric EQ instance. Stateful — one instance per channel
 * strip on the host side; this struct handles stereo internally.
 */
export class Eq8 {
    free(): void;
    [Symbol.dispose](): void;
    constructor(sample_rate: number);
    /**
     * Process N samples of one channel in place. `channel` is 0 (left) or 1
     * (right); any other value is taken mod 2.
     */
    process(buffer: Float32Array, channel: number): void;
    /**
     * Clear filter state — for example after a seek. Coefficients are kept.
     */
    reset(): void;
    /**
     * Configure one band. Index out of range is silently ignored.
     * Frequencies are clamped to (0, Nyquist).
     */
    set_band(idx: number, band_type: BandType, freq: number, gain_db: number, q: number): void;
    set_bypassed(bypassed: boolean): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_eq8_free: (a: number, b: number) => void;
    readonly eq8_new: (a: number) => number;
    readonly eq8_process: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly eq8_reset: (a: number) => void;
    readonly eq8_set_band: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly eq8_set_bypassed: (a: number, b: number) => void;
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
