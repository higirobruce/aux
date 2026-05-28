//! EQ-8 — eight-band parametric equalizer.
//!
//! Per docs/implementation.html §11 + §16.03. Eight biquad sections in series:
//!
//!   [0] HP (high-pass)    — 12 dB/oct, freq + Q (Q gates slope/resonance)
//!   [1] LS (low-shelf)    — freq + gain + Q (Q gates shelf slope)
//!   [2] Peak              — freq + gain + Q (resonance)
//!   [3] Peak
//!   [4] Peak
//!   [5] Peak
//!   [6] HS (high-shelf)   — freq + gain + Q
//!   [7] LP (low-pass)     — 12 dB/oct, freq + Q
//!
//! Coefficients follow the RBJ Audio EQ Cookbook (Robert Bristow-Johnson).
//! Each biquad keeps independent state per audio channel (stereo) so the
//! same Eq8 instance can process L+R alternately without bleed.
//!
//! ABI: wasm-bindgen `class Eq8` with new / set_band / set_bypassed / process
//! / reset. Process operates on a Float32Array slice in place.

use std::f32::consts::PI;
use wasm_bindgen::prelude::*;

const NUM_BANDS: usize = 8;
const MAX_CHANNELS: usize = 2;

#[wasm_bindgen]
#[repr(u8)]
#[derive(Copy, Clone, Debug)]
pub enum BandType {
    Bypass = 0,
    HighPass = 1,
    LowShelf = 2,
    Peak = 3,
    HighShelf = 4,
    LowPass = 5,
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: [f32; MAX_CHANNELS],
    x2: [f32; MAX_CHANNELS],
    y1: [f32; MAX_CHANNELS],
    y2: [f32; MAX_CHANNELS],
}

impl Biquad {
    const fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: [0.0; MAX_CHANNELS],
            x2: [0.0; MAX_CHANNELS],
            y1: [0.0; MAX_CHANNELS],
            y2: [0.0; MAX_CHANNELS],
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

    fn reset_state(&mut self) {
        self.x1 = [0.0; MAX_CHANNELS];
        self.x2 = [0.0; MAX_CHANNELS];
        self.y1 = [0.0; MAX_CHANNELS];
        self.y2 = [0.0; MAX_CHANNELS];
    }

    /// Copy only the coefficients from another biquad — state is preserved
    /// so coefficient changes don't pop.
    fn copy_coeffs(&mut self, src: &Biquad) {
        self.b0 = src.b0;
        self.b1 = src.b1;
        self.b2 = src.b2;
        self.a1 = src.a1;
        self.a2 = src.a2;
    }
}

/// RBJ Audio EQ Cookbook (revised 2005) — biquad coefficient helpers.
///
/// All return a biquad already normalized by a0 (so b/a here are b/a0).
mod rbj {
    use super::Biquad;
    use std::f32::consts::PI;

    fn omega(sample_rate: f32, freq: f32) -> (f32, f32, f32) {
        let w0 = 2.0 * PI * freq / sample_rate;
        (w0, w0.sin(), w0.cos())
    }

    pub fn high_pass(sr: f32, freq: f32, q: f32) -> Biquad {
        let (_, sin_w, cos_w) = omega(sr, freq);
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
        let (_, sin_w, cos_w) = omega(sr, freq);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cos_w) / 2.0 / a0;
        let b1 = (1.0 - cos_w) / a0;
        let b2 = (1.0 - cos_w) / 2.0 / a0;
        let a1 = -2.0 * cos_w / a0;
        let a2 = (1.0 - alpha) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }

    pub fn peak(sr: f32, freq: f32, gain_db: f32, q: f32) -> Biquad {
        let (_, sin_w, cos_w) = omega(sr, freq);
        let a_amp = 10.0_f32.powf(gain_db / 40.0);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let a0 = 1.0 + alpha / a_amp;
        let b0 = (1.0 + alpha * a_amp) / a0;
        let b1 = (-2.0 * cos_w) / a0;
        let b2 = (1.0 - alpha * a_amp) / a0;
        let a1 = (-2.0 * cos_w) / a0;
        let a2 = (1.0 - alpha / a_amp) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }

    pub fn low_shelf(sr: f32, freq: f32, gain_db: f32, q: f32) -> Biquad {
        let (_, sin_w, cos_w) = omega(sr, freq);
        let a_amp = 10.0_f32.powf(gain_db / 40.0);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let two_sqrt_a_alpha = 2.0 * a_amp.sqrt() * alpha;
        let a_plus_one = a_amp + 1.0;
        let a_minus_one = a_amp - 1.0;
        let a0 = a_plus_one + a_minus_one * cos_w + two_sqrt_a_alpha;
        let b0 = a_amp * (a_plus_one - a_minus_one * cos_w + two_sqrt_a_alpha) / a0;
        let b1 = 2.0 * a_amp * (a_minus_one - a_plus_one * cos_w) / a0;
        let b2 = a_amp * (a_plus_one - a_minus_one * cos_w - two_sqrt_a_alpha) / a0;
        let a1 = -2.0 * (a_minus_one + a_plus_one * cos_w) / a0;
        let a2 = (a_plus_one + a_minus_one * cos_w - two_sqrt_a_alpha) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }

    pub fn high_shelf(sr: f32, freq: f32, gain_db: f32, q: f32) -> Biquad {
        let (_, sin_w, cos_w) = omega(sr, freq);
        let a_amp = 10.0_f32.powf(gain_db / 40.0);
        let alpha = sin_w / (2.0 * q.max(0.001));
        let two_sqrt_a_alpha = 2.0 * a_amp.sqrt() * alpha;
        let a_plus_one = a_amp + 1.0;
        let a_minus_one = a_amp - 1.0;
        let a0 = a_plus_one - a_minus_one * cos_w + two_sqrt_a_alpha;
        let b0 = a_amp * (a_plus_one + a_minus_one * cos_w + two_sqrt_a_alpha) / a0;
        let b1 = -2.0 * a_amp * (a_minus_one + a_plus_one * cos_w) / a0;
        let b2 = a_amp * (a_plus_one + a_minus_one * cos_w - two_sqrt_a_alpha) / a0;
        let a1 = 2.0 * (a_minus_one - a_plus_one * cos_w) / a0;
        let a2 = (a_plus_one - a_minus_one * cos_w - two_sqrt_a_alpha) / a0;
        Biquad { b0, b1, b2, a1, a2, x1: [0.0; 2], x2: [0.0; 2], y1: [0.0; 2], y2: [0.0; 2] }
    }
}

/// Eight-band parametric EQ instance. Stateful — one instance per channel
/// strip on the host side; this struct handles stereo internally.
#[wasm_bindgen]
pub struct Eq8 {
    sample_rate: f32,
    bands: [Biquad; NUM_BANDS],
    bypassed: bool,
}

#[wasm_bindgen]
impl Eq8 {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let _ = PI; // silence unused-import on some toolchains
        Self {
            sample_rate: sr,
            bands: [Biquad::identity(); NUM_BANDS],
            bypassed: false,
        }
    }

    /// Configure one band. Index out of range is silently ignored.
    /// Frequencies are clamped to (0, Nyquist).
    pub fn set_band(&mut self, idx: usize, band_type: BandType, freq: f32, gain_db: f32, q: f32) {
        if idx >= NUM_BANDS {
            return;
        }
        let nyquist = self.sample_rate * 0.5;
        let f = freq.clamp(10.0, nyquist - 1.0);
        let q = if q.is_finite() && q > 0.0 { q } else { 0.707 };
        let coeffs = match band_type {
            BandType::Bypass => Biquad::identity(),
            BandType::HighPass => rbj::high_pass(self.sample_rate, f, q),
            BandType::LowPass => rbj::low_pass(self.sample_rate, f, q),
            BandType::Peak => rbj::peak(self.sample_rate, f, gain_db, q),
            BandType::LowShelf => rbj::low_shelf(self.sample_rate, f, gain_db, q),
            BandType::HighShelf => rbj::high_shelf(self.sample_rate, f, gain_db, q),
        };
        self.bands[idx].copy_coeffs(&coeffs);
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    /// Process N samples of one channel in place. `channel` is 0 (left) or 1
    /// (right); any other value is taken mod 2.
    pub fn process(&mut self, buffer: &mut [f32], channel: u32) {
        if self.bypassed {
            return;
        }
        let ch = (channel as usize) % MAX_CHANNELS;
        for x in buffer.iter_mut() {
            let mut y = *x;
            for band in self.bands.iter_mut() {
                y = band.process(y, ch);
            }
            *x = y;
        }
    }

    /// Clear filter state — for example after a seek. Coefficients are kept.
    pub fn reset(&mut self) {
        for band in self.bands.iter_mut() {
            band.reset_state();
        }
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

    fn sine(freq: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn identity_passthrough() {
        let sr = 48000.0_f32;
        let mut eq = Eq8::new(sr);
        let mut input: Vec<f32> = (0..256).map(|i| (i as f32 * 0.01).sin()).collect();
        let original = input.clone();
        eq.process(&mut input, 0);
        for (a, b) in input.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "expected passthrough, drift={}", a - b);
        }
    }

    #[test]
    fn low_shelf_boost_increases_lf() {
        let sr = 48000.0_f32;
        let mut eq = Eq8::new(sr);
        eq.set_band(1, BandType::LowShelf, 200.0, 12.0, 0.707);

        let mut bass = sine(80.0, sr, 4096);
        let bass_in = rms(&bass);
        eq.process(&mut bass, 0);
        // Skip the first transient block so the filter settles.
        let bass_out = rms(&bass[2048..]);
        assert!(
            bass_out > bass_in * 1.5,
            "expected ≥1.5× boost at 80 Hz, got in={bass_in} out={bass_out}"
        );
    }

    #[test]
    fn high_shelf_cut_decreases_hf() {
        let sr = 48000.0_f32;
        let mut eq = Eq8::new(sr);
        eq.set_band(6, BandType::HighShelf, 4000.0, -12.0, 0.707);

        let mut hi = sine(10_000.0, sr, 4096);
        let hi_in = rms(&hi);
        eq.process(&mut hi, 0);
        let hi_out = rms(&hi[2048..]);
        assert!(
            hi_out < hi_in * 0.5,
            "expected ≥6 dB cut at 10 kHz, got in={hi_in} out={hi_out}"
        );
    }

    #[test]
    fn bypass_is_passthrough_even_with_filters() {
        let sr = 48000.0_f32;
        let mut eq = Eq8::new(sr);
        eq.set_band(1, BandType::LowShelf, 200.0, 12.0, 0.707);
        eq.set_bypassed(true);

        let mut bass = sine(80.0, sr, 256);
        let original = bass.clone();
        eq.process(&mut bass, 0);
        for (a, b) in bass.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn stereo_channels_independent() {
        // Process L then R with the same input — output for each must be the
        // same (no cross-channel leak via shared state).
        let sr = 48000.0_f32;
        let mut eq = Eq8::new(sr);
        eq.set_band(2, BandType::Peak, 1000.0, 6.0, 1.0);

        let input = sine(1000.0, sr, 1024);
        let mut left = input.clone();
        let mut right = input.clone();
        eq.process(&mut left, 0);
        eq.process(&mut right, 1);
        for (l, r) in left.iter().zip(right.iter()) {
            assert!((l - r).abs() < 1e-5);
        }
    }
}
