//! Plate — Dattorro-style plate reverb (simplified topology).
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). Designed to live
//! on a user bus as a wet send-return.
//!
//! Topology:
//!
//! ```text
//!   in ─► [pre-delay] ─► [APF1] ─► [APF2] ─► [APF3] ─► [APF4] ─► tank_in
//!
//!   tank_in + (decay × tankB_out) ─► [APF_decay_A] ─► [delay_A1] ─►
//!                                    [LPF damping] ─► [delay_A2] ─► tankA_out
//!
//!   tank_in + (decay × tankA_out) ─► [APF_decay_B] ─► [delay_B1] ─►
//!                                    [LPF damping] ─► [delay_B2] ─► tankB_out
//!
//!   out_L = tap_A      ;   out_R = tap_B
//! ```
//!
//! Reference: Dattorro 1997, *Effect Design Part 1: Reverberator and Other
//! Filters*, JAES 45(9). Delay times here are the paper's values (in
//! samples at 29 761 Hz), scaled to the current sample rate.
//!
//! Stereo: the two tank halves carry the L and R outputs respectively, with
//! cross-feedback between them via the `decay` parameter. This gives the
//! characteristic stereo "smear" of a real plate without requiring two
//! independent reverbs.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(decay, damping, pre_delay_ms, mix)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()
//!
//! Mono input/output isn't surfaced — plates are inherently stereo.

use std::f32::consts::LN_10;
use wasm_bindgen::prelude::*;

const REFERENCE_SR: f32 = 29761.0;

// Dattorro 1997 — delay lengths (in samples at REFERENCE_SR).
const AP_IN_1: usize = 142;
const AP_IN_2: usize = 107;
const AP_IN_3: usize = 379;
const AP_IN_4: usize = 277;
const GAIN_IN_1_2: f32 = 0.75;
const GAIN_IN_3_4: f32 = 0.625;

// Tank A
const AP_DEC_A: usize = 672;
const DLY_A_1: usize = 4453;
const DLY_A_2: usize = 3720;
// Tank B
const AP_DEC_B: usize = 908;
const DLY_B_1: usize = 4217;
const DLY_B_2: usize = 3163;
const GAIN_DEC_AP: f32 = 0.7;

// Output taps (positions in each tank's second delay line, samples at REFERENCE_SR).
const TAP_A: usize = 1990;
const TAP_B: usize = 1066;

const MAX_PREDELAY_MS: f32 = 200.0;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

/// All-pass filter — `out = -gain * in + delay[n - L]; delay[n] = in + gain * out`.
/// Classic feed-back / feed-forward APF; magnitude response is flat,
/// phase response varies with frequency. The reverb's "diffusion".
struct AllPass {
    buf: Vec<f32>,
    pos: usize,
    gain: f32,
}

impl AllPass {
    fn new(len_samples: usize, gain: f32) -> Self {
        Self { buf: vec![0.0; len_samples.max(1)], pos: 0, gain }
    }

    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        let d = self.buf[self.pos];
        let y = -self.gain * x + d;
        self.buf[self.pos] = x + self.gain * y;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
    }
}

/// Plain delay line with tap-and-shift semantics: writing pushes the
/// oldest sample out the back.
struct Delay {
    buf: Vec<f32>,
    pos: usize,
}

impl Delay {
    fn new(len_samples: usize) -> Self {
        Self { buf: vec![0.0; len_samples.max(1)], pos: 0 }
    }

    /// Read the sample about to be overwritten (the "tail" of the line) and
    /// push a new one into the same slot in a single operation.
    #[inline(always)]
    fn push_read(&mut self, x: f32) -> f32 {
        let out = self.buf[self.pos];
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }

    /// Read N samples *before* the write position (without modifying state).
    #[inline(always)]
    fn tap(&self, offset_back: usize) -> f32 {
        let len = self.buf.len();
        let idx = (self.pos + len - (offset_back % len)) % len;
        self.buf[idx]
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
    }
}

/// One-pole low-pass filter; damping in the reverb tanks. `coeff` is the
/// "carry-over" amount (0 = no LPF, 1 = freeze).
struct OnePoleLpf {
    state: f32,
    coeff: f32,
}

impl OnePoleLpf {
    fn new() -> Self {
        Self { state: 0.0, coeff: 0.5 }
    }

    fn set_amount(&mut self, amount: f32) {
        // amount ∈ [0, 1]; map to coeff so 0 = bypass, 1 = strong damping.
        self.coeff = amount.clamp(0.0, 0.999);
    }

    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        self.state = self.coeff * self.state + (1.0 - self.coeff) * x;
        self.state
    }

    fn clear(&mut self) {
        self.state = 0.0;
    }
}

#[wasm_bindgen]
pub struct Plate {
    sample_rate: f32,
    bypassed: bool,

    decay: f32,         // 0..1; feedback amount around the tank loop
    damping: f32,       // 0..1; high-freq absorption in the tank
    pre_delay_ms: f32,  // ms; can be tweaked live
    mix: f32,           // 0..1; dry/wet on the way out

    // Pre-delay buffer.
    pre_delay: Delay,
    pre_delay_samples: usize, // live-set from pre_delay_ms

    // Input diffusion network (4 APFs in series).
    ap_in_1: AllPass,
    ap_in_2: AllPass,
    ap_in_3: AllPass,
    ap_in_4: AllPass,

    // Tank A.
    ap_dec_a: AllPass,
    dly_a_1: Delay,
    lpf_a: OnePoleLpf,
    dly_a_2: Delay,

    // Tank B.
    ap_dec_b: AllPass,
    dly_b_1: Delay,
    lpf_b: OnePoleLpf,
    dly_b_2: Delay,

    // Cross-feedback registers — last sample emitted by each tank.
    tank_a_out: f32,
    tank_b_out: f32,
}

#[wasm_bindgen]
impl Plate {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let scale = sr / REFERENCE_SR;
        let s = |n: usize| ((n as f32) * scale).ceil() as usize;
        let pre_delay_cap = ((MAX_PREDELAY_MS / 1000.0) * sr).ceil() as usize;
        let _ = LN10_OVER_TWENTY; // silence unused warning on toolchains without it

        let mut plate = Self {
            sample_rate: sr,
            bypassed: false,
            decay: 0.5,
            damping: 0.3,
            pre_delay_ms: 0.0,
            mix: 1.0,

            pre_delay: Delay::new(pre_delay_cap),
            pre_delay_samples: 0,

            ap_in_1: AllPass::new(s(AP_IN_1), GAIN_IN_1_2),
            ap_in_2: AllPass::new(s(AP_IN_2), GAIN_IN_1_2),
            ap_in_3: AllPass::new(s(AP_IN_3), GAIN_IN_3_4),
            ap_in_4: AllPass::new(s(AP_IN_4), GAIN_IN_3_4),

            ap_dec_a: AllPass::new(s(AP_DEC_A), GAIN_DEC_AP),
            dly_a_1: Delay::new(s(DLY_A_1)),
            lpf_a: OnePoleLpf::new(),
            dly_a_2: Delay::new(s(DLY_A_2)),

            ap_dec_b: AllPass::new(s(AP_DEC_B), GAIN_DEC_AP),
            dly_b_1: Delay::new(s(DLY_B_1)),
            lpf_b: OnePoleLpf::new(),
            dly_b_2: Delay::new(s(DLY_B_2)),

            tank_a_out: 0.0,
            tank_b_out: 0.0,
        };
        plate.set_params(plate.decay, plate.damping, plate.pre_delay_ms, plate.mix);
        plate
    }

    pub fn set_params(&mut self, decay: f32, damping: f32, pre_delay_ms: f32, mix: f32) {
        self.decay = decay.clamp(0.0, 0.95); // never quite self-oscillate
        self.damping = damping.clamp(0.0, 1.0);
        self.pre_delay_ms = pre_delay_ms.clamp(0.0, MAX_PREDELAY_MS);
        self.mix = mix.clamp(0.0, 1.0);

        self.pre_delay_samples = ((self.pre_delay_ms / 1000.0) * self.sample_rate) as usize;
        // Map damping 0..1 → LPF coeff 0..0.95 (we keep some headroom so
        // the tank never freezes completely).
        let lpf_coeff = self.damping * 0.95;
        self.lpf_a.set_amount(lpf_coeff);
        self.lpf_b.set_amount(lpf_coeff);
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        self.pre_delay.clear();
        self.ap_in_1.clear();
        self.ap_in_2.clear();
        self.ap_in_3.clear();
        self.ap_in_4.clear();
        self.ap_dec_a.clear();
        self.dly_a_1.clear();
        self.dly_a_2.clear();
        self.lpf_a.clear();
        self.ap_dec_b.clear();
        self.dly_b_1.clear();
        self.dly_b_2.clear();
        self.lpf_b.clear();
        self.tank_a_out = 0.0;
        self.tank_b_out = 0.0;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed {
            return;
        }
        let n = left.len().min(right.len());
        let scale = self.sample_rate / REFERENCE_SR;
        let tap_a = ((TAP_A as f32) * scale) as usize;
        let tap_b = ((TAP_B as f32) * scale) as usize;

        for i in 0..n {
            let l_in = left[i];
            let r_in = right[i];

            // 1. Pre-delay (mono summed input).
            let mono = (l_in + r_in) * 0.5;
            let _ = self.pre_delay.push_read(mono); // shift the line forward
            let predelayed = if self.pre_delay_samples > 0 {
                self.pre_delay.tap(self.pre_delay_samples)
            } else {
                mono
            };

            // 2. Input diffusion — 4 cascaded APFs.
            let mut x = self.ap_in_1.process(predelayed);
            x = self.ap_in_2.process(x);
            x = self.ap_in_3.process(x);
            x = self.ap_in_4.process(x);

            // 3. Tank A: input + decay × tankB feedback → APF → delay → damp → delay.
            let mut a = x + self.decay * self.tank_b_out;
            a = self.ap_dec_a.process(a);
            a = self.dly_a_1.push_read(a);
            a = self.lpf_a.process(a);
            self.tank_a_out = self.dly_a_2.push_read(a);

            // 4. Tank B: input + decay × tankA feedback → APF → delay → damp → delay.
            let mut b = x + self.decay * self.tank_a_out;
            b = self.ap_dec_b.process(b);
            b = self.dly_b_1.push_read(b);
            b = self.lpf_b.process(b);
            self.tank_b_out = self.dly_b_2.push_read(b);

            // 5. Output taps. Each tank's second delay is read at a fixed
            // offset (Dattorro's "tapped output" trick), producing the
            // perceived plate stereo.
            let wet_l = self.dly_a_2.tap(tap_a);
            let wet_r = self.dly_b_2.tap(tap_b);

            // 6. Dry/wet mix.
            left[i] = l_in + (wet_l - l_in) * self.mix;
            right[i] = r_in + (wet_r - r_in) * self.mix;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn dirac(n: usize) -> Vec<f32> {
        let mut v = vec![0.0; n];
        v[0] = 1.0;
        v
    }

    fn rms(buf: &[f32]) -> f32 {
        let s: f32 = buf.iter().map(|v| v * v).sum();
        (s / buf.len() as f32).sqrt()
    }

    #[test]
    fn dry_mix_is_bit_exact() {
        let mut p = Plate::new(48000.0);
        p.set_params(0.8, 0.3, 10.0, 0.0); // mix = 0
        let mut l = vec![0.5, -0.3, 0.7, -0.2];
        let mut r = vec![-0.5, 0.3, -0.7, 0.2];
        let l0 = l.clone();
        let r0 = r.clone();
        p.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(l0.iter()) {
            assert!((a - b).abs() < 1e-6, "L drift");
        }
        for (a, b) in r.iter().zip(r0.iter()) {
            assert!((a - b).abs() < 1e-6, "R drift");
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut p = Plate::new(48000.0);
        p.set_params(0.9, 0.5, 50.0, 1.0); // would reverb hard
        p.set_bypassed(true);
        let mut l: Vec<f32> = (0..512).map(|i| (i as f32 * 0.01).sin()).collect();
        let original = l.clone();
        let mut r = l.clone();
        p.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn dirac_makes_decaying_tail() {
        // Feed a single sample; energy should accumulate in the tank as the
        // impulse circulates, then decay. Tank delays are ~150 ms + 125 ms
        // so the first reverb tail energy lands roughly 300 ms after the
        // impulse — we check a window that comfortably contains that.
        let sr = 48000.0_f32;
        let mut p = Plate::new(sr);
        p.set_params(0.7, 0.3, 0.0, 1.0);
        let mut l = dirac(96000); // 2 seconds — long enough to see clear decay
        let mut r = vec![0.0; 96000];
        p.process_stereo(&mut l, &mut r);

        // 300 ms .. 800 ms = the "early reflections / build-up" window.
        let early = rms(&l[14400..38400]);
        let late = rms(&l[72000..]); // last 500 ms — should be quieter
        assert!(
            early > 0.0005,
            "expected detectable tail energy at 300–800 ms; got {early}"
        );
        assert!(
            late < early,
            "expected decay over time; early={early} late={late}"
        );
    }

    #[test]
    fn higher_decay_extends_tail() {
        let sr = 48000.0_f32;
        let energy_with = |decay| {
            let mut p = Plate::new(sr);
            p.set_params(decay, 0.3, 0.0, 1.0);
            let mut l = dirac(96000); // 2 s — same window as dirac_makes_decaying_tail
            let mut r = vec![0.0; 96000];
            p.process_stereo(&mut l, &mut r);
            rms(&l[48000..]) // tail energy after 1 s
        };
        let low = energy_with(0.3);
        let high = energy_with(0.85);
        assert!(
            high > low * 2.0,
            "expected longer tail at higher decay; low={low} high={high}"
        );
    }

    #[test]
    fn pre_delay_silences_first_block() {
        // 10 ms pre-delay at 48 kHz = 480 samples. The first 100 samples of
        // the wet output should be essentially zero (only dry passes through
        // until the wet starts arriving).
        let mut p = Plate::new(48000.0);
        p.set_params(0.7, 0.3, 10.0, 1.0);
        let mut l = dirac(2048);
        let mut r = vec![0.0; 2048];
        p.process_stereo(&mut l, &mut r);
        // The first sample IS the dry impulse (mix=1 replaces dry with wet
        // overall, but the dry is the "input" passed as the i=0 value...
        // actually wait — at mix=1 we replace dry with wet completely. The
        // wet output is zero for the first 480 samples because nothing has
        // come out of the pre-delay yet. So l[0..100] should be ~0.
        for (i, &v) in l[0..100].iter().enumerate() {
            assert!(v.abs() < 1e-5, "expected silence in first pre-delay window at i={i}, got {v}");
        }
    }
}
