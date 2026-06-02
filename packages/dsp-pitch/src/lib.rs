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
//!    random drift so it isn't robotic. The ratio drives **period-synchronous
//!    overlap-add**: 2-period Hann grains of recent input are laid at marks
//!    spaced by the *corrected* period. Period-aligned grains overlap-add
//!    coherently (no comb), each grain keeps the original waveform so formants
//!    are preserved, and resampling each grain by `formant` shifts the spectral
//!    envelope independently of pitch. Duration is preserved.
//!
//! Latency: synthesis reads from a fixed look-back so its group delay is a
//! constant `PITCH_LATENCY` samples **when engaged**, and exactly zero when
//! bypassed (straight passthrough). The host uses `latency_samples()` for
//! plugin-delay-compensation across the mixer.
//!
//! Monophonic by design (vocals/leads). Detection runs on L; the same period
//! marks drive L and R, preserving stereo width.
//!
//! ABI (wasm-bindgen):
//!   new(sample_rate)
//!   set_params(key_root, scale_id, speed, amount, humanize, formant)
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

// ── Period-synchronous overlap-add synthesis ──────────────────────────────
// Output OLA accumulator ring (power of two; must exceed SYN_LATENCY + GMAX).
const OUT_RING: usize = 4096;
const OUT_MASK: usize = OUT_RING - 1;
/// Grain length bounds (samples). A grain spans ~2 detected periods; capped so
/// latency stays bounded for very low notes (a sub-100 Hz note just gets a
/// slightly-under-2-period grain).
const GMIN: usize = 128;
const GMAX: usize = 1024;
/// Output placement: grain centres sit this far ahead of the read head, so a
/// freshly-laid grain writes strictly ahead of where we're reading.
const SYN_AHEAD: usize = 640;
/// Nominal analysis-centre lag (samples behind newest input). The analysis
/// pointer drifts ±period/2 around this to pick successive epochs, so this must
/// leave room for a formant-expanded half-grain read to stay causal.
const ANALYSIS_LAG: f32 = 1024.0;
/// Constant synthesis latency = ANALYSIS_LAG + SYN_AHEAD. Reported by
/// `latency_samples()`; the host's PDC constant matches.
const PITCH_LATENCY: u32 = 1664;
/// Max formant shift the knob maps to, in semitones (±). Kept modest so the
/// formant-expanded grain read stays within the analysis-lag headroom.
const FORMANT_SEMITONES: f32 = 4.0;

/// Samples of recent history fed to YIN. Must exceed the longest period
/// (≈ sr / MIN_HZ) by a comfortable margin.
const DET_WINDOW: usize = 2048;
/// YIN runs on a boxcar-decimated copy of the window — the difference function
/// is O(len · lag-range), so decimating by 4 cuts detection cost ~16×. That
/// headroom is what lets several channels run Pitch at once without the audio
/// thread overrunning its deadline (the multi-track glitch). Parabolic
/// interpolation recovers sub-sample period resolution, so f0 accuracy holds.
const DECIM: usize = 4;
/// Decimated window length actually fed to the difference function.
const DET_LEN: usize = DET_WINDOW / DECIM;
/// How often (in samples) detection re-runs. ~8 ms at 48k.
const DET_HOP: usize = 384;
/// Aperiodicity threshold — below this τ counts as a confident period.
const YIN_THRESH: f32 = 0.15;
/// If even the best τ is this aperiodic, treat the frame as unvoiced.
const VOICED_LIMIT: f32 = 0.45;
/// Detection hops a freshly-voiced note must persist before we start
/// correcting it — attacks/onsets give garbage f0, so we hold off (~32 ms).
const ONSET_HOLD: u32 = 4;
/// Hops a *new* snapped note must be seen consecutively before we re-aim at it.
/// Keeps the corrector locked to the held note across a transient mis-detection
/// instead of lurching note-to-note at boundaries (~16 ms).
const NOTE_HOLD: u32 = 2;
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
    formant: f32,   // -100..100 (0 = preserve)
    formant_factor: f32, // derived spectral-envelope scale (2^(semitones/12))

    // Detection.
    tau_min: usize,
    tau_max: usize,
    det_counter: usize,
    detected_f0: f32,    // Hz, 0 = unvoiced (the stabilised value the UI plots)
    f0_hist: [f32; 3],   // recent raw YIN estimates, for median outlier-reject
    smoothed_f0: f32,    // running stabilised f0 (0 = unvoiced)
    voiced_run: u32,     // consecutive voiced hops (onset hold-off)
    held_note: i32,      // committed snap target (MIDI); i32::MIN = none
    cand_note: i32,      // pending snap target awaiting confirmation
    cand_run: u32,       // consecutive hops cand_note has been seen

    // Input ring buffers.
    ring_l: Vec<f32>,
    ring_r: Vec<f32>,
    write_pos: usize,

    // Period-synchronous OLA synthesis. Grains (2-period Hann windows of recent
    // input) are laid into the output accumulator at marks spaced by the
    // *corrected* period; out_w holds the running window-sum for flat gain.
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    out_w: Vec<f32>,
    out_pos: usize,
    syn_phase: f32, // samples until the next grain mark
    a_lag: f32,     // analysis-centre lag behind newest input (drifts to shift pitch)

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
        // Lag bounds in *decimated* samples (YIN runs at sr / DECIM).
        let dsr = sr / DECIM as f32;
        let tau_min = (dsr / MAX_HZ).floor().max(2.0) as usize;
        let tau_max = ((dsr / MIN_HZ).ceil() as usize).min(DET_LEN - 2);
        let mut p = Self {
            sample_rate: sr,
            bypassed: false,
            key_root: 9, // A
            scale_id: 1, // Minor
            amount: 100.0,
            humanize: 20.0,
            formant: 0.0,
            formant_factor: 1.0,
            tau_min,
            tau_max,
            det_counter: 0,
            detected_f0: 0.0,
            f0_hist: [0.0; 3],
            smoothed_f0: 0.0,
            voiced_run: 0,
            held_note: i32::MIN,
            cand_note: i32::MIN,
            cand_run: 0,
            ring_l: vec![0.0; RING],
            ring_r: vec![0.0; RING],
            write_pos: 0,
            out_l: vec![0.0; OUT_RING],
            out_r: vec![0.0; OUT_RING],
            out_w: vec![0.0; OUT_RING],
            out_pos: 0,
            syn_phase: 0.0,
            a_lag: ANALYSIS_LAG,
            applied_cents: 0.0,
            target_cents: 0.0,
            glide_coeff: 0.0,
            drift_cents: 0.0,
            rng: 0x9E3779B9,
        };
        p.recompute_glide(40.0);
        p
    }

    /// key_root 0..11, scale_id 0..3, speed/amount/humanize 0..100,
    /// formant −100..100 (0 = preserve; ± shifts the spectral envelope by up to
    /// FORMANT_SEMITONES, independent of pitch).
    pub fn set_params(
        &mut self,
        key_root: i32,
        scale_id: i32,
        speed: f32,
        amount: f32,
        humanize: f32,
        formant: f32,
    ) {
        self.key_root = ((key_root % 12) + 12) % 12;
        self.scale_id = scale_id.clamp(0, 3);
        self.amount = amount.clamp(0.0, 100.0);
        self.humanize = humanize.clamp(0.0, 100.0);
        self.formant = formant.clamp(-100.0, 100.0);
        self.formant_factor = ((self.formant / 100.0) * FORMANT_SEMITONES / 12.0).exp2();
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
        for v in self.out_l.iter_mut() {
            *v = 0.0;
        }
        for v in self.out_r.iter_mut() {
            *v = 0.0;
        }
        for v in self.out_w.iter_mut() {
            *v = 0.0;
        }
        self.out_pos = 0;
        self.syn_phase = 0.0;
        self.a_lag = ANALYSIS_LAG;
        self.applied_cents = 0.0;
        self.target_cents = 0.0;
        self.drift_cents = 0.0;
        self.detected_f0 = 0.0;
        self.f0_hist = [0.0; 3];
        self.smoothed_f0 = 0.0;
        self.voiced_run = 0;
        self.held_note = i32::MIN;
        self.cand_note = i32::MIN;
        self.cand_run = 0;
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

        // ── Period-synchronous overlap-add ──────────────────────────────
        // Emit the normalised accumulator sample at the read head, then clear
        // it (grains were laid SYN_LATENCY ahead, so this slot is complete).
        let oi = self.out_pos & OUT_MASK;
        let wsum = self.out_w[oi];
        let (sh_l, sh_r) = if wsum > 1e-6 {
            (self.out_l[oi] / wsum, self.out_r[oi] / wsum)
        } else {
            (0.0, 0.0)
        };
        self.out_l[oi] = 0.0;
        self.out_r[oi] = 0.0;
        self.out_w[oi] = 0.0;

        // Lay a 2-period Hann grain whenever the synthesis mark arrives. Marks
        // are spaced by the *corrected* period (period / ratio): closer ⇒
        // higher pitch, while each grain still carries the original waveform, so
        // formants are preserved (period-aligned grains overlap-add coherently —
        // no comb). The newest grain sample anchors to the newest input, so the
        // read lag is always ≥ 0 (causal) for any formant factor.
        let period = if self.smoothed_f0 > 0.0 {
            self.sample_rate / self.smoothed_f0
        } else {
            256.0
        };
        let g = (2.0 * period).round().clamp(GMIN as f32, GMAX as f32) as usize;
        let g2 = g / 2;
        self.syn_phase -= 1.0;
        while self.syn_phase <= 0.0 {
            let ff = self.formant_factor;
            let gf = g as f32;
            for j in 0..g {
                let w = 0.5 - 0.5 * (TWO_PI * j as f32 / gf).cos();
                // Read the grain centred at the analysis lag; formant resampling
                // (`ff`) scales the spectral envelope independent of pitch.
                let off = j as f32 - g2 as f32;
                let lag = self.a_lag - off * ff;
                // Place centred SYN_AHEAD beyond the read head (always unread).
                let oidx = (self.out_pos + SYN_AHEAD + j - g2) & OUT_MASK;
                self.out_l[oidx] += w * read(&self.ring_l, self.write_pos, lag);
                self.out_r[oidx] += w * read(&self.ring_r, self.write_pos, lag);
                self.out_w[oidx] += w;
            }
            // Synthesis marks advance by the corrected period; the analysis
            // pointer advances by the input period. Their difference drifts
            // `a_lag` (selecting successive epochs → the pitch shift); wrap it by
            // whole periods to stay near ANALYSIS_LAG (bounded, phase-continuous).
            let po = (period / ratio).max(1.0);
            self.a_lag += po - period;
            while self.a_lag > ANALYSIS_LAG + period * 0.5 {
                self.a_lag -= period;
            }
            while self.a_lag < ANALYSIS_LAG - period * 0.5 {
                self.a_lag += period;
            }
            self.syn_phase += po;
        }

        // Blend toward the shifted (wet) path as far as we're correcting — or
        // fully when FORMANT is engaged (it processes independent of pitch).
        // Otherwise the clean dry, delayed by the same SYN_LATENCY so the
        // crossfade stays phase-aligned and click-free.
        let wet = wet_mix(self.applied_cents.abs()).max(if self.formant != 0.0 { 1.0 } else { 0.0 });
        let dry = 1.0 - wet;
        let lat = PITCH_LATENCY as f32;
        let out_l = dry * read(&self.ring_l, self.write_pos, lat) + wet * sh_l;
        let out_r = dry * read(&self.ring_r, self.write_pos, lat) + wet * sh_r;

        self.write_pos = (self.write_pos + 1) & RING_MASK;
        self.out_pos += 1;
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
            self.voiced_run += 1;
            let midi = 69.0 + 12.0 * (f0 / 440.0).log2();
            let snapped = snap_midi(midi, self.key_root, self.scale_id) as i32;

            // Note hysteresis: a new snapped note must hold for NOTE_HOLD hops
            // before we re-aim at it, so a transient mis-detection (or the brief
            // glide between two notes) doesn't make the corrector lurch.
            if snapped == self.cand_note {
                self.cand_run += 1;
            } else {
                self.cand_note = snapped;
                self.cand_run = 1;
            }
            if self.held_note == i32::MIN {
                self.held_note = snapped; // first lock of the phrase
            } else if snapped != self.held_note && self.cand_run >= NOTE_HOLD {
                self.held_note = snapped;
            }

            if self.voiced_run < ONSET_HOLD {
                // Attack/onset: f0 is unreliable — relax to no correction so the
                // phrase start doesn't "whoop".
                self.target_cents = self.drift_cents;
            } else {
                // Pull the continuous detected pitch toward the *held* note.
                let err_cents = (self.held_note as f32 - midi) * 100.0;
                // humanize also relaxes how hard we pull to pitch.
                let strength = (self.amount / 100.0) * (1.0 - 0.4 * (self.humanize / 100.0));
                self.target_cents = err_cents * strength + self.drift_cents;
            }
        } else {
            // Unvoiced/silence: reset so the next phrase re-locks fresh.
            self.voiced_run = 0;
            self.cand_run = 0;
            self.held_note = i32::MIN;
            self.cand_note = i32::MIN;
            self.target_cents = 0.0;
        }
    }

    /// YIN over the most recent DET_WINDOW samples of `ring_l`, decimated by
    /// DECIM (boxcar-averaged, which also anti-aliases). Returns f0 in Hz, or
    /// 0.0 when silent / unvoiced.
    fn detect_f0(&self) -> f32 {
        // Gather oldest→newest, averaging DECIM samples per decimated slot.
        let mut w = [0.0f32; DET_LEN];
        let start = (self.write_pos + RING - DET_WINDOW) & RING_MASK;
        let mut energy = 0.0f32;
        let inv = 1.0 / DECIM as f32;
        for (k, slot) in w.iter_mut().enumerate() {
            let base = start + k * DECIM;
            let mut acc = 0.0f32;
            for d in 0..DECIM {
                acc += self.ring_l[(base + d) & RING_MASK];
            }
            let s = acc * inv;
            *slot = s;
            energy += s * s;
        }
        if (energy / DET_LEN as f32).sqrt() < SILENCE_RMS {
            return 0.0;
        }

        let tau_max = self.tau_max.min(DET_LEN - 2);
        let mut cmnd = vec![1.0f32; tau_max + 1];
        let mut running = 0.0f32;
        for tau in 1..=tau_max {
            let len = DET_LEN - tau;
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
            // tau_f is in decimated samples → back to Hz at the full rate.
            self.sample_rate / (DECIM as f32 * tau_f)
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
        p.set_params(0, 0, 50.0, 100.0, 0.0, 0.0);
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
        p.set_params(9, 1, 50.0, 0.0, 0.0, 0.0);
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
        p.set_params(9, 1, 50.0, 0.0, 0.0, 0.0); // amount 0 — just want detection
        let mut buf = sine(220.0, 48000.0, 8192);
        p.process_mono(&mut buf);
        let f0 = p.detected_hz();
        assert!((f0 - 220.0).abs() / 220.0 < 0.05, "expected ~220 Hz, got {f0}");
    }

    #[test]
    fn decimated_detection_stays_accurate() {
        // Guard the decimated YIN across the vocal range — parabolic interp must
        // keep sub-sample accuracy despite the 4× coarser lag grid.
        for f in [98.0f32, 147.0, 220.0, 330.0, 440.0] {
            let mut p = Pitch::new(48000.0);
            p.set_params(9, 2, 50.0, 0.0, 0.0, 0.0); // chromatic, amount 0
            let mut buf = sine(f, 48000.0, 12000);
            p.process_mono(&mut buf);
            let f0 = p.detected_hz();
            assert!((f0 - f).abs() / f < 0.04, "f={f} detected={f0}");
        }
    }

    #[test]
    fn corrects_sharp_note_downward() {
        // 226 Hz is ~A4 (+47 cents). In A-minor (root 9), A is in scale, so
        // full correction should pull the pitch DOWN toward 220 Hz.
        let sr = 48000.0;
        let input = sine(226.0, sr, 32768);
        let mut buf = input.clone();
        let mut p = Pitch::new(sr);
        p.set_params(9, 1, 80.0, 100.0, 0.0, 0.0);
        p.process_mono(&mut buf);
        // Compare zero-crossing rate over a settled tail.
        let in_zcr = zcr(&input[8192..], sr);
        let out_zcr = zcr(&buf[8192..], sr);
        assert!(
            out_zcr < in_zcr - 1.0,
            "correction should lower the pitch toward A=220; in_zcr={in_zcr} out_zcr={out_zcr}"
        );
    }

    /// Goertzel power at `f` over `buf` (single-bin DFT magnitude²).
    fn goertzel(buf: &[f32], sr: f32, f: f32) -> f32 {
        let w = TWO_PI * f / sr;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &x in buf {
            let s0 = x + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        s1 * s1 + s2 * s2 - coeff * s1 * s2
    }

    #[test]
    fn psola_shift_is_clean_at_corrected_pitch() {
        // A 225 Hz sine corrects to A=220. A clean shift concentrates energy at
        // 220, not 225 — a garbled/comb-y output wouldn't.
        let sr = 48000.0;
        let mut buf = sine(225.0, sr, 32768);
        let mut p = Pitch::new(sr);
        p.set_params(9, 1, 80.0, 100.0, 0.0, 0.0);
        p.process_mono(&mut buf);
        let tail = &buf[12000..];
        let at220 = goertzel(tail, sr, 220.0);
        let at225 = goertzel(tail, sr, 225.0);
        assert!(at220 > 6.0 * at225, "expected energy at 220 ≫ 225: {at220} vs {at225}");
    }

    #[test]
    fn formant_shifts_timbre_independent_of_pitch() {
        // amount 0 ⇒ no pitch change; formant up resamples each grain → the
        // spectral envelope moves up (brighter) while the fundamental (set by
        // the OLA mark spacing) stays put. Probe a harmonic-rich tone with a
        // high-frequency ("brightness") measure and the fundamental's pitch.
        let sr = 48000.0;
        let f0 = 200.0;
        let saw: Vec<f32> = (0..32768)
            .map(|i| {
                let t = i as f32 / sr;
                (1..=8).map(|h| (1.0 / h as f32) * (TWO_PI * f0 * h as f32 * t).sin()).sum::<f32>()
                    * 0.4
            })
            .collect();
        // Brightness = mean squared first-difference (a cheap high-pass).
        let bright = |b: &[f32]| b.windows(2).map(|w| (w[1] - w[0]).powi(2)).sum::<f32>();
        let run = |formant: f32| -> (f32, f32) {
            let mut b = saw.clone();
            let mut p = Pitch::new(sr);
            p.set_params(9, 1, 80.0, 0.0, 0.0, formant); // amount 0 → pitch unchanged
            p.process_mono(&mut b);
            let tail = &b[12000..];
            (bright(tail), goertzel(tail, sr, f0))
        };
        let (b0, fund0) = run(0.0);
        let (bup, fundup) = run(100.0);
        assert!(bup > b0 * 1.15, "formant-up should brighten: up={bup} neutral={b0}");
        // Fundamental energy still present (pitch preserved, not silenced).
        assert!(fundup > 0.25 * fund0, "fundamental should survive formant shift");
    }

    #[test]
    fn noise_passes_without_blowing_up() {
        // Unvoiced/noise input shouldn't produce NaNs or runaway gain.
        let mut p = Pitch::new(48000.0);
        p.set_params(0, 0, 50.0, 100.0, 50.0, 0.0);
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
        p.set_params(9, 1, 60.0, 100.0, 0.0, 0.0); // A-minor, full correct
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
