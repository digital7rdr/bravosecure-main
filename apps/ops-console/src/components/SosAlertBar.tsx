'use client';

import Link from 'next/link';
import {useCallback, useEffect, useRef, useState} from 'react';
import useSWR from 'swr';
import {opsApi, opsDataApi, useSosEvents, type DeptIncidentRow, type DispatchMonitor, type MissionRow, type SosEventRow, type VbgMonitoringRow} from '@/lib/api';

/**
 * Issue 44 (Testing Issues V2, PDF p.49) — "SOS Activation Is Not Reflected in
 * the Bravo Control System". CRITICAL.
 *
 * The data half is fixed server-side: a client panic now flips missions.status
 * to SOS and carries mission_id on the sos_events row, so the console can both
 * see and work the alert. What remained is the console UX the PDF specifies:
 * "immediate PERSISTENT alert, AUDIBLE notification, acknowledgement workflow,
 * escalation status, audit record."
 *
 * Acknowledgement, escalation and the audit record already exist on /sos. The
 * two that did not:
 *
 *   PERSISTENT — the only banner lived on /live. An operator sitting on
 *   /bookings or /finance saw nothing but a small bell badge. An emergency
 *   alert that depends on which tab you happen to have open is not an alert,
 *   so this bar is mounted in the Shell and shows on EVERY page. It cannot be
 *   dismissed while an SOS is unresolved — only working the alert clears it.
 *
 *   AUDIBLE — there was no sound at all. Synthesised via Web Audio rather than
 *   an audio file: no asset to 404, no CSP media-src to widen, and it works
 *   offline.
 *
 * Browsers refuse to start audio before a user gesture, so the chime can be
 * armed only after one. We do NOT pretend otherwise — if the context is still
 * suspended the bar says the sound is off and offers a control to enable it.
 * Silently failing to sound a life-safety alarm would be a worse bug than the
 * one this fixes.
 */

/** Re-sound while an SOS stays UNACKNOWLEDGED. Long enough not to be torture in
 *  a control room, short enough that a walked-away operator is called back. */
const CHIME_REPEAT_MS = 20_000;

function unresolved(rows: SosEventRow[] | undefined): SosEventRow[] {
  return (rows ?? []).filter(r => !r.resolved_at);
}

/** OC-06 amber tier — slower sweep than SOS: these are "look soon", not sirens. */
const AMBER_POLL_MS = 10_000;
/** Matches the /live/[id] LOST SIGNAL threshold (300 s without a telemetry bump). */
const LOST_SIGNAL_MS = 300_000;
const TRACKED_STATUSES = new Set(['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);

/**
 * OC-02 — browser push for SOS. The in-page bar + chime cover a visible tab;
 * this covers the backgrounded one (paired with the SOS poll's
 * refreshWhenHidden). Permission is requested on the same first-gesture hook
 * that arms the chime, so the prompt appears in a user-gesture context.
 */
function useSosBrowserNotify(unacked: SosEventRow[]) {
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const fresh = unacked.filter(r => !seen.current.has(r.id));
    if (fresh.length === 0) return;
    for (const r of fresh) seen.current.add(r.id);
    if (Notification.permission !== 'granted') return;
    // Only when the tab can't be seen — a visible tab already has the bar.
    if (document.visibilityState === 'visible') return;
    const lead = fresh[0];
    const who = lead.user_display_name ?? lead.agent_call_sign ?? 'Unknown';
    try {
      const n = new Notification(`SOS — ${fresh.length} new emergency alert${fresh.length > 1 ? 's' : ''}`, {
        body: `${who} · ${lead.region_label ?? lead.region_code ?? ''} — open the console to respond`,
        tag: 'bravo-ops-sos', requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {
      // Notification construction can throw on some platforms; the bar remains.
    }
  }, [unacked]);
}

function useSosChime(active: boolean): {armed: boolean; arm: () => void} {
  const ctxRef = useRef<AudioContext | null>(null);
  const [armed, setArmed] = useState(false);

  const ctx = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!ctxRef.current) {
      const Ctor = window.AudioContext
        ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
      if (!Ctor) return null;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }, []);

  const arm = useCallback(() => {
    const c = ctx();
    if (!c) return;
    void c.resume().then(() => setArmed(c.state === 'running')).catch(() => setArmed(false));
  }, [ctx]);

  // Any interaction anywhere in the console satisfies the autoplay gate, so an
  // operator who simply uses the console never sees the enable control.
  useEffect(() => {
    if (typeof window === 'undefined' || armed) return;
    const onGesture = () => arm();
    window.addEventListener('pointerdown', onGesture, {once: true});
    window.addEventListener('keydown', onGesture, {once: true});
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, [armed, arm]);

  useEffect(() => {
    if (!active || !armed) return;
    const c = ctx();
    if (!c) return;

    // Two-tone alternating burst — a shape that reads as an alarm rather than
    // a notification ping, and cuts through room noise better than one tone.
    const sound = () => {
      if (c.state !== 'running') return;
      const now = c.currentTime;
      for (let i = 0; i < 4; i++) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'square';
        osc.frequency.value = i % 2 === 0 ? 880 : 660;
        const t0 = now + i * 0.22;
        // Ramp instead of a hard start/stop: a square wave gated abruptly
        // clicks, and a clicking alarm sounds broken.
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      }
    };

    sound();
    const id = setInterval(sound, CHIME_REPEAT_MS);
    return () => clearInterval(id);
  }, [active, armed, ctx]);

  return {armed, arm};
}

export default function SosAlertBar() {
  // 'active' == resolved_at IS NULL server-side.
  const {data} = useSosEvents('active');
  const rows = unresolved(data);
  const unacked = rows.filter(r => !r.acknowledged_at);
  const escalated = rows.filter(r => r.escalated_at);

  // The alarm sounds for UNACKNOWLEDGED alerts only. Once an operator has
  // acknowledged, the bar stays (the SOS is still open) but goes quiet —
  // otherwise it punishes the person already working it.
  const {armed, arm} = useSosChime(unacked.length > 0);

  useSosBrowserNotify(unacked);

  // Ask for notification permission on the first gesture (same moment the
  // chime arms) — never unprompted on load.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    const ask = () => { void Notification.requestPermission(); };
    window.addEventListener('pointerdown', ask, {once: true});
    return () => window.removeEventListener('pointerdown', ask);
  }, []);

  // OC-06 — amber tier. Before this, a critical incident or a live mission
  // whose telemetry died was visible ONLY to an operator already sitting on
  // /incidents or that mission's page. Two slow console-wide sweeps (10 s,
  // hidden-tab included) feed a non-siren banner: look soon, not jump now.
  const {data: critIncidents} = useSWR<DeptIncidentRow[]>(
    'alert-critical-incidents',
    () => opsApi.deptIncidents({severity: 'critical'}),
    {refreshInterval: AMBER_POLL_MS, refreshWhenHidden: true},
  );
  const openCritical = (critIncidents ?? []).filter(r => r.status !== 'resolved' && r.status !== 'closed');

  const {data: activeMissions} = useSWR<MissionRow[]>(
    'alert-missions-active',
    () => opsApi.listMissions(undefined, 'active'),
    {refreshInterval: AMBER_POLL_MS, refreshWhenHidden: true},
  );
  // Client-clock age like /vbg (the per-mission page keeps the skew-corrected
  // version); at a 5-minute threshold a few seconds of skew don't matter.
  const lostSignal = (activeMissions ?? []).filter(m =>
    TRACKED_STATUSES.has(m.status) && m.updated_at
    && Date.now() - new Date(m.updated_at).getTime() > LOST_SIGNAL_MS,
  );

  // OC-06 completion — the two deferred tiers. A booking the matchmaker gave
  // up on (NO_PROVIDER / AGENCY_NO_SHOW) and a VBG protectee whose heartbeat
  // went silent past 2x their interval (or who escalated) are both states
  // where a person expects protection and nobody is coming unless an operator
  // notices. Same fail-quiet contract as the other sweeps: a 403 for a viewer
  // role just leaves the count at 0.
  const {data: dispatchMon} = useSWR<DispatchMonitor>(
    'alert-dispatch-monitor',
    () => opsApi.dispatchMonitor(),
    {refreshInterval: AMBER_POLL_MS, refreshWhenHidden: true},
  );
  const failedDispatch = (dispatchMon?.recent ?? []).filter(
    r => r.status === 'NO_PROVIDER' || r.status === 'AGENCY_NO_SHOW');

  const {data: vbgRows} = useSWR<VbgMonitoringRow[]>(
    'alert-vbg-monitoring',
    () => opsDataApi.vbgMonitoring(),
    {refreshInterval: AMBER_POLL_MS, refreshWhenHidden: true},
  );
  // Same staleness rule as /vbg's isStale: silent past 2x the check-in interval.
  const vbgAttention = (vbgRows ?? []).filter(r =>
    r.escalated_at != null
    || (r.last_heartbeat_at != null
        && Date.now() - new Date(r.last_heartbeat_at).getTime() > 2 * r.interval_min * 60_000));

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const original = document.title;
    if (unacked.length > 0) {
      document.title = `(${unacked.length}) SOS — ${original.replace(/^\(\d+\) SOS — /, '')}`;
    }
    return () => { document.title = original; };
  }, [unacked.length]);

  const amberCount = openCritical.length + lostSignal.length + failedDispatch.length + vbgAttention.length;
  if (rows.length === 0 && amberCount === 0) return null;

  const amberBar = amberCount > 0 && (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '6px 16px',
        background: 'rgba(245,165,36,0.10)',
        borderBottom: '1px solid var(--warn, #F5A524)',
      }}>
      <span className="pill pill-warn" style={{fontFamily: 'JetBrains Mono', fontSize: 10, fontWeight: 700}}>
        ATTENTION
      </span>
      {openCritical.length > 0 && (
        <Link href="/incidents" style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-1)'}}>
          {openCritical.length} CRITICAL INCIDENT{openCritical.length > 1 ? 'S' : ''} OPEN →
        </Link>
      )}
      {lostSignal.length > 0 && (
        <Link href="/live" style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-1)'}}>
          {lostSignal.length} LIVE MISSION{lostSignal.length > 1 ? 'S' : ''} · LOST SIGNAL &gt;5m →
        </Link>
      )}
      {failedDispatch.length > 0 && (
        <Link href="/dispatch" style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-1)'}}>
          {failedDispatch.length} DISPATCH FAILURE{failedDispatch.length > 1 ? 'S' : ''} · NO PROVIDER →
        </Link>
      )}
      {vbgAttention.length > 0 && (
        <Link href="/vbg" style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-1)'}}>
          {vbgAttention.length} VBG PROTECTEE{vbgAttention.length > 1 ? 'S' : ''} · STALE/ESCALATED →
        </Link>
      )}
    </div>
  );

  if (rows.length === 0) return amberBar || null;

  const lead = unacked[0] ?? rows[0];
  const who = lead.user_display_name ?? lead.agent_call_sign ?? 'Unknown';
  const where = lead.region_label ?? lead.region_code ?? '—';
  const ref = lead.mission_short_code ?? lead.booking_id?.slice(0, 8) ?? lead.id.slice(0, 8);

  return (
    <>
    <div
      role="alert"
      aria-live="assertive"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 16px',
        background: unacked.length > 0 ? 'rgba(220,38,38,0.22)' : 'rgba(220,38,38,0.10)',
        borderBottom: '1px solid var(--err)',
      }}>
      <span
        className="pill"
        style={{
          background: 'var(--err)', borderColor: 'var(--err)', color: '#fff',
          animation: unacked.length > 0 ? 'pill-pulse 1.6s infinite' : undefined,
        }}>
        SOS
      </span>

      <span style={{fontFamily: 'Manrope', fontWeight: 700, fontSize: 12, color: 'var(--tx-1)'}}>
        {unacked.length > 0
          ? `${unacked.length} UNACKNOWLEDGED EMERGENCY ALERT${unacked.length > 1 ? 'S' : ''}`
          : `${rows.length} OPEN SOS — ACKNOWLEDGED, NOT RESOLVED`}
      </span>

      <span style={{fontFamily: 'JetBrains Mono', fontSize: 11, color: 'var(--tx-2)'}}>
        {ref} · {who} · {where}
        {lead.reason ? ` · ${lead.reason}` : ''}
      </span>

      {/* Escalation status — the PDF names it explicitly. */}
      {escalated.length > 0 && (
        <span className="pill pill-warn" style={{fontFamily: 'JetBrains Mono', fontSize: 10}}>
          {escalated.length} ESCALATED
          {escalated[0].escalated_to ? ` · ${escalated[0].escalated_to}` : ''}
        </span>
      )}

      {/* Honest about the alarm being muted, rather than failing silently. */}
      {unacked.length > 0 && !armed && (
        <button
          onClick={arm}
          style={{
            background: 'transparent', border: '1px solid var(--err)', borderRadius: 6,
            color: 'var(--err)', fontFamily: 'JetBrains Mono', fontSize: 9.5,
            fontWeight: 700, letterSpacing: 1, padding: '4px 8px', cursor: 'pointer',
          }}>
          SOUND OFF — ENABLE
        </button>
      )}

      <Link
        href="/sos"
        className="btn btn-sm"
        style={{marginLeft: 'auto', background: 'var(--err)', color: '#fff', border: 'none'}}>
        RESPOND →
      </Link>
    </div>
    {amberBar}
    </>
  );
}
