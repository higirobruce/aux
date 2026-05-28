/**
 * aux Plate worklet — Dattorro-style plate reverb (@aux/dsp-plate).
 *
 * Loaded via AudioContext.audioWorklet.addModule('/plate-worklet.js').
 * Lives on user buses (typically with a send routing in).
 *
 * Message protocol (main → worklet):
 *   { type: 'set-params', decay, damping, preDelayMs, mix }
 *   { type: 'set-bypassed', bypassed }
 *   { type: 'reset' }
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
// Inlined from packages/dsp-plate/wasm/plate.js — wasm-bindgen 0.2.122.
// `export` keywords stripped; ES default-export line removed.
// DO NOT EDIT BY HAND — re-bundle from wasm/plate.js.
// ──────────────────────────────────────────────────────────────────────────

class Plate {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PlateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_plate_free(ptr, 0);
    }
    constructor(sample_rate) {
        const ret = wasm.plate_new(sample_rate);
        this.__wbg_ptr = ret;
        PlateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    process_stereo(left, right) {
        var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_export);
        var len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_export);
        var len1 = WASM_VECTOR_LEN;
        wasm.plate_process_stereo(this.__wbg_ptr, ptr0, len0, addHeapObject(left), ptr1, len1, addHeapObject(right));
    }
    reset() {
        wasm.plate_reset(this.__wbg_ptr);
    }
    set_bypassed(bypassed) {
        wasm.plate_set_bypassed(this.__wbg_ptr, bypassed);
    }
    set_params(decay, damping, pre_delay_ms, mix) {
        wasm.plate_set_params(this.__wbg_ptr, decay, damping, pre_delay_ms, mix);
    }
}
if (Symbol.dispose) Plate.prototype[Symbol.dispose] = Plate.prototype.free;

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
        "./plate_bg.js": import0,
    };
}

const PlateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_plate_free(ptr, 1));

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

class PlateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wasmInit = options?.processorOptions?.wasmModule ?? options?.processorOptions?.wasmBytes;
    if (!wasmInit) {
      throw new Error('plate-worklet: missing processorOptions.wasmModule or wasmBytes');
    }
    initSync({ module: wasmInit });
    this.plate = new Plate(sampleRate);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-params':
        this.plate.set_params(msg.decay, msg.damping, msg.preDelayMs, msg.mix);
        break;
      case 'set-bypassed':
        this.plate.set_bypassed(!!msg.bypassed);
        break;
      case 'reset':
        this.plate.reset();
        break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;

    const inL = input[0];
    const inR = input[1] ?? input[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    if (!outL) return true;

    if (inL) outL.set(inL);
    else outL.fill(0);
    if (outR && outR !== outL) {
      if (inR) outR.set(inR);
      else outR.fill(0);
    }

    this.plate.process_stereo(outL, outR ?? outL);
    return true;
  }
}

registerProcessor('aux-plate-processor', PlateProcessor);
