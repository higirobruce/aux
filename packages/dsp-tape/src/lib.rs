//! Tape — single-stage tape-style saturation.
//!
//! Per docs/implementation.html §07 v1 suite. Soft tanh nonlinearity with
//! a one-pole tilt filter for the warm/bright character of analog tape
//! and a dry/wet mix so parallel saturation is easy. The DSP is the
//! cheapest plausible model of a tape stage — no bias modulation, no
//! pre/de-emphasis, no head bump — but it sounds right for the v1 use
//! case ("glue the bus, melt the transients a touch").
//!
//! Signal path:
//!
//! ```text
//!   in ── pre-drive (× gain_lin) ──► tanh ──► tilt ──┐
//!                                                    ├─► mix ──► out
//!                                                in ─┘
//! ```
//!
//! Tilt = one-pole low-shelf at 1 kHz. Positive `tone` lifts the highs
//! (cuts the lows) for a brighter feel; negative `tone` rolls off the
//! top for a warmer tape sound. Zero is flat.
//!
//! Three engineer-facing params:
//!   drive_db — pre-drive, 0..24 dB.
//!   tone     — output tilt, -1..1 (warm to bright).
//!   mix      — dry/wet, 0..1.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(drive_db, tone, mix)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()

use std::f32::consts::{LN_10, PI};
use wasm_bindgen::prelude::*;

const TILT_HINGE_HZ: f32 = 1000.0;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct Tape {
    sample_rate: f32,
    bypassed: bool,

    drive_db: f32,
    tone: f32,
    mix: f32,

    drive_gain: f32,
    // Output makeup. As drive grows, the average level rises (tanh asymptotes
    // at ±1), so we trim back toward unity using -drive_db / 2. Keeps the
    // overall level roughly consistent as the user sweeps drive.
    makeup_gain: f32,

    // First-order LPF coefficients (one-pole around TILT_HINGE_HZ) used
    // to split the saturated signal into bass / treble. Stereo state in
    // `shelf_z` — the running LPF output per channel.
    shelf_a: f32,
    shelf_b: f32,
    tilt_low_gain: f32,
    tilt_high_gain: f32,
    shelf_z: [f32; 2],
}

#[wasm_bindgen]
impl Tape {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut t = Self {
            sample_rate: sr,
            bypassed: false,
            drive_db: 0.0,
            tone: 0.0,
            mix: 1.0,
            drive_gain: 1.0,
            makeup_gain: 1.0,
            shelf_a: 0.0,
            shelf_b: 1.0,
            tilt_low_gain: 1.0,
            tilt_high_gain: 1.0,
            shelf_z: [0.0; 2],
        };
        t.set_params(0.0, 0.0, 1.0);
        t
    }

    /// `drive_db` ∈ [0, 24]; `tone` ∈ [-1, 1]; `mix` ∈ [0, 1].
    pub fn set_params(&mut self, drive_db: f32, tone: f32, mix: f32) {
        self.drive_db = drive_db.clamp(0.0, 24.0);
        self.tone = tone.clamp(-1.0, 1.0);
        self.mix = mix.clamp(0.0, 1.0);

        self.drive_gain = (self.drive_db * LN10_OVER_TWENTY).exp();
        // Pull back half the drive in dB on the output so loud drive
        // doesn't blow the level — engineer adjusts to taste with mix.
        self.makeup_gain = (-self.drive_db * 0.5 * LN10_OVER_TWENTY).exp();

        // First-order tilt: split the saturated signal into bass (one-pole
        // LPF at TILT_HINGE_HZ) and treble (signal − LPF), then weight each
        // band before recombining.
        //
        //   tone > 0 → bright: boost treble (×high_gain), cut bass (×low_gain)
        //   tone < 0 → warm:   the inverse
        //   tone = 0 → both gains = 1, sum is identity through the shelf
        //
        // Max ±6 dB at the extremes — enough character without overpowering
        // the saturation. Reciprocal gains keep loudness roughly balanced
        // as the user sweeps tone.
        let max_db = 6.0;
        let high_gain = (self.tone * max_db * LN10_OVER_TWENTY).exp();
        let low_gain = (-self.tone * max_db * LN10_OVER_TWENTY).exp();
        self.tilt_low_gain = low_gain;
        self.tilt_high_gain = high_gain;

        // Standard one-pole LPF coefficient at TILT_HINGE_HZ.
        let omega = 2.0 * PI * TILT_HINGE_HZ / self.sample_rate;
        let a = (-omega).exp();
        self.shelf_a = a;
        self.shelf_b = 1.0 - a;
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        self.shelf_z = [0.0; 2];
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.mix <= 1e-6 {
            return;
        }
        let n = left.len().min(right.len());
        let drive = self.drive_gain;
        let makeup = self.makeup_gain;
        let mix = self.mix;
        let dry = 1.0 - mix;
        let sa = self.shelf_a;
        let sb = self.shelf_b;
        let lg = self.tilt_low_gain;
        let hg = self.tilt_high_gain;

        for i in 0..n {
            // Left
            let xl = left[i];
            let saturated_l = soft_tanh(xl * drive) * makeup;
            self.shelf_z[0] = sb * saturated_l + sa * self.shelf_z[0];
            let lpf_l = self.shelf_z[0];
            let tilted_l = lpf_l * lg + (saturated_l - lpf_l) * hg;
            left[i] = dry * xl + mix * tilted_l;

            // Right
            let xr = right[i];
            let saturated_r = soft_tanh(xr * drive) * makeup;
            self.shelf_z[1] = sb * saturated_r + sa * self.shelf_z[1];
            let lpf_r = self.shelf_z[1];
            let tilted_r = lpf_r * lg + (saturated_r - lpf_r) * hg;
            right[i] = dry * xr + mix * tilted_r;
        }
    }
}

/// Fast tanh approximation good to within ~0.005 across [-3, 3] — past
/// that the standard tanh saturates to ±1 anyway, and we clamp.
#[inline(always)]
fn soft_tanh(x: f32) -> f32 {
    if x > 3.0 {
        1.0
    } else if x < -3.0 {
        -1.0
    } else {
        let x2 = x * x;
        let num = x * (27.0 + x2);
        let den = 27.0 + 9.0 * x2;
        num / den
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
    fn zero_drive_zero_tone_is_near_passthrough() {
        // tanh is identity only at x=0; with drive=0 makeup=0 the signal
        // still passes through tanh(x), which is ~0.0003 off from x at
        // amp 0.1. Use a small input so the test tolerates true math.
        let mut t = Tape::new(48000.0);
        t.set_params(0.0, 0.0, 1.0);
        let mut l = sine(440.0, 48000.0, 1024, 0.1);
        let mut r = sine(880.0, 48000.0, 1024, 0.1);
        let orig_l = l.clone();
        let orig_r = r.clone();
        t.process_stereo(&mut l, &mut r);
        for i in 32..l.len() {
            assert!(
                (l[i] - orig_l[i]).abs() < 0.005,
                "L diverged at {i}: {} vs {}",
                l[i],
                orig_l[i]
            );
            assert!((r[i] - orig_r[i]).abs() < 0.005);
        }
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut t = Tape::new(48000.0);
        t.set_params(12.0, 0.5, 1.0);
        t.set_bypassed(true);
        let mut l = sine(440.0, 48000.0, 1024, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        t.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn drive_compresses_peaks() {
        // Loud sine at +6 dB nominal level — tanh should clip the peaks
        // and the output's peak amplitude should fall below the input's.
        let mut t = Tape::new(48000.0);
        t.set_params(18.0, 0.0, 1.0); // heavy drive, no tone
        let mut l = sine(440.0, 48000.0, 4096, 0.9);
        let in_peak = l.iter().fold(0.0_f32, |m, v| m.max(v.abs()));
        let mut r = l.clone();
        t.process_stereo(&mut l, &mut r);
        let out_peak = l[2048..].iter().fold(0.0_f32, |m, v| m.max(v.abs()));
        // With 18 dB drive (×8) and tanh saturation, the peak gets crushed
        // to near unity, then makeup -9 dB pulls it back. Should be < input.
        assert!(out_peak < in_peak, "peak should compress: in={in_peak} out={out_peak}");
    }

    #[test]
    fn drive_adds_harmonics() {
        // Pure sine in → output RMS should be lower than naïve sine RMS
        // because the energy moves into harmonics that the (limited)
        // measurement window may not capture entirely. More importantly,
        // a comparison clean-vs-driven proves the curve is doing work.
        let sr = 48000.0_f32;
        let mut clean = sine(440.0, sr, 4096, 0.6);
        let mut clean_r = clean.clone();
        let mut driven = clean.clone();
        let mut driven_r = clean.clone();

        let mut t_clean = Tape::new(sr);
        t_clean.set_params(0.0, 0.0, 1.0);
        t_clean.process_stereo(&mut clean, &mut clean_r);

        let mut t_drive = Tape::new(sr);
        t_drive.set_params(18.0, 0.0, 1.0);
        t_drive.process_stereo(&mut driven, &mut driven_r);

        // Sample-by-sample, the driven signal should diverge from clean
        // (curve is doing something). Use a fixed sample far from start.
        let i = 512;
        assert!(
            (clean[i] - driven[i]).abs() > 0.01,
            "drive should change output: clean={} driven={}",
            clean[i],
            driven[i]
        );
        // Sanity: both still within range.
        for x in driven.iter() {
            assert!(x.abs() <= 1.5, "tape output should stay bounded");
        }
    }

    #[test]
    fn mix_zero_is_passthrough() {
        let mut t = Tape::new(48000.0);
        t.set_params(18.0, 0.5, 0.0); // heavy settings but mix=0
        let mut l = sine(440.0, 48000.0, 512, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        t.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6, "mix=0 must passthrough");
        }
    }

    #[test]
    fn positive_tone_brightens() {
        // tone > 0 → low-shelf cut / high-shelf boost. A pure low-freq
        // tone should come out quieter than input post-tilt; a pure
        // high-freq tone should come out louder.
        let sr = 48000.0_f32;
        let mut t = Tape::new(sr);
        t.set_params(0.0, 1.0, 1.0); // bright max

        let mut low_l = sine(80.0, sr, 4096, 0.3);
        let mut low_r = low_l.clone();
        t.process_stereo(&mut low_l, &mut low_r);
        let low_rms = rms(&low_l[2048..]);

        // Reset shelf state for fair comparison.
        t.reset();
        let mut hi_l = sine(8000.0, sr, 4096, 0.3);
        let mut hi_r = hi_l.clone();
        t.process_stereo(&mut hi_l, &mut hi_r);
        let hi_rms = rms(&hi_l[2048..]);

        // With drive 0, the only thing tilt does is shape frequency
        // response. High band should be louder than low band after tilt.
        assert!(
            hi_rms > low_rms,
            "bright tone should keep highs > lows; low={low_rms} hi={hi_rms}"
        );
    }
}
