//! Comp-Clean — VCA-style compressor.
//!
//! Per docs/implementation.html §07 (Native plugins, v1 suite). Classic feed-
//! forward design — sense the signal level, compute a gain reduction in dB,
//! smooth it through an attack/release envelope, then apply back as a linear
//! gain. "Clean" because there's no soft-clip or harmonic colouration — that
//! belongs in Comp-Color (FET-style).
//!
//! Signal flow per sample:
//!
//! ```text
//!     input ──┬──────────► (× wet) ──┐
//!             │                       ├─► output
//!             ▼                       │
//!         |peak|  ←   sum L/R, abs ── │
//!             │                       │
//!         to dB                       │
//!             │                       │
//!     excess = max(0, db − thresh)    │
//!             │                       │
//!     gain_red = excess × (1 − 1/r)   │
//!             │                       │
//!     smoothed ← attack/release       │
//!             │                       │
//!     linear = 10^((makeup − gr)/20)  │
//!             │                       │
//!         ───▼──► (× input)           │
//!     wet path                        │
//!             ├──► (× (1 − wet)) ── input dry path
//! ```
//!
//! Stereo: peak detection is on the max of L + R so left/right stay linked
//! (standard for buss / channel comp; dual-mono is an option for later).
//!
//! ABI (wasm-bindgen):
//!   - new(sample_rate)
//!   - set_params(threshold_db, ratio, attack_ms, release_ms, makeup_db, mix)
//!   - set_bypassed(bool)
//!   - process_stereo(&mut [f32] left, &mut [f32] right)
//!   - reset()
//!   - gain_reduction_db()  → meter feedback

use std::f32::consts::LN_10;
use wasm_bindgen::prelude::*;

const MIN_RATIO: f32 = 1.0;
const MAX_RATIO: f32 = 20.0;
const MIN_ATTACK_MS: f32 = 0.1;
const MIN_RELEASE_MS: f32 = 5.0;
const DB_FLOOR: f32 = -120.0;

/// 20 / ln(10) — multiply by ln(x) to get x in dB.
const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
/// ln(10) / 20 — multiply by dB to feed into exp() for linear gain.
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct CompClean {
    sample_rate: f32,
    bypassed: bool,

    // User-set params.
    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
    makeup_db: f32,
    mix: f32, // 0..1; 1 = full wet

    // Derived per-sample coefficients (recomputed when params change).
    attack_coeff: f32,
    release_coeff: f32,

    // Envelope follower state — held between blocks.
    envelope_db: f32,

    // Latest gain reduction, in dB (positive value = attenuation). Surfaced
    // through gain_reduction_db() for meter display.
    last_gr_db: f32,
}

#[wasm_bindgen]
impl CompClean {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut c = Self {
            sample_rate: sr,
            bypassed: false,
            threshold_db: 0.0,
            ratio: 1.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            makeup_db: 0.0,
            mix: 1.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            envelope_db: DB_FLOOR,
            last_gr_db: 0.0,
        };
        c.recompute_coeffs();
        c
    }

    /// Set all params at once. Validates + clamps. Cheap; safe to call per
    /// pointer-drag.
    pub fn set_params(
        &mut self,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
        mix: f32,
    ) {
        self.threshold_db = threshold_db.clamp(-80.0, 12.0);
        self.ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        self.attack_ms = attack_ms.max(MIN_ATTACK_MS);
        self.release_ms = release_ms.max(MIN_RELEASE_MS);
        self.makeup_db = makeup_db.clamp(-24.0, 24.0);
        self.mix = mix.clamp(0.0, 1.0);
        self.recompute_coeffs();
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    /// Most recent gain reduction in dB (>= 0). Read by the host for meter
    /// display; updates every block. Reset() clears.
    pub fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }

    pub fn reset(&mut self) {
        self.envelope_db = DB_FLOOR;
        self.last_gr_db = 0.0;
    }

    /// Process one block, stereo, in place. L and R MUST be the same length.
    /// Mono callers can pass the same buffer for both args — peak detection
    /// becomes a single-channel max which is correct for mono.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.ratio <= 1.0 + 1e-6 {
            // No-op fast path — equivalent to ratio 1:1 with mix 100%.
            return;
        }
        let n = left.len().min(right.len());
        let makeup_lin = (self.makeup_db * LN10_OVER_TWENTY).exp();
        let one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;
        let mut max_gr_db = 0.0_f32;

        for i in 0..n {
            let l_in = left[i];
            let r_in = right[i];
            let peak = l_in.abs().max(r_in.abs());

            // Convert to dB; floor at DB_FLOOR for silence.
            let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };

            // Envelope follower — one-pole filter, asymmetric attack/release.
            // Attack when the input exceeds the running envelope.
            let coeff = if in_db > self.envelope_db { self.attack_coeff } else { self.release_coeff };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * in_db;

            // Hard-knee static curve.
            let excess = (self.envelope_db - self.threshold_db).max(0.0);
            let gr_db = excess * one_minus_inv_ratio;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }

            // Net linear gain = makeup × 10^(-gr/20)
            let net_gain = makeup_lin * (-gr_db * LN10_OVER_TWENTY).exp();

            // Dry/wet mix on linear samples.
            let l_wet = l_in * net_gain;
            let r_wet = r_in * net_gain;
            left[i] = l_in + (l_wet - l_in) * self.mix;
            right[i] = r_in + (r_wet - r_in) * self.mix;
        }

        self.last_gr_db = max_gr_db;
    }

    /// Mono convenience — peak detection on a single channel.
    pub fn process_mono(&mut self, buffer: &mut [f32]) {
        if self.bypassed || self.ratio <= 1.0 + 1e-6 {
            return;
        }
        let makeup_lin = (self.makeup_db * LN10_OVER_TWENTY).exp();
        let one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;
        let mut max_gr_db = 0.0_f32;

        for x in buffer.iter_mut() {
            let peak = x.abs();
            let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };
            let coeff = if in_db > self.envelope_db { self.attack_coeff } else { self.release_coeff };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * in_db;

            let excess = (self.envelope_db - self.threshold_db).max(0.0);
            let gr_db = excess * one_minus_inv_ratio;
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
            let net_gain = makeup_lin * (-gr_db * LN10_OVER_TWENTY).exp();
            let wet = *x * net_gain;
            *x += (wet - *x) * self.mix;
        }

        self.last_gr_db = max_gr_db;
    }

    /// One-pole filter coefficient for a given time constant. Standard form:
    ///     y[n] = α · y[n−1] + (1−α) · x[n]
    /// where α = exp(−1 / (τ · sr)). τ is in seconds. For an exponential
    /// approach this is the time-to-63% rise; we approximate "time to
    /// settled" as ≈ τ × 5.
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
        use std::f32::consts::PI;
        (0..n).map(|i| amp * (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn unity_ratio_is_passthrough() {
        let mut c = CompClean::new(48000.0);
        c.set_params(-20.0, 1.0, 10.0, 100.0, 0.0, 1.0);
        let mut input = sine(440.0, 48000.0, 1024, 0.5);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "expected unity-ratio passthrough");
        }
    }

    #[test]
    fn bypassed_is_passthrough() {
        let mut c = CompClean::new(48000.0);
        c.set_params(-40.0, 10.0, 1.0, 50.0, 6.0, 1.0); // would compress hard
        c.set_bypassed(true);
        let mut input = sine(440.0, 48000.0, 1024, 0.8);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "bypass must be transparent");
        }
    }

    #[test]
    fn signal_above_threshold_is_attenuated() {
        // Loud sine above threshold should be reduced after attack settles.
        let mut c = CompClean::new(48000.0);
        c.set_params(-20.0, 4.0, 1.0, 50.0, 0.0, 1.0);
        let mut input = sine(440.0, 48000.0, 8192, 0.5); // ~-6 dB peak
        let original_rms = rms(&input);
        c.process_mono(&mut input);
        let settled_rms = rms(&input[4096..]); // skip attack transient
        assert!(
            settled_rms < original_rms * 0.7,
            "expected ≥30% attenuation; in={original_rms:.4} out={settled_rms:.4}"
        );
        assert!(c.gain_reduction_db() > 6.0, "expected ≥6 dB GR, got {}", c.gain_reduction_db());
    }

    #[test]
    fn signal_below_threshold_is_untouched() {
        // Quiet sine below threshold should pass through unchanged.
        let mut c = CompClean::new(48000.0);
        c.set_params(-6.0, 8.0, 1.0, 50.0, 0.0, 1.0);
        let mut input = sine(440.0, 48000.0, 4096, 0.1); // ~-20 dB peak
        let original = input.clone();
        c.process_mono(&mut input);
        // Skip the very first samples (envelope is at -120 dB floor and rising).
        for (a, b) in input.iter().zip(original.iter()).skip(1024) {
            assert!(
                (a - b).abs() < 1e-3,
                "below-threshold drift exceeded tolerance: |Δ|={}",
                (a - b).abs()
            );
        }
        assert!(c.gain_reduction_db() < 0.1);
    }

    #[test]
    fn dry_mix_blends_back_input() {
        // mix = 0 → pure dry → no change.
        let mut c = CompClean::new(48000.0);
        c.set_params(-30.0, 8.0, 1.0, 50.0, 0.0, 0.0);
        let mut input = sine(440.0, 48000.0, 1024, 0.8);
        let original = input.clone();
        c.process_mono(&mut input);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "mix=0 should be fully dry");
        }
    }

    #[test]
    fn makeup_gain_compensates() {
        // Compress hard then add makeup; output RMS should be similar to input.
        let mut c = CompClean::new(48000.0);
        c.set_params(-30.0, 8.0, 1.0, 50.0, 12.0, 1.0);
        let mut input = sine(440.0, 48000.0, 8192, 0.3);
        let in_rms = rms(&input);
        c.process_mono(&mut input);
        let out_rms = rms(&input[4096..]);
        // We're not pixel-matching — just confirming the makeup gain pulled
        // the level back into the same ballpark (within 6 dB either way).
        let ratio = out_rms / in_rms;
        assert!(ratio > 0.5 && ratio < 2.0, "expected ±6 dB of input, got ratio {ratio:.2}");
    }
}
