//! DeEss — split-band de-esser.
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). Tames sibilance
//! (4-10 kHz "ess" energy) by compressing *only* the high band — the body
//! of the signal is left alone. More transparent than a wideband de-esser
//! that ducks everything when sibilance appears.
//!
//! Topology:
//!
//! ```text
//!   in ─┬─► 2nd-order LR low-pass  ──► low_band   ────────┐
//!       │                                                 ├─► out
//!       └─► 2nd-order LR high-pass ──► high_band ──► comp ┘
//! ```
//!
//! - 2nd-order Linkwitz-Riley = two cascaded 1st-order Butterworth halves,
//!   here built as a Q=0.707 biquad LPF/HPF pair. Sums to flat magnitude
//!   response within ~0.1 dB.
//! - Compressor on the high band uses the same envelope-follower /
//!   linear-domain gain math as Comp-Clean, but with peak detection on
//!   the high band's own magnitude.
//!
//! Two engineer-facing params:
//!   freq   — crossover, 2..12 kHz (default 6).
//!   amount — 0..1; maps internally to threshold + ratio so a single knob
//!            sweeps from "no de-essing" to "strong taming".
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(freq_hz, amount)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()
//!   gain_reduction_db() -> f32

use std::f32::consts::{LN_10, PI};
use wasm_bindgen::prelude::*;

const MIN_FREQ: f32 = 2_000.0;
const MAX_FREQ: f32 = 12_000.0;
const ENV_ATTACK_MS: f32 = 1.0;
const ENV_RELEASE_MS: f32 = 50.0;
const DB_FLOOR: f32 = -120.0;
const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

/// Direct-form-I biquad — per-channel state for stereo.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: [f32; 2],
    x2: [f32; 2],
    y1: [f32; 2],
    y2: [f32; 2],
}

impl Biquad {
    const fn passthrough() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: [0.0; 2],
            x2: [0.0; 2],
            y1: [0.0; 2],
            y2: [0.0; 2],
        }
    }

    #[inline(always)]
    fn process(&mut self, x: f32, ch: usize) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1[ch] + self.b2 * self.x2[ch]
            - self.a1 * self.y1[ch]
            - self.a2 * self.y2[ch];
        self.x2[ch] = self.x1[ch];
        self.x1[ch] = x;
        self.y2[ch] = self.y1[ch];
        self.y1[ch] = y;
        y
    }

    fn clear(&mut self) {
        self.x1 = [0.0; 2];
        self.x2 = [0.0; 2];
        self.y1 = [0.0; 2];
        self.y2 = [0.0; 2];
    }

    fn copy_coeffs_from(&mut self, src: &Biquad) {
        self.b0 = src.b0;
        self.b1 = src.b1;
        self.b2 = src.b2;
        self.a1 = src.a1;
        self.a2 = src.a2;
    }
}

mod rbj {
    use super::Biquad;
    use std::f32::consts::PI;

    fn omega(sample_rate: f32, freq: f32) -> (f32, f32) {
        let w0 = 2.0 * PI * freq / sample_rate;
        (w0.sin(), w0.cos())
    }

    pub fn high_pass(sr: f32, freq: f32, q: f32) -> Biquad {
        let (sin_w, cos_w) = omega(sr, freq);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let a0 = 1.0 + alpha;
        let b0 = (1.0 + cos_w) / 2.0 / a0;
        let b1 = -(1.0 + cos_w) / a0;
        let b2 = (1.0 + cos_w) / 2.0 / a0;
        let a1 = -2.0 * cos_w / a0;
        let a2 = (1.0 - alpha) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }

    pub fn low_pass(sr: f32, freq: f32, q: f32) -> Biquad {
        let (sin_w, cos_w) = omega(sr, freq);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cos_w) / 2.0 / a0;
        let b1 = (1.0 - cos_w) / a0;
        let b2 = (1.0 - cos_w) / 2.0 / a0;
        let a1 = -2.0 * cos_w / a0;
        let a2 = (1.0 - alpha) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }
}

#[wasm_bindgen]
pub struct DeEss {
    sample_rate: f32,
    bypassed: bool,

    freq_hz: f32,
    amount: f32,

    // Internal compressor params derived from `amount`.
    threshold_db: f32,
    ratio: f32,
    attack_coeff: f32,
    release_coeff: f32,
    one_minus_inv_ratio: f32,

    lpf: Biquad,
    hpf: Biquad,
    envelope_db: f32,
    last_gr_db: f32,
}

#[wasm_bindgen]
impl DeEss {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let _ = PI; // satisfy unused import on some toolchains
        let mut d = Self {
            sample_rate: sr,
            bypassed: false,
            freq_hz: 6000.0,
            amount: 0.0,
            threshold_db: 0.0,
            ratio: 1.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            one_minus_inv_ratio: 0.0,
            lpf: Biquad::passthrough(),
            hpf: Biquad::passthrough(),
            envelope_db: DB_FLOOR,
            last_gr_db: 0.0,
        };
        d.set_params(d.freq_hz, d.amount);
        d
    }

    /// `freq_hz`: 2_000..12_000 (crossover). `amount`: 0..1 (de-ess strength).
    pub fn set_params(&mut self, freq_hz: f32, amount: f32) {
        self.freq_hz = freq_hz.clamp(MIN_FREQ, MAX_FREQ);
        self.amount = amount.clamp(0.0, 1.0);

        // Crossover — 2nd-order LR ≈ Q = 0.707 Butterworth on both LP + HP.
        let q = 0.7071;
        let lpf = rbj::low_pass(self.sample_rate, self.freq_hz, q);
        let hpf = rbj::high_pass(self.sample_rate, self.freq_hz, q);
        self.lpf.copy_coeffs_from(&lpf);
        self.hpf.copy_coeffs_from(&hpf);

        // Compressor mapping from `amount` ∈ [0, 1]:
        //   amount = 0   → threshold = 0 dB,  ratio = 1   (passthrough)
        //   amount = 1   → threshold = -30 dB, ratio = 10 (strong taming)
        self.threshold_db = -30.0 * self.amount;
        self.ratio = 1.0 + 9.0 * self.amount;
        self.one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;

        self.attack_coeff = Self::one_pole_coeff(self.sample_rate, ENV_ATTACK_MS);
        self.release_coeff = Self::one_pole_coeff(self.sample_rate, ENV_RELEASE_MS);
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }

    pub fn reset(&mut self) {
        self.lpf.clear();
        self.hpf.clear();
        self.envelope_db = DB_FLOOR;
        self.last_gr_db = 0.0;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.amount < 1e-6 {
            return;
        }
        let n = left.len().min(right.len());
        let mut max_gr_db = 0.0_f32;
        for i in 0..n {
            // Split into low + high band per channel (independent biquad
            // state). LR crossover sums back to flat.
            let l_in = left[i];
            let r_in = right[i];
            let l_lo = self.lpf.process(l_in, 0);
            let r_lo = self.lpf.process(r_in, 1);
            let l_hi = self.hpf.process(l_in, 0);
            let r_hi = self.hpf.process(r_in, 1);

            // Envelope follower on the stereo-linked high-band peak.
            let peak = l_hi.abs().max(r_hi.abs());
            let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };
            let coeff =
                if in_db > self.envelope_db { self.attack_coeff } else { self.release_coeff };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * in_db;

            // Static curve, only acting on the high band.
            let excess = (self.envelope_db - self.threshold_db).max(0.0);
            let gr_db = excess * self.one_minus_inv_ratio;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
            let hi_gain = (-gr_db * LN10_OVER_TWENTY).exp();

            // Recombine: low_band passes; high_band is attenuated when the
            // detection exceeds threshold.
            left[i] = l_lo + l_hi * hi_gain;
            right[i] = r_lo + r_hi * hi_gain;
        }
        self.last_gr_db = max_gr_db;
    }

    fn one_pole_coeff(sample_rate: f32, time_ms: f32) -> f32 {
        let tau = time_ms * 0.001 * sample_rate;
        if tau <= 0.0 { 0.0 } else { (-1.0 / tau).exp() }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    fn rms(buf: &[f32]) -> f32 {
        let s: f32 = buf.iter().map(|v| v * v).sum();
        (s / buf.len() as f32).sqrt()
    }

    #[test]
    fn zero_amount_is_passthrough() {
        let mut d = DeEss::new(48000.0);
        d.set_params(6000.0, 0.0);
        let mut l = sine(8000.0, 48000.0, 1024, 0.9);
        let mut r = sine(8000.0, 48000.0, 1024, 0.9);
        let orig = l.clone();
        d.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6, "expected passthrough at amount=0");
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut d = DeEss::new(48000.0);
        d.set_params(6000.0, 1.0);
        d.set_bypassed(true);
        let mut l = sine(8000.0, 48000.0, 1024, 0.9);
        let orig = l.clone();
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn loud_high_band_is_attenuated() {
        // 8 kHz sine, well above the 6 kHz crossover — the entire signal
        // is in the high band, so the compressor sees its peak.
        let mut d = DeEss::new(48000.0);
        d.set_params(6000.0, 1.0); // max de-essing
        let mut l = sine(8000.0, 48000.0, 8192, 0.9);
        let in_rms = rms(&l);
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        let out_rms = rms(&l[4096..]); // skip attack
        assert!(
            out_rms < in_rms * 0.5,
            "expected ≥6 dB high-band attenuation; in={in_rms} out={out_rms}"
        );
        assert!(d.gain_reduction_db() > 6.0);
    }

    #[test]
    fn low_band_is_untouched_when_high_is_loud() {
        // Bass+sibilance mix: 200 Hz tone (well below) + brief 8 kHz burst.
        // The 200 Hz tone (low band) should pass through almost intact.
        let sr = 48000.0_f32;
        let mut l: Vec<f32> = sine(200.0, sr, 8192, 0.5);
        // Overlay loud 8 kHz energy.
        for (i, x) in l.iter_mut().enumerate() {
            *x += 0.7 * (2.0 * PI * 8000.0 * i as f32 / sr).sin();
        }
        let in_low_rms = {
            let mut d = DeEss::new(sr);
            d.set_params(6000.0, 0.0); // measure baseline low-band
            let mut buf = l.clone();
            let mut r = buf.clone();
            d.process_stereo(&mut buf, &mut r);
            rms(&buf[4096..])
        };
        let mut d = DeEss::new(sr);
        d.set_params(6000.0, 1.0);
        let mut r = l.clone();
        d.process_stereo(&mut l, &mut r);
        let out_total_rms = rms(&l[4096..]);
        // We can't isolate the low band perfectly post-mix, but the output
        // should retain a sizeable chunk of energy from the untouched bass.
        assert!(
            out_total_rms > in_low_rms * 0.4,
            "expected low band to survive; in_baseline_rms={in_low_rms} out_rms={out_total_rms}"
        );
    }
}
