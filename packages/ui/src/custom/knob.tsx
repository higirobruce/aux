'use client';

import { useState } from 'react';
import { ACCENT, type Accent, clamp, lerp } from './accent';
import { useDrag } from './use-drag';

interface KnobProps {
  value: number;
  min?: number;
  max?: number;
  defaultValue?: number;
  size?: number;
  accent?: Accent;
  label?: string;
  /** Numeric/string readout shown under the label. */
  display?: string | number;
  unit?: string;
  /** Bipolar: value arc grows from 12 o'clock instead of the min stop. */
  bipolar?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (v: number) => void;
}

/**
 * Knob — minimal thin open ring + pointer line + accent value-arc.
 * Drag vertically (Shift = fine), scroll, or double-click to reset.
 * Keeps the slider a11y surface (role/aria-value*) the channel strip relies on.
 */
export function Knob({
  value,
  min = 0,
  max = 1,
  defaultValue,
  size = 38,
  accent = 'gold',
  label,
  display,
  unit = '',
  bipolar = false,
  disabled = false,
  ariaLabel,
  onChange,
}: KnobProps) {
  const [hover, setHover] = useState(false);
  const norm = (value - min) / (max - min || 1);
  const A0 = -135;
  const A1 = 135;
  const ang = lerp(A0, A1, norm);
  const col = disabled ? 'var(--txt-3)' : ACCENT[accent];
  const r = size / 2;
  const ringR = r - 4;
  const cx = r;
  const cy = r;

  // Quantize emitted SVG coords so the server-rendered and client strings are
  // byte-identical — raw trig differs by an ULP between runtimes, which trips
  // React's hydration check on knobs whose value isn't a round number.
  const q = (n: number) => Math.round(n * 1000) / 1000;
  const toXY = (deg: number): [number, number] => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [q(cx + ringR * Math.cos(rad)), q(cy + ringR * Math.sin(rad))];
  };
  const arcPath = (from: number, to: number) => {
    const [x0, y0] = toXY(from);
    const [x1, y1] = toXY(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${ringR} ${ringR} 0 ${large} 1 ${x1} ${y1}`;
  };
  const startA = bipolar ? 0 : A0;
  const down = useDrag({ value, min, max, onChange });
  const ptr = toXY(ang);
  const pin: [number, number] = [
    q(cx + (ringR - 7) * Math.cos(((ang - 90) * Math.PI) / 180)),
    q(cy + (ringR - 7) * Math.sin(((ang - 90) * Math.PI) / 180)),
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        userSelect: 'none',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <button
        type="button"
        role="slider"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        disabled={disabled}
        onPointerDown={disabled ? undefined : down}
        onDoubleClick={() => defaultValue != null && onChange(defaultValue)}
        onWheel={(e) => {
          if (disabled) return;
          const next = clamp(value - Math.sign(e.deltaY) * (max - min) * 0.02, min, max);
          onChange(next);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = (max - min) * (e.shiftKey ? 0.005 : 0.02);
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(clamp(value + step, min, max));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(clamp(value - step, min, max));
          }
        }}
        style={{
          width: size,
          height: size,
          cursor: disabled ? 'default' : 'ns-resize',
          touchAction: 'none',
          padding: 0,
          border: 'none',
          background: 'transparent',
          appearance: 'none',
        }}
        title={label}
      >
        <svg
          width={size}
          height={size}
          style={{ display: 'block', overflow: 'visible' }}
          aria-hidden="true"
        >
          <circle
            cx={cx}
            cy={cy}
            r={ringR + 1.5}
            fill="var(--inset)"
            stroke="var(--line)"
            strokeWidth="1"
          />
          <path
            d={arcPath(A0, A1)}
            fill="none"
            stroke="var(--line-2)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d={arcPath(Math.min(startA, ang), Math.max(startA, ang))}
            fill="none"
            stroke={col}
            strokeWidth="2.5"
            strokeLinecap="round"
            style={{
              filter: hover ? `drop-shadow(0 0 3px ${col})` : 'none',
              transition: 'filter var(--fast)',
            }}
          />
          <line
            x1={pin[0]}
            y1={pin[1]}
            x2={ptr[0]}
            y2={ptr[1]}
            stroke={col}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {label && (
        <div
          className="lbl"
          style={{ fontSize: 9, color: hover ? 'var(--txt-1)' : 'var(--txt-2)' }}
        >
          {label}
        </div>
      )}
      {display !== undefined && (
        <div className="val" style={{ fontSize: 10, color: 'var(--txt-1)', fontWeight: 500 }}>
          {display}
          {unit && <span style={{ color: 'var(--txt-2)' }}>{unit}</span>}
        </div>
      )}
    </div>
  );
}
