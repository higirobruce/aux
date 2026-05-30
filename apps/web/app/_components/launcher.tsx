'use client';

/**
 * Session launcher — the warm-analog "Start mixing." home. Ported from the
 * design package (home.jsx), wired to real session data + the real create POST.
 * New-session is inline (cloud/local cards + name + sample rate); recent
 * sessions are real; Learn + Mixing/mastering are placeholder content until
 * those features land.
 */

import { hasOpfs } from '@/lib/stem-store';
import type { SessionSummary } from '@/lib/types';
import { ACCENT, type Accent, Spectrum, clamp } from '@aux/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : 'Last week';
}

/* deterministic seed from a session id */
function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 40) + 1;
}

/* ---- procedural waveform thumbnail ---- */
function Thumb({
  seed = 1,
  color = 'var(--wave)',
  h = 38,
}: { seed?: number; color?: string; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const draw = () => {
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = getComputedStyle(cv).color;
      const mid = H / 2;
      let s = seed * 1000;
      const rnd = () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
      for (let x = 0; x < W; x += 2) {
        const t = x / W;
        const env = Math.min(1, t * 6) * Math.min(1, (1 - t) * 9 + 0.3);
        const hh =
          clamp((0.2 + 0.6 * Math.abs(Math.sin(t * 26 + seed)) * rnd()) * env, 0.03, 1) * mid;
        ctx.fillRect(x, mid - hh, 1.2, hh * 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [seed]);
  return <canvas ref={ref} style={{ width: '100%', height: h, color, display: 'block' }} />;
}

function Badge({
  children,
  accent = 'neutral',
  solid,
}: { children: React.ReactNode; accent?: Accent; solid?: boolean }) {
  const col = ACCENT[accent];
  return (
    <span
      className="lbl"
      style={{
        fontSize: 8,
        padding: '2px 6px',
        borderRadius: 3,
        letterSpacing: '0.1em',
        color: solid ? 'var(--bg-0)' : col,
        background: solid ? col : 'transparent',
        border: `1px solid ${solid ? col : 'var(--line-2)'}`,
      }}
    >
      {children}
    </span>
  );
}

const CloudGlyph = ({ c }: { c: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 3.5 3.5 0 0 0 7 18Z"
      stroke={c}
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
);
const DriveGlyph = ({ c }: { c: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.5" y="6" width="17" height="12" rx="2" stroke={c} strokeWidth="1.4" />
    <circle cx="16.5" cy="12" r="1.4" fill={c} />
    <line x1="6.5" y1="12" x2="12" y2="12" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

/* ---------------- New session (wired to real create) ---------------- */
function NewSession() {
  const router = useRouter();
  const [mode, setMode] = useState<'cloud' | 'local'>('cloud');
  const [name, setName] = useState('Untitled Session');
  const [sr, setSr] = useState('48k');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localAvailable, setLocalAvailable] = useState(false);
  useEffect(() => setLocalAvailable(hasOpfs()), []);

  async function create() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, storageMode: mode }),
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `Failed (HTTP ${res.status})`);
      }
      const created: { id: string } = await res.json();
      router.push(`/session/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
      setSubmitting(false);
    }
  }

  const modes = [
    {
      id: 'cloud' as const,
      accent: 'gold' as const,
      glyph: CloudGlyph,
      title: 'CLOUD',
      tag: 'RECOMMENDED',
      desc: 'Synced and versioned. Collaborate, render on our machines, pick up on any device.',
      notes: ['Auto-save & history', 'Shared stems', 'Cloud rendering'],
      disabled: false,
    },
    {
      id: 'local' as const,
      accent: 'teal' as const,
      glyph: DriveGlyph,
      title: 'LOCAL',
      tag: localAvailable ? 'OFFLINE' : 'UNAVAILABLE',
      desc: localAvailable
        ? 'Runs entirely on your machine. Lowest latency, full privacy, works with no connection.'
        : 'Needs a browser with OPFS — Chrome 86+, Safari 15+, Firefox 111+.',
      notes: ['Lowest latency', 'On-device files', 'No connection needed'],
      disabled: !localAvailable,
    },
  ];
  const inputCss: React.CSSProperties = {
    background: 'var(--inset)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-md)',
    color: 'var(--txt-0)',
    fontFamily: 'var(--mono)',
    fontSize: 13,
    padding: '10px 12px',
    width: '100%',
  };

  return (
    <section style={{ marginBottom: 44 }}>
      <SectionHead label="01" title="New session" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        {modes.map((m) => {
          const sel = mode === m.id;
          const col = ACCENT[m.accent];
          return (
            <button
              type="button"
              key={m.id}
              disabled={m.disabled}
              onClick={() => !m.disabled && setMode(m.id)}
              style={{
                textAlign: 'left',
                padding: 18,
                borderRadius: 'var(--r-lg)',
                cursor: m.disabled ? 'not-allowed' : 'pointer',
                opacity: m.disabled ? 0.5 : 1,
                background: sel
                  ? `linear-gradient(160deg, ${m.accent === 'gold' ? 'rgba(231,169,72,0.10)' : 'rgba(79,163,155,0.10)'}, var(--bg-2))`
                  : 'var(--bg-2)',
                border: `1px solid ${sel ? col : 'var(--line)'}`,
                boxShadow: sel ? `0 0 0 1px ${col}, 0 0 26px -10px ${col}` : 'var(--sh-1)',
                transition: 'background var(--med) var(--ease), box-shadow var(--med) var(--ease)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 'var(--r-md)',
                    display: 'grid',
                    placeItems: 'center',
                    background: sel
                      ? m.accent === 'gold'
                        ? 'var(--gold-a)'
                        : 'var(--teal-a)'
                      : 'var(--bg-3)',
                    border: `1px solid ${sel ? col : 'var(--line-2)'}`,
                  }}
                >
                  <m.glyph c={sel ? col : 'var(--txt-2)'} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span
                    className="lbl"
                    style={{
                      fontSize: 13,
                      color: sel ? col : 'var(--txt-1)',
                      letterSpacing: '0.18em',
                      fontWeight: 600,
                    }}
                  >
                    {m.title}
                  </span>
                  <Badge accent={m.accent}>{m.tag}</Badge>
                </div>
                <div
                  style={{
                    marginLeft: 'auto',
                    width: 18,
                    height: 18,
                    borderRadius: 12,
                    border: `1px solid ${sel ? col : 'var(--line-2)'}`,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {sel && (
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 8,
                        background: col,
                        boxShadow: `0 0 8px ${col}`,
                      }}
                    />
                  )}
                </div>
              </div>
              <p
                style={{
                  margin: '0 0 12px',
                  fontFamily: 'var(--sans)',
                  fontSize: 12.5,
                  color: 'var(--txt-1)',
                  lineHeight: 1.55,
                }}
              >
                {m.desc}
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {m.notes.map((n) => (
                  <span
                    key={n}
                    className="lbl"
                    style={{
                      fontSize: 8.5,
                      color: 'var(--txt-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <span
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: 4,
                        background: sel ? col : 'var(--txt-3)',
                      }}
                    />
                    {n}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          padding: 16,
          flexWrap: 'wrap',
        }}
      >
        <label style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span className="lbl" style={{ fontSize: 9 }}>
            Session name
          </span>
          <input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            style={inputCss}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span className="lbl" style={{ fontSize: 9 }}>
            Sample rate
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {['44k', '48k', '96k'].map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => setSr(r)}
                className="lbl"
                style={{
                  fontSize: 10,
                  padding: '9px 12px',
                  borderRadius: 'var(--r-md)',
                  border: `1px solid ${sr === r ? 'var(--gold)' : 'var(--line-2)'}`,
                  background: sr === r ? 'var(--gold-a)' : 'var(--inset)',
                  color: sr === r ? 'var(--gold)' : 'var(--txt-2)',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={submitting || !name.trim()}
          className="lbl"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            height: 40,
            padding: '0 22px',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--gold)',
            background: 'var(--gold)',
            color: 'var(--bg-0)',
            fontSize: 11,
            letterSpacing: '0.14em',
            fontWeight: 700,
            cursor: submitting || !name.trim() ? 'default' : 'pointer',
            opacity: submitting || !name.trim() ? 0.6 : 1,
            boxShadow: '0 0 20px -6px var(--gold)',
          }}
        >
          {submitting ? 'CREATING…' : 'CREATE SESSION'} <span style={{ fontSize: 14 }}>→</span>
        </button>
      </div>
      {error && (
        <p style={{ marginTop: 10, color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {error}
        </p>
      )}
    </section>
  );
}

/* ---------------- Recent sessions (real) ---------------- */
const WAVE_COLORS = ['var(--wave)', 'var(--teal)', 'var(--rust)', 'var(--violet)', 'var(--mauve)'];
function SessionRow({ s, idx }: { s: SessionSummary; idx: number }) {
  const [hover, setHover] = useState(false);
  const color = WAVE_COLORS[idx % WAVE_COLORS.length];
  return (
    <a
      href={`/session/${s.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '12px 16px',
        textDecoration: 'none',
        borderBottom: '1px solid var(--line)',
        background: hover ? 'var(--bg-3)' : 'transparent',
        transition: 'background var(--fast)',
        position: 'relative',
      }}
    >
      {hover && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--gold)',
          }}
        />
      )}
      <div
        style={{
          width: 130,
          flexShrink: 0,
          height: 40,
          background: 'var(--inset)',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--line)',
          padding: '0 5px',
          display: 'grid',
          alignItems: 'center',
        }}
      >
        <Thumb seed={seedFrom(s.id)} color={color} h={30} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--txt-0)',
            fontWeight: 500,
            marginBottom: 5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {s.name}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Badge accent={s.storageMode === 'cloud' ? 'gold' : 'teal'}>
            {s.storageMode === 'cloud' ? '☁ CLOUD' : '▣ LOCAL'}
          </Badge>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="lbl" style={{ fontSize: 9, color: 'var(--txt-2)' }}>
          opened {relativeTime(s.lastOpenedAt)}
        </div>
      </div>
      <span
        className="lbl"
        style={{
          fontSize: 10,
          padding: '7px 13px',
          borderRadius: 'var(--r-md)',
          border: `1px solid ${hover ? 'var(--gold)' : 'var(--line-2)'}`,
          background: hover ? 'var(--gold-a)' : 'transparent',
          color: hover ? 'var(--gold)' : 'var(--txt-2)',
          flexShrink: 0,
          transition: 'all var(--fast)',
        }}
      >
        OPEN
      </span>
    </a>
  );
}

/* ---------------- Articles + docs (placeholder) ---------------- */
const ARTICLES = [
  {
    cat: 'WORKFLOW',
    accent: 'gold' as Accent,
    title: 'Gain staging the fixed chain',
    excerpt:
      'Why the EQ→comp→tape order matters, and how to set levels so each stage hits its sweet spot.',
    read: '6 min',
    seed: 4,
  },
  {
    cat: 'MASTERING',
    accent: 'red' as Accent,
    title: 'When to reach for the limiter — and when not to',
    excerpt:
      'Loudness targets, true-peak ceilings, and the art of leaving headroom on the master bus.',
    read: '8 min',
    seed: 12,
  },
  {
    cat: 'MASTERING',
    accent: 'sage' as Accent,
    title: 'Reference rooms: mixing for laptops, earbuds & cars',
    excerpt: 'Use the Ref Room presets to translate your mix to the places people actually listen.',
    read: '5 min',
    seed: 19,
  },
  {
    cat: 'MIXING',
    accent: 'mauve' as Accent,
    title: 'De-essing without dulling the top end',
    excerpt: 'Tame harsh sibilance while keeping air and presence in vocals and acoustic sources.',
    read: '4 min',
    seed: 26,
  },
];
function ArticleCard({ a }: { a: (typeof ARTICLES)[number] }) {
  const [h, setH] = useState(false);
  const col = ACCENT[a.accent];
  return (
    <button
      type="button"
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'left',
        background: 'var(--bg-2)',
        border: `1px solid ${h ? 'var(--line-3)' : 'var(--line)'}`,
        borderRadius: 'var(--r-lg)',
        overflow: 'hidden',
        transition: 'all var(--med)',
        boxShadow: h ? 'var(--sh-2)' : 'var(--sh-1)',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <div
        style={{
          height: 72,
          width: '100%',
          background: 'var(--inset)',
          borderBottom: '1px solid var(--line)',
          position: 'relative',
          overflow: 'hidden',
          padding: '0 10px',
          display: 'grid',
          alignItems: 'center',
        }}
      >
        <div style={{ opacity: 0.55 }}>
          <Thumb seed={a.seed} color={col} h={44} />
        </div>
        <span
          className="lbl"
          style={{
            position: 'absolute',
            top: 9,
            left: 11,
            fontSize: 8,
            color: col,
            background: 'var(--bg-0)',
            padding: '3px 7px',
            borderRadius: 3,
            border: `1px solid ${col}`,
          }}
        >
          {a.cat}
        </span>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <h3
          style={{
            margin: 0,
            fontFamily: 'var(--sans)',
            fontSize: 15,
            color: h ? col : 'var(--txt-0)',
            fontWeight: 600,
            lineHeight: 1.3,
            transition: 'color var(--fast)',
          }}
        >
          {a.title}
        </h3>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--sans)',
            fontSize: 12,
            color: 'var(--txt-1)',
            lineHeight: 1.55,
            flex: 1,
          }}
        >
          {a.excerpt}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span className="lbl" style={{ fontSize: 9, color: 'var(--txt-2)' }}>
            {a.read} read
          </span>
          <span
            style={{
              marginLeft: 'auto',
              color: h ? col : 'var(--txt-2)',
              fontSize: 13,
              transition: 'all var(--fast)',
              transform: h ? 'translateX(2px)' : 'none',
            }}
          >
            →
          </span>
        </div>
      </div>
    </button>
  );
}

const DOCS = [
  {
    t: 'Getting started with Aux',
    d: 'Set up your first session and tour the interface.',
    icon: '◆',
  },
  {
    t: 'The fixed processing chain',
    d: 'EQ, comp, transient, image, tape — why the order is fixed.',
    icon: '⛓',
  },
  { t: 'Cloud vs Local mode', d: 'Pick the right mode for your workflow.', icon: '☁' },
  { t: 'Keyboard shortcuts', d: 'Move faster with the full shortcut reference.', icon: '⌘' },
];
function DocRow({ d }: { d: (typeof DOCS)[number] }) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        width: '100%',
        textAlign: 'left',
        alignItems: 'center',
        gap: 13,
        padding: '13px 15px',
        borderBottom: '1px solid var(--line)',
        background: h ? 'var(--bg-3)' : 'transparent',
        transition: 'background var(--fast)',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: 'var(--r-md)',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg-3)',
          border: '1px solid var(--line-2)',
          color: h ? 'var(--gold)' : 'var(--txt-2)',
          fontSize: 13,
        }}
      >
        {d.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--txt-0)', fontWeight: 500 }}>{d.t}</div>
        <div
          style={{ fontFamily: 'var(--sans)', fontSize: 11.5, color: 'var(--txt-2)', marginTop: 2 }}
        >
          {d.d}
        </div>
      </div>
      <span
        style={{
          color: h ? 'var(--gold)' : 'var(--txt-3)',
          fontSize: 13,
          transition: 'all var(--fast)',
        }}
      >
        →
      </span>
    </button>
  );
}

function SectionHead({ label, title, action }: { label: string; title: string; action?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
      <span className="val" style={{ fontSize: 11, color: 'var(--gold)', fontWeight: 600 }}>
        {label}
      </span>
      <h2
        style={{
          margin: 0,
          fontSize: 18,
          fontFamily: 'var(--sans)',
          fontWeight: 600,
          color: 'var(--txt-0)',
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </h2>
      {action && (
        <span className="lbl" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--txt-2)' }}>
          {action} →
        </span>
      )}
    </div>
  );
}

/* ---------------- Nav rail ---------------- */
function Rail({ userEmail, signOut }: { userEmail?: string; signOut: React.ReactNode }) {
  const items: [string, string, boolean][] = [
    ['◧', 'Sessions', true],
    ['＋', 'New', false],
    ['❏', 'Templates', false],
    ['◇', 'Learn', false],
    ['☁', 'Cloud', false],
  ];
  const initial = (userEmail?.[0] ?? 'A').toUpperCase();
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px 18px',
        position: 'sticky',
        top: 0,
        height: '100vh',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 32, paddingLeft: 4 }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 4,
            background: 'var(--gold)',
            boxShadow: '0 0 14px var(--gold)',
          }}
        />
        <span
          className="lbl"
          style={{ fontSize: 18, color: 'var(--gold)', letterSpacing: '0.24em', fontWeight: 700 }}
        >
          AUX
        </span>
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map(([ic, label, on]) => (
          <span
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '9px 12px',
              borderRadius: 'var(--r-md)',
              color: on ? 'var(--gold)' : 'var(--txt-1)',
              background: on ? 'var(--gold-a)' : 'transparent',
              border: `1px solid ${on ? 'rgba(231,169,72,0.3)' : 'transparent'}`,
            }}
          >
            <span style={{ fontSize: 13, width: 16, textAlign: 'center', opacity: on ? 1 : 0.7 }}>
              {ic}
            </span>
            <span
              className="lbl"
              style={{ fontSize: 11, letterSpacing: '0.1em', color: 'inherit' }}
            >
              {label}
            </span>
          </span>
        ))}
      </nav>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          style={{
            padding: 12,
            borderRadius: 'var(--r-md)',
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
            <span className="lbl" style={{ fontSize: 8 }}>
              CLOUD STORAGE
            </span>
            <span className="val" style={{ fontSize: 9, color: 'var(--gold)' }}>
              62%
            </span>
          </div>
          <div
            style={{ height: 5, background: 'var(--inset)', borderRadius: 3, overflow: 'hidden' }}
          >
            <div
              style={{
                width: '62%',
                height: '100%',
                background: 'linear-gradient(90deg,var(--sage),var(--gold))',
              }}
            />
          </div>
          <div className="lbl" style={{ fontSize: 8, color: 'var(--txt-2)', marginTop: 7 }}>
            12.4 / 20 GB
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px' }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'linear-gradient(135deg,var(--rust),var(--gold))',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--bg-0)',
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            {initial}
          </span>
          <div style={{ lineHeight: 1.3, minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--txt-0)',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {userEmail ?? 'Account'}
            </div>
            <div className="lbl" style={{ fontSize: 8, color: 'var(--txt-2)' }}>
              STUDIO PLAN
            </div>
          </div>
        </div>
        {signOut}
      </div>
    </aside>
  );
}

export function Launcher({
  sessions,
  userEmail,
  signOut,
}: { sessions: SessionSummary[]; userEmail?: string; signOut: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Rail userEmail={userEmail} signOut={signOut} />
      <main style={{ flex: 1, overflowY: 'auto', height: '100vh' }}>
        <div style={{ padding: '40px 48px 0', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 0.16, pointerEvents: 'none' }}>
            <Spectrum active accent="gold" height={180} bins={120} />
          </div>
          <div style={{ position: 'relative' }}>
            <span className="lbl" style={{ fontSize: 10, color: 'var(--txt-2)' }}>
              WELCOME BACK
            </span>
            <h1
              style={{
                margin: '8px 0 6px',
                fontFamily: 'var(--sans)',
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: 'var(--txt-0)',
              }}
            >
              Start mixing.
            </h1>
            <p
              style={{
                margin: 0,
                fontFamily: 'var(--sans)',
                fontSize: 14,
                color: 'var(--txt-1)',
                maxWidth: 540,
                lineHeight: 1.6,
              }}
            >
              Spin up a new session in the cloud or on your machine, jump back into recent work, or
              dig into the manual and mixing &amp; mastering guides.
            </p>
          </div>
        </div>

        <div style={{ padding: '36px 48px 64px', maxWidth: 1080 }}>
          <NewSession />

          <section style={{ marginBottom: 44 }}>
            <SectionHead
              label="02"
              title="Recent sessions"
              action={sessions.length ? 'All sessions' : undefined}
            />
            {sessions.length === 0 ? (
              <div
                style={{
                  background: 'var(--bg-2)',
                  border: '1px dashed var(--line-2)',
                  borderRadius: 'var(--r-lg)',
                  padding: '32px',
                  textAlign: 'center',
                  color: 'var(--txt-2)',
                  fontFamily: 'var(--sans)',
                  fontSize: 13,
                }}
              >
                No sessions yet — create your first one above.
              </div>
            ) : (
              <div
                style={{
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-lg)',
                  overflow: 'hidden',
                }}
              >
                {sessions.map((s, i) => (
                  <SessionRow key={s.id} s={s} idx={i} />
                ))}
              </div>
            )}
          </section>

          <section style={{ marginBottom: 44 }}>
            <SectionHead label="03" title="Learn the tool" action="Open the manual" />
            <div
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-lg)',
                overflow: 'hidden',
              }}
            >
              {DOCS.map((d) => (
                <DocRow key={d.t} d={d} />
              ))}
            </div>
          </section>

          <section>
            <SectionHead label="04" title="Mixing & mastering" action="All articles" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
              {ARTICLES.map((a) => (
                <ArticleCard key={a.title} a={a} />
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
