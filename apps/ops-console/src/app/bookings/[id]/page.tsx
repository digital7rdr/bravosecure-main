'use client';

import {useEffect, useRef, useState, use, type CSSProperties} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {BravoMap} from '@/components/BravoMapLazy';
import {useBookingDetail, opsApi, useOpsMe, type BookingStatus, type PoolVehicle, type BookingApplicant, type PriceBreakdown} from '@/lib/api';
import {Redacted} from '@/components/Redacted';
import {CopyId} from '@/components/CopyId';
import {formatDateTimeShortUtc, formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';
import {bookingServiceLabel} from '@/lib/format';
import {
  canApproveBooking, canRejectBooking, canDispatchBooking, canCompleteBooking,
} from '@/lib/rbac';

const SM_LABELS = [
  ['DRAFT',           'Submit'],
  ['PENDING_OPS',     'Ops Review'],
  ['OPS_APPROVED',    'Approved'],
  ['PAYMENT_PENDING', 'Payment'],
  ['CONFIRMED',       'Confirm'],
  ['LIVE',            'Live'],
  ['COMPLETED',       'Complete'],
] as const;

const STATUS_ORDER: Record<BookingStatus, number> = {
  DRAFT: 0, PENDING_OPS: 1, OPS_APPROVED: 2, PAYMENT_PENDING: 3,
  // Why: DISPATCHING sits between publish and CONFIRMED in the auto flow, so
  // it lights the Confirm step as "current"; the two stall states render like
  // CANCELLED (no progress highlight, tone carries the meaning).
  DISPATCHING: 4,
  CONFIRMED: 4, LIVE: 5, COMPLETED: 6,
  CANCELLED: -1, NO_PROVIDER: -1, AGENCY_NO_SHOW: -1,
};

const contactItemStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  padding: '9px 10px', borderRadius: 8, border: 0,
  background: 'transparent', cursor: 'pointer', textAlign: 'left',
};

export default function BookingDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const router = useRouter();
  const {data, mutate, isLoading, error} = useBookingDetail(id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const booking = data?.booking;
  const client = data?.client ?? null;
  const mission = data?.mission ?? null;
  const current = booking?.status ?? 'PENDING_OPS';
  const cur = STATUS_ORDER[current as BookingStatus] ?? 0;
  // Audit fix 4.2 — RBAC: hide destructive buttons from OPS-tier admins.
  // Backend already 403s on a click, but pre-empting saves a red flash.
  const {data: me} = useOpsMe();
  const role = me?.admin.role;
  // IS-21 — no decision on a settled booking; mirrors the mission ABORT
  // pattern (the server refuses these anyway — this stops the try-and-fail).
  const isTerminal = ['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW'].includes(current);

  // Approve & publish now requires the dress brief — agents see this on
  // their apply sheet and pledge what they'll wear against it.
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveDress, setApproveDress] = useState('');
  const [approveNotes, setApproveNotes] = useState('');

  // Audit fix 4.4 — proper reject modal replaces the old window.prompt.
  // Was: a single-line browser prompt with no styling, no copy, and no
  // length cap (an admin could paste 100KB and crash the audit row).
  // Now: themed modal with required-reason validation (8 chars), notes,
  // and a confirm step. State mirrors the approve modal layout.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNotes, setRejectNotes] = useState('');

  // Contact Client — popover with Call / Email actions. Reaching the client
  // by phone/email reveals their PII, so each action fires the same
  // pii-reveal audit row as the inline Redacted reveals (Audit fix 4.2).
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);
  const hasContact = !!(client?.phone || client?.email);

  useEffect(() => {
    if (!contactOpen) return;
    function onDocClick(e: MouseEvent) {
      if (contactRef.current && !contactRef.current.contains(e.target as Node)) {
        setContactOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setContactOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [contactOpen]);

  function contactClient(kind: 'phone' | 'email') {
    const value = kind === 'phone' ? client?.phone : client?.email;
    if (!value) return;
    // Fire-and-forget audit — never blocks the call/email handoff.
    opsApi.auditPiiReveal({kind, subject: id}).catch(() => {});
    const href = kind === 'phone' ? `tel:${value.replace(/[^\d+]/g, '')}` : `mailto:${value}`;
    window.open(href, '_self');
    setContactOpen(false);
  }

  async function confirmApprove() {
    const dress = approveDress.trim();
    if (dress.length < 8) {
      setErr('Dress instructions are required (min 8 chars).');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await opsApi.approveBooking(id, dress, approveNotes.trim() || undefined);
      setApproveOpen(false);
      setApproveDress('');
      setApproveNotes('');
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function confirmReject() {
    const reason = rejectReason.trim();
    if (reason.length < 8) {
      setErr('Reject reason is required (min 8 chars).');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await opsApi.rejectBooking(id, reason, rejectNotes.trim() || undefined);
      setRejectOpen(false);
      setRejectReason('');
      setRejectNotes('');
      await mutate();
      router.push('/bookings');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // ─── Team & Dispatch (only for CONFIRMED) ───────────────────────────
  const [applicants, setApplicants] = useState<BookingApplicant[]>([]);
  const [vehiclePool, setVehiclePool] = useState<PoolVehicle[]>([]);
  const [pickedApps, setPickedApps] = useState<string[]>([]);
  const [pickedVehicle, setPickedVehicle] = useState<string>('');
  const [pickedLead, setPickedLead] = useState<string>('');
  const [dressInstructions, setDressInstructions] = useState<string>('');

  // Audit fix 4.4 — dispatch picker tick race. The previous effect
  // re-fired every time SWR refetched the booking (object identity flip)
  // and the closure's `timer` was per-render, so an in-flight setTimeout
  // from the prior closure outlived the cleanup. That painted stale
  // applicants on top of the new ones and queued duplicate /applicants
  // polls. Two fixes:
  //   (1) Reduce deps to primitives (`region_code`) so the effect only
  //       re-runs on a region change, not every SWR mutation.
  //   (2) Track the timer in a ref so the cleanup can clear ANY pending
  //       tick, including ones scheduled from a stale closure.
  const pickerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const regionCode = booking?.region_code ?? null;
  useEffect(() => {
    if (current !== 'CONFIRMED' || !regionCode) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [appsRes, vehicles] = await Promise.all([
          opsApi.listBookingApplicants(id),
          opsApi.listAvailableVehicles(regionCode),
        ]);
        if (cancelled) return;
        const freshApps = appsRes.applicants.filter(
          a => a.status === 'PENDING' || a.status === 'SHORTLISTED' || a.status === 'ASSIGNED'
        );
        setApplicants(freshApps);
        setVehiclePool(vehicles);
        // Audit PAGE-04 — reconcile current picks against the refreshed
        // lists so a withdrawn applicant / gone vehicle can't stay "LOCKED"
        // in the banner and get posted as a stale id that only fails
        // server-side.
        const validAppIds = new Set(freshApps.map(a => a.id));
        setPickedApps(prev => prev.filter(pid => validAppIds.has(pid)));
        setPickedLead(prev => (prev && validAppIds.has(prev) ? prev : ''));
        const validVehIds = new Set(vehicles.map(v => v.id));
        setPickedVehicle(prev => (prev && validVehIds.has(prev) ? prev : ''));
      } catch (e) {
        // Audit PAGE-03 — a background poll failure must NOT write the
        // shared `err` (it bleeds into the approve/reject modals). Log and
        // keep polling; the next tick self-heals.
        if (!cancelled) console.warn('[bookings] applicant poll failed', (e as Error).message);
      } finally {
        // Audit PAGE-03 — always reschedule, even after an error, so one
        // transient failure doesn't permanently stop the "auto-refresh" loop.
        if (!cancelled) pickerTimer.current = setTimeout(tick, 6000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pickerTimer.current) {
        clearTimeout(pickerTimer.current);
        pickerTimer.current = null;
      }
    };
  }, [current, regionCode, id]);

  function toggleApplicant(applicationId: string) {
    const cap = booking?.cpo_count ?? 1;
    setPickedApps(prev => {
      if (prev.includes(applicationId)) {
        // unpicking the current lead clears the lead selection too.
        // `pickedLead` holds an application id (set/read as `a.id`
        // elsewhere), so compare it against applicationId directly — the
        // previous a.agent_id check never matched and left a dangling lead.
        if (pickedLead === applicationId) setPickedLead('');
        return prev.filter(x => x !== applicationId);
      }
      if (prev.length >= cap) return prev;
      return [...prev, applicationId];
    });
  }

  // SK-02 — mirror of the server rule (ops.service dispatchBooking): a Bravo
  // vehicle is only required when the booking is NOT driver-only AND actually
  // priced vehicles. Driver-only / exec protection-only details have nothing
  // to drive — demanding a vehicle dead-ended their dispatch.
  const needsVehicle = !!booking && !booking.driver_only && Number(booking.vehicle_count ?? 1) > 0;

  async function dispatch() {
    if (!booking) return;
    if (pickedApps.length !== booking.cpo_count) {
      setErr(`Pick exactly ${booking.cpo_count} applicant(s) before dispatching.`);
      return;
    }
    if (needsVehicle && !pickedVehicle) {
      setErr('Select a vehicle before dispatching.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      // CA-01 — ALWAYS name the lead: the explicit pick, else the first picked
      // applicant, so client and server agree on who leads regardless of row order.
      const leadApp = applicants.find(a => a.id === (pickedLead || pickedApps[0]));
      await opsApi.dispatchBooking(id, {
        applicationIds: pickedApps,
        ...(needsVehicle ? {vehicleId: pickedVehicle} : {}),
        dressInstructions: dressInstructions.trim() || null,
        leadAgentId: leadApp?.agent_id ?? null,
      });
      await mutate();
      setPickedApps([]);
      setPickedVehicle('');
      setPickedLead('');
      setDressInstructions('');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  // Payout review modal state.
  type PayoutDraft = {user_id: string; call_sign: string; display_name: string; proposed: number; paid: number; reason: string};
  const [payoutModalOpen, setPayoutModalOpen] = useState(false);
  const [payoutDrafts, setPayoutDrafts] = useState<PayoutDraft[]>([]);
  const [payoutMeta, setPayoutMeta] = useState<{escrow: number; even: number; remainder: number} | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);

  async function openPayoutModal() {
    setPayoutLoading(true); setErr(null);
    try {
      const proposed = await opsApi.getProposedPayouts(id);
      setPayoutDrafts(proposed.proposed.map(p => ({
        user_id: p.user_id,
        call_sign: p.call_sign,
        display_name: p.display_name,
        proposed: p.proposed_credits,
        paid: p.proposed_credits,
        reason: '',
      })));
      setPayoutMeta({
        escrow: proposed.escrow_credits,
        even: proposed.even_split,
        remainder: proposed.platform_remainder,
      });
      setPayoutModalOpen(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setPayoutLoading(false); }
  }

  function updatePayout(userId: string, patch: Partial<PayoutDraft>) {
    setPayoutDrafts(prev => prev.map(d => d.user_id === userId ? {...d, ...patch} : d));
  }

  async function submitPayouts() {
    if (!payoutMeta) return;
    for (const d of payoutDrafts) {
      if (d.paid < 0 || d.paid > d.proposed) {
        setErr(`${d.call_sign}: paid amount must be between 0 and ${d.proposed}.`);
        return;
      }
      if (d.paid < d.proposed && !d.reason.trim()) {
        setErr(`${d.call_sign}: a deduction reason is required.`);
        return;
      }
    }
    setBusy(true); setErr(null);
    try {
      await opsApi.completeBooking(id, {
        payouts: payoutDrafts.map(d => ({
          user_id: d.user_id,
          credits: d.paid,
          deduction_reason: d.paid < d.proposed ? d.reason.trim() : null,
        })),
      });
      setPayoutModalOpen(false);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  const totalPaid = payoutDrafts.reduce((s, d) => s + d.paid, 0);
  const totalDeducted = payoutDrafts.reduce((s, d) => s + (d.proposed - d.paid), 0);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Bookings · <span style={{color:'var(--tx-2)'}}>{id}</span></div>
          <h2>
            Booking <span className="mono" style={{color:'var(--acc)'}}>{id.slice(-12).toUpperCase()}<CopyId value={id} title="Copy booking id" /></span>
            <span className={`pill pill-${pillTone(current as BookingStatus)}`}>
              ● {current.replace(/_/g, ' ')}
            </span>
          </h2>
        </div>
        <div className="page-head-right">
          <Link href="/bookings" className="btn btn-ghost">← BACK TO QUEUE</Link>
          <div ref={contactRef} style={{position:'relative'}}>
            <button
              className="btn btn-sec"
              disabled={!hasContact}
              title={hasContact ? 'Call or email the client' : 'No contact details on file'}
              onClick={() => setContactOpen(o => !o)}>
              CONTACT CLIENT {contactOpen ? '▴' : '▾'}
            </button>
            {contactOpen && hasContact && (
              <div
                role="menu"
                style={{
                  position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:200,
                  minWidth:240, padding:6, borderRadius:10,
                  background:'var(--surf-2)', border:'1px solid var(--bd-2)',
                  boxShadow:'0 18px 44px rgba(0,0,0,0.5)',
                }}>
                {client?.phone && (
                  <button
                    type="button" role="menuitem"
                    onClick={() => contactClient('phone')}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surf-3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    style={contactItemStyle}>
                    <span style={{fontSize:14}}>📞</span>
                    <span style={{display:'flex', flexDirection:'column', alignItems:'flex-start', minWidth:0}}>
                      <span style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>Call client</span>
                      <span style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)'}}>{client.phone}</span>
                    </span>
                  </button>
                )}
                {client?.email && (
                  <button
                    type="button" role="menuitem"
                    onClick={() => contactClient('email')}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surf-3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    style={contactItemStyle}>
                    <span style={{fontSize:14}}>✉️</span>
                    <span style={{display:'flex', flexDirection:'column', alignItems:'flex-start', minWidth:0}}>
                      <span style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>Email client</span>
                      <span style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', overflow:'hidden', textOverflow:'ellipsis', maxWidth:200}}>{client.email}</span>
                    </span>
                  </button>
                )}
                <div style={{fontFamily:'JetBrains Mono', fontSize:8.5, color:'var(--tx-3)', letterSpacing:0.5, padding:'6px 8px 2px'}}>
                  REVEALING CONTACT IS AUDITED
                </div>
              </div>
            )}
          </div>
          {current === 'LIVE' && mission && (
            <Link href={`/live/${mission.id}`} className="btn btn-act btn-lg" style={{background:'var(--act)', color:'#fff', borderColor:'var(--act)'}}>
              VIEW LIVE MISSION →
            </Link>
          )}
          {current === 'PENDING_OPS' && canApproveBooking(role) && (
            <button
              className="btn btn-ok btn-lg"
              onClick={() => setApproveOpen(true)}
              disabled={busy}>
              {busy ? 'APPROVING…' : 'APPROVE & PUBLISH →'}
            </button>
          )}
        </div>
      </div>

      {err && (
        <div style={{padding:'10px 14px', background:'rgba(220,38,38,0.1)', border:'1px solid var(--err)', borderRadius:8, color:'#FFB4B4', marginBottom:12, fontFamily:'JetBrains Mono', fontSize:11}}>
          API ERROR · {err}
        </div>
      )}

      <div className="bk-detail-layout">
        {/* Left — summary */}
        <div className="card bk-detail-left">
          <div style={{padding:14, display:'flex', alignItems:'center', gap:12, borderBottom:'1px solid var(--bd-2)'}}>
            <div style={{width:46,height:46,borderRadius:12,background:'linear-gradient(135deg,var(--act),var(--acc))',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'Manrope',fontWeight:800,color:'#fff',fontSize:15}}>
              {booking?.region_code ?? '—'}
            </div>
            <div style={{flex:1}}>
              <div style={{fontFamily:'Manrope',fontWeight:800,fontSize:15,letterSpacing:0.4}}>
                {client?.display_name ?? booking?.region_label ?? (isLoading ? 'Loading…' : '—')}
              </div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.5,marginTop:2}}>
                {booking
                  ? `${booking.region_label} · ${bookingServiceLabel(booking.service)} · created ${formatDateTimeShortUtc(booking.created_at)}`
                  : (isLoading ? 'Loading…' : '—')}
              </div>
            </div>
            {client && (
              <div style={{display:'flex',gap:6}}>
                <span className={`pill pill-${client.kyc_status === 'approved' ? 'ok' : client.kyc_status === 'pending' ? 'warn' : 'info'}`}>
                  {client.kyc_status === 'approved' ? 'VERIFIED' : `KYC · ${client.kyc_status.toUpperCase()}`}
                </span>
              </div>
            )}
          </div>

          {/* Client card */}
          {client && (
            <>
              <div style={{padding:'12px 14px 6px', borderBottom:'1px solid var(--bd-2)'}}>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.5, textTransform:'uppercase'}}>
                  Client
                </div>
              </div>
              <div style={{padding:'10px 14px', display:'flex', alignItems:'center', gap:12, borderBottom:'1px solid var(--bd-2)'}}>
                <div style={{
                  width:38, height:38, borderRadius:10,
                  background:'linear-gradient(135deg,var(--acc),var(--act))',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontFamily:'Manrope', fontWeight:800, color:'#fff', fontSize:14,
                }}>
                  {client.display_name.slice(0,2).toUpperCase()}
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontFamily:'Manrope', fontWeight:800, fontSize:14, color:'var(--tx-1)'}}>
                    {client.display_name}
                  </div>
                  {/* Audit fix 4.2 — mask email/phone behind click-to-reveal.
                      Reveal fires an audit row via /ops/audit/pii-reveal so
                      we know which admin viewed which customer's contact. */}
                  <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2, letterSpacing:0.5}}>
                    <Redacted value={client.email} kind="email" subject={id} />
                    {client.phone ? <> · <Redacted value={client.phone} kind="phone" subject={id} /></> : null}
                  </div>
                </div>
                <div style={{display:'flex', flexDirection:'column', gap:4, alignItems:'flex-end'}}>
                  <span className={`pill pill-${client.kyc_status === 'approved' ? 'ok' : client.kyc_status === 'pending' ? 'warn' : 'info'}`}>
                    KYC · {client.kyc_status.toUpperCase()}
                  </span>
                  <span className="pill pill-info" style={{textTransform:'uppercase'}}>
                    {client.subscription_tier}
                  </span>
                  {data?.payer ? (
                    // IS-09 — the payer pill navigates to the owner's user page.
                    <Link href={`/users/${data.payer.id}`} style={{textDecoration:'none'}}>
                      <span className="pill pill-act" title="Family booking — paid from this owner's wallet. Open the owner's user page.">
                        UNDER {(data.payer.display_name ?? 'OWNER').toUpperCase()} →
                      </span>
                    </Link>
                  ) : null}
                </div>
              </div>
              <div style={{padding:'8px 14px', display:'grid', gridTemplateColumns:'120px 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', alignItems:'center'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700}}>Country</div>
                <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500}}>{client.country_code ?? '—'}</div>
              </div>
              <div style={{padding:'8px 14px', display:'grid', gridTemplateColumns:'120px 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', alignItems:'center'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700}}>Member Since</div>
                <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500}}>{formatDateUtc(client.created_at)}</div>
              </div>
              <div style={{padding:'8px 14px', display:'grid', gridTemplateColumns:'120px 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', alignItems:'center'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700}}>Client ID</div>
                <div style={{fontSize:11,color:'var(--tx-2)',fontFamily:'JetBrains Mono'}}>
                  {/* IS-09 — the client id links to the user record now. */}
                  <Link href={`/users/${client.id}`} style={{color:'var(--glow)'}}>{client.id}</Link>
                  <CopyId value={client.id} title="Copy client id" />
                </div>
              </div>
            </>
          )}

          {[
            ['Service', booking ? bookingServiceLabel(booking.service) : '—'],
            ...(booking?.service === 'executive_protection'
              ? [['Task', (booking?.task_type ?? 'site_protection').replace(/_/g, ' ')]]
              : []),
            ['Pickup',  booking?.pickup_address ?? '—'],
            ['Dropoff', booking?.dropoff_address ?? (booking?.service === 'executive_protection' ? 'On-site detail (no dropoff)' : '—')],
            ['Pickup Time', booking?.pickup_time ? formatDateTimeUtc(booking.pickup_time) : '—'],
            // SK-12 — when the dispatch pipeline stamped confirmation, show it.
            ...(booking?.confirmed_at ? [['Confirmed At', formatDateTimeUtc(booking.confirmed_at)]] : []),
            ['Crew Requested', booking ? `${booking.cpo_count}× CPO · ${booking.vehicle_count}× Vehicle` : '—'],
            ...(booking?.service === 'executive_protection' && booking?.exec_transport
              ? [[
                  'Transfer Leg',
                  `${String(booking.exec_transport.mode ?? '').replace(/_/g, ' ')} · ` +
                  `${booking.exec_transport.pickup?.address ?? '—'} → ${booking.exec_transport.dropoff?.address ?? '—'} · ` +
                  `${booking.exec_transport.passengers ?? '—'} pax` +
                  (booking.exec_transport.pickup_time ? ` · ${formatDateTimeUtc(booking.exec_transport.pickup_time)}` : ' · at start time'),
                ]]
              : []),
          ].map(([lbl, val]) => (
            <div key={lbl} style={{padding:'10px 14px', display:'grid', gridTemplateColumns:'120px 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', alignItems:'center'}}>
              <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700}}>{lbl}</div>
              <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500}}>{val}</div>
            </div>
          ))}

          {/* Preferences card — full booking config */}
          {booking && (
            <>
              <div style={{padding:'14px 14px 6px', borderBottom:'1px solid var(--bd-2)'}}>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.5, textTransform:'uppercase'}}>
                  Client Preferences
                </div>
              </div>
              {[
                ['Booking Mode', booking.booking_mode === 'now' ? 'Immediate (Now)' : `Scheduled (${booking.booking_mode})`],
                ['Duration', `${booking.duration_hours} hour${booking.duration_hours === 1 ? '' : 's'}`],
                ['Passengers', `${booking.passengers}`],
                ['CPOs', `${booking.cpo_count}`],
                ['Vehicles', `${booking.vehicle_count}`],
                ['Crew Type', booking.driver_only ? 'Driver-only (no CP)' : 'Full close-protection team'],
                ['Add-ons', formatAddOns(booking.add_ons, data?.price_breakdown ?? null)],
                ['Region', `${booking.region_label} (${booking.region_code})`],
                ['Rate', `${Number(booking.rate_eur_per_hour).toFixed(0)} BC/hr`],
                ['Payment', `${booking.payment_method.toUpperCase()} · ${booking.payment_captured ? 'CAPTURED' : 'PENDING'}`],
              ].map(([lbl, val]) => (
                <div key={lbl} style={{padding:'10px 14px', display:'grid', gridTemplateColumns:'120px 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', alignItems:'center'}}>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700}}>{lbl}</div>
                  <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500}}>{val}</div>
                </div>
              ))}
              {booking.notes && (
                <div style={{padding:'10px 14px', borderBottom:'1px solid var(--bd-2)'}}>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.3,textTransform:'uppercase',fontWeight:700, marginBottom:6}}>Client Notes</div>
                  <div style={{fontSize:12,color:'var(--tx-1)',fontFamily:'Manrope',lineHeight:1.5, padding:'8px 10px', background:'rgba(76,194,255,0.05)', border:'1px solid var(--bd-2)', borderRadius:6}}>
                    {booking.notes}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Mission link card */}
          {mission && (
            <div style={{padding:'12px 14px', borderBottom:'1px solid var(--bd-2)'}}>
              <Link href={`/live/${mission.id}`} style={{
                display:'flex', alignItems:'center', gap:10, textDecoration:'none',
                padding:'10px 12px', borderRadius:8,
                background:'rgba(91,141,239,0.08)', border:'1px solid var(--act)',
              }}>
                <div style={{width:8,height:8,borderRadius:4,background:'var(--act)',boxShadow:'0 0 8px var(--act)'}}/>
                <div style={{flex:1}}>
                  <div style={{fontFamily:'Manrope',fontWeight:700,fontSize:12.5,color:'var(--tx-1)'}}>
                    Live Mission · {mission.short_code}
                  </div>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginTop:2}}>
                    Status: {mission.status} · tap to open live ops view
                  </div>
                </div>
                <span style={{color:'var(--act)',fontFamily:'JetBrains Mono',fontSize:11,fontWeight:700}}>OPEN →</span>
              </Link>
            </div>
          )}

          {/* Mini map — Audit PAGE-02: render the booking's REAL pickup /
              dropoff coordinates (were hardcoded Jeddah→Makkah for every
              booking). Hidden entirely when there's no usable pickup fix. */}
          {(() => {
            const pLat = Number(booking?.pickup_lat),  pLng = Number(booking?.pickup_lng);
            const dLat = Number(booking?.dropoff_lat), dLng = Number(booking?.dropoff_lng);
            const okPickup  = Number.isFinite(pLat) && Number.isFinite(pLng) && !(pLat === 0 && pLng === 0);
            const okDropoff = Number.isFinite(dLat) && Number.isFinite(dLng) && !(dLat === 0 && dLng === 0);
            if (!okPickup) return null;
            const markers = [
              {id:'a', lat:pLat, lng:pLng, label:'A · PICKUP', type:'pickup' as const},
              ...(okDropoff ? [{id:'b', lat:dLat, lng:dLng, label:'B · DROPOFF', type:'dropoff' as const}] : []),
            ];
            const route: [number, number][] | undefined = okDropoff ? [[pLng, pLat], [dLng, dLat]] : undefined;
            const center: [number, number] = okDropoff ? [(pLng + dLng) / 2, (pLat + dLat) / 2] : [pLng, pLat];
            return (
              <div style={{margin:'10px 14px', height:170, borderRadius:8, border:'1px solid var(--bd-2)', overflow:'hidden'}}>
                <BravoMap
                  markers={markers}
                  route={route}
                  center={center}
                  zoom={okDropoff ? 9 : 12}
                  style={{width:'100%', height:'100%'}}
                />
              </div>
            );
          })()}

          {/* Audit timeline */}
          <div className="card-header" style={{borderTop:'1px solid var(--bd-2)', borderBottom:0}}>
            <div className="card-header-title"><span className="bar"/>Audit Timeline</div>
            <div className="card-header-act">{data?.audit?.length ?? 0} EVENTS</div>
          </div>
          {(data?.audit ?? []).length === 0 && (
            <div style={{padding:'18px 14px', color:'var(--tx-3)', fontSize:11.5}}>No audit events yet.</div>
          )}
          {(data?.audit ?? []).map((t, i) => {
            const row = t as {created_at?: string; actor_call?: string; actor_role?: string; action?: string};
            return (
              <div key={i} className="tl-ev">
                {/* CA-17/IS-18 — date component included: an audit trail spans days. */}
                <div className="tl-ts">{row.created_at ? formatDateTimeShortUtc(row.created_at) : ''}</div>
                <div className="tl-who">{row.actor_call ?? row.actor_role ?? ''}</div>
                <div className="tl-msg">{row.action ?? ''}</div>
              </div>
            );
          })}
        </div>

        {/* Right — state machine + pricing + decision */}
        <div className="bk-detail-right">
          <div className="card">
            <div className="card-header"><div className="card-header-title"><span className="bar"/>State Machine</div></div>
            <div style={{padding:14}}>
              <div className="sm">
                {SM_LABELS.map(([st, label], i) => {
                  const cls = i < cur ? 'done' : i === cur ? 'cur' : '';
                  return (
                    <div key={st} className={`sm-step ${cls}`}>
                      <div className="sm-dot">{cls === 'done' ? '✓' : i + 1}</div>
                      <div className="sm-lbl">{label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-header-title"><span className="bar"/>Pricing</div>
              <div className="card-header-act">BC</div>
            </div>
            <div style={{padding:14}}>
              {booking ? (
                <>
                  {/* IS-07 — per-unit composition for exec bookings (server-computed
                      via PricingService; the console never re-tables rates). */}
                  {data?.price_breakdown ? (
                    <>
                      {data.price_breakdown.items.map(it => (
                        <Row
                          key={it.id}
                          k={`${it.qty} × ${it.label} @ ${it.rate_eur} BC/hr`}
                          v={`${it.subtotal_eur.toLocaleString()} BC/hr`}
                        />
                      ))}
                      <Row k="Hourly rate" v={`${data.price_breakdown.rate_eur_per_hour.toLocaleString()} BC/hr`}/>
                      <Row
                        k={`× ${data.price_breakdown.duration_hours} hour${data.price_breakdown.duration_hours === 1 ? '' : 's'}`}
                        v={`${data.price_breakdown.total_eur.toLocaleString()} BC`}
                      />
                    </>
                  ) : (
                    <Row k="Total" v={`${Number(booking.total_eur).toLocaleString()} BC`}/>
                  )}
                  <RowTotal v={`${Number(booking.total_eur).toLocaleString()} BC`}/>
                </>
              ) : (
                <div style={{color:'var(--tx-3)', fontSize:11.5, padding:'8px 0'}}>
                  {/* Audit PAGE-12 — distinguish an API failure from a genuine
                      not-found so a 500/network blip doesn't read as "no such
                      booking", and offer a retry. */}
                  {isLoading
                    ? 'Loading…'
                    : error
                      ? <>Couldn&apos;t load this booking — {(error as Error).message}. <button onClick={() => void mutate()} style={{background:'none',border:'none',color:'var(--glow)',cursor:'pointer',textDecoration:'underline',padding:0,font:'inherit'}}>Retry</button></>
                      : 'Booking not found.'}
                </div>
              )}
            </div>
          </div>

          {/* Audit fix 4.2 — only SUPERVISOR/ADMIN see the decision card.
              OPS-tier admins get a read-only badge so the page doesn't
              look mysteriously empty. */}
          {(canApproveBooking(role) || canRejectBooking(role)) ? (
            <div className="card" style={{padding:14}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:10}}>Decision</div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
                {canApproveBooking(role) && (
                  <button className="btn btn-ok btn-lg" style={{width:'100%', justifyContent:'center'}} disabled={busy || current !== 'PENDING_OPS'} onClick={() => { setErr(null); setApproveOpen(true); }}>
                    {busy ? '…' : 'APPROVE & PUBLISH'}
                  </button>
                )}
                {canRejectBooking(role) && (
                  <button
                    className="btn btn-danger btn-lg"
                    style={{width:'100%', justifyContent:'center'}}
                    disabled={busy || isTerminal}
                    title={isTerminal ? `Booking is ${current.replace(/_/g, ' ')} — nothing left to reject.` : undefined}
                    onClick={() => { setErr(null); setRejectOpen(true); }}>
                    REJECT · REASON
                  </button>
                )}
              </div>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:0.5, marginTop:10, lineHeight:1.5}}>
                Approving publishes a job to the agent feed and emits an audit event.
                Estimated <b style={{color:'var(--tx-2)'}}>8-12</b> applications in the first hour.
              </div>
            </div>
          ) : (
            <div className="card" style={{padding:14, fontFamily:'JetBrains Mono', fontSize:11, color:'var(--tx-3)', letterSpacing:0.4, lineHeight:1.5}}>
              <b style={{color:'var(--tx-2)'}}>READ-ONLY ·</b> Decision actions require SUPERVISOR or ADMIN.
            </div>
          )}

          {current === 'LIVE' && booking && canCompleteBooking(role) && (
            <div className="card" style={{padding:14}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:10}}>
                Mission Live
              </div>
              <button
                className="btn btn-ok btn-lg"
                style={{width:'100%', justifyContent:'center'}}
                disabled={busy || payoutLoading}
                onClick={openPayoutModal}>
                {payoutLoading ? 'LOADING PAYOUTS…' : 'REVIEW PAYOUT → COMPLETE MISSION'}
              </button>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:0.5, marginTop:10, lineHeight:1.5}}>
                Opens a review where you can adjust each CPO&apos;s payout
                with a reason before settling. Default = even split of{' '}
                <b style={{color:'var(--tx-2)'}}>{Number(booking.total_eur).toLocaleString()} BC</b>{' '}
                across {data?.team?.cpos.length ?? 0} CPO(s). On submit,
                units release and the mission group chat is dissolved.
              </div>
            </div>
          )}

          {current === 'COMPLETED' && booking && (
            <div className="card" style={{padding:14}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--ok)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:8}}>
                Mission Completed
              </div>
              <div style={{fontSize:11.5, color:'var(--tx-2)', lineHeight:1.6}}>
                Booking closed · payouts settled · mission group dissolved.
                See the audit timeline for the per-CPO payout breakdown.
              </div>
            </div>
          )}

          {/* SK-05 — the client's post-mission rating (COMPLETED only). */}
          {current === 'COMPLETED' && booking && (
            <div className="card" style={{padding:14}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:10}}>
                Client Rating
              </div>
              {booking.rating != null ? (
                <>
                  <div style={{display:'flex', alignItems:'center', gap:8}}>
                    <span style={{fontSize:16, letterSpacing:2, color:'var(--warn, #FFC107)'}}>
                      {'★'.repeat(Math.max(0, Math.min(5, booking.rating)))}
                      <span style={{color:'var(--tx-3)'}}>{'★'.repeat(Math.max(0, 5 - Math.min(5, booking.rating)))}</span>
                    </span>
                    <span style={{fontFamily:'JetBrains Mono', fontSize:12, fontWeight:800, color:'var(--tx-1)'}}>
                      {booking.rating}/5
                    </span>
                  </div>
                  {(booking.rating_tags ?? []).length > 0 && (
                    <div style={{display:'flex', flexWrap:'wrap', gap:6, marginTop:10}}>
                      {(booking.rating_tags ?? []).map(t => (
                        <span key={t} style={{
                          fontFamily:'JetBrains Mono', fontSize:10, color:'var(--acc)',
                          border:'1px solid var(--bd-2)', borderRadius:99, padding:'3px 9px',
                        }}>
                          {t.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                  {booking.rating_remarks && (
                    <div style={{
                      fontSize:12, color:'var(--tx-1)', fontFamily:'Manrope', lineHeight:1.5,
                      marginTop:10, padding:'8px 10px',
                      background:'rgba(76,194,255,0.05)', border:'1px solid var(--bd-2)', borderRadius:6,
                    }}>
                      {booking.rating_remarks}
                    </div>
                  )}
                </>
              ) : (
                <div style={{fontSize:11.5, color:'var(--tx-3)'}}>No rating submitted.</div>
              )}
            </div>
          )}

          {data?.team && (data.team.cpos.length > 0 || data.team.vehicle) && (
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar"/>Assigned Team</div>
                <div className="card-header-act">
                  {data.team.cpos.length} CPO · {data.team.vehicle ? '1 vehicle' : 'no vehicle'}
                </div>
              </div>
              <div style={{padding:14, display:'flex', flexDirection:'column', gap:6}}>
                {data.team.cpos.map(c => (
                  <div key={c.id} style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'8px 10px', borderRadius:8,
                    border:'1px solid var(--bd-2)',
                    background:'rgba(74,222,128,0.05)',
                  }}>
                    <div style={{
                      width:8, height:8, borderRadius:4,
                      background:'var(--ok)', boxShadow:'0 0 6px var(--ok)',
                    }}/>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>
                        {c.call_sign} · {c.display_name}
                      </div>
                      <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2}}>
                        {c.role}
                      </div>
                    </div>
                  </div>
                ))}
                {data.team.vehicle && (
                  <div style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'8px 10px', borderRadius:8,
                    border:'1px solid var(--bd-2)',
                    background:'rgba(37,99,235,0.05)',
                  }}>
                    <div style={{
                      width:8, height:8, borderRadius:4,
                      background:'var(--act)', boxShadow:'0 0 6px var(--act)',
                    }}/>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>
                        {data.team.vehicle.call_sign} · {data.team.vehicle.make_model}
                      </div>
                      <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2}}>
                        {data.team.vehicle.armored ? `Armored · ${data.team.vehicle.armor_grade ?? 'B-grade'}` : 'Soft-skin'} · {data.team.vehicle.plate} · cap {data.team.vehicle.capacity}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {current === 'CONFIRMED' && booking && (
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar"/>Team & Dispatch</div>
                <div className="card-header-act">
                  {pickedApps.length}/{booking.cpo_count} applicants · {needsVehicle ? `${pickedVehicle ? '1' : '0'}/1 vehicle` : 'no vehicle'}
                </div>
              </div>
              <div style={{padding:14, display:'flex', flexDirection:'column', gap:14}}>
                <div>
                  <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:8}}>
                    Pick {booking.cpo_count} from applicants — {applicants.length} applied · auto-refresh every 6s
                    <div style={{textTransform:'none', letterSpacing:0.4, fontWeight:400, marginTop:4, color:'var(--tx-3)'}}>
                      The picked lead marks DISPATCH / RECON / PICKUP / DROPOFF from their phone, plus pushes GPS so the auto-checkpoints fire.
                    </div>
                  </div>
                  {applicants.length === 0 ? (
                    <div style={{
                      padding:'14px 12px', borderRadius:8,
                      background:'rgba(255,193,7,0.06)',
                      border:'1px solid rgba(255,193,7,0.3)',
                      fontSize:11.5, color:'var(--tx-2)', lineHeight:1.5,
                    }}>
                      No agents have applied yet. The job is published to the agent feed —
                      this list updates automatically as applications arrive.
                    </div>
                  ) : (
                    <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:280, overflow:'auto'}}>
                      {applicants.map(a => {
                        const on = pickedApps.includes(a.id);
                        const isLead = pickedLead === a.id || (!pickedLead && on && pickedApps[0] === a.id);
                        return (
                          <div
                            key={a.id}
                            style={{
                              display:'flex', alignItems:'center', gap:10,
                              padding:'8px 10px', borderRadius:8,
                              border:'1px solid', borderColor: isLead ? 'var(--act)' : on ? 'var(--ok)' : 'var(--bd-2)',
                              background: isLead ? 'rgba(91,141,239,0.08)' : on ? 'rgba(74,222,128,0.08)' : 'transparent',
                            }}>
                            <button
                              type="button"
                              onClick={() => toggleApplicant(a.id)}
                              title={on ? 'Remove from team' : 'Add to team'}
                              style={{
                                width:18, height:18, borderRadius:4, padding:0,
                                border:'1px solid', borderColor: on ? 'var(--ok)' : 'var(--bd-2)',
                                background: on ? 'var(--ok)' : 'transparent',
                                color:'#000', fontSize:11, fontWeight:800, textAlign:'center', lineHeight:'16px',
                                cursor:'pointer',
                              }}>{on ? '✓' : ''}</button>
                            <div style={{flex:1, minWidth:0}}>
                              <div style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>
                                {a.agent_call_sign} · {a.display_name ?? 'Agent'}
                              </div>
                              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2}}>
                                Tier {a.tier} · {a.jobs_total} jobs · ★ {a.rating ?? 'n/a'} · applied {fmtAppliedAt(a.applied_at)}
                              </div>
                              {a.dress_pledge && (
                                <div title={a.dress_pledge}
                                     style={{
                                       fontFamily:'Manrope', fontSize:11, color:'var(--tx-2)', marginTop:4,
                                       paddingLeft:8, borderLeft:'2px solid var(--act)',
                                       overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                                     }}>
                                  <span style={{color:'var(--tx-3)', fontFamily:'JetBrains Mono', fontSize:9, letterSpacing:1, marginRight:6}}>WILL WEAR</span>
                                  {a.dress_pledge}
                                </div>
                              )}
                            </div>
                            {on && (
                              <button
                                type="button"
                                onClick={() => setPickedLead(pickedLead === a.id ? '' : a.id)}
                                title={isLead ? 'Lead' : 'Set as lead'}
                                style={{
                                  fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:800, letterSpacing:1.2,
                                  padding:'4px 8px', borderRadius:6,
                                  border:'1px solid', borderColor: isLead ? 'var(--act)' : 'var(--bd-2)',
                                  background: isLead ? 'var(--act)' : 'transparent',
                                  color: isLead ? '#fff' : 'var(--tx-3)',
                                  cursor:'pointer', flexShrink:0,
                                }}>
                                {isLead ? '★ LEAD' : 'MAKE LEAD'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:8}}>
                    {needsVehicle ? `Pick a vehicle — ${vehiclePool.length} available` : 'Vehicle'}
                  </div>
                  {!needsVehicle ? (
                    <div style={{
                      padding:'12px 12px', borderRadius:8,
                      background:'rgba(74,222,128,0.05)', border:'1px solid var(--bd-2)',
                      fontSize:11.5, color:'var(--tx-2)', lineHeight:1.5,
                    }}>
                      No vehicle required — {booking.driver_only
                        ? 'driver-only booking (client supplies the vehicle).'
                        : 'protection-only detail (no vehicles priced).'}
                    </div>
                  ) : vehiclePool.length === 0 ? (
                    <div style={{fontSize:11.5, color:'var(--tx-3)'}}>No vehicles available in this region.</div>
                  ) : (
                    <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:200, overflow:'auto'}}>
                      {vehiclePool.map(v => {
                        const on = pickedVehicle === v.id;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => setPickedVehicle(on ? '' : v.id)}
                            style={{
                              display:'flex', alignItems:'center', gap:10,
                              padding:'8px 10px', borderRadius:8, textAlign:'left',
                              border:'1px solid', borderColor: on ? 'var(--act)' : 'var(--bd-2)',
                              background: on ? 'rgba(37,99,235,0.08)' : 'transparent',
                              cursor:'pointer',
                            }}>
                            <div style={{
                              width:18, height:18, borderRadius:9,
                              border:'1px solid', borderColor: on ? 'var(--act)' : 'var(--bd-2)',
                              background: on ? 'var(--act)' : 'transparent',
                            }}/>
                            <div style={{flex:1, minWidth:0}}>
                              <div style={{fontFamily:'Manrope', fontWeight:700, fontSize:12.5, color:'var(--tx-1)'}}>
                                {v.call_sign} · {v.make_model}
                              </div>
                              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', marginTop:2}}>
                                {v.armored ? `Armored · ${v.armor_grade ?? 'B-grade'}` : 'Soft-skin'} · {v.plate} · cap {v.capacity}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:8}}>
                    Dress Instructions <span style={{color:'var(--tx-3)', textTransform:'none', letterSpacing:0.4, fontWeight:400}}>· optional · shown to CPOs before mission</span>
                  </div>
                  <textarea
                    value={dressInstructions}
                    onChange={e => setDressInstructions(e.target.value)}
                    rows={3}
                    placeholder={"e.g. Black suit, white shirt, no tie, earpiece visible.\nPolished black shoes, concealed sidearm only."}
                    style={{
                      width:'100%', resize:'vertical',
                      borderRadius:8, padding:'10px 12px',
                      background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                      color:'var(--tx-1)', fontFamily:'Manrope', fontSize:12.5,
                      lineHeight:1.4, outline:'none',
                    }}
                  />
                </div>

                {(() => {
                  const missingApps = booking.cpo_count - pickedApps.length;
                  const missingVehicle = needsVehicle && !pickedVehicle;
                  const ready = missingApps === 0 && !missingVehicle;
                  return (
                    <>
                      <div style={{
                        display:'flex', alignItems:'center', gap:8,
                        padding:'8px 12px', borderRadius:8,
                        background: ready ? 'rgba(74,222,128,0.08)' : 'rgba(255,193,7,0.08)',
                        border: '1px solid',
                        borderColor: ready ? 'var(--ok)' : 'var(--warn, #FFC107)',
                        fontFamily:'JetBrains Mono', fontSize:11, fontWeight:700,
                        color: ready ? 'var(--ok)' : 'var(--warn, #FFC107)',
                        letterSpacing:0.6,
                      }}>
                        <span>{ready ? '✓' : '!'}</span>
                        <span>
                          {ready
                            ? `READY · ${booking.cpo_count} APPLICANT${needsVehicle ? ' + 1 VEHICLE' : ' · NO VEHICLE NEEDED'} LOCKED`
                            : `NEEDS ${missingApps > 0 ? `${missingApps} more applicant${missingApps === 1 ? '' : 's'}` : ''}${missingApps > 0 && missingVehicle ? ' AND ' : ''}${missingVehicle ? '1 vehicle' : ''}`}
                        </span>
                      </div>
                      {canDispatchBooking(role) ? (
                        <button
                          className="btn btn-ok btn-lg"
                          style={{
                            width:'100%', justifyContent:'center',
                            opacity: ready && !busy ? 1 : 0.4,
                            cursor: ready && !busy ? 'pointer' : 'not-allowed',
                          }}
                          disabled={busy || !ready}
                          onClick={dispatch}>
                          {busy ? 'DISPATCHING…' : 'DISPATCH MISSION → LIVE'}
                        </button>
                      ) : (
                        // Audit fix 4.2 — OPS-tier admins can shortlist/sort
                        // but cannot land the dispatch transition.
                        <div style={{padding:'10px 12px', borderRadius:8, background:'var(--surf-3)', border:'1px solid var(--bd-2)', fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)', letterSpacing:0.4, textAlign:'center'}}>
                          DISPATCH REQUIRES SUPERVISOR / ADMIN
                        </div>
                      )}
                    </>
                  );
                })()}
                <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:0.5, lineHeight:1.5}}>
                  Dispatch locks the chosen units to this booking and flips the
                  state to <b style={{color:'var(--tx-2)'}}>LIVE</b>. Client app
                  begins live tracking immediately.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {payoutModalOpen && payoutMeta && (
        <div
          onClick={() => !busy && setPayoutModalOpen(false)}
          style={{
            position:'fixed', inset:0, background:'rgba(4,16,31,0.7)',
            zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(4px)',
          }}>
          <div
            onClick={e => e.stopPropagation()}
            className="card"
            style={{
              width:'min(640px, 92vw)', maxHeight:'88vh', overflow:'auto',
              padding:0, border:'1px solid var(--act)',
              boxShadow:'0 24px 60px rgba(0,0,0,0.5)',
            }}>
            <div style={{padding:'16px 20px', borderBottom:'1px solid var(--bd-2)'}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:1.5, fontWeight:700}}>
                BRAVO · PAYOUT REVIEW
              </div>
              <div style={{fontFamily:'Manrope', fontSize:18, fontWeight:800, marginTop:4}}>
                Approve payouts before completing mission
              </div>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)', marginTop:6, lineHeight:1.5}}>
                Default is even split. Reduce a CPO&apos;s amount only if they
                were unresponsive or didn&apos;t meet standards — a written reason
                is required for every deduction. Deducted credits stay with the
                platform.
              </div>
            </div>

            <div style={{padding:'14px 20px', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, borderBottom:'1px solid var(--bd-2)', background:'rgba(91,141,239,0.04)'}}>
              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700}}>ESCROW</div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:14, color:'var(--acc)', fontWeight:800, marginTop:2}}>
                  {payoutMeta.escrow} BC
                </div>
              </div>
              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700}}>EVEN SPLIT</div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:14, color:'var(--tx-1)', fontWeight:800, marginTop:2}}>
                  {payoutMeta.even} BC × {payoutDrafts.length}
                </div>
              </div>
              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700}}>PLATFORM REMAINDER</div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:14, color:'var(--tx-2)', fontWeight:800, marginTop:2}}>
                  {payoutMeta.remainder} BC
                </div>
              </div>
            </div>

            <div style={{padding:'12px 20px', display:'flex', flexDirection:'column', gap:10}}>
              {payoutDrafts.map(d => {
                const deducted = d.proposed - d.paid;
                return (
                  <div key={d.user_id} style={{
                    border:'1px solid', borderColor: deducted > 0 ? 'var(--err)' : 'var(--bd-2)',
                    borderRadius:8, padding:12,
                    background: deducted > 0 ? 'rgba(220,38,38,0.05)' : 'transparent',
                  }}>
                    <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:8}}>
                      <div style={{
                        width:34,height:34,borderRadius:8,
                        background:'linear-gradient(135deg,var(--act-dim),var(--act))',
                        color:'#fff',fontFamily:'Manrope',fontWeight:800,fontSize:11,
                        display:'flex',alignItems:'center',justifyContent:'center',
                      }}>
                        {d.call_sign.slice(-2)}
                      </div>
                      <div style={{flex:1, minWidth:0}}>
                        <div style={{fontFamily:'Manrope',fontWeight:800,fontSize:13,color:'var(--tx-1)'}}>
                          {d.call_sign} · {d.display_name}
                        </div>
                        <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginTop:2}}>
                          Proposed: {d.proposed} BC
                        </div>
                      </div>
                    </div>
                    <div className="payout-grid">
                      <div>
                        <div style={{fontFamily:'JetBrains Mono', fontSize:8.5, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700, marginBottom:4}}>PAYOUT (BC)</div>
                        <input
                          type="number"
                          min={0} max={d.proposed} step={1}
                          value={d.paid}
                          onChange={e => updatePayout(d.user_id, {paid: Math.max(0, Math.min(d.proposed, Math.floor(Number(e.target.value) || 0)))})}
                          style={{
                            width:'100%', height:32, borderRadius:6,
                            background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                            padding:'0 10px', color:'var(--tx-1)',
                            fontFamily:'JetBrains Mono', fontSize:13, fontWeight:700, outline:'none',
                          }}
                        />
                      </div>
                      <div>
                        <div style={{fontFamily:'JetBrains Mono', fontSize:8.5, color: deducted > 0 ? 'var(--err)' : 'var(--tx-3)', letterSpacing:1.2, fontWeight:700, marginBottom:4}}>
                          {deducted > 0 ? `DEDUCTION REASON · REQUIRED (-${deducted} BC)` : 'DEDUCTION REASON · OPTIONAL'}
                        </div>
                        <input
                          type="text"
                          value={d.reason}
                          onChange={e => updatePayout(d.user_id, {reason: e.target.value})}
                          placeholder={deducted > 0 ? 'e.g. Late arrival, unresponsive on comms' : '—'}
                          disabled={deducted === 0}
                          style={{
                            width:'100%', height:32, borderRadius:6,
                            background: deducted > 0 ? 'var(--surf-3)' : 'transparent',
                            border:'1px solid', borderColor: deducted > 0 && !d.reason.trim() ? 'var(--err)' : 'var(--bd-2)',
                            padding:'0 10px', color:'var(--tx-1)',
                            fontFamily:'Manrope', fontSize:12, outline:'none',
                          }}
                        />
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontFamily:'JetBrains Mono', fontSize:8.5, color:'var(--tx-3)', letterSpacing:1.2, fontWeight:700}}>NET</div>
                        <div style={{fontFamily:'JetBrains Mono', fontSize:14, color: deducted > 0 ? 'var(--err)' : 'var(--ok)', fontWeight:800, marginTop:4}}>
                          {d.paid} BC
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{padding:'14px 20px', borderTop:'1px solid var(--bd-2)', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, alignItems:'center', background:'var(--surf-2)'}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:11, color:'var(--tx-2)', lineHeight:1.6}}>
                <div>TOTAL PAYOUT  <b style={{color:'var(--ok)', marginLeft:6}}>{totalPaid} BC</b></div>
                <div>DEDUCTED       <b style={{color: totalDeducted > 0 ? 'var(--err)' : 'var(--tx-3)', marginLeft:6}}>{totalDeducted} BC</b></div>
                <div>PLATFORM       <b style={{color:'var(--tx-1)', marginLeft:6}}>{payoutMeta.escrow - totalPaid} BC</b></div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
                <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => setPayoutModalOpen(false)}>
                  CANCEL
                </button>
                <button className="btn btn-ok btn-lg" disabled={busy} onClick={submitPayouts}>
                  {busy ? 'CLOSING…' : 'CONFIRM & CLOSE'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {approveOpen && (
        <div
          onClick={() => !busy && setApproveOpen(false)}
          style={{
            position:'fixed', inset:0, background:'rgba(4,16,31,0.7)',
            zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(4px)',
          }}>
          <div
            onClick={e => e.stopPropagation()}
            className="card"
            style={{
              width:'min(560px, 92vw)', maxHeight:'88vh', overflow:'auto',
              padding:0, border:'1px solid var(--act)',
              boxShadow:'0 24px 60px rgba(0,0,0,0.5)',
            }}>
            <div style={{padding:'16px 20px', borderBottom:'1px solid var(--bd-2)'}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--tx-3)', letterSpacing:1.5, fontWeight:700}}>
                BRAVO · PUBLISH TO AGENT FEED
              </div>
              <div style={{fontFamily:'Manrope', fontSize:18, fontWeight:800, marginTop:4}}>
                Set the dress brief
              </div>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)', marginTop:6, lineHeight:1.5}}>
                Required. Agents read this on the apply sheet and pledge what they&apos;ll wear.
                The pledge is audited on this booking.
              </div>
            </div>

            <div style={{padding:'14px 20px', display:'grid', gap:12}}>
              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:8}}>
                  Quick presets
                </div>
                <div style={{display:'flex', flexWrap:'wrap', gap:6}}>
                  {[
                    'Black suit, white shirt, black tie. Earpiece concealed.',
                    'Smart casual — dark jacket, no tie. Plainclothes blend-in.',
                    'Tactical kit — plate carrier optional, dark cargo trousers, boots.',
                    'High-vis driver attire — uniform shirt, polished shoes.',
                  ].map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setApproveDress(p)}
                      style={{
                        fontFamily:'Manrope', fontSize:11.5, color:'var(--tx-2)',
                        padding:'6px 10px', borderRadius:99,
                        border:'1px solid var(--bd-2)', background:'var(--surf-3)',
                        cursor:'pointer',
                      }}>
                      {p.split('.')[0]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:6}}>
                  Dress instructions
                </div>
                <textarea
                  value={approveDress}
                  onChange={e => setApproveDress(e.target.value)}
                  rows={4}
                  placeholder="Describe what each CPO must wear. Be specific."
                  autoFocus
                  style={{
                    width:'100%', resize:'vertical',
                    borderRadius:8, padding:'10px 12px',
                    background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                    color:'var(--tx-1)', fontFamily:'Manrope', fontSize:13, lineHeight:1.5,
                  }}
                />
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)', marginTop:6}}>
                  {approveDress.trim().length} chars · min 8 to publish
                </div>
              </div>

              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:6}}>
                  Approval notes <span style={{textTransform:'none', letterSpacing:0.4, fontWeight:400}}>· optional · audit only</span>
                </div>
                <input
                  value={approveNotes}
                  onChange={e => setApproveNotes(e.target.value)}
                  placeholder="e.g. Verified client identity via passport scan."
                  style={{
                    width:'100%',
                    borderRadius:8, padding:'9px 12px',
                    background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                    color:'var(--tx-1)', fontFamily:'Manrope', fontSize:12.5,
                  }}
                />
              </div>

              {err && (
                <div style={{fontFamily:'JetBrains Mono', fontSize:11, color:'var(--err, #F87171)'}}>
                  {err}
                </div>
              )}
            </div>

            <div style={{padding:'12px 20px', borderTop:'1px solid var(--bd-2)', display:'flex', gap:10, justifyContent:'flex-end'}}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setApproveOpen(false)}>
                CANCEL
              </button>
              <button
                className="btn btn-ok btn-lg"
                disabled={busy || approveDress.trim().length < 8}
                onClick={confirmApprove}>
                {busy ? 'PUBLISHING…' : 'CONFIRM & PUBLISH'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit fix 4.4 — reject modal replaces the legacy window.prompt.
          Reason is required (min 8 chars) and goes into ops_audit; notes
          are optional. ESC / backdrop click cancels unless busy. */}
      {rejectOpen && (
        <div
          onClick={() => !busy && setRejectOpen(false)}
          style={{
            position:'fixed', inset:0, background:'rgba(4,16,31,0.7)',
            zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(4px)',
          }}>
          <div
            onClick={e => e.stopPropagation()}
            className="card"
            style={{
              width:'min(520px, 92vw)', maxHeight:'88vh', overflow:'auto',
              padding:0, border:'1px solid var(--err, #F87171)',
              boxShadow:'0 24px 60px rgba(0,0,0,0.5)',
            }}>
            <div style={{padding:'16px 20px', borderBottom:'1px solid var(--bd-2)'}}>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--err, #F87171)', letterSpacing:1.5, fontWeight:700}}>
                BRAVO · REJECT BOOKING
              </div>
              <div style={{fontFamily:'Manrope', fontSize:18, fontWeight:800, marginTop:4}}>
                Reason for rejection
              </div>
              <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-3)', marginTop:6, lineHeight:1.5}}>
                Required. The client sees a system message with this reason;
                ops audit captures the full row.
              </div>
            </div>

            <div style={{padding:'14px 20px', display:'grid', gap:12}}>
              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:6}}>
                  Reason
                </div>
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Pickup outside coverage zone; client unverified."
                  autoFocus
                  maxLength={1024}
                  style={{
                    width:'100%', resize:'vertical',
                    borderRadius:8, padding:'10px 12px',
                    background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                    color:'var(--tx-1)', fontFamily:'Manrope', fontSize:13, lineHeight:1.5,
                  }}
                />
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)', marginTop:6}}>
                  {rejectReason.trim().length} chars · min 8 to reject
                </div>
              </div>

              <div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, fontWeight:700, color:'var(--tx-3)', letterSpacing:1.3, textTransform:'uppercase', marginBottom:6}}>
                  Internal notes <span style={{textTransform:'none', letterSpacing:0.4, fontWeight:400}}>· optional · audit only</span>
                </div>
                <input
                  value={rejectNotes}
                  onChange={e => setRejectNotes(e.target.value)}
                  placeholder="e.g. Will reach out via phone; client agreed to resubmit."
                  maxLength={1024}
                  style={{
                    width:'100%',
                    borderRadius:8, padding:'9px 12px',
                    background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                    color:'var(--tx-1)', fontFamily:'Manrope', fontSize:12.5,
                  }}
                />
              </div>

              {err && (
                <div style={{fontFamily:'JetBrains Mono', fontSize:11, color:'var(--err, #F87171)'}}>
                  {err}
                </div>
              )}
            </div>

            <div style={{padding:'12px 20px', borderTop:'1px solid var(--bd-2)', display:'flex', gap:10, justifyContent:'flex-end'}}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRejectOpen(false)}>
                CANCEL
              </button>
              <button
                className="btn btn-danger btn-lg"
                disabled={busy || rejectReason.trim().length < 8}
                onClick={confirmReject}>
                {busy ? 'REJECTING…' : 'CONFIRM REJECT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function fmtAppliedAt(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return formatDateTimeShortUtc(d);  // Audit PAGE-09 — UTC, not viewer-local
}

function Row({k, v}: {k: string; v: string}) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', padding:'7px 0', fontSize:12, color:'var(--tx-2)'}}>
      <span>{k}</span>
      <span style={{fontFamily:'JetBrains Mono', color:'var(--tx-1)', fontWeight:600}}>{v}</span>
    </div>
  );
}

function RowTotal({v}: {v: string}) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', padding:'12px 0 4px', borderTop:'1px solid var(--bd-2)', marginTop:8, fontSize:14, fontWeight:700}}>
      <span style={{color:'var(--tx-1)'}}>TOTAL</span>
      <span style={{fontFamily:'JetBrains Mono', color:'var(--acc)', fontSize:20, fontWeight:800}}>{v}</span>
    </div>
  );
}

function pillTone(s: BookingStatus): 'ok' | 'warn' | 'info' | 'err' | 'act' {
  if (s === 'CONFIRMED' || s === 'COMPLETED') return 'ok';
  if (s === 'CANCELLED' || s === 'AGENCY_NO_SHOW') return 'err';
  if (s === 'LIVE')      return 'act';
  if (s === 'OPS_APPROVED' || s === 'DISPATCHING') return 'info';
  return 'warn';
}

function formatAddOns(
  addOns: Array<string | {id: string; label?: string}>,
  breakdown?: PriceBreakdown | null,
): string {
  if (!Array.isArray(addOns) || addOns.length === 0) return 'None';
  const labels: Record<string, string> = {
    female_cpo: 'Female CPO Team',
    recon: 'Recon Team',
    medical: 'Medical Support',
    comms: 'Comms / SIGINT',
  };
  // IS-07 — when the server sent the price composition, each add-on carries
  // its per-hour rate right next to its name.
  const priceById = new Map((breakdown?.items ?? []).map(it => [it.id, it.rate_eur]));
  return addOns
    .map(a => {
      const addOnId = typeof a === 'string' ? a : a.id;
      const label = typeof a === 'string'
        ? (labels[a] ?? a)
        : (a.label ?? labels[a.id] ?? a.id);
      const rate = priceById.get(addOnId);
      return rate != null ? `${label} (${rate} BC/hr)` : label;
    })
    .join(' · ');
}
