//! Imager — M/S stereo-width tool.
//!
//! Per docs/implementation.html §07 v1 suite. Converts L/R to mid/side,
//! scales the side signal, and recombines. One knob `width`:
//!   0   → mono (side fully muted)
//!   1   → unity (true bypass)
//!   2   → exaggerated stereo (side doubled)
//!
//! Math:
//!   M = (L + R) * 0.5
//!   S = (L - R) * 0.5
//!   S' = S * width
//!   L' = M + S'
//!   R' = M - S'
//!
//! No filters, no envelope — this is a pure linear matrix, so it doesn't
//! need any per-block state. The class still carries `bypassed` so the host
//! can A/B without re-instantiating.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_width(width)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   reset()

use wasm_bindgen::prelude::*;

const MAX_WIDTH: f32 = 2.0;

#[wasm_bindgen]
pub struct Imager {
    bypassed: bool,
    width: f32,
}

#[wasm_bindgen]
impl Imager {
    #[wasm_bindgen(constructor)]
    pub fn new(_sample_rate: f32) -> Self {
        Self { bypassed: false, width: 1.0 }
    }

    pub fn set_width(&mut self, width: f32) {
        self.width = width.clamp(0.0, MAX_WIDTH);
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {}

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || (self.width - 1.0).abs() < 1e-6 {
            return;
        }
        let w = self.width;
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i];
            let r = right[i];
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5 * w;
            left[i] = mid + side;
            right[i] = mid - side;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn rms(buf: &[f32]) -> f32 {
        let s: f32 = buf.iter().map(|v| v * v).sum();
        (s / buf.len() as f32).sqrt()
    }

    #[test]
    fn width_one_is_passthrough() {
        let mut im = Imager::new(48000.0);
        im.set_width(1.0);
        let mut l: Vec<f32> =
            (0..512).map(|i| (2.0 * PI * 440.0 * i as f32 / 48000.0).sin()).collect();
        let mut r: Vec<f32> =
            (0..512).map(|i| (2.0 * PI * 220.0 * i as f32 / 48000.0).sin()).collect();
        let l0 = l.clone();
        let r0 = r.clone();
        im.process_stereo(&mut l, &mut r);
        for ((a, b), (c, d)) in l.iter().zip(l0.iter()).zip(r.iter().zip(r0.iter())) {
            assert!((a - b).abs() < 1e-6 && (c - d).abs() < 1e-6);
        }
    }

    #[test]
    fn width_zero_collapses_to_mono() {
        let mut im = Imager::new(48000.0);
        im.set_width(0.0);
        // Different L vs. R content.
        let mut l: Vec<f32> = (0..512).map(|i| i as f32 * 0.001).collect();
        let mut r: Vec<f32> = (0..512).map(|i| -(i as f32) * 0.0005).collect();
        let l_in_avg: Vec<f32> = l.iter().zip(r.iter()).map(|(a, b)| (a + b) * 0.5).collect();
        im.process_stereo(&mut l, &mut r);
        for ((a, b), m) in l.iter().zip(r.iter()).zip(l_in_avg.iter()) {
            assert!((a - b).abs() < 1e-6, "L and R should be identical (mono)");
            assert!((a - m).abs() < 1e-6, "L should equal pre-mix mid");
        }
    }

    #[test]
    fn width_two_widens_side() {
        let mut im = Imager::new(48000.0);
        // Generate a hard-panned signal: L = sine, R = 0 → all side.
        let l_in: Vec<f32> =
            (0..512).map(|i| (2.0 * PI * 440.0 * i as f32 / 48000.0).sin() * 0.5).collect();
        let r_in: Vec<f32> = vec![0.0; 512];
        let mut l = l_in.clone();
        let mut r = r_in.clone();
        im.set_width(2.0);
        im.process_stereo(&mut l, &mut r);
        // Side should be doubled, so |L - R| ≈ 2x input |L - R|.
        let in_diff_rms: f32 = rms(
            &l_in.iter().zip(r_in.iter()).map(|(a, b)| a - b).collect::<Vec<_>>()[..],
        );
        let out_diff_rms: f32 = rms(
            &l.iter().zip(r.iter()).map(|(a, b)| a - b).collect::<Vec<_>>()[..],
        );
        assert!(
            (out_diff_rms / in_diff_rms - 2.0).abs() < 0.05,
            "expected ≈2x side at width=2; in={in_diff_rms} out={out_diff_rms}"
        );
    }

    #[test]
    fn bypass_skips_processing() {
        let mut im = Imager::new(48000.0);
        im.set_width(0.0);
        im.set_bypassed(true);
        let mut l: Vec<f32> = (0..512).map(|i| i as f32 * 0.001).collect();
        let mut r: Vec<f32> = (0..512).map(|i| -(i as f32) * 0.001).collect();
        let l0 = l.clone();
        let r0 = r.clone();
        im.process_stereo(&mut l, &mut r);
        assert_eq!(l, l0);
        assert_eq!(r, r0);
    }
}
