'use client';

import { Knob as UiKnob } from '@aux/ui';

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
  ariaLabel: string;
  onChange: (value: number) => void;
}

/**
 * Channel-strip knob — now the warm-analog thin-ring SVG knob (@aux/ui),
 * sized compact for the strip. Thin adapter so the ~40 strip/bus call sites
 * keep their existing API (value/min/max/defaultValue/variant/ariaLabel).
 */
export function Knob({
  value,
  min,
  max,
  defaultValue,
  variant = 'default',
  ariaLabel,
  onChange,
}: Props) {
  return (
    <UiKnob
      value={value}
      min={min}
      max={max}
      defaultValue={defaultValue}
      size={30}
      accent="gold"
      bipolar={variant === 'pan'}
      ariaLabel={ariaLabel}
      onChange={onChange}
    />
  );
}
