/**
 * aux Meter worklet — ITU-R BS.1770 loudness + true-peak (read-only sink).
 *
 * Message protocol (main -> worklet):
 *   { type: 'set-bypassed', bypassed }
 *   { type: 'reset' }
 * Posts (worklet -> main), throttled ~12 Hz:
 *   { type: 'loudness', momentary, short, integrated, truePeakDb, overs }
 */

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor() {}
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
        if (b1 < 0xc0) continue;
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
// Inlined from packages/dsp-meter/wasm/meter.js — wasm-bindgen.
// DO NOT EDIT BY HAND — re-bundle from wasm/meter.js.
// ──────────────────────────────────────────────────────────────────────────

/* @ts-self-types="./meter.d.ts" */

class Meter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meter_free(ptr, 0);
    }
    /**
     * Integrated (gated) loudness in LUFS since the last reset.
     * @returns {number}
     */
    integrated_lufs() {
        const ret = wasm.meter_integrated_lufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Momentary loudness (400 ms) in LUFS.
     * @returns {number}
     */
    momentary_lufs() {
        const ret = wasm.meter_momentary_lufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.meter_new(sample_rate);
        this.__wbg_ptr = ret;
        MeterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Count of oversampled samples over 0 dBTP since reset.
     * @returns {number}
     */
    overs() {
        const ret = wasm.meter_overs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Reads L/R; never writes. Accumulates loudness + true-peak state.
     * @param {Float32Array} left
     * @param {Float32Array} right
     */
    process_stereo(left, right) {
        var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_export);
        var len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_export);
        var len1 = WASM_VECTOR_LEN;
        wasm.meter_process_stereo(this.__wbg_ptr, ptr0, len0, addHeapObject(left), ptr1, len1, addHeapObject(right));
    }
    reset() {
        wasm.meter_reset(this.__wbg_ptr);
    }
    /**
     * @param {boolean} bypassed
     */
    set_bypassed(bypassed) {
        wasm.meter_set_bypassed(this.__wbg_ptr, bypassed);
    }
    /**
     * Short-term loudness (3 s) in LUFS.
     * @returns {number}
     */
    short_lufs() {
        const ret = wasm.meter_short_lufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Maximum true-peak since reset, in dBTP.
     * @returns {number}
     */
    true_peak_db() {
        const ret = wasm.meter_true_peak_db(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Meter.prototype[Symbol.dispose] = Meter.prototype.free;
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
        "./meter_bg.js": import0,
    };
}

const MeterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meter_free(ptr, 1));

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

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
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

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('meter_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasmInit = options?.processorOptions?.wasmModule ?? options?.processorOptions?.wasmBytes;
    if (!wasmInit) {
      throw new Error('meter-worklet: missing processorOptions.wasmModule or wasmBytes');
    }
    initSync({ module: wasmInit });
    this.meter = new Meter(sampleRate);
    this._counter = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-bypassed':
        this.meter.set_bypassed(!!msg.bypassed);
        break;
      case 'reset':
        this.meter.reset();
        break;
    }
  }

  // Sink: reads the input, writes no output. Returns true to stay alive.
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0];
    const inR = input[1] ?? input[0];
    if (inL) {
      // Copies: process_stereo takes &mut slices but never writes; the copies
      // keep the graph's input buffers untouched.
      this.meter.process_stereo(new Float32Array(inL), new Float32Array(inR));
    }
    // ~12 Hz at 128-sample blocks / 48k.
    if (++this._counter >= 32) {
      this._counter = 0;
      this.port.postMessage({
        type: 'loudness',
        momentary: this.meter.momentary_lufs(),
        short: this.meter.short_lufs(),
        integrated: this.meter.integrated_lufs(),
        truePeakDb: this.meter.true_peak_db(),
        overs: this.meter.overs(),
      });
    }
    return true;
  }
}

registerProcessor('aux-meter-processor', MeterProcessor);
