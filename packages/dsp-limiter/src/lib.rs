//! Limiter — look-ahead brick-wall peak limiter for the master bus.
//!
//! Per docs/implementation.html §07 v1 suite (must-ship). Designed for the
//! final-stage Master chain — keeps peaks at or below `threshold_db`, with
//! a short look-ahead window so gain reduction can be in place *before* a
//! transient arrives. Uses a sample-domain peak detector (not true-peak /
//! ISP); good enough for v0.3, swap for an oversampled true-peak detector
//! when the ship-gate calls for it.
//!
//! Signal flow per sample:
//!
//! ```text
//!     in ─► × makeup ─┬─► delay (lookahead) ───┬──► × current_gain ─► out
//!                     │                         │
//!                     ▼                         │
//!               look-ahead window               │
//!               (find max |x|)                  │
//!                     │                         │
//!               target_gain = min(1,            │
//!                 threshold / peak)             │
//!                     │                         │
//!                  smoother  ────► current_gain ┘
//! ```
//!
//! Stereo: the look-ahead window's peak is `max(|L|, |R|)` so left and
//! right stay linked (any other choice causes lateral image shift at
//! limit). Both channels share the same delay length.
//!
//! ABI (wasm-bindgen): identical shape to the other plugins —
//!   new(sample_rate)
//!   set_params(threshold_db, release_ms, makeup_db)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   process_mono(&mut [f32])
//!   gain_reduction_db() -> f32
//!   reset()

use std::f32::consts::LN_10;
use wasm_bindgen::prelude::*;

const LOOKAHEAD_MS: f32 = 5.0;
const ATTACK_MS: f32 = 1.0; // gain reduction reaches target in ~1 ms
const MIN_RELEASE_MS: f32 = 10.0;
const DB_FLOOR: f32 = -120.0;

const TWENTY_OVER_LN10: f32 = 20.0 / LN_10;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct Limiter {
    sample_rate: f32,
    bypassed: bool,

    threshold_db: f32,
    threshold_lin: f32,
    release_ms: f32,
    release_coeff: f32,
    attack_coeff: f32,
    makeup_db: f32,
    makeup_lin: f32,

    /// Look-ahead in samples. The delay buffer holds this many samples.
    lookahead_samples: usize,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    write_idx: usize,

    /// Running gain reduction in linear (0..1). 1 = no GR; 0 = silence.
    current_gain: f32,
    last_gr_db: f32,
}

#[wasm_bindgen]
impl Limiter {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let lookahead = ((LOOKAHEAD_MS / 1000.0) * sr).ceil() as usize;
        let cap = lookahead.max(1);
        let mut limiter = Self {
            sample_rate: sr,
            bypassed: false,
            threshold_db: 0.0,
            threshold_lin: 1.0,
            release_ms: 100.0,
            release_coeff: 0.0,
            attack_coeff: 0.0,
            makeup_db: 0.0,
            makeup_lin: 1.0,
            lookahead_samples: lookahead,
            delay_l: vec![0.0; cap],
            delay_r: vec![0.0; cap],
            write_idx: 0,
            current_gain: 1.0,
            last_gr_db: 0.0,
        };
        limiter.recompute_coeffs();
        limiter
    }

    /// Set all three user-facing params at once.
    /// - threshold_db: −24..0 dBFS (the peak ceiling).
    /// - release_ms:   ≥ 10 ms.
    /// - makeup_db:    −12..+24 dB (pre-limit gain).
    pub fn set_params(&mut self, threshold_db: f32, release_ms: f32, makeup_db: f32) {
        self.threshold_db = threshold_db.clamp(-24.0, 0.0);
        self.threshold_lin = (self.threshold_db * LN10_OVER_TWENTY).exp();
        self.release_ms = release_ms.max(MIN_RELEASE_MS);
        self.makeup_db = makeup_db.clamp(-12.0, 24.0);
        self.makeup_lin = (self.makeup_db * LN10_OVER_TWENTY).exp();
        self.recompute_coeffs();
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn gain_reduction_db(&self) -> f32 {
        self.last_gr_db
    }

    pub fn reset(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.write_idx = 0;
        self.current_gain = 1.0;
        self.last_gr_db = 0.0;
    }

    /// Look-ahead samples — useful for the host to report PDC.
    pub fn latency_samples(&self) -> u32 {
        self.lookahead_samples as u32
    }

    /// Process stereo in place. L and R must be the same length.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed {
            return;
        }
        let n = left.len().min(right.len());
        let cap = self.lookahead_samples;
        if cap == 0 {
            return;
        }
        let mut max_gr_db = 0.0_f32;

        for i in 0..n {
            // Read the sample that's about to leave the delay (its window has
            // been fully observed). On the very first calls this is silence,
            // which is the standard "latency" cost of a look-ahead limiter.
            let read_idx = self.write_idx;
            let out_l_pre = self.delay_l[read_idx] * self.makeup_lin;
            let out_r_pre = self.delay_r[read_idx] * self.makeup_lin;

            // Write current input to the same slot — slot was just consumed.
            self.delay_l[read_idx] = left[i];
            self.delay_r[read_idx] = right[i];
            self.write_idx = (self.write_idx + 1) % cap;

            // Look-ahead peak across the buffer (linear). This is O(N) per
            // sample × N samples per block, which is O(N²). With N ≈ 240
            // (5 ms @ 48 kHz) and a typical 128-sample block, this is well
            // under 1% CPU. Swap for a sliding-max ring once we have profile
            // data demanding it.
            let mut peak = 0.0_f32;
            for k in 0..cap {
                let l = self.delay_l[k] * self.makeup_lin;
                let r = self.delay_r[k] * self.makeup_lin;
                let a = l.abs().max(r.abs());
                if a > peak {
                    peak = a;
                }
            }

            // Target gain — bring the worst-case window peak down to the
            // threshold; never above 1 (don't try to *boost*).
            let target_gain = if peak > self.threshold_lin {
                self.threshold_lin / peak
            } else {
                1.0
            };

            // Smooth: fast attack toward smaller gain, configured release
            // toward larger gain. (Asymmetric so the limiter clamps quickly
            // but lets quiet sections breathe.)
            let coeff = if target_gain < self.current_gain {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.current_gain = coeff * self.current_gain + (1.0 - coeff) * target_gain;

            left[i] = out_l_pre * self.current_gain;
            right[i] = out_r_pre * self.current_gain;

            let gr_db = if self.current_gain > 0.0 {
                -(self.current_gain.ln() * TWENTY_OVER_LN10)
            } else {
                -DB_FLOOR
            };
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
        }

        self.last_gr_db = max_gr_db;
    }

    /// Mono in place — same delay buffer used for both reads/writes via L.
    pub fn process_mono(&mut self, buffer: &mut [f32]) {
        if self.bypassed {
            return;
        }
        let cap = self.lookahead_samples;
        if cap == 0 {
            return;
        }
        let mut max_gr_db = 0.0_f32;

        for x in buffer.iter_mut() {
            let read_idx = self.write_idx;
            let out_pre = self.delay_l[read_idx] * self.makeup_lin;
            self.delay_l[read_idx] = *x;
            self.write_idx = (self.write_idx + 1) % cap;

            let mut peak = 0.0_f32;
            for k in 0..cap {
                let a = (self.delay_l[k] * self.makeup_lin).abs();
                if a > peak {
                    peak = a;
                }
            }

            let target_gain = if peak > self.threshold_lin {
                self.threshold_lin / peak
            } else {
                1.0
            };
            let coeff = if target_gain < self.current_gain {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.current_gain = coeff * self.current_gain + (1.0 - coeff) * target_gain;

            *x = out_pre * self.current_gain;

            let gr_db = if self.current_gain > 0.0 {
                -(self.current_gain.ln() * TWENTY_OVER_LN10)
            } else {
                -DB_FLOOR
            };
            if gr_db > max_gr_db {
                max_gr_db = gr_db;
            }
        }

        self.last_gr_db = max_gr_db;
    }

    fn recompute_coeffs(&mut self) {
        self.attack_coeff = Self::one_pole_coeff(self.sample_rate, ATTACK_MS);
        self.release_coeff = Self::one_pole_coeff(self.sample_rate, self.release_ms);
    }

    fn one_pole_coeff(sample_rate: f32, time_ms: f32) -> f32 {
        let tau_samples = time_ms * 0.001 * sample_rate;
        if tau_samples <= 0.0 {
            0.0
        } else {
            (-1.0 / tau_samples).exp()
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0_f32, |a, &b| a.max(b.abs()))
    }

    #[test]
    fn quiet_signal_passes_with_only_delay() {
        // Below threshold — output should match input after the look-ahead
        // delay. We compare RMS to avoid the cold-start zeroes muddying.
        let mut lim = Limiter::new(48000.0);
        lim.set_params(0.0, 100.0, 0.0);
        let mut buf = sine(440.0, 48000.0, 4096, 0.1);
        let in_peak = peak(&buf);
        lim.process_mono(&mut buf);
        let out_peak = peak(&buf[2048..]); // skip warmup
        // 0.1 amplitude, 0 dB threshold → no limiting. Output peak ≈ input peak.
        assert!(
            (out_peak - in_peak).abs() < 0.01,
            "expected near-passthrough at -20 dB; in={in_peak} out={out_peak}"
        );
    }

    #[test]
    fn loud_signal_is_clamped_below_threshold() {
        // Hot input, threshold at −6 dB → output peak must not exceed it.
        let mut lim = Limiter::new(48000.0);
        lim.set_params(-6.0, 50.0, 0.0);
        let mut buf = sine(440.0, 48000.0, 8192, 1.0);
        lim.process_mono(&mut buf);
        let out_peak = peak(&buf[4096..]);
        // -6 dB ≈ 0.5012 linear. Allow a tiny slop for the smoother + the
        // very first lookahead window settling.
        assert!(
            out_peak < 0.52,
            "expected peak ≤ -6 dB threshold; got {out_peak}"
        );
        assert!(lim.gain_reduction_db() > 4.0);
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut lim = Limiter::new(48000.0);
        lim.set_params(-12.0, 50.0, 6.0); // would limit hard
        lim.set_bypassed(true);
        let mut buf = sine(440.0, 48000.0, 1024, 0.8);
        let original = buf.clone();
        lim.process_mono(&mut buf);
        for (a, b) in buf.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn makeup_below_threshold_increases_level() {
        // Input is quiet; +6 dB makeup, threshold at 0 → output is ~2× input
        // (no limiting yet since 0.1 × 2 = 0.2 << 1.0).
        let mut lim = Limiter::new(48000.0);
        lim.set_params(0.0, 50.0, 6.0);
        let mut buf = sine(440.0, 48000.0, 4096, 0.1);
        lim.process_mono(&mut buf);
        let out_peak = peak(&buf[2048..]);
        // +6 dB ≈ 2.0 linear. Output peak ≈ 0.2.
        assert!(out_peak > 0.18 && out_peak < 0.22, "expected ~+6 dB; got {out_peak}");
    }

    #[test]
    fn stereo_peak_link_keeps_image_intact() {
        // If only L is loud, both L and R should attenuate equally — peak
        // detection is linked.
        let mut lim = Limiter::new(48000.0);
        lim.set_params(-6.0, 50.0, 0.0);
        let mut l: Vec<f32> = sine(440.0, 48000.0, 4096, 1.0);
        let mut r: Vec<f32> = sine(440.0, 48000.0, 4096, 0.3); // quieter
        let r_in_peak = peak(&r);
        lim.process_stereo(&mut l, &mut r);
        let l_out_peak = peak(&l[2048..]);
        let r_out_peak = peak(&r[2048..]);
        assert!(l_out_peak < 0.52);
        // R was originally 0.3 — well below the −6 dB ceiling. But because
        // L is being attenuated, R should be too (same gain envelope).
        assert!(
            r_out_peak < r_in_peak * 0.7,
            "expected R to follow L attenuation; in={r_in_peak} out={r_out_peak}"
        );
    }

    #[test]
    fn latency_reported_matches_lookahead() {
        let sr = 48000.0;
        let lim = Limiter::new(sr);
        let expected = ((LOOKAHEAD_MS / 1000.0) * sr).ceil() as u32;
        assert_eq!(lim.latency_samples(), expected);
    }
}
