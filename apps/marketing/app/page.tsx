import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="min-h-screen px-6 py-24 max-w-4xl mx-auto">
      <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-4">
        aux · v0.1
      </p>
      <h1 className="font-display text-7xl tracking-tight mb-6 leading-none">
        Paper &amp; ink.
        <br />
        Now with audio.
      </h1>
      <p className="text-xl text-ink-2 max-w-2xl leading-relaxed mb-10">
        A pure mixing &amp; mastering studio for the web. No arrangement, no MIDI, no
        instruments — you bring the stems, aux brings the room, the meters, and
        the delivery.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href="http://localhost:3000"
          className="inline-flex items-center px-5 py-2.5 text-sm font-medium bg-ink text-paper rounded-md hover:bg-ink-2 transition-colors"
        >
          Open the mixer
        </Link>
        <Link
          href="/playground"
          className="inline-flex items-center px-5 py-2.5 text-sm font-medium border border-line text-ink rounded-md hover:border-ink transition-colors"
        >
          Design system playground
        </Link>
      </div>
    </main>
  );
}
