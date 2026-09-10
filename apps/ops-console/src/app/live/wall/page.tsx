'use client';

import { Shell } from '@/components/Shell';
import Link from 'next/link';
import { useState } from 'react';

const REGIONS = [
  { label: 'DUBAI',     cnt: 14, active: true },
  { label: 'RIYADH',    cnt: 8,  active: false },
  { label: 'JEDDAH',    cnt: 4,  active: false },
  { label: 'ABU DHABI', cnt: 3,  active: false },
  { label: 'LONDON',    cnt: 2,  active: false },
  { label: 'MIAMI',     cnt: 1,  active: false, dim: true },
];

// Grid lines background reused across tiles
function GridBg() {
  return (
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      backgroundImage:
        'linear-gradient(rgba(76,194,255,0.05) 1px, transparent 1px),' +
        'linear-gradient(90deg, rgba(76,194,255,0.05) 1px, transparent 1px)',
      backgroundSize: '36px 36px',
    }} />
  );
}

// Corner bracket decoration
function Corners({ color = 'var(--act)' }: { color?: string }) {
  const s = (pos: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute', width: 18, height: 18,
    borderColor: color, ...pos,
  });
  return (
    <>
      <div style={s({ top: 8, left: 8, borderTop: `2px solid ${color}`, borderLeft: `2px solid ${color}` })} />
      <div style={s({ top: 8, right: 8, borderTop: `2px solid ${color}`, borderRight: `2px solid ${color}` })} />
      <div style={s({ bottom: 8, left: 8, borderBottom: `2px solid ${color}`, borderLeft: `2px solid ${color}` })} />
      <div style={s({ bottom: 8, right: 8, borderBottom: `2px solid ${color}`, borderRight: `2px solid ${color}` })} />
    </>
  );
}

interface MarkerProps {
  top: number; left: number;
  sos?: boolean; small?: boolean;
  label?: string; labelColor?: string;
}
function Marker({ top, left, sos, small, label, labelColor }: MarkerProps) {
  const sz = small ? 7 : sos ? 13 : 10;
  const bg = sos ? 'var(--err)' : 'var(--act)';
  const glow = sos
    ? '0 0 0 4px rgba(220,38,38,0.2),0 0 18px var(--err)'
    : '0 0 0 2px rgba(91,141,239,0.2),0 0 10px var(--act)';
  return (
    <>
      <div style={{
        position: 'absolute', top: `${top}%`, left: `${left}%`,
        transform: 'translate(-50%,-50%)',
        width: sz, height: sz, borderRadius: '50%',
        background: bg, boxShadow: glow,
      }} />
      {label && (
        <div style={{
          position: 'absolute', top: `${top - 4}%`, left: `${left + 2}%`,
          fontFamily: 'JetBrains Mono', fontSize: 9.5,
          color: labelColor ?? 'var(--glow)',
          letterSpacing: 0.4, fontWeight: sos ? 700 : 400,
          whiteSpace: 'nowrap',
        }}>{label}</div>
      )}
    </>
  );
}

function CityLabel({ label, rec = true }: { label: string; rec?: boolean }) {
  return (
    <div style={{
      position: 'absolute', top: 10, left: 12,
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: 'JetBrains Mono', fontSize: 10.5,
      fontWeight: 700, color: 'var(--tx-1)',
      letterSpacing: 1.2, textTransform: 'uppercase',
    }}>
      {rec && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--err)', boxShadow: '0 0 8px var(--err)', display: 'inline-block' }} />}
      {label}
    </div>
  );
}

function StreamId({ label }: { label: string }) {
  return (
    <div style={{ position: 'absolute', top: 10, right: 12, fontFamily: 'JetBrains Mono', fontSize: 9, color: 'var(--tx-3)', letterSpacing: 1 }}>
      {label}
    </div>
  );
}

function Timestamp({ label }: { label: string }) {
  return (
    <div style={{
      position: 'absolute', bottom: 10, right: 12,
      fontFamily: 'JetBrains Mono', fontSize: 9.5, color: 'var(--glow)', letterSpacing: 0.5,
      background: 'rgba(5,7,10,0.8)', padding: '3px 6px', borderRadius: 3, border: '1px solid var(--bd-2)',
    }}>{label}</div>
  );
}

function StatBadge({ label, value, err }: { label: string; value: string; err?: boolean }) {
  return (
    <span style={{ background: 'rgba(5,7,10,0.8)', padding: '3px 7px', borderRadius: 3, border: `1px solid ${err ? 'rgba(220,38,38,0.4)' : 'var(--bd-2)'}` }}>
      <span style={{ color: err ? 'var(--err)' : 'var(--tx-3)' }}>{label}</span>{' '}
      <b style={{ color: err ? 'var(--err)' : 'var(--tx-1)' }}>{value}</b>
    </span>
  );
}

export default function LiveWall() {
  const [activeRegion, setActiveRegion] = useState('DUBAI');

  return (
    <Shell>
      {/* OC-11 — honesty banner: everything below is hardcoded sample data. */}
      <div role="note" style={{padding: '8px 14px', marginBottom: 12, borderRadius: 8, background: 'rgba(245,165,36,0.12)', border: '1px solid rgba(245,165,36,0.45)', color: 'var(--tx-1)', fontFamily: 'JetBrains Mono', fontSize: 11, letterSpacing: 0.6}}>
        SAMPLE DATA — this wall is a design mockup with no live video pipeline. Feeds, counts and regions are hardcoded.
      </div>
      {/* Top bar: region scrub + pills + controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexShrink: 0 }}>
        {/* Region scrub */}
        <div style={{
          display: 'flex', gap: 6,
          background: 'var(--surf-2)', border: '1px solid var(--bd-2)', borderRadius: 10, padding: 6,
        }}>
          {REGIONS.map(r => {
            const on = activeRegion === r.label;
            return (
              <button
                key={r.label}
                onClick={() => setActiveRegion(r.label)}
                style={{
                  padding: '8px 16px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontFamily: 'JetBrains Mono', fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2,
                  color: on ? '#fff' : 'var(--tx-3)',
                  background: on ? 'var(--act)' : 'transparent',
                  boxShadow: on ? '0 0 12px rgba(91,141,239,0.3)' : 'none',
                  opacity: r.dim ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: r.dim ? 'var(--tx-3)' : 'var(--ok)',
                  boxShadow: r.dim ? 'none' : '0 0 6px var(--ok)',
                  display: 'inline-block',
                }} />
                {r.label}
                <span style={{
                  background: on ? 'rgba(255,255,255,0.18)' : 'var(--surf-3)',
                  color: on ? '#fff' : 'var(--tx-2)',
                  padding: '2px 7px', borderRadius: 10, fontSize: 9,
                }}>{r.cnt}</span>
              </button>
            );
          })}
        </div>

        {/* Status pills.
            Audit L3 — this wall is a layout/visual PREVIEW: the region
            counts, feeds, and SOS markers are sample data, not wired to the
            live mission store yet. Label it honestly so an operator never
            mistakes the mockup for real-time state (real ops monitoring is
            on /live and /live/[id]). Replace this badge with the live pills
            when the wall is wired to useMissions(). */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            className="pill"
            title="Layout preview — counts & markers are sample data, not live. Use /live for real-time monitoring."
            style={{ background: 'rgba(255,193,7,0.14)', border: '1px solid rgba(255,193,7,0.5)', color: 'var(--warn)' }}>
            ◆ PREVIEW · SAMPLE DATA
          </span>
          <Link href="/live" className="pill pill-live" style={{ textDecoration: 'none' }}>● LIVE OPS →</Link>
        </div>

        {/* Layout btn */}
        <button className="btn btn-ghost" style={{ gap: 8 }}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="1" width="5" height="5" stroke="currentColor" strokeWidth="1.4" />
            <rect x="8" y="1" width="5" height="5" stroke="currentColor" strokeWidth="1.4" />
            <rect x="1" y="8" width="5" height="5" stroke="currentColor" strokeWidth="1.4" />
            <rect x="8" y="8" width="5" height="5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          LAYOUT
        </button>
      </div>

      {/* ── CCTV Grid: 3 cols × 2 rows. Primary (Dubai) = col 1-2 × row 1-2 ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        flex: 1, minHeight: 0,
        overflow: 'hidden',
      }}>

        {/* ── PRIMARY: DUBAI ── */}
        <div style={{
          gridColumn: '1/3', gridRow: '1/3',
          background: 'var(--bg-depth)',
          border: '1px solid var(--act)',
          borderRadius: 12, position: 'relative', overflow: 'hidden',
          boxShadow: '0 0 0 1px rgba(91,141,239,0.15),0 20px 40px rgba(0,0,0,0.3)',
        }}>
          <GridBg />
          <Corners />

          {/* Scan line */}
          <div style={{
            position: 'absolute', left: 0, right: 0, top: '32%', height: 60,
            background: 'linear-gradient(180deg,transparent,rgba(91,141,239,0.08),transparent)',
            pointerEvents: 'none',
          }} />

          {/* SVG coastline + route lines */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.6 }} viewBox="0 0 100 100" preserveAspectRatio="none" fill="none">
            {/* Coastline */}
            <path d="M0,58 C14,52 26,60 36,54 C46,48 56,52 66,46 C76,40 86,44 100,38" stroke="#4CC2FF" strokeWidth="0.3" strokeDasharray="1.5 1" opacity="0.7" />
            <path d="M10,78 C24,72 36,80 50,74 C64,68 76,72 92,66 C96,64 100,62 100,62" stroke="#4CC2FF" strokeWidth="0.2" opacity="0.4" />
            {/* Route lines */}
            <path d="M8,30 L32,38 L44,45 L58,52 L74,62 L88,72" stroke="#5B8DEF" strokeWidth="0.5" strokeDasharray="2 1" opacity="0.8" />
            <path d="M6,44 L28,40 L42,42 L58,52" stroke="#5B8DEF" strokeWidth="0.4" strokeDasharray="2 1.5" opacity="0.6" />
            <path d="M10,62 L34,55 L56,52 L74,62" stroke="#8FB0F7" strokeWidth="0.35" strokeDasharray="1.5 1.5" opacity="0.5" />
          </svg>

          {/* Mission markers */}
          <Marker top={38} left={26} label="MSN-21 · CPO-44" />
          <Marker top={50} left={43} label="MSN-16 · CPO-07" />
          <Marker top={58} left={56} label="MSN-12" />
          <Marker top={43} left={70} sos label="⚠ MSN-17 SOS" labelColor="#FFB4B4" />
          <Marker top={28} left={40} small />
          <Marker top={66} left={28} small />
          <Marker top={70} left={74} small />
          <Marker top={32} left={56} small />

          {/* City label */}
          <CityLabel label="DUBAI · AE · CAM-01" />
          <StreamId label="04 / STREAM" />

          {/* Stats row */}
          <div style={{
            position: 'absolute', bottom: 40, left: 12, right: 12,
            display: 'flex', gap: 8,
            fontFamily: 'JetBrains Mono', fontSize: 9.5,
            color: 'var(--tx-2)', letterSpacing: 0.5,
          }}>
            <StatBadge label="ACTIVE" value="14" />
            <StatBadge label="STBY" value="22" />
            <StatBadge label="BOOKED 24H" value="47" />
            <StatBadge label="GMV 24H" value="128k BC" />
            <StatBadge label="SOS" value="1" err />
          </div>

          {/* Bottom bar */}
          <div style={{
            position: 'absolute', bottom: 10, left: 12,
            fontFamily: 'JetBrains Mono', fontSize: 9.5, color: 'var(--tx-2)', letterSpacing: 0.6,
          }}>
            <span style={{ background: 'rgba(5,7,10,0.8)', padding: '3px 7px', borderRadius: 3, border: '1px solid var(--bd-2)' }}>
              · RECORDING
            </span>
          </div>
          <div style={{
            position: 'absolute', bottom: 10, right: 12,
            fontFamily: 'JetBrains Mono', fontSize: 9.5, color: 'var(--glow)', letterSpacing: 0.5,
            background: 'rgba(5,7,10,0.8)', padding: '3px 6px', borderRadius: 3, border: '1px solid var(--bd-2)',
          }}>
            14:23:15 UTC · 1920×1080
          </div>
        </div>

        {/* ── RIYADH ── */}
        <div style={{ background: 'var(--bg-depth)', border: '1px solid var(--bd-2)', borderRadius: 12, position: 'relative', overflow: 'hidden' }}>
          <GridBg />
          <Corners />
          {/* Radar rings (Riyadh has concentric circles in the design) */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="none" fill="none">
            <circle cx="50" cy="52" r="18" stroke="#4CC2FF" strokeWidth="0.3" opacity="0.5" strokeDasharray="1 1" />
            <circle cx="50" cy="52" r="32" stroke="#4CC2FF" strokeWidth="0.25" opacity="0.3" strokeDasharray="1 1" />
            <path d="M20,52 L80,52 M50,22 L50,82" stroke="#4CC2FF" strokeWidth="0.2" opacity="0.3" />
          </svg>
          <Marker top={46} left={42} />
          <Marker top={56} left={58} />
          <Marker top={38} left={54} small />
          <Marker top={62} left={38} small />
          <CityLabel label="RIYADH · SA · CAM-02" />
          <StreamId label="STREAM 02" />
          <div style={{ position: 'absolute', bottom: 10, left: 12, display: 'flex', gap: 6, fontFamily: 'JetBrains Mono', fontSize: 9.5, color: 'var(--tx-2)' }}>
            <StatBadge label="ACTV" value="8" />
            <StatBadge label="STBY" value="12" />
          </div>
          <Timestamp label="14:23:15" />
        </div>

        {/* ── JEDDAH ── */}
        <div style={{ background: 'var(--bg-depth)', border: '1px solid var(--bd-2)', borderRadius: 12, position: 'relative', overflow: 'hidden' }}>
          <GridBg />
          <Corners />
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="none" fill="none">
            <path d="M0,40 C10,44 20,40 28,48 C36,56 44,52 54,58 C64,64 74,58 84,66 C92,72 100,68 100,70" stroke="#4CC2FF" strokeWidth="0.35" opacity="0.6" />
            <path d="M10,30 L40,50 L68,72" stroke="#5B8DEF" strokeWidth="0.3" strokeDasharray="2 1" opacity="0.6" />
          </svg>
          <Marker top={52} left={44} />
          <Marker top={42} left={58} small />
          <Marker top={64} left={66} small />
          <CityLabel label="JEDDAH · SA · CAM-03" />
          <StreamId label="STREAM 03" />
          <div style={{ position: 'absolute', bottom: 10, left: 12, display: 'flex', gap: 6, fontFamily: 'JetBrains Mono', fontSize: 9.5, color: 'var(--tx-2)' }}>
            <StatBadge label="ACTV" value="4" />
            <StatBadge label="STBY" value="7" />
          </div>
          <Timestamp label="14:23:15" />
        </div>
      </div>
    </Shell>
  );
}
