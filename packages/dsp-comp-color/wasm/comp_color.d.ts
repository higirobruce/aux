/* tslint:disable */
/* eslint-disable */

export class CompColor {
    free(): void;
    [Symbol.dispose](): void;
    gain_reduction_db(): number;
    constructor(sample_rate: number);
    /**
     * Mono in place — sidechain is the input itself (no L/R sum).
     */
    process_mono(buffer: Float32Array): void;
    /**
     * Stereo in place. L + R must be the same length.
     */
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * Set all params at once. Cheap; safe per pointer-drag.
     */
    set_params(threshold_db: number, ratio: number, attack_ms: number, release_ms: number, makeup_db: number, mix: number, drive_db: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_compcolor_free: (a: number, b: number) => void;
    readonly compcolor_gain_reduction_db: (a: number) => number;
    readonly compcolor_new: (a: number) => number;
    readonly compcolor_process_mono: (a: number, b: number, c: number, d: number) => void;
    readonly compcolor_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly compcolor_reset: (a: number) => void;
    readonly compcolor_set_bypassed: (a: number, b: number) => void;
    readonly compcolor_set_params: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
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
