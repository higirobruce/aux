'use client';

import { useCallback, useEffect, useRef } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  /** Rotation range in degrees, +/- around 0. Default 135 (270° total). */
  travelDegrees?: number;
  /** Pixels of drag for the full min..max sweep. */
  sensitivity?: number;
  /** Extra class — e.g. 'pan' for the amber indicator. */
  variant?: 'default' | 'pan';
  ariaLabel: string;
  onChange: (value: number) => void;
}

/**
 * Knob — drag vertically (or scroll) to set the value. Maps the value
 * range linearly to a rotation of (-travelDegrees .. +travelDegrees).
 * Double-click resets to defaultValue (or midpoint if not supplied).
 */
export function Knob({
  value,
  min,
  max,
  defaultValue,
  travelDegrees = 135,
  sensitivity = 150,
  variant = 'default',
  ariaLabel,
  onChange,
}: Props) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const normalized = (value - min) / (max - min || 1);
  const rotation = -travelDegrees + normalized * travelDegrees * 2;

  const handleMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return;
      const dy = startY.current - e.clientY;
      const range = max - min;
      const next = Math.max(min, Math.min(max, startValue.current + (dy * range) / sensitivity));
      onChange(next);
      e.preventDefault();
    },
    [min, max, sensitivity, onChange]
  );

  const handleUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
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
    startY.current = e.clientY;
    startValue.current = value;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  }

  function handleDoubleClick() {
    onChange(defaultValue ?? (min + max) / 2);
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const range = max - min;
    const next = Math.max(min, Math.min(max, value - Math.sign(e.deltaY) * range * 0.02));
    onChange(next);
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      role="slider"
      className={`knob ${variant === 'pan' ? 'pan' : ''}`}
      style={{ ['--rot' as string]: `${rotation}deg` }}
      onPointerDown={handleDown}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
    />
  );
}
