export default function PlaygroundPage() {
  return (
    <main className="min-h-screen px-6 py-16 max-w-5xl mx-auto">
      <p className="font-mono text-xs tracking-widest uppercase text-ink-3 mb-3">
        Design system · playground
      </p>
      <h1 className="font-display text-4xl tracking-tight mb-8">Components</h1>
      <p className="text-ink-2 mb-12 max-w-2xl">
        This route is a live showcase of the @aux/ui components — once they exist. For now, this is
        a stub. Add components to <code>@aux/ui</code> via{' '}
        <code>pnpm dlx shadcn add &lt;name&gt;</code> from <code>apps/web</code>.
      </p>
      <div className="font-mono text-xs text-ink-3">
        {/* TODO: render every component, every state */}
      </div>
    </main>
  );
}
