/* tslint:disable */
/* eslint-disable */

export class Pitch {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Last detected fundamental in Hz (0 = unvoiced/silent). Lets the UI
     * draw the real pitch instead of a synthetic trace.
     */
    detected_hz(): number;
    /**
     * Constant group delay (samples) the engaged shifter imposes. The host
     * compensates other channels by this much. Zero when bypassed.
     */
    latency_samples(): number;
    constructor(sample_rate: number);
    process_mono(buffer: Float32Array): void;
    process_stereo(left: Float32Array, right: Float32Array): void;
    reset(): void;
    set_bypassed(bypassed: boolean): void;
    /**
     * key_root 0..11, scale_id 0..3, speed/amount/humanize 0..100.
     */
    set_params(key_root: number, scale_id: number, speed: number, amount: number, humanize: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pitch_free: (a: number, b: number) => void;
    readonly pitch_detected_hz: (a: number) => number;
    readonly pitch_latency_samples: (a: number) => number;
    readonly pitch_new: (a: number) => number;
    readonly pitch_process_mono: (a: number, b: number, c: number, d: number) => void;
    readonly pitch_process_stereo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly pitch_reset: (a: number) => void;
    readonly pitch_set_bypassed: (a: number, b: number) => void;
    readonly pitch_set_params: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
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
