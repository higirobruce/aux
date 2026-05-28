export default function MixerPage() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center max-w-xl px-6">
        <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">
          aux · v0.1 · skeleton
        </p>
        <h1 className="font-display text-6xl tracking-tight mb-4">Mixer.</h1>
        <p className="text-ink-2 leading-relaxed">
          The session lives here. This route will host the mixer console once the
          audio engine, channel strips, and session document are wired up.
        </p>
      </div>
    </main>
  );
}
