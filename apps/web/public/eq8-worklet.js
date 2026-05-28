/**
 * aux EQ-8 worklet — one AudioWorkletNode per channel strip, each running
 * an 8-band parametric EQ from @aux/dsp-eq8 (Rust → WASM).
 *
 * Loaded via AudioContext.audioWorklet.addModule('/eq8-worklet.js').
 *
 * The wasm-bindgen-generated bindings (eq8.js) are inlined below — original
 * uses ES `export`/`import`, but AudioWorkletGlobalScope's static-import
 * support is uneven across browsers, so we ship a single self-contained
 * file. Regenerate with `pnpm --filter @aux/dsp-eq8 build` and copy the
 * eq8.js body in over the inlined section. Keep eq8_bg.wasm next to this
 * file so the host can fetch it.
 *
 * The host passes WASM bytes through processorOptions at construction time;
 * the processor calls initSync() so its DSP is ready by the first process()
 * call. No async-not-ready window.
 *
 * Message protocol (main → worklet):
 *   { type: 'set-band', idx, bandType, freq, gainDb, q }
 *   { type: 'set-bypassed', bypassed }
 *   { type: 'reset' }
 *
 * Keep this in sync with packages/audio-engine/src/eq8-worklet.ts (the typed
 * reference). Plain JS until the worklet build pipeline lands.
 */

// ──────────────────────────────────────────────────────────────────────────
// TextDecoder polyfill.
//
// AudioWorkletGlobalScope does NOT inherit from WorkerGlobalScope, so the
// usual `TextDecoder` constructor isn't defined here. wasm-bindgen's
// generated helpers construct one at module evaluation time; without this
// shim the file throws ReferenceError before the processor is registered.
//
// Coverage: enough UTF-8 to round-trip the error strings wasm-bindgen
// produces. No streaming, no encoding sniffing — just bytes → string.
// ──────────────────────────────────────────────────────────────────────────

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor() {
      /* options ignored — we only support utf-8, ignoreBOM, fatal */
    }
    decode(buf) {
      if (!buf || buf.byteLength === 0) return '';
      const bytes =
        buf instanceof Uint8Array
          ? buf
          : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
      let s = '';
      let i = 0;
      while (i < bytes.length) {
        const b1 = bytes[i++];
        if (b1 < 0x80) {
          s += String.fromCharCode(b1);
          continue;
        }
        if (b1 < 0xc0) continue; // stray continuation byte
        if (b1 < 0xe0) {
          const b2 = bytes[i++] & 0x3f;
          s += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
          continue;
        }
        if (b1 < 0xf0) {
          const b2 = bytes[i++] & 0x3f;
          const b3 = bytes[i++] & 0x3f;
          s += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
          continue;
        }
        const b2 = bytes[i++] & 0x3f;
        const b3 = bytes[i++] & 0x3f;
        const b4 = bytes[i++] & 0x3f;
        const cp = (((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4) - 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10));
        s += String.fromCharCode(0xdc00 + (cp & 0x3ff));
      }
      return s;
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined from packages/dsp-eq8/wasm/eq8.js — wasm-bindgen 0.2.122 output.
// `export` keywords stripped; ES default-export line removed. Everything
// else is verbatim. DO NOT EDIT BY HAND — re-bundle from wasm/eq8.js.
// ──────────────────────────────────────────────────────────────────────────

/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5}
 */
const BandType = Object.freeze({
    Bypass: 0, "0": "Bypass",
    HighPass: 1, "1": "HighPass",
    LowShelf: 2, "2": "LowShelf",
    Peak: 3, "3": "Peak",
    HighShelf: 4, "4": "HighShelf",
    LowPass: 5, "5": "LowPass",
});

class Eq8 {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Eq8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_eq8_free(ptr, 0);
    }
    /**
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.eq8_new(sample_rate);
        this.__wbg_ptr = ret;
        Eq8Finalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Float32Array} buffer
     * @param {number} channel
     */
    process(buffer, channel) {
        var ptr0 = passArrayF32ToWasm0(buffer, wasm.__wbindgen_export);
        var len0 = WASM_VECTOR_LEN;
        wasm.eq8_process(this.__wbg_ptr, ptr0, len0, addHeapObject(buffer), channel);
    }
    reset() {
        wasm.eq8_reset(this.__wbg_ptr);
    }
    /**
     * @param {number} idx
     * @param {BandType} band_type
     * @param {number} freq
     * @param {number} gain_db
     * @param {number} q
     */
    set_band(idx, band_type, freq, gain_db, q) {
        wasm.eq8_set_band(this.__wbg_ptr, idx, band_type, freq, gain_db, q);
    }
    /**
     * @param {boolean} bypassed
     */
    set_bypassed(bypassed) {
        wasm.eq8_set_bypassed(this.__wbg_ptr, bypassed);
    }
}
if (Symbol.dispose) Eq8.prototype[Symbol.dispose] = Eq8.prototype.free;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_7a3f7b938f93cf12: function(arg0, arg1, arg2) {
            new Uint8Array(getObject(arg2).buffer, getObject(arg2).byteOffset, getObject(arg2).byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./eq8_bg.js": import0,
    };
}

const Eq8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_eq8_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

// ──────────────────────────────────────────────────────────────────────────
// Worklet processor
// ──────────────────────────────────────────────────────────────────────────

class Eq8Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasmInit = options?.processorOptions?.wasmModule ?? options?.processorOptions?.wasmBytes;
    if (!wasmInit) {
      throw new Error('eq8-worklet: missing processorOptions.wasmModule or wasmBytes');
    }
    initSync({ module: wasmInit });
    this.eq = new Eq8(sampleRate);
    this.bypassed = false;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-band':
        this.eq.set_band(msg.idx, msg.bandType, msg.freq, msg.gainDb, msg.q);
        break;
      case 'set-bypassed':
        this.bypassed = !!msg.bypassed;
        this.eq.set_bypassed(this.bypassed);
        break;
      case 'reset':
        this.eq.reset();
        break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!outCh) continue;
      if (inCh) {
        outCh.set(inCh);
        this.eq.process(outCh, ch);
      } else {
        outCh.fill(0);
      }
    }
    return true;
  }
}

registerProcessor('aux-eq8-processor', Eq8Processor);
