'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { authApi, useDashboard, useOpsMe, useSosEvents, clearSession } from '@/lib/api';
import { hasRole, type AdminRole } from '@/lib/rbac';
import { useMessenger } from './messenger/MessengerProvider';
import NotificationBell from './NotificationBell';
import SosAlertBar from './SosAlertBar';

// Audit fix 4.1 — refresh the access cookie this many seconds BEFORE it
// expires so a long-running request doesn't race the rotation. 60s gives
// plenty of slack on a 15-min default access TTL.
const REFRESH_LEAD_SEC = 60;

// Audit fix 4.1 — idle timeout. Q5 decision: 15 minutes of no activity
// (mouse/keyboard/touch/visibilitychange) → logout. Reset on any input
// event so an admin reading a long card doesn't get bounced mid-glance.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const NAV = [
  {
    href: '/dashboard', title: 'Dashboard',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="11" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="2" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4"/></svg>,
  },
  {
    href: '/bookings', title: 'Bookings',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="1.4" stroke="currentColor" strokeWidth="1.4"/><path d="M3 8h14M7 2v4M13 2v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/pro-applications', title: 'Pro Applications',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2l6 2.5v5c0 4-2.7 6.4-6 8.5-3.3-2.1-6-4.5-6-8.5v-5L10 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M10 6.5l1.1 2.2 2.4.35-1.75 1.7.4 2.4L10 12l-2.15 1.15.4-2.4-1.75-1.7 2.4-.35L10 6.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/pro-management', title: 'Pro Management',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="7" cy="6.5" r="2.6" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 16c0-2.6 2-4.4 4.5-4.4s4.5 1.8 4.5 4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M13.5 5.5l1 1 2-2M13.5 10.5l1 1 2-2M13.5 15.5l1 1 2-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/jobs', title: 'Job Feed',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 5h14v12H3z" stroke="currentColor" strokeWidth="1.4"/><path d="M6 2h8l1 3H5l1-3Z" stroke="currentColor" strokeWidth="1.4"/><path d="M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/agents', title: 'Agents',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.4"/><path d="M3 18c0-3.5 3-6 7-6s7 2.5 7 6" stroke="currentColor" strokeWidth="1.4"/></svg>,
  },
  {
    href: '/users', title: 'Users',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.4"/><circle cx="13.5" cy="8.5" r="2.1" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 16.5c0-2.6 2-4.4 4.5-4.4s4.5 1.8 4.5 4.4M12.5 12.6c2.3.2 5 1.6 5 3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/referral-codes', title: 'Referral Codes',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M11 3h5a1 1 0 0 1 1 1v5l-8 8-6-6 8-8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><circle cx="13.5" cy="6.5" r="1.2" stroke="currentColor" strokeWidth="1.2"/></svg>,
  },
  {
    href: '/live', title: 'Live Ops',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"/><circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.4"/><circle cx="10" cy="10" r="1" fill="currentColor"/></svg>,
  },
  {
    href: '/sos', title: 'SOS Log',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6.5v4M10 13.5v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  },
  {
    href: '/protection', title: 'Protection',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2l6 2.5v4.5c0 4-2.6 6.6-6 8-3.4-1.4-6-4-6-8V4.5L10 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><circle cx="10" cy="9" r="1.6" fill="currentColor"/></svg>,
  },
  {
    href: '/dispatch', title: 'Dispatch',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2l7 4-7 4-7-4 7-4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M3 10l7 4 7-4M3 14l7 4 7-4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/dispatch-inspector', title: 'Inspector',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.4"/><path d="M13.5 13.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/compliance', title: 'Compliance',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2l6 2.5v5c0 4-2.7 6.4-6 8.5-3.3-2.1-6-4.5-6-8.5v-5L10 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M7.5 10l1.8 1.8L13 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/incidents', title: 'Incidents',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2L2 17h16L10 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M10 8v4M10 14.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/vbg', title: 'VBG Monitoring',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2l6 2.5v5c0 4-2.7 6.4-6 8.5-3.3-2.1-6-4.5-6-8.5v-5L10 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M10 7v3.5M10 13v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/dept-attendance', title: 'Attendance',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="4" width="14" height="13" rx="1.4" stroke="currentColor" strokeWidth="1.4"/><path d="M3 8h14M7 2v4M13 2v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M7 12l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/messenger', title: 'Messenger',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 4h14v10H7l-4 4V4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>,
  },
  {
    href: '/departments', title: 'Departments',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M4 4h12v9H8l-3 3V4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M7 7h6M7 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/finance', title: 'Finance',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 13l4-5 3 3 6-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 17h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/analytics', title: 'Analytics',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 17V7M8 17V3M13 17V10M17 17V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/audit', title: 'Audit Log',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="4" y="2.5" width="12" height="15" rx="1.4" stroke="currentColor" strokeWidth="1.4"/><path d="M7 6.5h6M7 9.5h6M7 12.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    href: '/admins', title: 'Admins',
    icon: <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.4"/><path d="M4 17c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" strokeWidth="1.4"/><path d="M14.5 3.5l1 1 2-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
];

// Why: 18 flat icons with only hover tooltips were unreadable. Group the
// nav into labelled sections so related tools cluster (Safety = SOS +
// Incidents + Compliance + VBG, etc.). Icons are reused from NAV by href
// so there's a single source for each SVG.
const NAV_GROUPS: Array<{group: string; hrefs: string[]}> = [
  {group: 'Overview', hrefs: ['/dashboard', '/analytics']},
  {group: 'Operations', hrefs: ['/bookings', '/pro-applications', '/pro-management', '/jobs', '/agents', '/users', '/live', '/referral-codes']},
  {group: 'Dispatch', hrefs: ['/dispatch', '/dispatch-inspector']},
  {group: 'Safety', hrefs: ['/sos', '/protection', '/incidents', '/compliance', '/vbg']},
  {group: 'Comms & Org', hrefs: ['/messenger', '/departments', '/dept-attendance']},
  {group: 'Finance', hrefs: ['/finance', '/audit']},
  {group: 'Admin', hrefs: ['/admins']},
];
// OC-12 — role-filtered navigation. These routes 403 below the named tier
// server-side (users/finance/audit are SUPERVISOR+, admins is ADMIN-only);
// rendering them for an OPS operator just walks them into error pages.
// UX hygiene only — the backend @RequireRoles remain the boundary.
const NAV_MIN_ROLE: Record<string, AdminRole> = {
  '/users': 'SUPERVISOR',
  '/finance': 'SUPERVISOR',
  '/audit': 'SUPERVISOR',
  '/admins': 'ADMIN',
};

const NAV_BY_HREF: Record<string, (typeof NAV)[number]> = Object.fromEntries(
  NAV.map(n => [n.href, n]),
);

const RAIL_COLLAPSED_KEY = 'bravo_ops_rail_collapsed';

function Splash({label}: {label: string}) {
  return (
    <div style={{
      minHeight:'100vh', background:'var(--bg)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '2.5px solid var(--surf-3)', borderTopColor: 'var(--acc)',
        animation: 'splashspin 0.9s linear infinite',
      }}/>
      <div style={{
        fontFamily: 'JetBrains Mono', fontSize: 10.5, color: 'var(--tx-3)',
        letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase',
      }}>{label}</div>
      <style>{`@keyframes splashspin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function UtcClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const d = now.toISOString().slice(0, 10);
      const t = now.toUTCString().slice(17, 25);
      setTime(`${d}  ·  ${t} UTC`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <div className="topbar-clock">{time}</div>;
}

export function Shell({ children }: { children: ReactNode }) {
  const path   = usePathname();
  const router = useRouter();
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  // Collapsible rail — persisted so an admin's choice survives navigation
  // and reloads. Read in an effect (not initial state) to avoid an SSR /
  // hydration mismatch; a brief expanded→collapsed flip on first paint is
  // acceptable.
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setRailCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed(c => {
      const next = !c;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      }
      return next;
    });
  }, []);

  // Audit fix 0.4 — the cookie session is httpOnly so JS can't probe for
  // it directly. The CSRF cookie IS readable, so we use its presence as
  // a "we're logged in" hint. The middleware handles the redirect on
  // server-side requests; this client-side check just avoids flashing
  // the dashboard before /ops/me bounces us.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const hasCsrfCookie = /(?:^|;\s*)bravo_ops_csrf=/.test(document.cookie);
    if (!hasCsrfCookie) {
      router.replace('/login');
      setHasToken(false);
    } else {
      setHasToken(true);
    }
  }, [router]);

  // SWR fetches /ops/me — if the request 401s, fetchJson auto-redirects.
  const {data: me} = useOpsMe();
  const {wipe: wipeMessenger} = useMessenger();
  const {mutate} = useSWRConfig();

  const logout = useCallback(() => {
    // Audit fix 4.1 / 4.7 + audit P0-W5 — coordinated client-side teardown:
    //   1. Wipe the messenger runtime AND its IndexedDB vault. The
    //      previous version only `lock()`-ed (dropped the in-memory
    //      key), leaving the IDB-encrypted ratchet/messages on disk
    //      forever — a different admin signing in on the same browser
    //      saw the prior admin's encrypted state, and a stolen device
    //      retained the entire history at rest. `wipe()` deletes the
    //      bravo-messenger-<userId> database wholesale.
    //   2. clearSession() wipes the cookies server-side and clears the
    //      in-memory messenger ticket cache (#13).
    //   3. SWR cache invalidated globally so /ops/me + dashboard widgets
    //      don't briefly paint with the prior admin's data on next mount.
    //   4. Redirect to /login regardless of server-side failure.
    void wipeMessenger().catch(() => { /* logout always proceeds */ });
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem('bravo_ops_access_expires_at');
    }
    void mutate(() => true, undefined, {revalidate: false});
    // Hard navigation (not router.replace): a full document load tears
    // down the silent-refresh timer, idle timer, SWR cache and messenger
    // provider so none of them can resurrect the session after we've
    // cleared the cookies. A soft nav keeps the SPA — and its refresh
    // timer — alive, which is part of how sign-out "didn't take".
    void clearSession().finally(() => {
      if (typeof window !== 'undefined') window.location.replace('/login');
      else router.replace('/login');
    });
  }, [wipeMessenger, mutate, router]);

  // Audit fix 4.1 — silent token refresh. Schedules a refresh
  // REFRESH_LEAD_SEC before the access cookie expires. The refresh
  // endpoint reads the path-scoped httpOnly `bravo_ops_refresh` cookie
  // and rotates BOTH cookies, so on success we simply re-arm the timer
  // with the new expiry. On any failure we drop straight to logout —
  // there's no graceful retry, because by then the cookie is gone and
  // the next /ops/me will 401 anyway.
  useEffect(() => {
    if (hasToken !== true) return;
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule(expiresAtMs: number) {
      const delay = Math.max(expiresAtMs - Date.now() - REFRESH_LEAD_SEC * 1000, 1_000);
      timer = setTimeout(async () => {
        try {
          const {expiresIn} = await authApi.sessionRefresh();
          const next = Date.now() + expiresIn * 1000;
          window.sessionStorage.setItem('bravo_ops_access_expires_at', String(next));
          schedule(next);
        } catch {
          logout();
        }
      }, delay);
    }

    const raw = window.sessionStorage.getItem('bravo_ops_access_expires_at');
    // If we don't know when the cookie expires (e.g. tab restored without
    // a fresh login), assume a 15-min ceiling and try to refresh now-ish.
    const initialExpiry = raw ? Number(raw) : Date.now() + 15 * 60_000;
    schedule(initialExpiry);
    return () => { if (timer) clearTimeout(timer); };
  }, [hasToken, logout]);

  // OC-02 — an idle logout during an active SOS would unmount the alert bar
  // and silence the alarm: the monitoring station disarming itself at the
  // worst moment. Same SWR key as SosAlertBar, so this adds no extra fetch.
  const {data: sosRows} = useSosEvents('active');
  const sosActiveRef = useRef(false);
  sosActiveRef.current = (sosRows ?? []).some(r => !r.resolved_at);

  // Audit fix 4.1 — idle timeout. Any user activity resets the clock;
  // 15 min of nothing → logout. Listening on the window catches both the
  // ops-console pages and any nested iframes. visibilitychange fires
  // when the tab is hidden so we don't keep the timer alive in the
  // background (a stale tab shouldn't keep a session warm for an hour).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasToken !== true) return;
    if (typeof window === 'undefined') return;

    function fire() {
      // OC-02 — defer, don't skip: re-check every minute so the logout still
      // lands once the SOS is resolved. Security posture is unchanged for
      // every idle session that is NOT holding a live emergency.
      if (sosActiveRef.current) {
        idleTimer.current = setTimeout(fire, 60_000);
        return;
      }
      // Surface the reason so the login page can show a soft notice.
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bravo_ops_idle_logout', '1');
      }
      logout();
    }

    function reset() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(fire, IDLE_TIMEOUT_MS);
    }

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, reset, {passive: true});
    document.addEventListener('visibilitychange', reset);
    reset();

    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      document.removeEventListener('visibilitychange', reset);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [hasToken, logout]);

  // Audit fix 4.6 — bell badge wired to unacked SOS count from the
  // dashboard endpoint (the most operationally urgent thing the badge
  // could carry — a paged admin who sees a "7" wants to know it isn't
  // marketing fluff). useDashboard already SWR-polls, no extra fetch.
  //
  // IMPORTANT: this hook MUST be declared BEFORE the conditional early
  // returns below — otherwise the first render (hasToken === null)
  // exits before this hook is called, and the next render
  // (hasToken === true) calls one more hook than the previous one →
  // React error #310 "Rendered more hooks than during the previous
  // render". The early returns belong after every hook has been
  // declared.
  const {data: dash} = useDashboard(me?.admin.region);
  const unackedSos = dash?.kpis?.sos_active ?? 0;
  // IS-14 — Pro queue counts ride the same dashboard poll (no extra fetch):
  // small count badges on the PRO nav items so pending work is visible from
  // anywhere in the console.
  const navBadges: Record<string, number> = {
    '/pro-applications': dash?.kpis?.pro_pending ?? 0,
    '/pro-management': dash?.kpis?.pro_requests ?? 0,
  };

  if (hasToken === false) return <Splash label="Redirecting…"/>;
  if (hasToken === null)  return <Splash label="Loading…"/>;

  const callSign = me?.admin.call_sign ?? '…';
  const role     = me?.admin.role ?? '…';
  const initials = callSign.slice(0, 2).toUpperCase();

  const isActive = (href: string) => path === href || path.startsWith(href + '/');

  return (
    <div className="app-shell" data-rail={railCollapsed ? 'collapsed' : 'expanded'}>
      {/* Left rail */}
      <nav className="rail">
        <div className="rail-head">
          <div className="rail-logo">BR</div>
          <span className="rail-brand">BRAVO OPS</span>
          <button
            className="rail-toggle"
            onClick={toggleRail}
            title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {railCollapsed ? '»' : '«'}
          </button>
        </div>
        <div className="rail-nav">
          {NAV_GROUPS.map(g => {
            // OC-12 — drop items (and whole groups) below the operator's tier.
            // Until /ops/me resolves, show everything (a flash of extra items
            // beats a nav that pops in group by group).
            const roleKnown = role === 'OPS' || role === 'SUPERVISOR' || role === 'ADMIN'
              ? (role as AdminRole) : undefined;
            const hrefs = g.hrefs.filter(h => {
              const min = NAV_MIN_ROLE[h];
              return !min || !roleKnown || hasRole(roleKnown, min);
            });
            if (hrefs.length === 0) return null;
            return (
            <div key={g.group} className="rail-group-block">
              <div className="rail-group">{g.group}</div>
              {hrefs.map(href => {
                const n = NAV_BY_HREF[href];
                if (!n) return null;
                const badge = navBadges[n.href] ?? 0;
                return (
                  <Link key={n.href} href={n.href} title={badge > 0 ? `${n.title} · ${badge} waiting` : n.title}
                    className={`rail-item ${isActive(n.href) ? 'active' : ''}`}>
                    <span className="rail-ic">{n.icon}</span>
                    <span className="rail-label">{n.title}</span>
                    {badge > 0 && (
                      <span style={{
                        marginLeft: 'auto', minWidth: 16, height: 16, padding: '0 4px',
                        borderRadius: 8, background: 'var(--acc)', color: '#07090D',
                        fontFamily: 'JetBrains Mono', fontSize: 9, fontWeight: 800,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        lineHeight: 1,
                      }}>
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
            );
          })}
        </div>
        <div className="rail-sep" />
        <Link href="/settings" title="Settings" className={`rail-item ${isActive('/settings') ? 'active' : ''}`}>
          <span className="rail-ic"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>
          <span className="rail-label">Settings</span>
        </Link>
      </nav>

      {/* Top bar */}
      <header className="topbar">
        {/* DC-17 — the fake ⌘K search box promised a global search that never
            existed; removed until a real one ships. Spacer keeps the layout. */}
        <div style={{flex: 1}} />
        <UtcClock />
        {/* N-23/N-24 — real notification centre: a dropdown over the live
            activity feed with a per-browser unread watermark, plus the
            actionable (unacked AND unresolved) SOS count as a red sub-badge. */}
        <NotificationBell activity={dash?.activity ?? []} sosActive={unackedSos} />
        <div className="topbar-admin">
          <div className="topbar-admin-av">{initials}</div>
          <div>
            <div className="topbar-admin-name">{callSign}</div>
            <div className="topbar-admin-role">{role}</div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            style={{
              marginLeft: 10, padding: '6px 10px', borderRadius: 6,
              background: 'var(--surf-3)', border: '1px solid var(--bd-2)',
              color: 'var(--tx-2)', fontFamily: 'JetBrains Mono', fontSize: 9.5,
              letterSpacing: 1.2, fontWeight: 700, cursor: 'pointer',
            }}>
            SIGN OUT
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="main-area">
        {/* Issue 44 — the SOS banner used to live on /live only, so an operator
            on any other page saw nothing but a bell badge. An emergency alert
            that depends on which tab is open is not an alert. Persistent,
            audible, and not dismissible while the SOS is unresolved. */}
        <SosAlertBar />
        {children}
      </main>
    </div>
  );
}
