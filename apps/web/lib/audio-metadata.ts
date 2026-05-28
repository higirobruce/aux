/**
 * Browser-side audio metadata extraction.
 *
 * We decode the file once in an OfflineAudioContext, extract length /
 * channels / sample-rate, then walk the channel data for peak.
 *
 * LUFS-I per ITU BS.1770-4 is real DSP work — for v0.1 skeleton we use
 * an RMS-derived estimate. The real implementation lands with the audio
 * engine in v0.2 / Reference Rooms work.
 */

export interface AudioMetadata {
  lengthMs: number;
  channels: number;
  sampleRate: number;
  peakDb: number;
  lufsI: number;
}

function linearToDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
}

export async function extractMetadata(file: File): Promise<AudioMetadata> {
  const arrayBuffer = await file.arrayBuffer();

  const AudioContextCtor =
    typeof window !== 'undefined'
      ? // biome-ignore lint/suspicious/noExplicitAny: webkitAudioContext
        ((window as any).AudioContext ?? (window as any).webkitAudioContext)
      : null;

  if (!AudioContextCtor) {
    throw new Error('AudioContext not available — cannot decode audio metadata.');
  }

  // Use a temporary AudioContext for decoding.
  const ctx = new AudioContextCtor();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await ctx.close();
  }

  const lengthMs = Math.round((audio.length / audio.sampleRate) * 1000);

  let peak = 0;
  let rmsSqSum = 0;
  let rmsCount = 0;

  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const sample = data[i] ?? 0;
      const v = Math.abs(sample);
      if (v > peak) peak = v;
      rmsSqSum += sample * sample;
      rmsCount += 1;
    }
  }

  const rms = rmsCount > 0 ? Math.sqrt(rmsSqSum / rmsCount) : 0;
  const peakDb = linearToDb(peak);
  // Rough LUFS-I stand-in until the real BS.1770 measurer lands.
  // Real LUFS uses a K-weighting filter + gated mean. RMS dBFS is in the
  // ballpark for typical music (within a few dB), good enough for v0.1.
  const lufsI = linearToDb(rms);

  return {
    lengthMs,
    channels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
    peakDb: Number.isFinite(peakDb) ? Math.max(-200, Math.min(20, peakDb)) : -200,
    lufsI: Number.isFinite(lufsI) ? Math.max(-200, Math.min(20, lufsI)) : -200,
  };
}
