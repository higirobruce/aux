'use client';

import type { Accent } from './accent';

interface ReadoutProps {
  label?: string;
  value: string | number;
  unit?: string;
  accent?: Accent;
  big?: boolean;
}

/** Numeric value pill — tracked-caps label over a tabular-nums value. */
export function Readout({ label, value, unit, big }: ReadoutProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {label && (
        <span className="lbl" style={{ fontSize: 9 }}>
          {label}
        </span>
      )}
      <span
        className="val"
        style={{ fontSize: big ? 15 : 12, color: 'var(--txt-0)', fontWeight: 600 }}
      >
        {value}
        {unit && (
          <span style={{ color: 'var(--txt-2)', fontSize: '0.75em', marginLeft: 2 }}>{unit}</span>
        )}
      </span>
    </div>
  );
}
