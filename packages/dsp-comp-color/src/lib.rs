//! Comp-Color — FET-style compressor.
//!
//! Per docs/implementation.html §07 v1 suite. Where Comp-Clean (the VCA
//! sibling) optimizes for transparency, Comp-Color leans into the
//! historical character of FET-style hardware:
//!
//!   1. **Faster envelope**. Attack down to 0.05 ms — the FET-modeled
//!      hardware classic responds in microseconds.
//!   2. **High-pass sidechain at 100 Hz**. Keeps bass from triggering on
//!      every kick — standard mixing-buss / drum-buss behavior. The
//!      detection signal is filtered; the audio path is not.
//!   3. **Soft-clip saturation on the wet path**. A tanh-shaped drive
//!      stage adds 2nd + 3rd harmonic content. `drive` parameter scales
//!      pre-saturation gain (0..24 dB); makeup compensates on the way out.
//!   4. **Output trim still goes through the dry/wet mix** — engineers
//!      can dial in "parallel saturation" by lowering the mix.
//!
//! Signal flow per sample:
//!
//! ```text
//!     input ─┬──────────────────────────────► (× (1 - mix)) ──┐
//!            │                                                 │
//!            ├─► one-pole HPF @ 100 Hz ──► |peak| ──► to dB    │
//!            │                                          │      │
//!            │                                 envelope follower      ├─► output
//!            │                                          │      │
//!            ▼                                  gain reduction        │
//!     × (drive × makeup) ──► tanh soft-clip ──► × 10^(-gr/20) ──► (× mix) ─┘
//! ```
//!
//! Stereo: same peak-link as Comp-Clean (max of |L|, |R|). The sidechain
//! HPF is also stereo-summed for symmetry — a single one-pole for both.

use std::f32::consts::{LN_10, PI};
use wasm_bindgen::prelude::*;

const MIN_RATIO: f32 = 1.0;
const MAX_RATIO: f32 = 30.0;
const MIN_ATTACK_MS: f32 = 0.05;
const MIN_RELEASE_MS: f32 = 5.0;
const DB_FLOOR: f32 = -120.0;
const SIDECHAIN_HPF_HZ: f32 = 100.0;

const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct CompColor {
    sample_rate: f32,
    bypassed: bool,

    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
    makeup_db: f32,
    mix: f32,
    /// Pre-saturation gain in dB, 0..24. Scales how hard tanh clips.
    drive_db: f32,

    attack_coeff: f32,
    release_coeff: f32,
    /// One-pole HPF coefficient for the sidechain detection signal.
    hpf_alpha: f32,

    envelope_db: f32,
    /// Sidechain HPF state — one running highpass for stereo-summed input.
    hpf_state: f32,
    last_gr_db: f32,
}

#[wasm_bindgen]
impl CompColor {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut c = Self {
            sample_rate: sr,
            bypassed: false,
            threshold_db: 0.0,
            ratio: 1.0,
            attack_ms: 1.0,   // fast — FET hallmark
            release_ms: 50.0, // also fast
            makeup_db: 0.0,
            mix: 1.0,
            drive_db: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            hpf_alpha: 0.0,
            envelope_db: DB_FLOOR,
            hpf_state: 0.0,
            last_gr_db: 0.0,
        };
        c.recompute_coeffs();
        c
    }

    /// Set all params at once. Cheap; safe per pointer-drag.
    pub fn set_params(
        &mut self,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
        mix: f32,
        drive_db: f32,
    ) {
        self.threshold_db = threshold_db.clamp(-80.0, 12.0);
        self.ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        self.attack_ms = attack_ms.max(MIN_ATTACK_MS);
        self.release_ms = release_ms.max(MIN_RELEASE_MS);
        self.makeup_db = makeup_db.clamp(-24.0, 24.0);
        self.mix = mix.clamp(0.0, 1.0);
        self.drive_db = drive_db.clamp(0.0, 24.0);
        self.recompute_coeffs();
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }

    pub fn reset(&mut self) {
        self.envelope_db = DB_FLOOR;
        self.hpf_state = 0.0;
        self.last_gr_db = 0.0;
    }

    /// Stereo in place. L + R must be the same length.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.ratio <= 1.0 + 1e-6 {
            return;
        }
        let n = left.len().min(right.len());
        let pre_lin = ((self.makeup_db + self.drive_db) * LN10_OVER_TWENTY).exp();
        let post_lin = (-self.drive_db * LN10_OVER_TWENTY).exp();
        let one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;
        let mut max_gr_db = 0.0_f32;

        for i in 0..n {
            let l_in = left[i];
            let r_in = right[i];

            // ── Sidechain: stereo-sum then highpass for detection only.
            let mono = (l_in + r_in) * 0.5;
            let hpf_out = mono - self.hpf_state;
            self.hpf_state += self.hpf_alpha * hpf_out;
            let detect = hpf_out;

            let peak = detect.abs();
            let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };

            // Envelope follower — one-pole, asymmetric attack/release.
            let coeff = if in_db > self.envelope_db { self.attack_coeff } else { self.release_coeff };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * in_db;

            let excess = (self.envelope_db - self.threshold_db).max(0.0);
            let gr_db = excess * one_minus_inv_ratio;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }

            // Static curve in linear domain; then drive + soft-clip + post.
            let gain = (-gr_db * LN10_OVER_TWENTY).exp();

            // pre = (drive + makeup) -> tanh -> post (= -drive) -> gr ramp
            let l_pre = l_in * pre_lin;
            let r_pre = r_in * pre_lin;
            let l_clip = l_pre.tanh();
            let r_clip = r_pre.tanh();
            let l_wet = l_clip * post_lin * gain;
            let r_wet = r_clip * post_lin * gain;

            left[i] = l_in + (l_wet - l_in) * self.mix;
            right[i] = r_in + (r_wet - r_in) * self.mix;
        }

        self.last_gr_db = max_gr_db;
    }

    /// Mono in place — sidechain is the input itself (no L/R sum).
    pub fn process_mono(&mut self, buffer: &mut [f32]) {
        if self.bypassed || self.ratio <= 1.0 + 1e-6 {
            return;
        }
        let pre_lin = ((self.makeup_db + self.drive_db) * LN10_OVER_TWENTY).exp();
        let post_lin = (-self.drive_db * LN10_OVER_TWENTY).exp();
        let one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;
        let mut max_gr_db = 0.0_f32;

        for x in buffer.iter_mut() {
            let in_val = *x;
            let hpf_out = in_val - self.hpf_state;
            self.hpf_state += self.hpf_alpha * hpf_out;
            let detect = hpf_out;

            let peak = detect.abs();
            let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };
            let coeff = if in_db > self.envelope_db { self.attack_coeff } else { self.release_coeff };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * in_db;

            let excess = (self.envelope_db - self.threshold_db).max(0.0);
            let gr_db = excess * one_minus_inv_ratio;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
            let gain = (-gr_db * LN10_OVER_TWENTY).exp();

            let pre = in_val * pre_lin;
            let clip = pre.tanh();
            let wet = clip * post_lin * gain;
            *x += (wet - in_val) * self.mix;
        }

        self.last_gr_db = max_gr_db;
    }

    fn one_pole_coeff(sample_rate: f32, time_ms: f32) -> f32 {
        let tau_samples = time_ms * 0.001 * sample_rate;
        if tau_samples <= 0.0 {
            0.0
        } else {
            (-1.0 / tau_samples).exp()
        }
    }

    fn recompute_coeffs(&mut self) {
        self.attack_coeff = Self::one_pole_coeff(self.sample_rate, self.attack_ms);
        self.release_coeff = Self::one_pole_coeff(self.sample_rate, self.release_ms);
        // One-pole HPF: alpha = 1 - exp(-2*pi*fc / sr). Approximation, but
        // close to ideal for sidechain detection at fc = 100 Hz.
        let omega = 2.0 * PI * SIDECHAIN_HPF_HZ / self.sample_rate;
        self.hpf_alpha = 1.0 - (-omega).exp();
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(buf: &[f32]) -> f32 {
        let sum_sq: f32 = buf.iter().map(|v| v * v).sum();
        (sum_sq / buf.len() as f32).sqrt()
    }

    fn sine(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn unity_ratio_is_passthrough() {
        let mut c = CompColor::new(48000.0);
        c.set_params(-20.0, 1.0, 1.0, 50.0, 0.0, 1.0, 0.0);
        let mut input = sine(440.0, 48000.0, 1024, 0.5);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn bypass_overrides_any_setting() {
        let mut c = CompColor::new(48000.0);
        c.set_params(-40.0, 10.0, 0.1, 30.0, 6.0, 1.0, 12.0);
        c.set_bypassed(true);
        let mut input = sine(440.0, 48000.0, 1024, 0.8);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn loud_signal_above_threshold_gets_compressed() {
        let mut c = CompColor::new(48000.0);
        c.set_params(-20.0, 6.0, 1.0, 50.0, 0.0, 1.0, 0.0);
        let mut input = sine(440.0, 48000.0, 8192, 0.6);
        let in_rms = rms(&input);
        c.process_mono(&mut input);
        let settled = rms(&input[4096..]);
        assert!(settled < in_rms * 0.7);
        assert!(c.gain_reduction_db() > 6.0);
    }

    #[test]
    fn sidechain_hpf_attenuates_subbass_relative_to_mids() {
        // The one-pole HPF at 100 Hz can't completely block 40 Hz (–6 dB/oct
        // slope), but it should let noticeably less of the bass through to
        // the detector than the mid-range. Same params, two different tones,
        // compare GR after the envelope has settled.
        let gr_at = |freq: f32| {
            let mut c = CompColor::new(48000.0);
            c.set_params(-30.0, 8.0, 1.0, 50.0, 0.0, 1.0, 0.0);
            let mut buf = sine(freq, 48000.0, 8192, 0.5);
            c.process_mono(&mut buf);
            c.gain_reduction_db()
        };
        let gr_bass = gr_at(40.0);
        let gr_mid = gr_at(1000.0);
        // 1 kHz lives way above the corner, so its detection is essentially
        // unfiltered. 40 Hz should produce noticeably less GR.
        assert!(
            gr_bass < gr_mid - 4.0,
            "sidechain HPF should suppress 40 Hz vs 1 kHz; got bass={gr_bass} mid={gr_mid}"
        );
    }

    #[test]
    fn drive_adds_harmonic_content() {
        // With nothing else changing, a non-zero drive should distort a
        // pure sine. Measure crest factor — a clipped sine has lower peak/
        // RMS ratio than a clean one (peaks flatten, RMS rises).
        let baseline = {
            let mut c = CompColor::new(48000.0);
            c.set_params(-3.0, 6.0, 1.0, 50.0, 0.0, 1.0, 0.0); // drive = 0
            let mut buf = sine(440.0, 48000.0, 4096, 0.5);
            c.process_mono(&mut buf);
            let peak = buf.iter().fold(0.0_f32, |a, &b| a.max(b.abs()));
            let r = rms(&buf);
            peak / r
        };
        let driven = {
            let mut c = CompColor::new(48000.0);
            c.set_params(-3.0, 6.0, 1.0, 50.0, 0.0, 1.0, 18.0); // drive = 18 dB
            let mut buf = sine(440.0, 48000.0, 4096, 0.5);
            c.process_mono(&mut buf);
            let peak = buf.iter().fold(0.0_f32, |a, &b| a.max(b.abs()));
            let r = rms(&buf);
            peak / r
        };
        // Heavily-driven sine looks more like a square wave — crest factor
        // drops toward 1.0. Pure sine sits at ~√2 ≈ 1.414.
        assert!(
            driven < baseline,
            "expected driven crest factor < baseline; got driven={driven} baseline={baseline}"
        );
        assert!(driven < 1.3, "expected significant saturation; got crest={driven}");
    }

    #[test]
    fn dry_mix_is_bit_exact_dry() {
        let mut c = CompColor::new(48000.0);
        c.set_params(-30.0, 8.0, 1.0, 50.0, 0.0, 0.0, 12.0); // mix = 0
        let mut input = sine(440.0, 48000.0, 1024, 0.8);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
