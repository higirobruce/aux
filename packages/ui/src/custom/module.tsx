'use client';

import { ACCENT, type Accent } from './accent';

interface ModuleProps {
  title: string;
  accent?: Accent;
  children: React.ReactNode;
  style?: React.CSSProperties;
  right?: React.ReactNode;
}

/** Group box used inside plugin windows — accent dot + tracked-caps title. */
export function Module({ title, accent = 'gold', children, style, right }: ModuleProps) {
  const col = ACCENT[accent];
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-2)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 9px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 6, background: col }} />
        <span className="lbl" style={{ fontSize: 9, color: 'var(--txt-1)' }}>
          {title}
        </span>
        <div style={{ flex: 1 }} />
        {right}
      </div>
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
}
