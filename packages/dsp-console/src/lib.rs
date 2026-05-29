//! Console — channel-strip "sum bus" saturation.
//!
//! Per docs/implementation.html §07 v1 suite. Where Tape is symmetric
//! tanh + tilt, Console is asymmetric soft-clip + a touch of transformer
//! iron — meant to feel like the gain stages of an analog console summing
//! buss. Drive harder and the asymmetry brings out even-order harmonics
//! and a perceived "punch" / "glue" character that mono tape can't.
//!
//! Signal path:
//!
//! ```text
//!   in ── drive ──► asym_tanh ──► iron_shelf ──► top_smooth ──┐
//!                                                             ├─► mix ──► out
//!                                                         in ─┘
//! ```
//!
//! Asymmetric curve: `tanh(x · drive + bias) - tanh(bias)`. Shifting the
//! tanh by a positive bias makes the upper rail saturate sooner than the
//! lower rail; subtracting `tanh(bias)` removes the resulting DC offset.
//! bias = 0 → symmetric tanh (Tape-equivalent), bias > 0 → asymmetric.
//!
//! Iron shelf: a one-pole low shelf around 100 Hz, +3 dB at character=1.
//! Models the small low-end bump real iron transformers add at the
//! summing point. Negligible at character=0.
//!
//! Top smooth: a one-pole low-pass around 10 kHz, gently rolling off
//! the highest octave at character=1 — the "warm console" perception.
//!
//! Three engineer-facing params:
//!   drive_db  — pre-drive, 0..24 dB.
//!   character — 0..1; couples asymmetry strength + iron-shelf gain +
//!               top-smooth amount. One knob feels right for a "console
//!               vibe" macro.
//!   mix       — dry/wet, 0..1.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(drive_db, character, mix)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()

use std::f32::consts::{LN_10, PI};
use wasm_bindgen::prelude::*;

const IRON_HINGE_HZ: f32 = 100.0;
const TOP_HINGE_HZ: f32 = 10_000.0;
const MAX_IRON_DB: f32 = 3.0;
const MAX_TOP_CUT_DB: f32 = 2.0;
const LN10_OVER_TWENTY: f32 = LN_10 / 20.0;

#[wasm_bindgen]
pub struct Console {
    sample_rate: f32,
    bypassed: bool,

    drive_db: f32,
    character: f32,
    mix: f32,

    drive_gain: f32,
    makeup_gain: f32,

    bias: f32,
    bias_baseline: f32,

    // Iron low-shelf: split with a 100 Hz LPF and re-weight bass with
    // `iron_gain`. Treble stays at unity.
    iron_a: f32,
    iron_b: f32,
    iron_gain: f32,
    iron_z: [f32; 2],

    // Top-smooth one-pole LPF at TOP_HINGE_HZ. At character=0 we blend it
    // back with the signal (high-band gain 1.0); at character=1 we drop
    // the high-band gain to `top_high_gain` to soften the top end.
    top_a: f32,
    top_b: f32,
    top_high_gain: f32,
    top_z: [f32; 2],
}

#[wasm_bindgen]
impl Console {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let mut c = Self {
            sample_rate: sr,
            bypassed: false,
            drive_db: 0.0,
            character: 0.0,
            mix: 1.0,
            drive_gain: 1.0,
            makeup_gain: 1.0,
            bias: 0.0,
            bias_baseline: 0.0,
            iron_a: 0.0,
            iron_b: 1.0,
            iron_gain: 1.0,
            iron_z: [0.0; 2],
            top_a: 0.0,
            top_b: 1.0,
            top_high_gain: 1.0,
            top_z: [0.0; 2],
        };
        c.set_params(0.0, 0.0, 1.0);
        c
    }

    /// `drive_db` ∈ [0, 24]; `character` ∈ [0, 1]; `mix` ∈ [0, 1].
    pub fn set_params(&mut self, drive_db: f32, character: f32, mix: f32) {
        self.drive_db = drive_db.clamp(0.0, 24.0);
        self.character = character.clamp(0.0, 1.0);
        self.mix = mix.clamp(0.0, 1.0);

        self.drive_gain = (self.drive_db * LN10_OVER_TWENTY).exp();
        // Output trim: pull back half the drive so loud drive doesn't
        // blow the level. Same approach as Tape.
        self.makeup_gain = (-self.drive_db * 0.5 * LN10_OVER_TWENTY).exp();

        // Asymmetry: bias the tanh input by character × 0.4. Compensate
        // the DC offset by subtracting tanh(bias) from every output sample.
        self.bias = self.character * 0.4;
        self.bias_baseline = soft_tanh(self.bias);

        // Iron shelf (one-pole LPF + bass weighting).
        let iron_omega = 2.0 * PI * IRON_HINGE_HZ / self.sample_rate;
        let iron_a = (-iron_omega).exp();
        self.iron_a = iron_a;
        self.iron_b = 1.0 - iron_a;
        // Up to +3 dB on the bass band at character=1.
        let iron_db = self.character * MAX_IRON_DB;
        self.iron_gain = (iron_db * LN10_OVER_TWENTY).exp();

        // Top-smooth (one-pole LPF + treble weighting).
        let top_omega = 2.0 * PI * TOP_HINGE_HZ / self.sample_rate;
        let top_a = (-top_omega).exp();
        self.top_a = top_a;
        self.top_b = 1.0 - top_a;
        // Down to -2 dB on the treble band at character=1.
        let top_db = -self.character * MAX_TOP_CUT_DB;
        self.top_high_gain = (top_db * LN10_OVER_TWENTY).exp();
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        self.iron_z = [0.0; 2];
        self.top_z = [0.0; 2];
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.mix <= 1e-6 {
            return;
        }
        let n = left.len().min(right.len());
        let drive = self.drive_gain;
        let makeup = self.makeup_gain;
        let bias = self.bias;
        let baseline = self.bias_baseline;
        let mix = self.mix;
        let dry = 1.0 - mix;
        let ia = self.iron_a;
        let ib = self.iron_b;
        let ig = self.iron_gain;
        let ta = self.top_a;
        let tb = self.top_b;
        let thg = self.top_high_gain;

        for i in 0..n {
            // Left
            let xl = left[i];
            let saturated_l = (soft_tanh(xl * drive + bias) - baseline) * makeup;
            // Iron shelf: LPF bass band, weight, recombine with treble at 1.0
            self.iron_z[0] = ib * saturated_l + ia * self.iron_z[0];
            let bass_l = self.iron_z[0];
            let after_iron_l = bass_l * ig + (saturated_l - bass_l);
            // Top smooth: LPF bass band (relative to TOP_HINGE_HZ), recombine
            // with treble at top_high_gain (<1 when character > 0)
            self.top_z[0] = tb * after_iron_l + ta * self.top_z[0];
            let low_l = self.top_z[0];
            let after_top_l = low_l + (after_iron_l - low_l) * thg;
            left[i] = dry * xl + mix * after_top_l;

            // Right
            let xr = right[i];
            let saturated_r = (soft_tanh(xr * drive + bias) - baseline) * makeup;
            self.iron_z[1] = ib * saturated_r + ia * self.iron_z[1];
            let bass_r = self.iron_z[1];
            let after_iron_r = bass_r * ig + (saturated_r - bass_r);
            self.top_z[1] = tb * after_iron_r + ta * self.top_z[1];
            let low_r = self.top_z[1];
            let after_top_r = low_r + (after_iron_r - low_r) * thg;
            right[i] = dry * xr + mix * after_top_r;
        }
    }
}

/// Same rational tanh approximation as Tape — good to ~0.005 across
/// [-3, 3], clamps past that.
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
    fn defaults_pass_quietly() {
        // drive=0, char=0, mix=1 → tanh(x) of small input ≈ x, both shelves
        // unity, so the output sticks close to the input.
        let mut c = Console::new(48000.0);
        let mut l = sine(440.0, 48000.0, 1024, 0.1);
        let mut r = sine(880.0, 48000.0, 1024, 0.1);
        let orig_l = l.clone();
        let orig_r = r.clone();
        c.process_stereo(&mut l, &mut r);
        for i in 64..l.len() {
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
        let mut c = Console::new(48000.0);
        c.set_params(12.0, 0.8, 1.0);
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
    fn mix_zero_is_passthrough() {
        let mut c = Console::new(48000.0);
        c.set_params(18.0, 0.9, 0.0);
        let mut l = sine(440.0, 48000.0, 512, 0.5);
        let orig = l.clone();
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6, "mix=0 must passthrough");
        }
    }

    #[test]
    fn character_produces_asymmetry() {
        // At character=1 with drive, positive and negative peaks should not
        // cancel — the asymmetric curve clips one rail sooner. Measure the
        // mean of the output (post-DC-compensation it should be small, but
        // distinct from a symmetric run).
        let sr = 48000.0_f32;
        let n = 8192;
        // Symmetric reference: character = 0
        let mut sym = sine(220.0, sr, n, 0.9);
        let mut sym_r = sym.clone();
        let mut c_sym = Console::new(sr);
        c_sym.set_params(18.0, 0.0, 1.0);
        c_sym.process_stereo(&mut sym, &mut sym_r);
        // Asymmetric: character = 1
        let mut asym = sine(220.0, sr, n, 0.9);
        let mut asym_r = asym.clone();
        let mut c_asym = Console::new(sr);
        c_asym.set_params(18.0, 1.0, 1.0);
        c_asym.process_stereo(&mut asym, &mut asym_r);

        // The two outputs should diverge meaningfully at any given sample
        // past startup (asymmetry shifts the waveform shape).
        let mid = n / 2;
        let diff: f32 = (mid..mid + 128).map(|i| (sym[i] - asym[i]).abs()).sum();
        assert!(
            diff > 0.5,
            "asymmetric output should differ from symmetric run; total diff {diff}"
        );
    }

    #[test]
    fn drive_compresses_peaks() {
        // Same sanity check as Tape: heavy drive should clip the peaks.
        let mut c = Console::new(48000.0);
        c.set_params(18.0, 0.0, 1.0);
        let mut l = sine(440.0, 48000.0, 4096, 0.9);
        let in_peak = l.iter().fold(0.0_f32, |m, v| m.max(v.abs()));
        let mut r = l.clone();
        c.process_stereo(&mut l, &mut r);
        let out_peak = l[2048..].iter().fold(0.0_f32, |m, v| m.max(v.abs()));
        assert!(out_peak < in_peak, "peak should compress: in={in_peak} out={out_peak}");
    }

    #[test]
    fn character_lifts_bass() {
        // The iron shelf hinges at 100 Hz — the +3 dB boost is fully
        // realised well below the hinge, not at it. Use a 40 Hz tone so
        // the LPF passes ~93 % of the signal and the shelf gain dominates.
        let sr = 48000.0_f32;
        let n = 32768; // long buffer so the one-pole settles + steady-state RMS is honest

        let mut flat = sine(40.0, sr, n, 0.2);
        let mut flat_r = flat.clone();
        let mut c_flat = Console::new(sr);
        c_flat.set_params(0.0, 0.0, 1.0);
        c_flat.process_stereo(&mut flat, &mut flat_r);

        let mut warm = sine(40.0, sr, n, 0.2);
        let mut warm_r = warm.clone();
        let mut c_warm = Console::new(sr);
        c_warm.set_params(0.0, 1.0, 1.0);
        c_warm.process_stereo(&mut warm, &mut warm_r);

        let flat_rms = rms(&flat[n / 2..]);
        let warm_rms = rms(&warm[n / 2..]);
        assert!(
            warm_rms > flat_rms * 1.15,
            "iron shelf should boost bass: flat={flat_rms} warm={warm_rms}"
        );
    }
}
