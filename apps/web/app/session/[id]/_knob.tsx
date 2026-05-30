'use client';

import { type Accent, Knob as UiKnob } from '@aux/ui';

interface Props {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  /** Legacy props (CSS-rotation knob) — accepted for call-site compatibility,
   *  no longer used by the SVG thin-ring knob. */
  travelDegrees?: number;
  sensitivity?: number;
  /** 'pan' renders bipolar (arc grows from 12 o'clock). */
  variant?: 'default' | 'pan';
  /** Section accent (per-insert colour). Defaults to gold. */
  accent?: Accent;
  ariaLabel: string;
  onChange: (value: number) => void;
}

/**
 * Channel-strip knob — the warm-analog thin-ring SVG knob (@aux/ui), sized
 * compact (22px) to fit three across an 88px strip without spilling. Thin
 * adapter so the strip/bus call sites keep their existing API; `accent` tints
 * the value-arc per insert section.
 */
export function Knob({
  value,
  min,
  max,
  defaultValue,
  variant = 'default',
  accent = 'gold',
  ariaLabel,
  onChange,
}: Props) {
  return (
    <UiKnob
      value={value}
      min={min}
      max={max}
      defaultValue={defaultValue}
      size={22}
      accent={accent}
      bipolar={variant === 'pan'}
      ariaLabel={ariaLabel}
      onChange={onChange}
    />
  );
}
