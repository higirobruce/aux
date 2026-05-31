'use client';

/**
 * Design-system reference — the warm-analog visual language + primitive kit.
 * Ported from the design handoff's ds.jsx, rendered with the real @aux/ui
 * components so it doubles as a live component gallery. Static showcase, so
 * the meters self-animate off a clock (no audio signal here).
 */

import { type Accent, Fader, Meter, Module, Segmented, Spectrum, Toggle } from '@aux/ui';
import { Knob } from '@aux/ui';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

function Swatch({ name, varName, val }: { name: string; varName: string; val?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          height: 56,
          borderRadius: 6,
          background: `var(${varName})`,
          border: '1px solid var(--line)',
          boxShadow: 'var(--sh-1)',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 11, color: 'var(--txt-0)', fontWeight: 500 }}>{name}</span>
        <span className="val" style={{ fontSize: 10, color: 'var(--txt-2)' }}>
          {varName}
        </span>
        {val && (
          <span className="val" style={{ fontSize: 10, color: 'var(--txt-3)' }}>
            {val}
          </span>
        )}
      </div>
    </div>
  );
}

function Section({
  n,
  title,
  desc,
  children,
  id,
}: { n: string; title: string; desc?: string; children: ReactNode; id: string }) {
  return (
    <section id={id} style={{ marginBottom: 56, scrollMarginTop: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          marginBottom: 6,
          borderBottom: '1px solid var(--line-2)',
          paddingBottom: 12,
        }}
      >
        <span className="val" style={{ fontSize: 12, color: 'var(--gold)', fontWeight: 600 }}>
          {n}
        </span>
        <h2
          style={{
            margin: 0,
            fontSize: 22,
            color: 'var(--txt-0)',
            fontWeight: 600,
            fontFamily: 'var(--sans)',
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h2>
      </div>
      {desc && (
        <p
          style={{
            margin: '12px 0 22px',
            color: 'var(--txt-1)',
            fontSize: 13,
            fontFamily: 'var(--sans)',
            maxWidth: 620,
            lineHeight: 1.6,
          }}
        >
          {desc}
        </p>
      )}
      {children}
    </section>
  );
}

function Card({ title, children, w }: { title?: string; children: ReactNode; w?: number }) {
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: 18,
        width: w,
        boxShadow: 'var(--sh-1)',
      }}
    >
      {title && (
        <div className="lbl" style={{ fontSize: 9, marginBottom: 16, color: 'var(--txt-2)' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function DemoKnob({
  label,
  accent,
  min,
  max,
  start = 0,
  bipolar,
  defaultValue,
  size = 48,
  fmt,
}: {
  label: string;
  accent: Accent;
  min: number;
  max: number;
  start?: number;
  bipolar?: boolean;
  defaultValue?: number;
  size?: number;
  fmt?: (v: number) => string;
}) {
  const [v, setV] = useState(start);
  return (
    <Knob
      size={size}
      label={label}
      accent={accent}
      min={min}
      max={max}
      value={v}
      bipolar={bipolar}
      defaultValue={defaultValue}
      ariaLabel={label}
      display={fmt ? fmt(v) : v.toFixed(0)}
      onChange={setV}
    />
  );
}

/** A clock-driven [0,1] level for the demo meters (no audio signal here). */
function clockLevel(skew = 0): [number, number] {
  const b = 0.4 + 0.4 * Math.abs(Math.sin(Date.now() / (280 + skew)));
  return [b, b * 0.92];
}

function DemoFader() {
  const [v, setV] = useState(-6);
  return (
    <Fader
      value={v}
      min={-60}
      max={6}
      onChange={setV}
      height={150}
      meter={<Meter getLevel={() => clockLevel(20)} height={150} width={8} stereo />}
    />
  );
}

/** Horizontal gain-reduction demo bar (clock-animated). */
function DemoGr() {
  const fillRef = useRef<HTMLDivElement>(null);
  const valRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const gr = Math.abs(Math.sin(Date.now() / 700) * 8);
      if (fillRef.current) fillRef.current.style.width = `${Math.min(1, gr / 20) * 100}%`;
      if (valRef.current) valRef.current.textContent = `-${gr.toFixed(1)} dB`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 220 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="lbl" style={{ fontSize: 8 }}>
          GAIN REDUCTION
        </span>
        <span ref={valRef} className="val" style={{ fontSize: 10, color: 'var(--sage)' }}>
          -0.0 dB
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 12,
          background: 'var(--inset)',
          borderRadius: 3,
          overflow: 'hidden',
          boxShadow: 'inset 0 0 0 1px var(--line)',
        }}
      >
        <div
          ref={fillRef}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: '0%',
            background: 'linear-gradient(90deg,var(--sage),var(--gold))',
          }}
        />
      </div>
    </div>
  );
}

const grid = (min: number): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill,minmax(${min}px,1fr))`,
  gap: 14,
});

const NAV = ['Foundation', 'Color', 'Type', 'Controls', 'Meters', 'Buttons', 'Surfaces'];

export default function DesignSystemPage() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-0)' }}>
      <aside
        style={{
          width: 230,
          flexShrink: 0,
          borderRight: '1px solid var(--line)',
          background: 'var(--bg-1)',
          padding: '28px 22px',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: 'var(--gold)',
              boxShadow: '0 0 12px var(--gold)',
            }}
          />
          <span
            className="lbl"
            style={{ fontSize: 16, color: 'var(--gold)', letterSpacing: '0.22em', fontWeight: 600 }}
          >
            AUX
          </span>
        </div>
        <p
          style={{
            fontSize: 11,
            color: 'var(--txt-2)',
            fontFamily: 'var(--sans)',
            margin: '0 0 28px',
            lineHeight: 1.5,
          }}
        >
          Design System · Web DAW
        </p>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map((n, i) => (
            <a
              key={n}
              href={`#s${i}`}
              className="lbl"
              style={{
                fontSize: 10,
                color: 'var(--txt-1)',
                textDecoration: 'none',
                padding: '7px 10px',
                borderRadius: 5,
              }}
            >
              {String(i + 1).padStart(2, '0')} · {n}
            </a>
          ))}
        </nav>
        <div style={{ position: 'absolute', bottom: 24, left: 22, right: 22 }}>
          <a
            href="/"
            className="lbl"
            style={{
              fontSize: 9,
              color: 'var(--txt-2)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            ← OPEN THE DAW
          </a>
        </div>
      </aside>

      <main style={{ flex: 1, overflowY: 'auto', padding: '40px 56px 80px' }}>
        <div style={{ maxWidth: 1000 }}>
          <header style={{ marginBottom: 56 }}>
            <h1
              style={{
                fontFamily: 'var(--sans)',
                fontSize: 40,
                fontWeight: 600,
                margin: '0 0 14px',
                letterSpacing: '-0.02em',
                color: 'var(--txt-0)',
              }}
            >
              Warm analog terminal
            </h1>
            <p
              style={{
                fontFamily: 'var(--sans)',
                fontSize: 15,
                color: 'var(--txt-1)',
                maxWidth: 660,
                lineHeight: 1.65,
                margin: 0,
              }}
            >
              The visual language for aux. Dark and monospace-driven like a pro-audio tool, but
              shifted off blue-black toward warm graphite, with an analog accent palette —
              level-gold, tape-rust, dynamics-sage, image-mauve. Hairline structure, real-time
              motion, no skeuomorphism.
            </p>
          </header>

          <Section
            n="01"
            title="Foundation"
            id="s0"
            desc="Four ideas hold the system together: a warm neutral ramp instead of cold gray, one workhorse monospace, hairline dividers (never heavy borders), and a single semantic accent per processing module so the eye reads function by colour."
          >
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {(
                [
                  ['Warm neutrals', 'oklch hue ~70 — graphite, not slate'],
                  ['Mono-first', 'IBM Plex Mono carries labels, values, transport'],
                  ['Hairlines', '1px dividers at low contrast structure the grid'],
                  ['Semantic accent', 'each module owns one colour, end to end'],
                ] as const
              ).map(([t, d]) => (
                <div
                  key={t}
                  style={{
                    flex: '1 1 200px',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--txt-0)',
                      fontWeight: 600,
                      marginBottom: 6,
                      fontFamily: 'var(--sans)',
                    }}
                  >
                    {t}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--txt-2)',
                      fontFamily: 'var(--sans)',
                      lineHeight: 1.5,
                    }}
                  >
                    {d}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            n="02"
            title="Color"
            id="s1"
            desc="The neutral ramp runs from near-black void to warm cream. Accents are muted and analog — they glow at low alpha rather than shout."
          >
            <div className="lbl" style={{ fontSize: 9, margin: '0 0 12px' }}>
              Neutral ramp
            </div>
            <div style={grid(110)}>
              {(
                [
                  ['Void', '--bg-0'],
                  ['Panel', '--bg-1'],
                  ['Surface', '--bg-2'],
                  ['Raised', '--bg-3'],
                  ['Hover', '--bg-4'],
                  ['Inset', '--inset'],
                  ['Line', '--line'],
                  ['Line 2', '--line-2'],
                ] as const
              ).map(([n, v]) => (
                <Swatch key={v} name={n} varName={v} />
              ))}
            </div>
            <div className="lbl" style={{ fontSize: 9, margin: '28px 0 12px' }}>
              Text
            </div>
            <div style={grid(110)}>
              {(
                [
                  ['Primary', '--txt-0'],
                  ['Secondary', '--txt-1'],
                  ['Dim', '--txt-2'],
                  ['Faint', '--txt-3'],
                ] as const
              ).map(([n, v]) => (
                <Swatch key={v} name={n} varName={v} />
              ))}
            </div>
            <div className="lbl" style={{ fontSize: 9, margin: '28px 0 12px' }}>
              Analog accents — one per module
            </div>
            <div style={grid(110)}>
              {(
                [
                  ['Level / EQ', '--gold'],
                  ['Tape / Drive', '--rust'],
                  ['Dynamics', '--sage'],
                  ['Transient', '--teal'],
                  ['Imaging', '--mauve'],
                  ['Pitch', '--violet'],
                  ['Alert / Clip', '--red'],
                  ['OK / Saved', '--green'],
                  ['Waveform', '--wave'],
                ] as const
              ).map(([n, v]) => (
                <Swatch key={v} name={n} varName={v} />
              ))}
            </div>
          </Section>

          <Section
            n="03"
            title="Typography"
            id="s2"
            desc="IBM Plex Mono does the work — labels, values, transport, track names — for the engineering-tool feel. IBM Plex Sans handles running prose and large headings where mono would tire the eye."
          >
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Card title="MONO · IBM PLEX MONO" w={420}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <span
                      className="val"
                      style={{ fontSize: 28, color: 'var(--gold)', fontWeight: 600 }}
                    >
                      0:11 / 5:43
                    </span>
                    <div className="lbl" style={{ fontSize: 9, marginTop: 4 }}>
                      Transport · 28 / 600
                    </div>
                  </div>
                  <div>
                    <span
                      className="val"
                      style={{ fontSize: 15, color: 'var(--txt-0)', fontWeight: 600 }}
                    >
                      -18.0 dB · 3.0:1 · 650 Hz
                    </span>
                    <div className="lbl" style={{ fontSize: 9, marginTop: 4 }}>
                      Values · 13–15 / tabular
                    </div>
                  </div>
                  <div>
                    <span className="lbl" style={{ fontSize: 10, color: 'var(--txt-1)' }}>
                      THRESHOLD · RATIO · MAKEUP
                    </span>
                    <div className="lbl" style={{ fontSize: 9, marginTop: 4 }}>
                      Labels · 10 / +0.14em caps
                    </div>
                  </div>
                </div>
              </Card>
              <Card title="SANS · IBM PLEX SANS" w={420}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    style={{
                      fontFamily: 'var(--sans)',
                      fontSize: 28,
                      fontWeight: 600,
                      color: 'var(--txt-0)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Parametric EQ
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--sans)',
                      fontSize: 13,
                      color: 'var(--txt-1)',
                      lineHeight: 1.6,
                    }}
                  >
                    Running copy, tooltips and longer descriptions use the sans at 13px with
                    generous line-height for comfortable reading.
                  </div>
                </div>
              </Card>
            </div>
          </Section>

          <Section
            n="04"
            title="Controls"
            id="s3"
            desc="The knob is the signature control: a minimal open ring with a single pointer line and a slim accent value-arc that glows on hover. Drag vertically, double-click to reset, shift for fine. Faders, toggles and segmented controls complete the kit."
          >
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <Card title="KNOBS · BY ACCENT">
                <div style={{ display: 'flex', gap: 18 }}>
                  <DemoKnob
                    label="GAIN"
                    accent="gold"
                    min={-18}
                    max={18}
                    bipolar
                    start={5}
                    defaultValue={0}
                    fmt={(v) => (v >= 0 ? '+' : '') + v.toFixed(1)}
                  />
                  <DemoKnob label="DRIVE" accent="rust" min={0} max={100} start={40} />
                  <DemoKnob
                    label="RATIO"
                    accent="sage"
                    min={1}
                    max={12}
                    start={3}
                    fmt={(v) => v.toFixed(1)}
                  />
                  <DemoKnob
                    label="WIDTH"
                    accent="mauve"
                    min={0}
                    max={2}
                    start={1.2}
                    fmt={(v) => v.toFixed(2)}
                  />
                </div>
              </Card>
              <Card title="SIZES">
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
                  <DemoKnob size={28} label="28" accent="gold" min={0} max={100} start={60} />
                  <DemoKnob size={38} label="38" accent="gold" min={0} max={100} start={60} />
                  <DemoKnob size={48} label="48" accent="gold" min={0} max={100} start={60} />
                </div>
              </Card>
              <Card title="FADER + METER">
                <DemoFader />
              </Card>
              <Card title="TOGGLES & SEGMENTED">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Toggle on accent="gold" onClick={() => {}}>
                      EQ
                    </Toggle>
                    <Toggle on accent="sage" onClick={() => {}}>
                      COMP
                    </Toggle>
                    <Toggle on accent="rust" onClick={() => {}}>
                      TAPE
                    </Toggle>
                    <Toggle on accent="violet" onClick={() => {}}>
                      PITCH
                    </Toggle>
                  </div>
                  <DemoSeg opts={['CLEAN', 'COLOR']} accent="sage" />
                  <DemoSeg opts={['TAPE', 'TUBE', 'TRANS']} accent="rust" />
                </div>
              </Card>
            </div>
          </Section>

          <Section
            n="05"
            title="Meters & visualization"
            id="s4"
            desc="Real-time feedback is core to the system. Level meters use a green→gold→red gradient with peak-hold; gain-reduction draws right-to-left; the analyzer and goniometer animate continuously."
          >
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <Card title="GAIN REDUCTION">
                <div style={{ paddingTop: 24 }}>
                  <DemoGr />
                </div>
              </Card>
              <Card title="SPECTRUM ANALYZER" w={340}>
                <div
                  style={{
                    background: 'var(--inset)',
                    borderRadius: 6,
                    border: '1px solid var(--line)',
                    overflow: 'hidden',
                  }}
                >
                  <Spectrum active accent="gold" height={120} />
                </div>
              </Card>
              <Card title="LEVEL · STEREO">
                <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 4 }}>
                  <Meter getLevel={() => clockLevel(0)} height={140} width={12} stereo />
                </div>
              </Card>
            </div>
          </Section>

          <Section
            n="06"
            title="Buttons"
            id="s5"
            desc="Buttons are quiet by default and earn colour only when active. The primary action borrows the gold accent; transport and utility buttons stay neutral."
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="lbl"
                style={{
                  height: 34,
                  padding: '0 16px',
                  borderRadius: 5,
                  border: '1px solid var(--gold)',
                  background: 'var(--gold-a)',
                  color: 'var(--gold)',
                  fontSize: 11,
                  letterSpacing: '0.14em',
                  fontWeight: 600,
                }}
              >
                PRIMARY
              </button>
              <button
                type="button"
                className="lbl"
                style={{
                  height: 34,
                  padding: '0 16px',
                  borderRadius: 5,
                  border: '1px solid var(--line-2)',
                  background: 'var(--bg-3)',
                  color: 'var(--txt-1)',
                  fontSize: 11,
                  letterSpacing: '0.14em',
                }}
              >
                SECONDARY
              </button>
              <button
                type="button"
                aria-label="play"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 5,
                  border: '1px solid var(--line-2)',
                  background: 'var(--bg-3)',
                  color: 'var(--txt-0)',
                  fontSize: 14,
                }}
              >
                ▶
              </button>
              <button
                type="button"
                className="lbl"
                style={{
                  height: 34,
                  padding: '0 16px',
                  borderRadius: 5,
                  border: '1px solid var(--red)',
                  background: 'var(--red-a)',
                  color: 'var(--red)',
                  fontSize: 11,
                  letterSpacing: '0.14em',
                }}
              >
                ● REC
              </button>
            </div>
          </Section>

          <Section
            n="07"
            title="Surfaces"
            id="s6"
            desc="Panels nest by elevation, never by hard borders. Floating plugin windows carry a draggable title bar with the module's accent dot, a bypass toggle, and the channel they belong to."
          >
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Module title="MODULE HEADER" accent="gold" style={{ width: 240 }}>
                <div style={{ fontSize: 12, color: 'var(--txt-1)', fontFamily: 'var(--sans)' }}>
                  Grouped controls live inside a Module with an accent dot and hairline header.
                </div>
              </Module>
              <div
                style={{
                  width: 300,
                  background: 'linear-gradient(180deg,var(--bg-3),var(--bg-2))',
                  borderRadius: 9,
                  boxShadow: 'var(--sh-win)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '0 12px',
                    height: 34,
                    borderBottom: '1px solid var(--line)',
                    background: 'linear-gradient(180deg,var(--bg-4),transparent)',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 9,
                      background: 'var(--rust)',
                      boxShadow: '0 0 7px var(--rust)',
                    }}
                  />
                  <span
                    className="lbl"
                    style={{
                      fontSize: 11,
                      color: 'var(--txt-0)',
                      letterSpacing: '0.18em',
                      fontWeight: 600,
                    }}
                  >
                    WINDOW
                  </span>
                  <div style={{ flex: 1 }} />
                  <span
                    className="lbl"
                    style={{
                      fontSize: 9,
                      color: 'var(--rust)',
                      border: '1px solid var(--rust)',
                      borderRadius: 3,
                      padding: '3px 6px',
                    }}
                  >
                    ON
                  </span>
                </div>
                <div
                  style={{
                    padding: 20,
                    fontSize: 12,
                    color: 'var(--txt-2)',
                    fontFamily: 'var(--sans)',
                  }}
                >
                  Floating plugin window chrome.
                </div>
              </div>
            </div>
          </Section>
        </div>
      </main>
    </div>
  );
}

function DemoSeg({ opts, accent }: { opts: string[]; accent: Accent }) {
  const [v, setV] = useState(opts[0] ?? '');
  return <Segmented options={opts} value={v} accent={accent} onChange={setV} />;
}
