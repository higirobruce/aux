/* tslint:disable */
/* eslint-disable */

export class Meter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Integrated (gated) loudness in LUFS since the last reset.
     */
    integrated_lufs(): number;
    /**
     * Momentary loudness (400 ms) in LUFS.
     */
    momentary_lufs(): number;
    constructor(sample_rate: number);
    /**
     * Count of oversampled samples over 0 dBTP since reset.
     */
    overs(): number;
    /**
     * Reads L/R; never writes. Accumulates loudness + true-peak state.
     */
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * Short-term loudness (3 s) in LUFS.
     */
    short_lufs(): number;
    /**
     * Maximum true-peak since reset, in dBTP.
     */
    true_peak_db(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_meter_free: (a: number, b: number) => void;
    readonly meter_integrated_lufs: (a: number) => number;
    readonly meter_momentary_lufs: (a: number) => number;
    readonly meter_new: (a: number) => number;
    readonly meter_overs: (a: number) => number;
    readonly meter_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly meter_reset: (a: number) => void;
    readonly meter_set_bypassed: (a: number, b: number) => void;
    readonly meter_short_lufs: (a: number) => number;
    readonly meter_true_peak_db: (a: number) => number;
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
