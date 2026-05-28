//! Transient — attack/sustain shaper.
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). Threshold-free
//! design: two envelope followers run in parallel against the same input
//! magnitude — a fast one and a slow one. Their ratio in dB tells us
//! whether the signal is in its attack phase (fast > slow) or in the
//! sustain / decay phase (fast < slow), and by how much. We scale the
//! output gain by that excursion:
//!
//! ```text
//!   mag      = max(|L|, |R|)
//!   fast_env = AR(1 ms, 50 ms)   ← short attack catches transient peaks
//!   slow_env = AR(30 ms, 300 ms) ← longer attack tracks the average body
//!   log_ratio = 20·log10(fast_env / slow_env)
//!   gain_db = log_ratio ≥ 0 ? attack · log_ratio : sustain · |log_ratio|
//! ```
//!
//! Both `attack` and `sustain` are unitless ∈ [-1, 1]; +1 doubles the
//! transient/sustain excursion, -1 cancels it (kills transients or
//! lengthens sustain). 0 is bypass-equivalent.
//!
//! Stereo: peak-linked detection (`max(|L|, |R|)`) so gain modulation is
//! identical across channels — no image shift at transients.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(attack, sustain)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   process_mono(&mut [f32])
//!   reset()

use std::f32::consts::LN_10;
use wasm_bindgen::prelude::*;

const FAST_ATTACK_MS: f32 = 1.0;
const FAST_RELEASE_MS: f32 = 50.0;
const SLOW_ATTACK_MS: f32 = 30.0;
const SLOW_RELEASE_MS: f32 = 300.0;
/// Output gain smoothing — needs to be fast enough to track transients but
/// slow enough to avoid clicks. 1 ms ≈ 48 samples at 48 kHz.
const GAIN_SMOOTH_MS: f32 = 1.0;
/// Cap the dB excursion the attack/sustain knobs can apply — prevents
/// extreme settings from running the gain off into ±∞ on edge cases.
const MAX_GAIN_DB: f32 = 18.0;

const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;
const EPSILON: f32 = 1e-9;

#[wasm_bindgen]
pub struct Transient {
    sample_rate: f32,
    bypassed: bool,

    attack: f32,  // ∈ [-1, 1]
    sustain: f32, // ∈ [-1, 1]

    // Per-envelope one-pole coefficients (carry-over fraction).
    fast_attack_c: f32,
    fast_release_c: f32,
    slow_attack_c: f32,
    slow_release_c: f32,
    gain_smooth_c: f32,

    fast_env: f32,
    slow_env: f32,
    smoothed_gain: f32,
}

#[wasm_bindgen]
impl Transient {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut t = Self {
            sample_rate: sr,
            bypassed: false,
            attack: 0.0,
            sustain: 0.0,
            fast_attack_c: 0.0,
            fast_release_c: 0.0,
            slow_attack_c: 0.0,
            slow_release_c: 0.0,
            gain_smooth_c: 0.0,
            fast_env: 0.0,
            slow_env: 0.0,
            smoothed_gain: 1.0,
        };
        t.recompute_coeffs();
        t
    }

    pub fn set_params(&mut self, attack: f32, sustain: f32) {
        self.attack = attack.clamp(-1.0, 1.0);
        self.sustain = sustain.clamp(-1.0, 1.0);
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        self.fast_env = 0.0;
        self.slow_env = 0.0;
        self.smoothed_gain = 1.0;
    }

    /// Process stereo in place. L + R must be the same length.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || (self.attack.abs() < 1e-6 && self.sustain.abs() < 1e-6) {
            return;
        }
        let n = left.len().min(right.len());
        for i in 0..n {
            let mag = left[i].abs().max(right[i].abs());
            let gain = self.compute_gain(mag);
            left[i] *= gain;
            right[i] *= gain;
        }
    }

    /// Process mono in place — same envelope/gain math, single-channel
    /// detection. Useful for the mono `process_*` style of tests below.
    pub fn process_mono(&mut self, buffer: &mut [f32]) {
        if self.bypassed || (self.attack.abs() < 1e-6 && self.sustain.abs() < 1e-6) {
            return;
        }
        for x in buffer.iter_mut() {
            let gain = self.compute_gain(x.abs());
            *x *= gain;
        }
    }

    /// Compute one-pole AR coefficient for a given time-constant. Standard:
    ///     α = exp(−1 / (τ · sr)), τ in seconds; y[n] = α·y[n-1] + (1-α)·x[n].
    fn one_pole_coeff(sample_rate: f32, time_ms: f32) -> f32 {
        let tau_samples = time_ms * 0.001 * sample_rate;
        if tau_samples <= 0.0 {
            0.0
        } else {
            (-1.0 / tau_samples).exp()
        }
    }

    fn recompute_coeffs(&mut self) {
        self.fast_attack_c = Self::one_pole_coeff(self.sample_rate, FAST_ATTACK_MS);
        self.fast_release_c = Self::one_pole_coeff(self.sample_rate, FAST_RELEASE_MS);
        self.slow_attack_c = Self::one_pole_coeff(self.sample_rate, SLOW_ATTACK_MS);
        self.slow_release_c = Self::one_pole_coeff(self.sample_rate, SLOW_RELEASE_MS);
        self.gain_smooth_c = Self::one_pole_coeff(self.sample_rate, GAIN_SMOOTH_MS);
    }

    #[inline(always)]
    fn compute_gain(&mut self, mag: f32) -> f32 {
        // Asymmetric one-pole envelope followers.
        let fast_c = if mag > self.fast_env { self.fast_attack_c } else { self.fast_release_c };
        self.fast_env = fast_c * self.fast_env + (1.0 - fast_c) * mag;

        let slow_c = if mag > self.slow_env { self.slow_attack_c } else { self.slow_release_c };
        self.slow_env = slow_c * self.slow_env + (1.0 - slow_c) * mag;

        // Log-ratio in dB — positive = attack phase, negative = sustain.
        let log_ratio = if self.slow_env > EPSILON && self.fast_env > EPSILON {
            (self.fast_env / self.slow_env).ln() * TWENTY_OVER_LN10
        } else {
            0.0
        };

        let mut gain_db = if log_ratio >= 0.0 {
            self.attack * log_ratio
        } else {
            self.sustain * (-log_ratio)
        };
        gain_db = gain_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB);
        let target = (gain_db * LN10_OVER_TWENTY).exp();

        // Smooth target → smoothed_gain to avoid clicks at fast transitions.
        let c = self.gain_smooth_c;
        self.smoothed_gain = c * self.smoothed_gain + (1.0 - c) * target;
        self.smoothed_gain
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    /// Hat-style transient: short loud burst (5 ms), then quiet body.
    fn transient_burst(sr: f32, n: usize, burst_ms: f32) -> Vec<f32> {
        let burst_samples = ((burst_ms / 1000.0) * sr) as usize;
        let mut v = vec![0.0; n];
        for (i, x) in v.iter_mut().enumerate() {
            if i < burst_samples {
                *x = 0.9 * (2.0 * PI * 4000.0 * i as f32 / sr).sin();
            } else {
                // sustained quiet tail
                *x = 0.05 * (2.0 * PI * 4000.0 * i as f32 / sr).sin();
            }
        }
        v
    }

    fn rms(buf: &[f32]) -> f32 {
        let s: f32 = buf.iter().map(|v| v * v).sum();
        (s / buf.len() as f32).sqrt()
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0_f32, |a, &b| a.max(b.abs()))
    }

    #[test]
    fn zero_params_is_passthrough() {
        let mut t = Transient::new(48000.0);
        t.set_params(0.0, 0.0);
        let mut buf = transient_burst(48000.0, 4096, 5.0);
        let original = buf.clone();
        t.process_mono(&mut buf);
        for (a, b) in buf.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "expected passthrough at attack=sustain=0");
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut t = Transient::new(48000.0);
        t.set_params(1.0, -1.0); // would change a lot
        t.set_bypassed(true);
        let mut buf = transient_burst(48000.0, 4096, 5.0);
        let original = buf.clone();
        t.process_mono(&mut buf);
        for (a, b) in buf.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn positive_attack_boosts_burst_peak() {
        let in_burst = transient_burst(48000.0, 8192, 5.0);
        let in_peak = peak(&in_burst[..480]); // first 10 ms
        let mut buf = in_burst.clone();
        let mut t = Transient::new(48000.0);
        t.set_params(1.0, 0.0); // strong attack boost
        t.process_mono(&mut buf);
        let out_peak = peak(&buf[..480]);
        assert!(
            out_peak > in_peak * 1.1,
            "expected boosted transient peak; in={in_peak} out={out_peak}"
        );
    }

    #[test]
    fn negative_attack_softens_burst_peak() {
        let in_burst = transient_burst(48000.0, 8192, 5.0);
        let in_peak = peak(&in_burst[..480]);
        let mut buf = in_burst.clone();
        let mut t = Transient::new(48000.0);
        t.set_params(-1.0, 0.0); // softening attacks
        t.process_mono(&mut buf);
        let out_peak = peak(&buf[..480]);
        assert!(
            out_peak < in_peak * 0.95,
            "expected softened transient peak; in={in_peak} out={out_peak}"
        );
    }

    #[test]
    fn negative_sustain_quiets_tail() {
        // For sustain attenuation to bite, the slow envelope needs to
        // actually be tracking the loud part — a 5 ms burst is shorter than
        // its 30 ms attack, so it never catches up. Use 100 ms of loud
        // signal then quiet, and measure the window right after the loud
        // section where slow_env is still high but fast_env has dropped.
        let sr = 48000.0_f32;
        let loud_ms = 100.0;
        let total = (sr as usize) / 2; // 500 ms
        let loud_end = ((loud_ms / 1000.0) * sr) as usize;
        let window_start = loud_end + (60.0 / 1000.0 * sr) as usize; // +60 ms
        let window_end = loud_end + (200.0 / 1000.0 * sr) as usize; // +200 ms

        let make = || -> Vec<f32> {
            let mut v = vec![0.0_f32; total];
            for (i, x) in v.iter_mut().enumerate() {
                let amp = if i < loud_end { 0.8 } else { 0.1 };
                *x = amp * (2.0 * PI * 4000.0 * i as f32 / sr).sin();
            }
            v
        };

        let in_buf = make();
        let in_tail = rms(&in_buf[window_start..window_end]);
        let mut out_buf = make();
        let mut t = Transient::new(sr);
        t.set_params(0.0, -1.0);
        t.process_mono(&mut out_buf);
        let out_tail = rms(&out_buf[window_start..window_end]);
        assert!(
            out_tail < in_tail * 0.9,
            "expected reduced sustain energy; in_tail={in_tail} out_tail={out_tail}"
        );
    }

    #[test]
    fn stereo_link_means_equal_attenuation() {
        // L is loud, R is quiet. With link-stereo detection, attack=-1
        // should clamp BOTH channels in step (no image shift).
        let mut l: Vec<f32> = (0..2048).map(|i| 0.9 * (2.0 * PI * 4000.0 * i as f32 / 48000.0).sin()).collect();
        let mut r: Vec<f32> = (0..2048).map(|i| 0.2 * (2.0 * PI * 4000.0 * i as f32 / 48000.0).sin()).collect();
        let l_in_peak = peak(&l);
        let r_in_peak = peak(&r);
        let mut t = Transient::new(48000.0);
        t.set_params(-1.0, 0.0);
        t.process_stereo(&mut l, &mut r);
        let l_out_peak = peak(&l);
        let r_out_peak = peak(&r);
        // L should attenuate. R was already near its quiet sustain level,
        // and stereo-linked detection means R was treated as "loud" too —
        // so its peak shouldn't have grown.
        assert!(l_out_peak < l_in_peak * 0.95, "L should attenuate");
        assert!(r_out_peak <= r_in_peak * 1.05, "R shouldn't be boosted");
    }
}
