'use client';

import { ACCENT, type Accent } from './accent';

type Option = string | { value: string; label: string };

interface SegmentedProps {
  options: Option[];
  value: string;
  onChange: (v: string) => void;
  accent?: Accent;
}

/** Segmented control — inset track with an accent-filled selected segment. */
export function Segmented({ options, value, onChange, accent = 'gold' }: SegmentedProps) {
  const col = ACCENT[accent];
  return (
    <div
      style={{
        display: 'flex',
        background: 'var(--inset)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-sm)',
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const lbl = typeof o === 'object' ? o.label : o;
        const sel = v === value;
        return (
          <button
            type="button"
            key={v}
            onClick={() => onChange(v)}
            className="lbl"
            style={{
              flex: 1,
              fontSize: 9,
              padding: '3px 7px',
              borderRadius: 2,
              border: 'none',
              background: sel ? col : 'transparent',
              color: sel ? 'var(--bg-0)' : 'var(--txt-2)',
              fontWeight: sel ? 600 : 500,
              letterSpacing: '0.1em',
              transition: 'all var(--fast)',
            }}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}
