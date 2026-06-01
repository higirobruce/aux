//! Meter — loudness + true-peak metering per ITU-R BS.1770-4.
//!
//! A read-only tap (the worklet feeds audio in but takes no output). Computes,
//! per `process_stereo` call and exposed through getters:
//!
//! * **Momentary** LUFS  — 400 ms sliding window.
//! * **Short-term** LUFS — 3 s sliding window.
//! * **Integrated** LUFS — gated (absolute −70 LUFS + relative −10 LU) over
//!   400 ms blocks at 100 ms hops, accumulated since `reset()`.
//! * **True-peak** (dBTP) and an **over** count — 4× oversampled per channel.
//!
//! Loudness path: K-weighting (a +4 dB high-shelf then a ~38 Hz high-pass, the
//! BS.1770 "K" curve) → mean-square → channel sum → `−0.691 + 10·log10(·)`.
//! Filter coefficients are derived from the spec's analog prototypes via the
//! bilinear transform at the actual sample rate (libebur128 formulas), so the
//! meter is correct at 44.1 / 48 / 96 k, not just 48 k.
//!
//! Integrated loudness uses a 0.1 LU histogram (count + energy per bin) so
//! memory is bounded regardless of programme length.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])   (reads only)
//!   reset()
//!   momentary_lufs() · short_lufs() · integrated_lufs() -> f32
//!   true_peak_db() · overs() -> f32

use wasm_bindgen::prelude::*;

/// Absolute silence floor reported when there's nothing to measure (LUFS).
const SILENCE_LUFS: f32 = -120.0;
/// BS.1770 loudness offset.
const OFFSET: f64 = -0.691;

// Integrated-loudness histogram: 0.1 LU bins from −70 to +5 LUFS.
const HIST_LO: f64 = -70.0;
const HIST_STEP: f64 = 0.1;
const HIST_BINS: usize = 750;

// True-peak oversampler: 4 phases × 8 taps = 32-tap windowed-sinc prototype.
const TP_PHASES: usize = 4;
const TP_TPP: usize = 8;
const TP_TAPS: usize = TP_PHASES * TP_TPP;

/// Transposed-Direct-Form-II biquad in f64.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// BS.1770 K-weighting (high-shelf "pre-filter" → RLB high-pass), libebur128
/// coefficients for an arbitrary sample rate.
fn k_weight(fs: f64) -> (Biquad, Biquad) {
    // Stage 1 — high-shelf.
    let db = 3.999_843_853_973_347_f64;
    let f0 = 1681.974_450_955_533_f64;
    let q = 0.707_175_236_955_419_6_f64;
    let k = (std::f64::consts::PI * f0 / fs).tan();
    let vh = 10f64.powf(db / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        z1: 0.0,
        z2: 0.0,
    };

    // Stage 2 — high-pass (RLB).
    let f0 = 38.135_470_876_024_44_f64;
    let q = 0.500_327_037_323_877_3_f64;
    let k = (std::f64::consts::PI * f0 / fs).tan();
    let denom = 1.0 + k / q + k * k;
    let hp = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / denom,
        a2: (1.0 - k / q + k * k) / denom,
        z1: 0.0,
        z2: 0.0,
    };

    (shelf, hp)
}

/// 4× polyphase oversampler for true-peak estimation (one per channel).
struct TruePeak {
    coef: [f64; TP_TAPS],
    hist: [f64; TP_TPP],
    pos: usize,
}

impl TruePeak {
    fn new() -> Self {
        // Windowed-sinc lowpass; centred so phase 0 reproduces the input.
        let center = (TP_TAPS as f64 - 1.0) / 2.0;
        let mut coef = [0.0f64; TP_TAPS];
        for (k, c) in coef.iter_mut().enumerate() {
            let t = (k as f64 - center) / TP_PHASES as f64;
            let sinc = if t.abs() < 1e-9 {
                1.0
            } else {
                (std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t)
            };
            // Hann window across the taps.
            let w = 0.5
                - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (TP_TAPS as f64 - 1.0)).cos();
            *c = sinc * w;
        }
        Self { coef, hist: [0.0; TP_TPP], pos: 0 }
    }

    /// Push one input sample; return the max |oversampled value| around it.
    #[inline]
    fn push(&mut self, x: f64) -> f64 {
        self.hist[self.pos] = x;
        let mut peak = 0.0f64;
        for p in 0..TP_PHASES {
            let mut acc = 0.0f64;
            for j in 0..TP_TPP {
                // newest sample is at self.pos, go backwards
                let idx = (self.pos + TP_TPP - j) % TP_TPP;
                acc += self.hist[idx] * self.coef[j * TP_PHASES + p];
            }
            let a = acc.abs();
            if a > peak {
                peak = a;
            }
        }
        self.pos = (self.pos + 1) % TP_TPP;
        peak
    }

    fn reset(&mut self) {
        self.hist = [0.0; TP_TPP];
        self.pos = 0;
    }
}

#[wasm_bindgen]
pub struct Meter {
    sample_rate: f64,
    bypassed: bool,

    kw_l: (Biquad, Biquad),
    kw_r: (Biquad, Biquad),

    // 100 ms sub-block accumulation.
    hop: usize,
    sub_count: usize,
    sum_sq_l: f64,
    sum_sq_r: f64,

    // Ring of the last 30 sub-block channel-summed mean-squares (3 s).
    sub_z: [f64; 30],
    sub_pos: usize,
    sub_filled: usize,

    // Integrated gating histogram.
    hist_count: Vec<u32>,
    hist_energy: Vec<f64>,

    // True-peak.
    tp_l: TruePeak,
    tp_r: TruePeak,
    tp_max: f64,
    overs: u32,
}

#[wasm_bindgen]
impl Meter {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let fs = if sample_rate > 0.0 { sample_rate as f64 } else { 48000.0 };
        let hop = (0.1 * fs).round().max(1.0) as usize;
        Self {
            sample_rate: fs,
            bypassed: false,
            kw_l: k_weight(fs),
            kw_r: k_weight(fs),
            hop,
            sub_count: 0,
            sum_sq_l: 0.0,
            sum_sq_r: 0.0,
            sub_z: [0.0; 30],
            sub_pos: 0,
            sub_filled: 0,
            hist_count: vec![0; HIST_BINS],
            hist_energy: vec![0.0; HIST_BINS],
            tp_l: TruePeak::new(),
            tp_r: TruePeak::new(),
            tp_max: 0.0,
            overs: 0,
        }
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    /// Reads L/R; never writes. Accumulates loudness + true-peak state.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed {
            return;
        }
        let n = left.len().min(right.len());
        for i in 0..n {
            let xl = left[i] as f64;
            let xr = right[i] as f64;

            // True-peak (pre-weighting, on the actual signal).
            let pl = self.tp_l.push(xl);
            let pr = self.tp_r.push(xr);
            let p = pl.max(pr);
            if p > self.tp_max {
                self.tp_max = p;
            }
            if pl > 1.0 {
                self.overs += 1;
            }
            if pr > 1.0 {
                self.overs += 1;
            }

            // K-weighted mean-square accumulation.
            let yl = self.kw_l.1.process(self.kw_l.0.process(xl));
            let yr = self.kw_r.1.process(self.kw_r.0.process(xr));
            self.sum_sq_l += yl * yl;
            self.sum_sq_r += yr * yr;
            self.sub_count += 1;

            if self.sub_count >= self.hop {
                self.finalize_subblock();
            }
        }
    }

    pub fn reset(&mut self) {
        self.kw_l = k_weight(self.sample_rate);
        self.kw_r = k_weight(self.sample_rate);
        self.sub_count = 0;
        self.sum_sq_l = 0.0;
        self.sum_sq_r = 0.0;
        self.sub_z = [0.0; 30];
        self.sub_pos = 0;
        self.sub_filled = 0;
        for c in self.hist_count.iter_mut() {
            *c = 0;
        }
        for e in self.hist_energy.iter_mut() {
            *e = 0.0;
        }
        self.tp_l.reset();
        self.tp_r.reset();
        self.tp_max = 0.0;
        self.overs = 0;
    }

    /// Momentary loudness (400 ms) in LUFS.
    pub fn momentary_lufs(&self) -> f32 {
        self.window_lufs(4)
    }

    /// Short-term loudness (3 s) in LUFS.
    pub fn short_lufs(&self) -> f32 {
        self.window_lufs(30)
    }

    /// Integrated (gated) loudness in LUFS since the last reset.
    pub fn integrated_lufs(&self) -> f32 {
        // Pass 1 — mean over all absolute-gated blocks (everything in the
        // histogram is already ≥ −70 LUFS).
        let mut count = 0u64;
        let mut energy = 0.0f64;
        for b in 0..HIST_BINS {
            count += self.hist_count[b] as u64;
            energy += self.hist_energy[b];
        }
        if count == 0 {
            return SILENCE_LUFS;
        }
        let rel_thresh = OFFSET + 10.0 * (energy / count as f64).log10() - 10.0;

        // Pass 2 — mean over blocks above the relative gate.
        let mut g_count = 0u64;
        let mut g_energy = 0.0f64;
        for b in 0..HIST_BINS {
            let bin_loud = HIST_LO + (b as f64 + 0.5) * HIST_STEP;
            if bin_loud >= rel_thresh {
                g_count += self.hist_count[b] as u64;
                g_energy += self.hist_energy[b];
            }
        }
        if g_count == 0 {
            return SILENCE_LUFS;
        }
        (OFFSET + 10.0 * (g_energy / g_count as f64).log10()) as f32
    }

    /// Maximum true-peak since reset, in dBTP.
    pub fn true_peak_db(&self) -> f32 {
        if self.tp_max <= 1e-9 {
            return SILENCE_LUFS;
        }
        (20.0 * self.tp_max.log10()) as f32
    }

    /// Count of oversampled samples over 0 dBTP since reset.
    pub fn overs(&self) -> f32 {
        self.overs as f32
    }

    // ── internals ──────────────────────────────────────────────────────

    fn finalize_subblock(&mut self) {
        let n = self.sub_count as f64;
        let z = self.sum_sq_l / n + self.sum_sq_r / n; // channel-summed mean-square
        self.sub_z[self.sub_pos] = z;
        self.sub_pos = (self.sub_pos + 1) % 30;
        if self.sub_filled < 30 {
            self.sub_filled += 1;
        }
        self.sum_sq_l = 0.0;
        self.sum_sq_r = 0.0;
        self.sub_count = 0;

        // Form a 400 ms integration block (last 4 sub-blocks) at this 100 ms
        // hop and add it to the gating histogram if it clears the absolute gate.
        if self.sub_filled >= 4 {
            let block_z = self.mean_last(4);
            if block_z > 0.0 {
                let loud = OFFSET + 10.0 * block_z.log10();
                if loud >= HIST_LO {
                    let bin = (((loud - HIST_LO) / HIST_STEP).floor() as isize)
                        .clamp(0, HIST_BINS as isize - 1) as usize;
                    self.hist_count[bin] += 1;
                    self.hist_energy[bin] += block_z;
                }
            }
        }
    }

    /// Mean of the most recent `want` sub-block energies.
    fn mean_last(&self, want: usize) -> f64 {
        let take = want.min(self.sub_filled);
        if take == 0 {
            return 0.0;
        }
        let mut sum = 0.0;
        for j in 0..take {
            let idx = (self.sub_pos + 30 - 1 - j) % 30;
            sum += self.sub_z[idx];
        }
        sum / take as f64
    }

    fn window_lufs(&self, blocks: usize) -> f32 {
        let z = self.mean_last(blocks);
        if z <= 0.0 {
            return SILENCE_LUFS;
        }
        (OFFSET + 10.0 * z.log10()) as f32
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: f32 = 48000.0;

    /// Stereo sine (identical L/R) of `n` samples at amplitude `amp`.
    fn stereo_sine(freq: f32, amp: f32, n: usize) -> (Vec<f32>, Vec<f32>) {
        let l: Vec<f32> =
            (0..n).map(|i| amp * (2.0 * PI * freq * i as f32 / SR).sin()).collect();
        (l.clone(), l)
    }

    #[test]
    fn k_weight_near_unity_at_1k() {
        // The K curve is ~flat near 1 kHz; gain should be within a couple dB.
        let (mut shelf, mut hp) = k_weight(SR as f64);
        let n = 48000;
        let mut sin_sq = 0.0f64;
        let mut out_sq = 0.0f64;
        for i in 0..n {
            let x = (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / SR as f64).sin();
            let y = hp.process(shelf.process(x));
            if i > 2000 {
                sin_sq += x * x;
                out_sq += y * y;
            }
        }
        let gain_db = 10.0 * (out_sq / sin_sq).log10();
        assert!(gain_db.abs() < 2.5, "K-weight gain at 1k = {gain_db} dB");
    }

    #[test]
    fn louder_input_reads_higher() {
        let mut m = Meter::new(SR);
        let (mut l, mut r) = stereo_sine(1000.0, 0.5, SR as usize);
        m.process_stereo(&mut l, &mut r);
        let quiet = m.momentary_lufs();

        let mut m2 = Meter::new(SR);
        let (mut l2, mut r2) = stereo_sine(1000.0, 1.0, SR as usize); // +6 dB
        m2.process_stereo(&mut l2, &mut r2);
        let loud = m2.momentary_lufs();

        let delta = loud - quiet;
        assert!((delta - 6.0).abs() < 0.4, "doubling amplitude → +6 LU, got {delta}");
    }

    #[test]
    fn integrated_in_plausible_range() {
        // A 1 kHz stereo sine at amplitude 1.0 should land in a sane LUFS band.
        let mut m = Meter::new(SR);
        let (mut l, mut r) = stereo_sine(1000.0, 1.0, 3 * SR as usize);
        m.process_stereo(&mut l, &mut r);
        let i = m.integrated_lufs();
        assert!(i > -10.0 && i < 6.0, "integrated LUFS out of range: {i}");
    }

    #[test]
    fn true_peak_catches_inter_sample() {
        // 12 kHz (= SR/4) sine at π/4 phase: samples sit at ±0.707 but the
        // continuous peak is ~1.0. True-peak must exceed the sample peak.
        let n = 8000;
        let amp = 1.0f32;
        let l: Vec<f32> = (0..n)
            .map(|i| amp * (2.0 * PI * (SR / 4.0) * i as f32 / SR + PI / 4.0).sin())
            .collect();
        let mut r = l.clone();
        let mut ll = l.clone();
        let sample_peak = l.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        let mut m = Meter::new(SR);
        m.process_stereo(&mut ll, &mut r);
        let tp_db = m.true_peak_db();
        let sp_db = 20.0 * sample_peak.log10();
        assert!(tp_db > sp_db + 1.0, "true-peak {tp_db} should exceed sample peak {sp_db}");
        assert!(tp_db > -1.5, "true-peak should approach 0 dBTP, got {tp_db}");
    }

    #[test]
    fn silence_and_reset() {
        let mut m = Meter::new(SR);
        let (mut l, mut r) = stereo_sine(1000.0, 1.0, SR as usize);
        m.process_stereo(&mut l, &mut r);
        assert!(m.integrated_lufs() > -10.0);
        m.reset();
        assert_eq!(m.integrated_lufs(), SILENCE_LUFS);
        assert_eq!(m.true_peak_db(), SILENCE_LUFS);
        assert_eq!(m.overs(), 0.0);
    }
}
