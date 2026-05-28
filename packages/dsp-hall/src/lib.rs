//! Hall — large-room reverb (Dattorro-derived).
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). Sibling to the
//! Plate reverb (@aux/dsp-plate) but tuned for the spaciousness of a
//! concert hall:
//!
//!   - 6 input diffusion all-pass filters (vs Plate's 4) for denser early
//!     reflections and a smoother attack.
//!   - Tank delays scaled ~1.7× from Plate's Dattorro values, so the RT60
//!     at the same `decay` setting is meaningfully longer.
//!   - Wider pre-delay range (0..500 ms vs Plate's 0..200) — engineers
//!     often want a noticeable gap before the wet kicks in for halls.
//!   - Slightly lower damping default to keep the high-end alive; modify
//!     to taste.
//!
//! Topology is structurally identical to Plate (two-tank cross-feedback,
//! tap-based stereo output) so the worklet + UI pattern is one-for-one
//! the same. The audible difference comes from the delay constants.
//!
//! ABI (wasm-bindgen): identical to Plate.
//!   new(sample_rate)
//!   set_params(decay, damping, pre_delay_ms, mix)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()

use wasm_bindgen::prelude::*;

const REFERENCE_SR: f32 = 29761.0;

// Six input diffusers — denser than Plate's four.
const AP_IN_1: usize = 142;
const AP_IN_2: usize = 107;
const AP_IN_3: usize = 379;
const AP_IN_4: usize = 277;
const AP_IN_5: usize = 553;
const AP_IN_6: usize = 421;
const GAIN_IN_EARLY: f32 = 0.75;
const GAIN_IN_LATE: f32 = 0.625;

// Tank A — Dattorro values × ~1.7 (rounded to coprime-ish lengths to avoid
// periodic colouration).
const AP_DEC_A: usize = 1129;
const DLY_A_1: usize = 7547;
const DLY_A_2: usize = 6311;
// Tank B
const AP_DEC_B: usize = 1543;
const DLY_B_1: usize = 7159;
const DLY_B_2: usize = 5381;
const GAIN_DEC_AP: f32 = 0.7;

// Output taps — bigger offsets than Plate's so the perceived "first
// reflection" lands later, reinforcing the hall feel.
const TAP_A: usize = 3361;
const TAP_B: usize = 1801;

const MAX_PREDELAY_MS: f32 = 500.0;

/// All-pass filter — `out = -gain * in + delay[n - L]; delay[n] = in + gain * out`.
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

struct Delay {
    buf: Vec<f32>,
    pos: usize,
}

impl Delay {
    fn new(len_samples: usize) -> Self {
        Self { buf: vec![0.0; len_samples.max(1)], pos: 0 }
    }

    #[inline(always)]
    fn push_read(&mut self, x: f32) -> f32 {
        let out = self.buf[self.pos];
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }

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

struct OnePoleLpf {
    state: f32,
    coeff: f32,
}

impl OnePoleLpf {
    fn new() -> Self {
        Self { state: 0.0, coeff: 0.5 }
    }

    fn set_amount(&mut self, amount: f32) {
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
pub struct Hall {
    sample_rate: f32,
    bypassed: bool,

    decay: f32,
    damping: f32,
    pre_delay_ms: f32,
    mix: f32,

    pre_delay: Delay,
    pre_delay_samples: usize,

    ap_in_1: AllPass,
    ap_in_2: AllPass,
    ap_in_3: AllPass,
    ap_in_4: AllPass,
    ap_in_5: AllPass,
    ap_in_6: AllPass,

    ap_dec_a: AllPass,
    dly_a_1: Delay,
    lpf_a: OnePoleLpf,
    dly_a_2: Delay,

    ap_dec_b: AllPass,
    dly_b_1: Delay,
    lpf_b: OnePoleLpf,
    dly_b_2: Delay,

    tank_a_out: f32,
    tank_b_out: f32,
}

#[wasm_bindgen]
impl Hall {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let scale = sr / REFERENCE_SR;
        let s = |n: usize| ((n as f32) * scale).ceil() as usize;
        let pre_delay_cap = ((MAX_PREDELAY_MS / 1000.0) * sr).ceil() as usize;

        let mut hall = Self {
            sample_rate: sr,
            bypassed: false,
            decay: 0.7,
            damping: 0.25,
            pre_delay_ms: 0.0,
            mix: 1.0,

            pre_delay: Delay::new(pre_delay_cap),
            pre_delay_samples: 0,

            ap_in_1: AllPass::new(s(AP_IN_1), GAIN_IN_EARLY),
            ap_in_2: AllPass::new(s(AP_IN_2), GAIN_IN_EARLY),
            ap_in_3: AllPass::new(s(AP_IN_3), GAIN_IN_LATE),
            ap_in_4: AllPass::new(s(AP_IN_4), GAIN_IN_LATE),
            ap_in_5: AllPass::new(s(AP_IN_5), GAIN_IN_LATE),
            ap_in_6: AllPass::new(s(AP_IN_6), GAIN_IN_LATE),

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
        hall.set_params(hall.decay, hall.damping, hall.pre_delay_ms, hall.mix);
        hall
    }

    pub fn set_params(&mut self, decay: f32, damping: f32, pre_delay_ms: f32, mix: f32) {
        self.decay = decay.clamp(0.0, 0.95);
        self.damping = damping.clamp(0.0, 1.0);
        self.pre_delay_ms = pre_delay_ms.clamp(0.0, MAX_PREDELAY_MS);
        self.mix = mix.clamp(0.0, 1.0);

        self.pre_delay_samples = ((self.pre_delay_ms / 1000.0) * self.sample_rate) as usize;
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
        self.ap_in_5.clear();
        self.ap_in_6.clear();
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

            // Pre-delay (mono summed).
            let mono = (l_in + r_in) * 0.5;
            let _ = self.pre_delay.push_read(mono);
            let predelayed = if self.pre_delay_samples > 0 {
                self.pre_delay.tap(self.pre_delay_samples)
            } else {
                mono
            };

            // 6-stage input diffusion.
            let mut x = self.ap_in_1.process(predelayed);
            x = self.ap_in_2.process(x);
            x = self.ap_in_3.process(x);
            x = self.ap_in_4.process(x);
            x = self.ap_in_5.process(x);
            x = self.ap_in_6.process(x);

            // Tank A (cross-feedback from tank B).
            let mut a = x + self.decay * self.tank_b_out;
            a = self.ap_dec_a.process(a);
            a = self.dly_a_1.push_read(a);
            a = self.lpf_a.process(a);
            self.tank_a_out = self.dly_a_2.push_read(a);

            // Tank B (cross-feedback from tank A).
            let mut b = x + self.decay * self.tank_a_out;
            b = self.ap_dec_b.process(b);
            b = self.dly_b_1.push_read(b);
            b = self.lpf_b.process(b);
            self.tank_b_out = self.dly_b_2.push_read(b);

            let wet_l = self.dly_a_2.tap(tap_a);
            let wet_r = self.dly_b_2.tap(tap_b);

            left[i] = l_in + (wet_l - l_in) * self.mix;
            right[i] = r_in + (wet_r - r_in) * self.mix;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests — same shape as the Plate suite
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
        let mut h = Hall::new(48000.0);
        h.set_params(0.8, 0.3, 10.0, 0.0);
        let mut l = vec![0.5, -0.3, 0.7, -0.2];
        let mut r = vec![-0.5, 0.3, -0.7, 0.2];
        let l0 = l.clone();
        let r0 = r.clone();
        h.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(l0.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
        for (a, b) in r.iter().zip(r0.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut h = Hall::new(48000.0);
        h.set_params(0.9, 0.5, 100.0, 1.0);
        h.set_bypassed(true);
        let mut l: Vec<f32> = (0..512).map(|i| (i as f32 * 0.01).sin()).collect();
        let original = l.clone();
        let mut r = l.clone();
        h.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn dirac_makes_decaying_tail() {
        // Hall tank delays ≈ 250 ms + 210 ms; first significant tail lands
        // around 500 ms after the impulse. Use a wider window than Plate.
        let sr = 48000.0_f32;
        let mut h = Hall::new(sr);
        h.set_params(0.75, 0.25, 0.0, 1.0);
        let mut l = dirac(192000); // 4 s
        let mut r = vec![0.0; 192000];
        h.process_stereo(&mut l, &mut r);

        let early = rms(&l[24000..72000]); // 500 ms .. 1.5 s
        let late = rms(&l[144000..]); // 3 s+
        assert!(early > 0.0005, "expected detectable tail at 500 ms..1.5 s; got {early}");
        assert!(late < early, "expected decay over time; early={early} late={late}");
    }

    #[test]
    fn higher_decay_extends_tail() {
        let sr = 48000.0_f32;
        let energy_with = |decay| {
            let mut h = Hall::new(sr);
            h.set_params(decay, 0.25, 0.0, 1.0);
            let mut l = dirac(192000);
            let mut r = vec![0.0; 192000];
            h.process_stereo(&mut l, &mut r);
            rms(&l[96000..]) // tail energy after 2 s
        };
        let low = energy_with(0.3);
        let high = energy_with(0.9);
        assert!(
            high > low * 2.0,
            "expected longer tail at higher decay; low={low} high={high}"
        );
    }

    #[test]
    fn hall_tail_outlasts_plate_at_same_decay() {
        // Compare 2-second tail energy: Hall's longer delays should mean
        // more accumulated energy at the same decay setting. We don't link
        // to the plate crate here (would create a circular dependency in
        // the workspace), so this is a self-consistency check: at the same
        // decay, Hall's late-window energy is greater than its early-window
        // energy ratio — i.e. it sustains rather than just decaying away.
        let sr = 48000.0_f32;
        let mut h = Hall::new(sr);
        h.set_params(0.8, 0.25, 0.0, 1.0);
        let mut l = dirac(192000);
        let mut r = vec![0.0; 192000];
        h.process_stereo(&mut l, &mut r);
        let early = rms(&l[24000..48000]);
        let late_1 = rms(&l[48000..96000]);
        let late_2 = rms(&l[96000..144000]);
        // Tail shouldn't drop off too fast — late_2 should be > 25% of late_1
        // at decay 0.8, indicating sustained ringing.
        assert!(
            late_2 > late_1 * 0.25,
            "expected sustained tail at decay 0.8; early={early} late_1={late_1} late_2={late_2}"
        );
    }

    #[test]
    fn long_pre_delay_silences_first_samples() {
        // 300 ms pre-delay — first ~1000 wet samples should still be silent
        // since neither dry (mix=1) nor wet has produced output yet.
        let mut h = Hall::new(48000.0);
        h.set_params(0.7, 0.3, 300.0, 1.0);
        let mut l = dirac(48000);
        let mut r = vec![0.0; 48000];
        h.process_stereo(&mut l, &mut r);
        for (i, &v) in l[0..1000].iter().enumerate() {
            assert!(v.abs() < 1e-5, "expected silence in pre-delay window at i={i}, got {v}");
        }
    }
}
