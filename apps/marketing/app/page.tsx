import { Button } from '@aux/ui';
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
        <Button asChild size="lg">
          <Link href="http://localhost:3100">Open the mixer</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/playground">Design system playground</Link>
        </Button>
      </div>
    </main>
  );
}
