'use client';

import { useCallback, useEffect, useRef } from 'react';

interface Props {
  /** 0..1 position from bottom of the track. 0.75 = unity per the brainstorm. */
  position: number;
  ariaLabel: string;
  onChange: (position: number) => void;
  onReset?: () => void;
}

/**
 * Vertical fader. Drag the cap (or anywhere on the track) up/down.
 * Internally exposes a 0..1 position; mapping to dB lives in the consumer.
 */
export function Fader({ position, ariaLabel, onChange, onReset }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);

  const setFromPointer = useCallback(
    (e: { clientY: number }) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Fader cap floats inside an 8px-inset track.
      const inset = 8;
      const usableTop = rect.top + inset;
      const usableHeight = rect.height - inset * 2;
      const offset = e.clientY - usableTop;
      const fromBottom = 1 - offset / usableHeight;
      onChange(Math.max(0, Math.min(1, fromBottom)));
    },
    [onChange]
  );

  const handleMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return;
      setFromPointer(e);
      e.preventDefault();
    },
    [setFromPointer]
  );

  const handleUp = useCallback(() => {
    if (dragging.current) {
      dragging.current = false;
      document.body.style.cursor = '';
    }
  }, []);

  useEffect(() => {
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
  }, [handleMove, handleUp]);

  function handleDown(e: React.PointerEvent) {
    dragging.current = true;
    document.body.style.cursor = 'ns-resize';
    setFromPointer(e);
    e.preventDefault();
  }

  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      aria-valuenow={position}
      aria-valuemin={0}
      aria-valuemax={1}
      role="slider"
      className="fader"
      onPointerDown={handleDown}
      onDoubleClick={() => onReset?.()}
    >
      <span className="fader-track" />
      <span className="fader-cap" style={{ bottom: `${position * 100}%` }} />
    </button>
  );
}
