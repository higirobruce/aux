'use client';

import { ACCENT, type Accent } from './accent';
import { useDrag } from './use-drag';

interface FaderProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  height?: number;
  accent?: Accent;
  /** Optional meter element rendered beside the slot. */
  meter?: React.ReactNode;
  ariaLabel?: string;
}

/** Vertical fader — inset slot, accent fill below the cap, draggable cap. */
export function Fader({
  value,
  min = -60,
  max = 6,
  onChange,
  height = 200,
  accent = 'gold',
  meter,
  ariaLabel,
}: FaderProps) {
  const col = ACCENT[accent];
  const norm = (value - min) / (max - min || 1);
  const down = useDrag({ value, min, max, onChange });
  return (
    <div style={{ display: 'flex', gap: 6, height }}>
      <button
        type="button"
        role="slider"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={down}
        onDoubleClick={() => onChange(0)}
        style={{
          position: 'relative',
          width: 26,
          height,
          cursor: 'ns-resize',
          touchAction: 'none',
          padding: 0,
          border: 'none',
          background: 'transparent',
          appearance: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            transform: 'translateX(-50%)',
            width: 4,
            height: '100%',
            background: 'var(--inset)',
            borderRadius: 3,
            boxShadow: 'inset 0 0 0 1px var(--line)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 4,
            bottom: 0,
            height: `${norm * 100}%`,
            background: col,
            opacity: 0.35,
            borderRadius: 3,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: `calc(${norm * 100}% - 9px)`,
            transform: 'translateX(-50%)',
            width: 22,
            height: 18,
            background: 'linear-gradient(180deg,var(--bg-4),var(--bg-2))',
            borderRadius: 3,
            boxShadow: 'var(--sh-1), 0 2px 4px rgba(0,0,0,.5)',
            border: '1px solid var(--line-2)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 3,
              right: 3,
              top: '50%',
              height: 2,
              transform: 'translateY(-50%)',
              background: col,
              borderRadius: 2,
              boxShadow: `0 0 4px ${col}`,
            }}
          />
        </div>
      </button>
      {meter}
    </div>
  );
}
