'use client';

import { ACCENT, ACCENT_SOFT, type Accent } from './accent';

interface ToggleProps {
  on: boolean;
  onClick: () => void;
  accent?: Accent;
  children: React.ReactNode;
  mini?: boolean;
}

/** Toggle chip / module-bypass button — outlined when off, accent-filled when on. */
export function Toggle({ on, onClick, accent = 'gold', children, mini }: ToggleProps) {
  const col = ACCENT[accent];
  const aFill = ACCENT_SOFT[accent] ?? 'var(--gold-a)';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="lbl"
      style={{
        fontSize: mini ? 9 : 10,
        padding: mini ? '3px 6px' : '4px 9px',
        background: on ? aFill : 'transparent',
        color: on ? col : 'var(--txt-2)',
        border: `1px solid ${on ? col : 'var(--line-2)'}`,
        borderRadius: 'var(--r-sm)',
        letterSpacing: '0.12em',
        transition: 'all var(--fast) var(--ease)',
        whiteSpace: 'nowrap',
        boxShadow: on ? `0 0 9px -3px ${col}` : 'none',
      }}
    >
      {children}
    </button>
  );
}
