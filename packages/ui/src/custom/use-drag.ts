'use client';

import { useCallback, useRef } from 'react';
import { clamp } from './accent';

interface DragOpts {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** Higher = more sensitive. 1 ≈ full range over 170px of travel. */
  sens?: number;
  onEnd?: () => void;
}

/**
 * Vertical-drag → value hook shared by Knob and Fader. Drag up increases;
 * hold Shift for fine (0.22×) control. Returns a pointerdown handler.
 */
export function useDrag({ value, min, max, onChange, sens = 1, onEnd }: DragOpts) {
  const ref = useRef({ value, min, max, onChange, sens, onEnd });
  ref.current = { value, min, max, onChange, sens, onEnd };

  return useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const { value: startV, min: lo, max: hi } = ref.current;
    const range = hi - lo;
    const move = (ev: PointerEvent) => {
      const fine = ev.shiftKey ? 0.22 : 1;
      const dy = startY - ev.clientY;
      const nv = clamp(startV + (dy / (170 / ref.current.sens)) * range * fine, lo, hi);
      ref.current.onChange(nv);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      ref.current.onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'ns-resize';
  }, []);
}
