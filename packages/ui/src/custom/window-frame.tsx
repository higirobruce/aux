'use client';

import { useState } from 'react';
import { ACCENT, type Accent, clamp } from './accent';
import { Toggle } from './toggle';

interface WindowFrameProps {
  title: string;
  sub?: string;
  accent?: Accent;
  children: React.ReactNode;
  onClose: () => void;
  initial?: { x: number; y: number };
  width?: number;
  z?: number;
  onFocus?: () => void;
  bypass?: boolean;
  onBypass?: () => void;
}

/** Draggable floating plugin window with a title bar, bypass toggle, and close. */
export function WindowFrame({
  title,
  sub,
  accent = 'gold',
  children,
  onClose,
  initial = { x: 420, y: 120 },
  width = 540,
  z,
  onFocus,
  bypass,
  onBypass,
}: WindowFrameProps) {
  const [pos, setPos] = useState(initial);
  const col = ACCENT[accent];

  const onTitleDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onFocus?.();
    const sx = e.clientX - pos.x;
    const sy = e.clientY - pos.y;
    const move = (ev: PointerEvent) =>
      setPos({
        x: clamp(ev.clientX - sx, -width + 80, window.innerWidth - 80),
        y: clamp(ev.clientY - sy, 0, window.innerHeight - 40),
      });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      onMouseDown={onFocus}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width,
        zIndex: z ?? 50,
        background: 'linear-gradient(180deg,var(--bg-3),var(--bg-2))',
        borderRadius: 'var(--r-win)',
        boxShadow: 'var(--sh-win)',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onTitleDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 10px',
          height: 34,
          cursor: 'grab',
          borderBottom: '1px solid var(--line)',
          background: 'linear-gradient(180deg,var(--bg-4),transparent)',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 9,
            background: col,
            boxShadow: `0 0 7px ${col}`,
          }}
        />
        <span
          className="lbl"
          style={{ fontSize: 11, color: 'var(--txt-0)', letterSpacing: '0.18em', fontWeight: 600 }}
        >
          {title}
        </span>
        {sub && (
          <span className="lbl" style={{ fontSize: 9, color: 'var(--txt-2)' }}>
            {sub}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onBypass && (
          <Toggle on={!bypass} accent={accent} onClick={onBypass} mini>
            {bypass ? 'BYP' : 'ON'}
          </Toggle>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            width: 22,
            height: 22,
            borderRadius: 4,
            border: '1px solid var(--line-2)',
            background: 'transparent',
            color: 'var(--txt-2)',
            fontSize: 13,
            lineHeight: 1,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          position: 'relative',
          opacity: bypass ? 0.4 : 1,
          transition: 'opacity var(--med)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
