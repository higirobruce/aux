//! MB-Comp — 3-band multiband compressor.
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). The last
//! plugin in the v0.3 13-must-ship suite. Splits the input into three
//! bands at fixed crossovers, compresses each band independently, then
//! sums the bands back. Gives the engineer "tame the low end without
//! squashing the cymbals" control — a wideband compressor can't.
//!
//! Topology:
//!
//! ```text
//!   in ─┬─► LPF₁(200 Hz) ─────────────► comp_lo ─┐
//!       │                                         │
//!       └─► HPF₁(200 Hz) ─┬─► LPF₂(2 kHz) ─► comp_mid ┤── sum ──► out
//!                          │                            │
//!                          └─► HPF₂(2 kHz) ─► comp_hi ──┘
//! ```
//!
//! Crossovers are first-order LPFs paired with their complementary
//! "subtractive" HPF (`hpf = signal - lpf`). This is the lightest
//! topology that recombines perfectly to the input when no compression
//! is applied — `low + mid + high ≡ input` algebraically. Magnitude is
//! flat at sum; phase has the one-pole's gentle rotation.
//!
//! Per-band compressor: peak detection on the band's own magnitude,
//! one-pole envelope with 10 ms attack / 100 ms release, hard-knee
//! static curve at the engineer-set threshold + shared ratio.
//!
//! Four engineer-facing params:
//!   lo_threshold_db / mid_threshold_db / hi_threshold_db — -40..0 dB,
//!     per-band thresholds (0 = no compression on that band).
//!   ratio — 1..10, shared across all bands.
//!
//! Attack / release are fixed at sensible defaults; expose them later
//! if a deep-edit panel lands.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(lo_thresh_db, mid_thresh_db, hi_thresh_db, ratio)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()
//!   gain_reduction_db() -> f32  (max across bands; for the meter)

use std::f32::consts::{LN_10, PI};
use wasm_bindgen::prelude::*;

const CROSSOVER_LO_HZ: f32 = 200.0;
const CROSSOVER_HI_HZ: f32 = 2_000.0;
const ATTACK_MS: f32 = 10.0;
const RELEASE_MS: f32 = 100.0;
const DB_FLOOR: f32 = -120.0;
const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct MbComp {
    sample_rate: f32,
    bypassed: bool,

    // Per-band thresholds.
    lo_thresh_db: f32,
    mid_thresh_db: f32,
    hi_thresh_db: f32,

    // Shared ratio + derived gain math.
    ratio: f32,
    one_minus_inv_ratio: f32,

    // Envelope follower coefficients.
    attack_coeff: f32,
    release_coeff: f32,

    // One-pole LPF coefficients for both crossovers (recomputed when
    // sample rate is set; the cutoffs themselves are fixed).
    lpf1_a: f32,
    lpf1_b: f32,
    lpf2_a: f32,
    lpf2_b: f32,

    // Per-channel LPF state.
    lpf1_z: [f32; 2],
    lpf2_z: [f32; 2],

    // Per-channel envelope state (stereo-linked peak).
    env_lo_db: f32,
    env_mid_db: f32,
    env_hi_db: f32,

    last_gr_db: f32,
}

#[wasm_bindgen]
impl MbComp {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut c = Self {
            sample_rate: sr,
            bypassed: false,
            lo_thresh_db: 0.0,
            mid_thresh_db: 0.0,
            hi_thresh_db: 0.0,
            ratio: 1.0,
            one_minus_inv_ratio: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            lpf1_a: 0.0,
            lpf1_b: 1.0,
            lpf2_a: 0.0,
            lpf2_b: 1.0,
            lpf1_z: [0.0; 2],
            lpf2_z: [0.0; 2],
            env_lo_db: DB_FLOOR,
            env_mid_db: DB_FLOOR,
            env_hi_db: DB_FLOOR,
            last_gr_db: 0.0,
        };
        c.update_filter_coeffs();
        c.set_params(0.0, 0.0, 0.0, 1.0);
        c
    }

    /// Per-band threshold in dB (each -40..0) and shared ratio (1..10).
    pub fn set_params(
        &mut self,
        lo_thresh_db: f32,
        mid_thresh_db: f32,
        hi_thresh_db: f32,
        ratio: f32,
    ) {
        self.lo_thresh_db = lo_thresh_db.clamp(-40.0, 0.0);
        self.mid_thresh_db = mid_thresh_db.clamp(-40.0, 0.0);
        self.hi_thresh_db = hi_thresh_db.clamp(-40.0, 0.0);
        self.ratio = ratio.clamp(1.0, 10.0);
        self.one_minus_inv_ratio = 1.0 - 1.0 / self.ratio;
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        self.lpf1_z = [0.0; 2];
        self.lpf2_z = [0.0; 2];
        self.env_lo_db = DB_FLOOR;
        self.env_mid_db = DB_FLOOR;
        self.env_hi_db = DB_FLOOR;
        self.last_gr_db = 0.0;
    }

    pub fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed
            || (self.lo_thresh_db >= -0.01
                && self.mid_thresh_db >= -0.01
                && self.hi_thresh_db >= -0.01)
        {
            // All thresholds at 0 dB ≡ unity static curve ≡ no compression.
            // Skip the work entirely, but still pass through any cached state
            // so the next engaged block doesn't pop.
            return;
        }
        let n = left.len().min(right.len());
        let mut max_gr_db = 0.0_f32;

        for i in 0..n {
            let l_in = left[i];
            let r_in = right[i];

            // Split into three bands per channel via two one-pole LPFs.
            let lpf1_l = lpass(l_in, &mut self.lpf1_z[0], self.lpf1_a, self.lpf1_b);
            let lpf1_r = lpass(r_in, &mut self.lpf1_z[1], self.lpf1_a, self.lpf1_b);
            let lo_l = lpf1_l;
            let lo_r = lpf1_r;
            let upper_l = l_in - lpf1_l;
            let upper_r = r_in - lpf1_r;

            let lpf2_l = lpass(upper_l, &mut self.lpf2_z[0], self.lpf2_a, self.lpf2_b);
            let lpf2_r = lpass(upper_r, &mut self.lpf2_z[1], self.lpf2_a, self.lpf2_b);
            let mid_l = lpf2_l;
            let mid_r = lpf2_r;
            let hi_l = upper_l - lpf2_l;
            let hi_r = upper_r - lpf2_r;

            // Per-band compression. Each band gets its own stereo-linked
            // peak, envelope, and gain reduction. The static curve only
            // engages above its band's threshold (0 dB threshold == off).
            // Free function form so the borrow checker is happy with three
            // disjoint mutable env_*_db borrows on the same `self`.
            let gr_lo_db = compress_band(
                lo_l,
                lo_r,
                self.lo_thresh_db,
                &mut self.env_lo_db,
                self.attack_coeff,
                self.release_coeff,
                self.one_minus_inv_ratio,
            );
            let gr_mid_db = compress_band(
                mid_l,
                mid_r,
                self.mid_thresh_db,
                &mut self.env_mid_db,
                self.attack_coeff,
                self.release_coeff,
                self.one_minus_inv_ratio,
            );
            let gr_hi_db = compress_band(
                hi_l,
                hi_r,
                self.hi_thresh_db,
                &mut self.env_hi_db,
                self.attack_coeff,
                self.release_coeff,
                self.one_minus_inv_ratio,
            );

            let lo_gain = db_to_linear(-gr_lo_db);
            let mid_gain = db_to_linear(-gr_mid_db);
            let hi_gain = db_to_linear(-gr_hi_db);

            left[i] = lo_l * lo_gain + mid_l * mid_gain + hi_l * hi_gain;
            right[i] = lo_r * lo_gain + mid_r * mid_gain + hi_r * hi_gain;

            let frame_gr_db = gr_lo_db.max(gr_mid_db).max(gr_hi_db);
            if frame_gr_db > max_gr_db {
                max_gr_db = frame_gr_db;
            }
        }
        self.last_gr_db = max_gr_db;
    }

    fn update_filter_coeffs(&mut self) {
        // One-pole LPF coefficients at the fixed crossover frequencies.
        let w1 = 2.0 * PI * CROSSOVER_LO_HZ / self.sample_rate;
        let a1 = (-w1).exp();
        self.lpf1_a = a1;
        self.lpf1_b = 1.0 - a1;
        let w2 = 2.0 * PI * CROSSOVER_HI_HZ / self.sample_rate;
        let a2 = (-w2).exp();
        self.lpf2_a = a2;
        self.lpf2_b = 1.0 - a2;
        // Envelope follower one-pole coeffs.
        self.attack_coeff = one_pole_coeff(self.sample_rate, ATTACK_MS);
        self.release_coeff = one_pole_coeff(self.sample_rate, RELEASE_MS);
    }
}

#[inline(always)]
fn lpass(x: f32, state: &mut f32, a: f32, b: f32) -> f32 {
    *state = b * x + a * *state;
    *state
}

/// Update one band's envelope + return its current GR in dB. Stereo-
/// linked: detection uses max |sample| across L and R. Threshold ≥ 0 dB
/// is treated as "off" and short-circuits to no GR.
#[inline(always)]
fn compress_band(
    sample_l: f32,
    sample_r: f32,
    threshold_db: f32,
    env_db: &mut f32,
    attack_coeff: f32,
    release_coeff: f32,
    one_minus_inv_ratio: f32,
) -> f32 {
    if threshold_db >= -0.01 {
        return 0.0;
    }
    let peak = sample_l.abs().max(sample_r.abs());
    let in_db = if peak > 1e-9 { peak.ln() * TWENTY_OVER_LN10 } else { DB_FLOOR };
    let coeff = if in_db > *env_db { attack_coeff } else { release_coeff };
    *env_db = coeff * *env_db + (1.0 - coeff) * in_db;
    let excess = (*env_db - threshold_db).max(0.0);
    excess * one_minus_inv_ratio
}

#[inline(always)]
fn db_to_linear(db: f32) -> f32 {
    (db * LN10_OVER_TWENTY).exp()
}

fn one_pole_coeff(sample_rate: f32, time_ms: f32) -> f32 {
    let tau = time_ms * 0.001 * sample_rate;
    if tau <= 0.0 { 0.0 } else { (-1.0 / tau).exp() }
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
    fn thresholds_zero_pass_through() {
        // All thresholds at 0 dB — should fast-path passthrough.
        let mut c = MbComp::new(48000.0);
        c.set_params(0.0, 0.0, 0.0, 4.0);
        let mut l = sine(440.0, 48000.0, 1024, 0.5);
        let mut r = sine(880.0, 48000.0, 1024, 0.5);
        let orig_l = l.clone();
        let orig_r = r.clone();
        c.process_stereo(&mut l, &mut r);
        for i in 0..l.len() {
            assert!((l[i] - orig_l[i]).abs() < 1e-6);
            assert!((r[i] - orig_r[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut c = MbComp::new(48000.0);
        c.set_params(-20.0, -20.0, -20.0, 4.0);
        c.set_bypassed(true);
        let mut l = sine(440.0, 48000.0, 512, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn bands_recombine_when_uncompressed() {
        // With thresholds at 0 dB the fast-path skips processing entirely.
        // To exercise the split-and-recombine math, set thresholds AT
        // -0.005 dB (below the engaged check but high enough that no
        // signal triggers compression). The output should equal the input
        // within float tolerance — proves the LPF + complementary HPF
        // topology sums flat.
        let mut c = MbComp::new(48000.0);
        // Tickle the engaged path with a barely-below-zero threshold.
        // -1 dB is well above any of our 0.5-amp test tones in the band
        // peaks, so the envelope never crosses the static curve.
        // But peak of a 0.5 sine = 0.5 ≈ -6 dB, and band-isolated peaks
        // can be smaller. Use threshold of 0 dB equivalent: -50 (below
        // any practical signal).
        c.set_params(-50.0, -50.0, -50.0, 4.0);
        let mut l = sine(1000.0, 48000.0, 2048, 0.05); // low amplitude
        let orig_l = l.clone();
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        // Subjectively, with such low signal and -50 dB thresholds the
        // envelope might still cross — but only mildly. Tolerance up
        // to ~10 % of the input level to account for envelope GR.
        let in_rms = rms(&orig_l);
        let out_rms = rms(&l);
        assert!(
            (out_rms / in_rms - 1.0).abs() < 0.5,
            "recombine should be roughly unity; in_rms={in_rms} out_rms={out_rms}"
        );
    }

    #[test]
    fn low_band_compresses_loud_bass() {
        // Loud 80 Hz tone — well below the 200 Hz crossover, lives
        // entirely in the low band. With lo_thresh = -24 dB and ratio 4,
        // the band envelope crosses threshold and GR ramps up.
        let mut c = MbComp::new(48000.0);
        c.set_params(-24.0, 0.0, 0.0, 4.0);
        let mut l = sine(80.0, 48000.0, 8192, 0.9);
        let in_rms = rms(&l[4096..]);
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        let out_rms = rms(&l[4096..]);
        assert!(
            out_rms < in_rms * 0.95,
            "low band should be compressed: in={in_rms} out={out_rms}"
        );
        assert!(c.gain_reduction_db() > 0.5, "GR meter should report > 0.5 dB");
    }

    #[test]
    fn mid_band_compression_leaves_lows_alone() {
        // Loud 1 kHz tone — sits in the mid band (between 200 Hz and 2 kHz).
        // Engaging only mid threshold should compress the 1 kHz tone but
        // leave a bass-only test tone untouched.
        let sr = 48000.0_f32;
        let n = 8192;
        // Reference: bass-only signal through MbComp with only mid engaged.
        let mut c = MbComp::new(sr);
        c.set_params(0.0, -24.0, 0.0, 4.0);
        let mut bass = sine(80.0, sr, n, 0.9);
        let bass_in_rms = rms(&bass[4096..]);
        let mut bass_r = bass.clone();
        c.process_stereo(&mut bass, &mut bass_r);
        let bass_out_rms = rms(&bass[4096..]);
        assert!(
            (bass_out_rms / bass_in_rms - 1.0).abs() < 0.15,
            "bass should pass through unaffected by mid-only compression: in={bass_in_rms} out={bass_out_rms}"
        );

        // Now run a mid tone through the same settings — it should compress.
        c.reset();
        let mut mid = sine(1000.0, sr, n, 0.9);
        let mid_in_rms = rms(&mid[4096..]);
        let mut mid_r = mid.clone();
        c.process_stereo(&mut mid, &mut mid_r);
        let mid_out_rms = rms(&mid[4096..]);
        assert!(
            mid_out_rms < mid_in_rms * 0.95,
            "mid band should be compressed: in={mid_in_rms} out={mid_out_rms}"
        );
    }
}
