//! Pitch — monophonic pitch corrector.
//!
//! Per docs/implementation.html §07 — the v1 "Pitch" insert. Detects the
//! sung fundamental, snaps it to the chosen key/scale, and resynthesises the
//! corrected pitch in the time domain (no FFT). Two stages:
//!
//! 1. **Detection (YIN)** — cumulative-mean-normalised difference function
//!    over a window of recent input gives the period τ → f0. Below an
//!    aperiodicity threshold the frame is treated as voiced; otherwise the
//!    corrector glides back to no shift (unvoiced / silence passes through).
//!
//! 2. **Correction + shift** — f0 → MIDI → nearest in-scale note → a pitch
//!    ratio. `amount` scales how far toward the target (in cents); `speed`
//!    sets the glide time; `humanize` relaxes the strength and adds a slow
//!    random drift so it isn't robotic. The ratio drives a classic two-tap
//!    cross-fading delay-line pitch shifter (Hann-windowed grains, half a
//!    grain apart → constant-power overlap). Duration is preserved.
//!
//! Latency: the shifter reads from a window of recent history, so its group
//! delay is a constant `GRAIN/2` samples **when engaged**, and exactly zero
//! when bypassed (straight passthrough). The host uses `latency_samples()`
//! for plugin-delay-compensation across the mixer.
//!
//! Monophonic by design (vocals/leads). Detection runs on L; the same ratio
//! is applied to L and R independently, preserving stereo width. `formant`
//! is accepted by the UI but not yet processed (no-op this version).
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(key_root, scale_id, speed, amount, humanize)
//!   set_bypassed(bool)
//!   process_stereo(&mut [f32], &mut [f32])
//!   process_mono(&mut [f32])
//!   reset()
//!   latency_samples() -> u32
//!   detected_hz() -> f32   (last detected f0, 0 = unvoiced — also drives the UI)

use std::f32::consts::PI;
use wasm_bindgen::prelude::*;

const RING: usize = 4096;
const RING_MASK: usize = RING - 1;
/// Grain length for the two-tap shifter. Reported latency is GRAIN/2.
const GRAIN: f32 = 1024.0;
const HALF_GRAIN: f32 = GRAIN * 0.5;
const PITCH_LATENCY: u32 = 512; // GRAIN / 2

/// Samples of recent history fed to YIN. Must exceed the longest period
/// (≈ sr / MIN_HZ) by a comfortable margin.
const DET_WINDOW: usize = 2048;
/// How often (in samples) detection re-runs. ~8 ms at 48k.
const DET_HOP: usize = 384;
/// Aperiodicity threshold — below this τ counts as a confident period.
const YIN_THRESH: f32 = 0.15;
/// If even the best τ is this aperiodic, treat the frame as unvoiced.
const VOICED_LIMIT: f32 = 0.45;
const MIN_HZ: f32 = 70.0;
const MAX_HZ: f32 = 1000.0;
const SILENCE_RMS: f32 = 1e-4;

/// Correction magnitude (cents) over which the shifted ("wet") path fully takes
/// over from the clean delayed dry. Below DRY we pass dry (transparent on pitch
/// / unvoiced — no shifter artefacts); above FULL we fully correct.
const WET_DRY_CENTS: f32 = 2.0;
const WET_FULL_CENTS: f32 = 14.0;

const TWO_PI: f32 = 2.0 * PI;

/// Pitch-class membership for the four scales the UI exposes
/// (0 Major · 1 Minor · 2 Chromatic · 3 Pentatonic).
fn in_scale(semitone_from_root: i32, scale_id: i32) -> bool {
    let pc = ((semitone_from_root % 12) + 12) % 12;
    match scale_id {
        0 => matches!(pc, 0 | 2 | 4 | 5 | 7 | 9 | 11), // Major
        1 => matches!(pc, 0 | 2 | 3 | 5 | 7 | 8 | 10), // Minor
        3 => matches!(pc, 0 | 2 | 4 | 7 | 9),          // Pentatonic
        _ => true,                                     // Chromatic / unknown
    }
}

/// Nearest integer MIDI note (to a continuous `midi`) whose pitch class is in
/// the key+scale. Searches ±3 semitones, which always contains a member.
fn snap_midi(midi: f32, key_root: i32, scale_id: i32) -> f32 {
    let base = midi.round() as i32;
    let mut best = base;
    let mut best_dist = f32::MAX;
    for cand in (base - 3)..=(base + 3) {
        if in_scale(cand - key_root, scale_id) {
            let d = (cand as f32 - midi).abs();
            if d < best_dist {
                best_dist = d;
                best = cand;
            }
        }
    }
    best as f32
}

/// Middle of three values — `med = a+b+c − max − min`. A 3-point median over
/// successive detection hops rejects a single spurious estimate (a lone
/// octave/harmonic glitch) without lagging steady pitch.
fn median3(a: f32, b: f32, c: f32) -> f32 {
    let mx = a.max(b).max(c);
    let mn = a.min(b).min(c);
    a + b + c - mx - mn
}

/// Fold an octave-error estimate back onto the running pitch. YIN occasionally
/// latches a sub-/super-harmonic (½× or 2× the true period); when the new
/// estimate sits within ~6 % of an exact octave of `prev` we read it as that
/// error and fold it. Genuine melodic intervals (anything but an octave) pass
/// untouched, so real leaps still track.
fn octave_snap(f0: f32, prev: f32) -> f32 {
    if f0 <= 0.0 || prev <= 0.0 {
        return f0;
    }
    if (f0 / (prev * 2.0) - 1.0).abs() < 0.06 {
        f0 * 0.5
    } else if (f0 / (prev * 0.5) - 1.0).abs() < 0.06 {
        f0 * 2.0
    } else {
        f0
    }
}

/// Wet (shifted) proportion for a correction magnitude in cents — a smoothstep
/// from fully dry below WET_DRY_CENTS to fully wet above WET_FULL_CENTS, so the
/// shifter only engages once the note is meaningfully off pitch and stays
/// transparent when it's already in tune.
fn wet_mix(cents: f32) -> f32 {
    let t = ((cents - WET_DRY_CENTS) / (WET_FULL_CENTS - WET_DRY_CENTS)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[wasm_bindgen]
pub struct Pitch {
    sample_rate: f32,
    bypassed: bool,

    // Params (UI units).
    key_root: i32,  // 0..11 (C..B)
    scale_id: i32,  // 0..3
    amount: f32,    // 0..100
    humanize: f32,  // 0..100

    // Detection.
    tau_min: usize,
    tau_max: usize,
    det_counter: usize,
    detected_f0: f32,    // Hz, 0 = unvoiced (the stabilised value the UI plots)
    f0_hist: [f32; 3],   // recent raw YIN estimates, for median outlier-reject
    smoothed_f0: f32,    // running stabilised f0 (0 = unvoiced)

    // Ring buffers (L/R share write_pos + sweep so the ratio is identical).
    ring_l: Vec<f32>,
    ring_r: Vec<f32>,
    write_pos: usize,
    sweep: f32, // ∈ [0, GRAIN)

    // Correction state, all in cents.
    applied_cents: f32,
    target_cents: f32,
    glide_coeff: f32, // per-sample one-pole carry-over (from `speed`)
    drift_cents: f32, // humanize wander

    rng: u32,
}

#[wasm_bindgen]
impl Pitch {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        let tau_min = (sr / MAX_HZ).floor().max(2.0) as usize;
        let tau_max = ((sr / MIN_HZ).ceil() as usize).min(DET_WINDOW - 1);
        let mut p = Self {
            sample_rate: sr,
            bypassed: false,
            key_root: 9, // A
            scale_id: 1, // Minor
            amount: 100.0,
            humanize: 20.0,
            tau_min,
            tau_max,
            det_counter: 0,
            detected_f0: 0.0,
            f0_hist: [0.0; 3],
            smoothed_f0: 0.0,
            ring_l: vec![0.0; RING],
            ring_r: vec![0.0; RING],
            write_pos: 0,
            sweep: 0.0,
            applied_cents: 0.0,
            target_cents: 0.0,
            glide_coeff: 0.0,
            drift_cents: 0.0,
            rng: 0x9E3779B9,
        };
        p.recompute_glide(40.0);
        p
    }

    /// key_root 0..11, scale_id 0..3, speed/amount/humanize 0..100.
    pub fn set_params(&mut self, key_root: i32, scale_id: i32, speed: f32, amount: f32, humanize: f32) {
        self.key_root = ((key_root % 12) + 12) % 12;
        self.scale_id = scale_id.clamp(0, 3);
        self.amount = amount.clamp(0.0, 100.0);
        self.humanize = humanize.clamp(0.0, 100.0);
        self.recompute_glide(speed.clamp(0.0, 100.0));
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    pub fn reset(&mut self) {
        for v in self.ring_l.iter_mut() {
            *v = 0.0;
        }
        for v in self.ring_r.iter_mut() {
            *v = 0.0;
        }
        self.write_pos = 0;
        self.sweep = 0.0;
        self.applied_cents = 0.0;
        self.target_cents = 0.0;
        self.drift_cents = 0.0;
        self.detected_f0 = 0.0;
        self.f0_hist = [0.0; 3];
        self.smoothed_f0 = 0.0;
        self.det_counter = 0;
    }

    /// Constant group delay (samples) the engaged shifter imposes. The host
    /// compensates other channels by this much. Zero when bypassed.
    pub fn latency_samples(&self) -> u32 {
        PITCH_LATENCY
    }

    /// Last detected fundamental in Hz (0 = unvoiced/silent). Lets the UI
    /// draw the real pitch instead of a synthetic trace.
    pub fn detected_hz(&self) -> f32 {
        self.detected_f0
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed {
            return;
        }
        let n = left.len().min(right.len());
        for i in 0..n {
            let (ol, or) = self.tick(left[i], right[i]);
            left[i] = ol;
            right[i] = or;
        }
    }

    pub fn process_mono(&mut self, buffer: &mut [f32]) {
        if self.bypassed {
            return;
        }
        for x in buffer.iter_mut() {
            let (o, _) = self.tick(*x, *x);
            *x = o;
        }
    }

    // ── internals ──────────────────────────────────────────────────────

    fn recompute_glide(&mut self, speed: f32) {
        // speed 0 → slow glide (~220 ms), 100 → snappy (~4 ms).
        let time_ms = 220.0 - (speed / 100.0) * 216.0;
        let tau = (time_ms * 0.001 * self.sample_rate).max(1.0);
        self.glide_coeff = (-1.0 / tau).exp();
    }

    #[inline]
    fn next_rand(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// One sample. Writes input to the rings, retriggers detection on the
    /// hop boundary, glides the correction, and reads the two shifter taps.
    #[inline]
    fn tick(&mut self, in_l: f32, in_r: f32) -> (f32, f32) {
        self.ring_l[self.write_pos] = in_l;
        self.ring_r[self.write_pos] = in_r;

        self.det_counter += 1;
        if self.det_counter >= DET_HOP {
            self.det_counter = 0;
            self.update_pitch();
        }

        // Glide the correction (cents) toward target.
        self.applied_cents =
            self.glide_coeff * self.applied_cents + (1.0 - self.glide_coeff) * self.target_cents;
        let ratio = (self.applied_cents / 1200.0).exp2();

        // Advance the shared sweep; wrap into [0, GRAIN). A fixed grain keeps
        // both tap lags continuous — resizing it per hop made the read jump and
        // clicked, so the grain stays constant and the wrap is masked by the
        // two-tap crossfade (Hann taps half a grain apart, wa+wb ≡ 1).
        self.sweep += 1.0 - ratio;
        if self.sweep >= GRAIN {
            self.sweep -= GRAIN;
        } else if self.sweep < 0.0 {
            self.sweep += GRAIN;
        }
        let da = self.sweep;
        let db = if da + HALF_GRAIN >= GRAIN { da - HALF_GRAIN } else { da + HALF_GRAIN };
        let wa = 0.5 - 0.5 * (TWO_PI * da / GRAIN).cos();
        let wb = 0.5 - 0.5 * (TWO_PI * db / GRAIN).cos();

        let sh_l = wa * read(&self.ring_l, self.write_pos, da)
            + wb * read(&self.ring_l, self.write_pos, db);
        let sh_r = wa * read(&self.ring_r, self.write_pos, da)
            + wb * read(&self.ring_r, self.write_pos, db);

        // Blend toward the shifted signal only as far as we're actually
        // correcting; otherwise pass the clean dry, delayed by the same group
        // delay (HALF_GRAIN) so the crossfade stays phase-aligned and click-free.
        let wet = wet_mix(self.applied_cents.abs());
        let dry = 1.0 - wet;
        let out_l = dry * read(&self.ring_l, self.write_pos, HALF_GRAIN) + wet * sh_l;
        let out_r = dry * read(&self.ring_r, self.write_pos, HALF_GRAIN) + wet * sh_r;

        self.write_pos = (self.write_pos + 1) & RING_MASK;
        (out_l, out_r)
    }

    /// Re-detect f0 over the recent window and recompute the target cents.
    fn update_pitch(&mut self) {
        // Raw per-hop YIN estimate → robustness chain: a 3-point median drops a
        // single spurious hop, an octave guard folds half/double-period latches
        // back onto the running pitch, and a light one-pole smooths the rest.
        // This kills the brief octave-glitch spikes without lagging real notes.
        let raw = self.detect_f0();
        self.f0_hist[2] = self.f0_hist[1];
        self.f0_hist[1] = self.f0_hist[0];
        self.f0_hist[0] = raw;
        let mut f0 = median3(self.f0_hist[0], self.f0_hist[1], self.f0_hist[2]);

        if f0 > 0.0 {
            f0 = octave_snap(f0, self.smoothed_f0);
            self.smoothed_f0 = if self.smoothed_f0 > 0.0 {
                0.6 * self.smoothed_f0 + 0.4 * f0
            } else {
                f0
            };
        } else {
            self.smoothed_f0 = 0.0;
        }
        let f0 = self.smoothed_f0;
        self.detected_f0 = f0;

        // Slow random wander for humanize (updated once per hop).
        let max_drift = (self.humanize / 100.0) * 18.0; // cents
        let want = self.next_rand() * max_drift;
        self.drift_cents += 0.12 * (want - self.drift_cents);

        if f0 > 0.0 {
            let midi = 69.0 + 12.0 * (f0 / 440.0).log2();
            let snapped = snap_midi(midi, self.key_root, self.scale_id);
            let err_cents = (snapped - midi) * 100.0;
            // humanize also relaxes how hard we pull to pitch.
            let strength = (self.amount / 100.0) * (1.0 - 0.4 * (self.humanize / 100.0));
            self.target_cents = err_cents * strength + self.drift_cents;
        } else {
            self.target_cents = 0.0;
        }
    }

    /// YIN over the most recent DET_WINDOW samples of `ring_l`. Returns f0 in
    /// Hz, or 0.0 when silent / unvoiced.
    fn detect_f0(&self) -> f32 {
        // Gather window oldest→newest into a contiguous scratch buffer.
        let mut w = [0.0f32; DET_WINDOW];
        let start = (self.write_pos + RING - DET_WINDOW) & RING_MASK;
        let mut energy = 0.0f32;
        for (k, slot) in w.iter_mut().enumerate() {
            let s = self.ring_l[(start + k) & RING_MASK];
            *slot = s;
            energy += s * s;
        }
        if (energy / DET_WINDOW as f32).sqrt() < SILENCE_RMS {
            return 0.0;
        }

        let tau_max = self.tau_max.min(DET_WINDOW - 2);
        let mut cmnd = vec![1.0f32; tau_max + 1];
        let mut running = 0.0f32;
        for tau in 1..=tau_max {
            let len = DET_WINDOW - tau;
            let mut d = 0.0f32;
            for j in 0..len {
                let diff = w[j] - w[j + tau];
                d += diff * diff;
            }
            running += d;
            cmnd[tau] = if running > 0.0 { d * tau as f32 / running } else { 1.0 };
        }

        // First τ ≥ tau_min that dips below the threshold and is a local min;
        // else the global minimum across the range.
        let mut chosen = 0usize;
        let mut tau = self.tau_min.max(2);
        while tau <= tau_max {
            if cmnd[tau] < YIN_THRESH {
                while tau + 1 <= tau_max && cmnd[tau + 1] < cmnd[tau] {
                    tau += 1;
                }
                chosen = tau;
                break;
            }
            tau += 1;
        }
        if chosen == 0 {
            let mut best = self.tau_min.max(2);
            for t in (self.tau_min.max(2))..=tau_max {
                if cmnd[t] < cmnd[best] {
                    best = t;
                }
            }
            if cmnd[best] > VOICED_LIMIT {
                return 0.0; // too aperiodic — unvoiced
            }
            chosen = best;
        }

        // Parabolic interpolation around the dip for sub-sample τ.
        let tau_f = if chosen > self.tau_min && chosen < tau_max {
            let s0 = cmnd[chosen - 1];
            let s1 = cmnd[chosen];
            let s2 = cmnd[chosen + 1];
            let denom = 2.0 * (2.0 * s1 - s0 - s2);
            if denom.abs() > 1e-9 {
                chosen as f32 + (s2 - s0) / denom
            } else {
                chosen as f32
            }
        } else {
            chosen as f32
        };

        if tau_f > 0.0 {
            self.sample_rate / tau_f
        } else {
            0.0
        }
    }
}

/// Fractional read from a ring buffer, `lag` samples behind the write head.
#[inline]
fn read(ring: &[f32], write_pos: usize, lag: f32) -> f32 {
    let p = write_pos as f32 - lag;
    let ip = p.floor();
    let frac = p - ip;
    let i0 = (ip as i64).rem_euclid(RING as i64) as usize;
    let i1 = (i0 + 1) & RING_MASK;
    ring[i0] * (1.0 - frac) + ring[i1] * frac
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(freq: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| 0.6 * (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    /// Zero-crossing rate (per second) of a steady segment — a cheap pitch proxy.
    fn zcr(buf: &[f32], sr: f32) -> f32 {
        let mut crossings = 0;
        for w in buf.windows(2) {
            if (w[0] <= 0.0 && w[1] > 0.0) || (w[0] >= 0.0 && w[1] < 0.0) {
                crossings += 1;
            }
        }
        crossings as f32 / (buf.len() as f32 / sr)
    }

    #[test]
    fn scale_membership() {
        assert!(in_scale(0, 0)); // root in Major
        assert!(!in_scale(1, 0)); // minor 2nd not in Major
        assert!(in_scale(3, 1)); // minor 3rd in Minor
        assert!(!in_scale(4, 1)); // major 3rd not in Minor
        assert!(in_scale(7, 3)); // 5th in Pentatonic
        assert!(!in_scale(5, 3)); // 4th not in Pentatonic
        for s in 0..12 {
            assert!(in_scale(s, 2)); // Chromatic accepts all
        }
    }

    #[test]
    fn snap_picks_nearest_in_scale() {
        // C Major (root 0). 60=C in scale → stays. 61=C# → snaps to 60 or 62.
        assert_eq!(snap_midi(60.0, 0, 0), 60.0);
        let s = snap_midi(61.2, 0, 0);
        assert!(s == 60.0 || s == 62.0);
        // A Minor (root 9): G#(68, pc8) not in minor → snaps to A(69) or G(67).
        let s = snap_midi(68.4, 9, 1);
        assert!(s == 67.0 || s == 69.0);
    }

    #[test]
    fn bypass_is_passthrough() {
        let mut p = Pitch::new(48000.0);
        p.set_params(0, 0, 50.0, 100.0, 0.0);
        p.set_bypassed(true);
        let original = sine(233.0, 48000.0, 4096);
        let mut buf = original.clone();
        p.process_mono(&mut buf);
        for (a, b) in buf.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-9, "bypass must be bit-exact passthrough");
        }
    }

    #[test]
    fn engaged_amount_zero_preserves_energy() {
        // amount 0 ⇒ ratio 1 ⇒ a clean delayed copy; RMS should be preserved.
        let mut p = Pitch::new(48000.0);
        p.set_params(9, 1, 50.0, 0.0, 0.0);
        let input = sine(220.0, 48000.0, 16384);
        let mut buf = input.clone();
        p.process_mono(&mut buf);
        let rms = |b: &[f32]| (b.iter().map(|v| v * v).sum::<f32>() / b.len() as f32).sqrt();
        // measure past the initial latency/glide settling
        let r_in = rms(&input[4096..]);
        let r_out = rms(&buf[4096..]);
        assert!(
            (r_out - r_in).abs() / r_in < 0.2,
            "amount=0 should preserve level; in={r_in} out={r_out}"
        );
    }

    #[test]
    fn detects_220hz() {
        let mut p = Pitch::new(48000.0);
        p.set_params(9, 1, 50.0, 0.0, 0.0); // amount 0 — just want detection
        let mut buf = sine(220.0, 48000.0, 8192);
        p.process_mono(&mut buf);
        let f0 = p.detected_hz();
        assert!((f0 - 220.0).abs() / 220.0 < 0.05, "expected ~220 Hz, got {f0}");
    }

    #[test]
    fn corrects_sharp_note_downward() {
        // 226 Hz is ~A4 (+47 cents). In A-minor (root 9), A is in scale, so
        // full correction should pull the pitch DOWN toward 220 Hz.
        let sr = 48000.0;
        let input = sine(226.0, sr, 32768);
        let mut buf = input.clone();
        let mut p = Pitch::new(sr);
        p.set_params(9, 1, 80.0, 100.0, 0.0);
        p.process_mono(&mut buf);
        // Compare zero-crossing rate over a settled tail.
        let in_zcr = zcr(&input[8192..], sr);
        let out_zcr = zcr(&buf[8192..], sr);
        assert!(
            out_zcr < in_zcr - 1.0,
            "correction should lower the pitch toward A=220; in_zcr={in_zcr} out_zcr={out_zcr}"
        );
    }

    #[test]
    fn noise_passes_without_blowing_up() {
        // Unvoiced/noise input shouldn't produce NaNs or runaway gain.
        let mut p = Pitch::new(48000.0);
        p.set_params(0, 0, 50.0, 100.0, 50.0);
        let mut rng = 0x1234567u32;
        let mut buf: Vec<f32> = (0..8192)
            .map(|_| {
                rng ^= rng << 13;
                rng ^= rng >> 17;
                rng ^= rng << 5;
                (rng as f32 / u32::MAX as f32) * 0.4 - 0.2
            })
            .collect();
        p.process_mono(&mut buf);
        for x in &buf {
            assert!(x.is_finite() && x.abs() < 4.0, "output went unstable: {x}");
        }
    }

    #[test]
    fn median3_rejects_a_single_spike() {
        assert_eq!(median3(1.0, 3.0, 2.0), 2.0);
        assert_eq!(median3(220.0, 9000.0, 219.0), 220.0); // octave/harmonic spike
        assert_eq!(median3(0.0, 0.0, 440.0), 0.0); // lone voiced amid unvoiced
        assert_eq!(median3(221.0, 220.0, 219.0), 220.0);
    }

    #[test]
    fn octave_snap_folds_errors_but_keeps_intervals() {
        assert!((octave_snap(440.0, 220.0) - 220.0).abs() < 1.0); // octave-high latch ↓
        assert!((octave_snap(110.0, 220.0) - 220.0).abs() < 1.0); // octave-low latch ↑
        assert!((octave_snap(330.0, 220.0) - 330.0).abs() < 1.0); // real fifth — untouched
        assert_eq!(octave_snap(440.0, 0.0), 440.0); // no history ⇒ passthrough
    }

    /// Realistic singing: a 220 Hz tone with 5 Hz, ±35-cent vibrato so f0
    /// wanders continuously (the case that exposes click sources).
    fn vibrato(sr: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                let cents = 35.0 * (2.0 * PI * 5.0 * t).sin();
                let f = 220.0 * (cents / 1200.0).exp2();
                // integrate frequency for phase continuity
                0.6 * (2.0 * PI * f * t).sin()
            })
            .collect()
    }

    #[test]
    fn no_click_discontinuities_on_wandering_pitch() {
        // Correcting a continuously-wandering voice must not introduce sample
        // jumps far beyond the signal's own slope. (Resizing the grain per hop
        // regressed this to ~33× with dozens of audible clicks; this guards it.)
        let sr = 48000.0;
        let input = vibrato(sr, 48000);
        let mut buf = input.clone();
        let mut p = Pitch::new(sr);
        p.set_params(9, 1, 60.0, 100.0, 0.0); // A-minor, full correct
        p.process_mono(&mut buf);
        let max_d = |b: &[f32]| {
            b[8192..].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max)
        };
        let in_jump = max_d(&input);
        let out_jump = max_d(&buf);
        let big = buf[8192..]
            .windows(2)
            .filter(|w| (w[1] - w[0]).abs() > 5.0 * in_jump)
            .count();
        assert!(
            out_jump < 2.0 * in_jump && big == 0,
            "shifter introduced discontinuities: in={in_jump:.5} out={out_jump:.5} big={big}"
        );
    }

    #[test]
    fn wet_mix_ramps_dry_to_wet() {
        assert_eq!(wet_mix(0.0), 0.0); // on pitch ⇒ pass dry
        assert_eq!(wet_mix(WET_FULL_CENTS + 10.0), 1.0); // well off ⇒ full shift
        let mid = wet_mix((WET_DRY_CENTS + WET_FULL_CENTS) * 0.5);
        assert!(mid > 0.2 && mid < 0.8, "midpoint should be partial: {mid}");
    }
}
