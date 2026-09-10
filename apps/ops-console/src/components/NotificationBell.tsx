'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * N-23 — a real ops notification centre. The bell used to be a static link to
 * /live badged only with the SOS count; there was no way to see recent ops
 * activity (bookings, jobs, missions, geofence, auth) without leaving the page.
 * This dropdown surfaces the live activity feed (already polled on the
 * dashboard), tracks a per-browser "last seen" watermark for the unread count,
 * and keeps the actionable SOS count as a distinct red sub-badge.
 */

type ActivityItem = {
  id: number;
  kind: string;
  severity: 'info' | 'ok' | 'warn' | 'err';
  actor: string | null;
  subject: string | null;
  message: string;
  created_at: string;
};

const SEEN_KEY = 'bravo:ops-activity-seen';
const SEV_COLOR: Record<ActivityItem['severity'], string> = {
  info: 'var(--muted, #8a93a6)',
  ok:   'var(--ok, #46c98b)',
  warn: 'var(--warn, #e5b567)',
  err:  'var(--err, #F87171)',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (Number.isNaN(m)) { return ''; }
  if (m < 1) { return 'now'; }
  if (m < 60) { return `${m}m`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return `${h}h`; }
  return `${Math.floor(h / 24)}d`;
}

export default function NotificationBell({ activity, sosActive }: { activity: ActivityItem[]; sosActive: number }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number>(0);
  const ref = useRef<HTMLDivElement>(null);

  // Initialise the watermark from localStorage; first-ever run seeds it to now
  // so existing history isn't all counted as unread.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEEN_KEY);
      if (raw) {
        setSeen(Number(raw) || 0);
      } else {
        const now = Date.now();
        window.localStorage.setItem(SEEN_KEY, String(now));
        setSeen(now);
      }
    } catch { /* private mode — treat everything as read */ setSeen(Date.now()); }
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) { return; }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const unread = activity.filter(a => new Date(a.created_at).getTime() > seen).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && activity.length > 0) {
      // Mark the newest as seen so the unread count clears on view.
      const newest = Math.max(...activity.map(a => new Date(a.created_at).getTime()).filter(n => !Number.isNaN(n)), seen);
      setSeen(newest);
      try { window.localStorage.setItem(SEEN_KEY, String(newest)); } catch { /* ignore */ }
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={toggle}
        title={unread > 0 ? `${unread} new` : 'Notifications'}
        className="topbar-bell"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', position: 'relative', padding: 6 }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2c2.7 0 4 1.8 4 5v2l1.5 2H2.5L4 9V7c0-3.2 1.3-5 4-5Z" stroke="currentColor" strokeWidth="1.4" /><path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" stroke="currentColor" strokeWidth="1.4" /></svg>
        {unread > 0 && (
          <div className="topbar-bell-cnt" style={{ background: 'var(--accent, #5B8DEF)' }}>
            {unread > 9 ? '9+' : unread}
          </div>
        )}
        {sosActive > 0 && (
          <div style={{ position: 'absolute', bottom: 2, right: 2, width: 8, height: 8, borderRadius: 4, background: 'var(--err, #F87171)', border: '1.5px solid var(--bg, #0b0e14)' }} />
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340, maxHeight: 420, overflowY: 'auto',
            background: 'var(--panel, #131824)', border: '1px solid var(--hair, rgba(255,255,255,0.08))',
            borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.45)', zIndex: 200, padding: 6,
          }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: 'var(--text, #e8ecf4)' }}>NOTIFICATIONS</span>
            {sosActive > 0 && (
              <Link href="/sos" onClick={() => setOpen(false)} style={{ fontSize: 11, color: 'var(--err, #F87171)', textDecoration: 'none', fontWeight: 700 }}>
                {sosActive} SOS →
              </Link>
            )}
          </div>
          {activity.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted, #8a93a6)', fontSize: 12 }}>No recent activity.</div>
          ) : (
            activity.map(ev => (
              <div key={ev.id} style={{ display: 'flex', gap: 8, padding: '9px 10px', borderTop: '1px solid var(--hair, rgba(255,255,255,0.05))' }}>
                <div style={{ width: 6, height: 6, borderRadius: 3, marginTop: 5, flex: '0 0 auto', background: SEV_COLOR[ev.severity] }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text, #e8ecf4)' }}>{ev.message}</div>
                  {ev.subject && <div style={{ fontSize: 11, color: 'var(--muted, #8a93a6)', marginTop: 1 }}>{ev.subject}</div>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted, #8a93a6)', flex: '0 0 auto' }}>{relTime(ev.created_at)}</div>
              </div>
            ))
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderTop: '1px solid var(--hair, rgba(255,255,255,0.08))' }}>
            <Link href="/live" onClick={() => setOpen(false)} style={{ fontSize: 11.5, color: 'var(--accent, #5B8DEF)', textDecoration: 'none' }}>Live ops →</Link>
            <Link href="/sos" onClick={() => setOpen(false)} style={{ fontSize: 11.5, color: 'var(--accent, #5B8DEF)', textDecoration: 'none' }}>SOS log →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
