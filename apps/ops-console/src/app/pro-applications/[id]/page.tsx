'use client';

/**
 * Pro application detail — review the requirements, keep internal notes,
 * converse with the client (revision thread), and answer with a versioned
 * proposal (monthly Bravo Credits, included services, assigned team, terms)
 * or a rejection. Decisions mirror backend @RequireRoles(SUPERVISOR, ADMIN).
 */
import {useParams, useRouter} from 'next/navigation';
import Link from 'next/link';
import {useEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {Shell} from '@/components/Shell';
import {CopyId} from '@/components/CopyId';
import {
  ApiError, proAppsApi, proFleetApi, proMgmtApi, useOpsMe, useProApplication,
  useProApplicationResources, useProApplicationVehicles, useProFleet, useProResources,
  type CreateProProposalBody, type ProMissionRecord, type ProPoolCpo,
} from '@/lib/api';
import {canDecideProApplication} from '@/lib/rbac';
import {
  PRO_SERVICE_CATALOG, durationLabel, intendedUseLabel, proStatusTone, serviceLabel,
} from '@/lib/proapps';
import {formatDateTimeShortUtc, formatDateUtc} from '@/lib/datetime';

const inputStyle: CSSProperties = {
  height: 38, borderRadius: 8, background: 'var(--surf-3)',
  border: '1px solid var(--bd-2)', padding: '0 12px', color: 'var(--tx-1)',
  fontFamily: 'Manrope', fontSize: 13, outline: 'none', width: '100%',
};
const labelStyle: CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: 1.2,
  color: 'var(--tx-3)', fontWeight: 700, textTransform: 'uppercase',
  display: 'block', marginBottom: 6,
};

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  // CA-12 — clamp to the target month's last day: setUTCMonth on Jan 31
  // overflowed +1mo into Mar 3, silently over-promising coverage.
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

function plusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface TeamRow { role: string; count: string; label: string }

export default function ProApplicationDetailPage() {
  const params = useParams<{id: string}>();
  const id = params?.id ?? null;
  const router = useRouter();
  const {data, error, mutate, isLoading} = useProApplication(id);
  const {data: me} = useOpsMe();
  const role = me?.admin?.role;
  const canDecide = canDecideProApplication(role);

  const app = data?.application;
  const latestProposal = data?.proposals?.[0] ?? null;

  // Issue 30 — protection resources (assigned vehicles + resources) + catalogs
  // for the assign pickers. Catalogs default to active-only (server-filtered).
  const {data: vehData, mutate: mutateVeh} = useProApplicationVehicles(id);
  const {data: resAsgData, mutate: mutateResAsg} = useProApplicationResources(id);
  const {data: fleetCatalog} = useProFleet();
  const {data: resourceCatalog} = useProResources();

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Internal notes (any admin).
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  // IS-20 — unsaved internal notes survive a logout/navigation too.
  const notesKey = id ? `proNotes:${id}` : null;
  const notesRestored = useRef(false);
  // Thread reply.
  const [reply, setReply] = useState('');
  // Reject modal.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // Cancel modal (withdrawal on the client's behalf — optional note).
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  // Mission schedule/decline modals. Scheduling = picking REAL officers from
  // the availability-checked pool for the request's date window.
  const [msnFor, setMsnFor] = useState<ProMissionRecord | null>(null);
  const [msnPool, setMsnPool] = useState<ProPoolCpo[] | null>(null);
  const [msnPicked, setMsnPicked] = useState<Set<string>>(new Set());
  const [msnNote, setMsnNote] = useState('');
  const [msnDeclineFor, setMsnDeclineFor] = useState<ProMissionRecord | null>(null);
  const [msnDeclineNote, setMsnDeclineNote] = useState('');
  // Proposal builder modal.
  const [propOpen, setPropOpen] = useState(false);
  const [credits, setCredits] = useState('');
  const [validUntil, setValidUntil] = useState(plusDays(7));
  const [covStart, setCovStart] = useState('');
  const [covEnd, setCovEnd] = useState('');
  const [services, setServices] = useState<Set<string>>(new Set());
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [terms, setTerms] = useState('');
  const [note, setNote] = useState('');
  // Issue 30 — assign vehicle/resource modal + release confirm.
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignMode, setAssignMode] = useState<'vehicle' | 'resource'>('vehicle');
  const [assignVehicleId, setAssignVehicleId] = useState('');
  const [assignResourceId, setAssignResourceId] = useState('');
  const [assignQty, setAssignQty] = useState('1');
  const [assignStart, setAssignStart] = useState('');
  const [assignEnd, setAssignEnd] = useState('');
  const [assignNote, setAssignNote] = useState('');
  const [releaseFor, setReleaseFor] = useState<{kind: 'vehicle' | 'resource'; id: string; label: string} | null>(null);

  // IS-20 — proposal drafts survive the modal closing (idle logout, misclick
  // on the backdrop, a navigation away): state mirrors into sessionStorage
  // keyed by application id, restored on reopen, cleared on submit.
  const draftKey = id ? `proDraft:${id}` : null;
  const draftHydrated = useRef(false);

  // Seed the builder from the request whenever it opens — a stored draft wins.
  useEffect(() => {
    if (!propOpen || !app) return;
    const saved = draftKey && typeof window !== 'undefined'
      ? window.sessionStorage.getItem(draftKey) : null;
    if (saved) {
      try {
        const d = JSON.parse(saved) as {
          credits: string; validUntil: string; covStart: string; covEnd: string;
          services: string[]; team: TeamRow[]; terms: string; note: string;
        };
        setCredits(d.credits); setValidUntil(d.validUntil);
        setCovStart(d.covStart); setCovEnd(d.covEnd);
        setServices(new Set(d.services)); setTeam(d.team.length ? d.team : [{role: '', count: '1', label: ''}]);
        setTerms(d.terms); setNote(d.note);
        draftHydrated.current = true;
        return;
      } catch { /* corrupt draft — fall through to a fresh seed */ }
    }
    setCovStart(app.start_date);
    setCovEnd(addMonths(app.start_date, app.duration_months ?? 1));
    setValidUntil(plusDays(7));
    setServices(new Set(app.services.filter(s => s !== 'other')));
    const seed: TeamRow[] = [];
    if (app.cpo_count > 0) seed.push({role: 'Close Protection Officer', count: String(app.cpo_count), label: ''});
    if (app.driver_count > 0) seed.push({role: 'Driver', count: String(app.driver_count), label: ''});
    if (app.support_staff_count > 0) seed.push({role: 'Support Staff', count: String(app.support_staff_count), label: ''});
    setTeam(seed.length ? seed : [{role: '', count: '1', label: ''}]);
    draftHydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propOpen]);

  // Mirror every edit while the builder is open. Hydration gate stops the
  // pre-seed render from clobbering the stored draft before it is read.
  useEffect(() => {
    if (!propOpen) { draftHydrated.current = false; return; }
    if (!draftHydrated.current || !draftKey || typeof window === 'undefined') return;
    window.sessionStorage.setItem(draftKey, JSON.stringify({
      credits, validUntil, covStart, covEnd, services: [...services], team, terms, note,
    }));
  }, [propOpen, draftKey, credits, validUntil, covStart, covEnd, services, team, terms, note]);

  // Internal-notes draft: restore once the application has loaded, then
  // mirror keystrokes; cleared when the save lands (notesDraft → null).
  useEffect(() => {
    if (notesRestored.current || !notesKey || !app || typeof window === 'undefined') return;
    notesRestored.current = true;
    const saved = window.sessionStorage.getItem(notesKey);
    if (saved !== null && saved !== (app.internal_notes ?? '')) setNotesDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesKey, app]);
  useEffect(() => {
    if (!notesRestored.current || !notesKey || typeof window === 'undefined') return;
    if (notesDraft === null) window.sessionStorage.removeItem(notesKey);
    else window.sessionStorage.setItem(notesKey, notesDraft);
  }, [notesKey, notesDraft]);

  const canOfferProposal = app && (app.status === 'PENDING_PROPOSAL' || app.status === 'REVISION_REQUESTED');
  const canReject = app && ['PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED'].includes(app.status);
  // Withdrawal window mirrors the client's own: any pre-activation state.
  const canCancel = app && ['PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED'].includes(app.status);

  const proposalValidation = useMemo(() => {
    const parsed = parseInt(credits, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 'Total Bravo Credits required (≥ 1).';
    if (!covStart || !covEnd) return 'Coverage period required.';
    if (covEnd < covStart) return 'Coverage end is before start.';
    if (!validUntil || validUntil < new Date().toISOString().slice(0, 10)) return 'Valid-until must be in the future.';
    if (!team.some(t => t.role.trim())) return 'At least one team row required.';
    return null;
  }, [credits, covStart, covEnd, validUntil, team]);

  async function submitProposal() {
    if (!id || proposalValidation) return;
    setBusy(true); setErr(null);
    try {
      const body: CreateProProposalBody = {
        total_credits: parseInt(credits, 10),
        valid_until: `${validUntil}T23:59:59.000Z`,
        coverage_start: covStart,
        coverage_end: covEnd,
        included_services: [...services],
        assigned_team: team
          .filter(t => t.role.trim())
          .map(t => ({
            role: t.role.trim(),
            count: Math.max(1, parseInt(t.count, 10) || 1),
            ...(t.label.trim() ? {label: t.label.trim()} : {}),
          })),
        ...(terms.trim() ? {terms: terms.trim()} : {}),
        ...(note.trim() ? {note: note.trim()} : {}),
      };
      await proAppsApi.createProposal(id, body);
      setPropOpen(false);
      setCredits(''); setTerms(''); setNote('');
      // IS-20 — a submitted proposal must not resurrect as a stale draft.
      if (draftKey && typeof window !== 'undefined') window.sessionStorage.removeItem(draftKey);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReject() {
    if (!id || rejectReason.trim().length < 3) {
      setErr('Rejection reason required (min 3 chars).');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await proAppsApi.reject(id, rejectReason.trim());
      setRejectOpen(false);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCancel() {
    if (!id) return;
    setBusy(true); setErr(null);
    try {
      await proAppsApi.cancel(id, cancelNote);
      setCancelOpen(false);
      setCancelNote('');
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    if (!id || notesDraft === null) return;
    setBusy(true); setErr(null);
    try {
      await proAppsApi.setInternalNotes(id, notesDraft);
      setNotesDraft(null);
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openScheduleModal(m: ProMissionRecord) {
    const dates = [...m.mission_dates].sort();
    setMsnFor(m); setMsnPool(null); setMsnPicked(new Set()); setMsnNote(''); setErr(null);
    void proMgmtApi.pool(dates[0], dates[dates.length - 1], id ?? undefined)
      .then(r => setMsnPool([...r.cpos].sort((a, b) => Number(b.dedicated ?? false) - Number(a.dedicated ?? false))))
      .catch(e => { setMsnPool([]); setErr((e as Error).message); });
  }

  async function submitSchedule() {
    if (!id || !msnFor || msnPicked.size === 0) return;
    setBusy(true); setErr(null);
    try {
      await proMgmtApi.scheduleWithCpos(id, msnFor.id, {
        cpo_user_ids: [...msnPicked],
        ...(msnNote.trim() ? {ops_note: msnNote.trim()} : {}),
      });
      setMsnFor(null); setMsnNote('');
      await mutate();
    } catch (e) {
      const apiErr = e as Error & {body?: {conflicts?: Array<{member: string | null; starts_on: string; ends_on: string}>}};
      setErr(apiErr.body?.conflicts?.length
        ? `Officer unavailable — clashes with ${apiErr.body.conflicts.map(c => `${c.member ?? 'a member'} (${c.starts_on} → ${c.ends_on})`).join('; ')}`
        : apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitMissionDecline() {
    if (!id || !msnDeclineFor) return;
    setBusy(true); setErr(null);
    try {
      await proAppsApi.declineMission(id, msnDeclineFor.id, msnDeclineNote.trim() || undefined);
      setMsnDeclineFor(null); setMsnDeclineNote('');
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    // CA-05 — busy guard: Enter in the input could race the in-flight POST
    // (the SEND button was disabled, the keyboard path wasn't).
    if (!id || !reply.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      await proAppsApi.sendMessage(id, reply.trim());
      setReply('');
      await mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Issue 30 — map the server's coded conflicts to plain operator language
  // (NestJS sets the exception message to the code, echoed into ApiError.message).
  function friendlyAssignError(e: unknown): string {
    const code = e instanceof ApiError ? (e.body as {message?: string} | null)?.message : undefined;
    const msg = (e as Error)?.message;
    const c = code ?? msg;
    if (c === 'vehicle_unavailable_overlap') {
      return 'That vehicle is already assigned for those dates. Pick a different vehicle or window.';
    }
    if (c === 'assignment_plan_mismatch') {
      return 'That CPO detail belongs to a different plan — only this plan’s details can be pinned.';
    }
    if (c === 'catalog_row_inactive') {
      return 'That item has been retired and can no longer be assigned.';
    }
    if (c === 'ends_before_starts') {
      return 'The end date is before the start date.';
    }
    return msg ?? 'Assignment failed.';
  }

  function openAssign(mode: 'vehicle' | 'resource') {
    if (!app) return;
    setAssignMode(mode);
    setAssignVehicleId(''); setAssignResourceId(''); setAssignQty('1'); setAssignNote('');
    // Default the window to the plan's coverage (start → start + duration).
    setAssignStart(app.start_date);
    setAssignEnd(addMonths(app.start_date, app.duration_months ?? 1));
    setErr(null);
    setAssignOpen(true);
  }

  async function submitAssign() {
    if (!id) return;
    const picked = assignMode === 'vehicle' ? assignVehicleId : assignResourceId;
    if (!picked) { setErr(`Pick a ${assignMode}.`); return; }
    if (!assignStart || !assignEnd) { setErr('Date window required.'); return; }
    if (assignEnd < assignStart) { setErr('The end date is before the start date.'); return; }
    setBusy(true); setErr(null);
    try {
      if (assignMode === 'vehicle') {
        await proFleetApi.assignVehicle(id, {
          vehicle_id: assignVehicleId, starts_on: assignStart, ends_on: assignEnd,
          ...(assignNote.trim() ? {note: assignNote.trim()} : {}),
        });
        await mutateVeh();
      } else {
        await proFleetApi.assignResource(id, {
          resource_id: assignResourceId, qty: Math.max(1, parseInt(assignQty, 10) || 1),
          starts_on: assignStart, ends_on: assignEnd,
          ...(assignNote.trim() ? {note: assignNote.trim()} : {}),
        });
        await mutateResAsg();
      }
      setAssignOpen(false);
    } catch (e) {
      setErr(friendlyAssignError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitRelease() {
    if (!releaseFor) return;
    setBusy(true); setErr(null);
    try {
      if (releaseFor.kind === 'vehicle') {
        await proFleetApi.releaseVehicle(releaseFor.id);
        await mutateVeh();
      } else {
        await proFleetApi.releaseResource(releaseFor.id);
        await mutateResAsg();
      }
      setReleaseFor(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">
            <button
              onClick={() => router.push('/pro-applications')}
              style={{background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer', padding: 0, font: 'inherit'}}>
              PRO APPLICATIONS
            </button>
            {' '}· DETAIL
          </div>
          <h1 style={{display: 'flex', alignItems: 'center', gap: 12}}>
            {app ? (
              // IS-09 — the applicant identity links through to the user record.
              <Link href={`/users/${app.user_id}`} style={{color: 'inherit', textDecoration: 'none'}} title="Open user record">
                {app.client_name || app.client_email}
              </Link>
            ) : 'Loading…'}
            {app && (
              <span className={`pill pill-${proStatusTone(app.status)}`}>
                ● {app.status.replace(/_/g, ' ')}
              </span>
            )}
            {id && <CopyId value={id} title="Copy application id" />}
          </h1>
        </div>
      </div>

      {err ? (
        <div role="alert" style={{
          background: 'rgba(220,38,38,0.1)', border: '1px solid var(--err)',
          color: '#FFB4B4', borderRadius: 10, padding: '10px 14px',
          fontSize: 12.5, marginBottom: 14,
        }}>
          API ERROR · {err}
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{
          background: 'rgba(220,38,38,0.1)', border: '1px solid var(--err)',
          color: '#FFB4B4', borderRadius: 10, padding: '10px 14px',
          fontSize: 12.5, marginBottom: 14,
        }}>
          LOAD ERROR · {(error as Error).message}
        </div>
      ) : null}

      {!app ? (
        isLoading ? <div className="card" style={{padding: 28, color: 'var(--tx-3)', fontSize: 13}}>Loading…</div> : null
      ) : (
        <div style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 14, alignItems: 'start'}}>

          {/* ── Left: request + timeline + thread ── */}
          <div style={{display: 'grid', gap: 14}}>
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />REQUIREMENTS</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px', fontSize: 12.5}}>
                <Field k="Intended use" v={intendedUseLabel(app)} />
                <Field k="Duration" v={durationLabel(app)} />
                <Field k="Start date" v={formatDateUtc(app.start_date)} />
                <Field k="Coverage area" v={app.coverage_area} />
                <Field k="Team" v={`${app.cpo_count} CPO · ${app.driver_count} Driver · ${app.support_staff_count} Support`} />
                <Field k="Gender preference" v={app.gender_preference.replace(/_/g, ' ')} />
                <Field k="Services" v={app.services.length ? app.services.map(serviceLabel).join(', ') : '—'} full />
                {app.service_other_note ? <Field k="Other service" v={app.service_other_note} full /> : null}
                {app.notes ? <Field k="Client notes" v={app.notes} full /> : null}
                <Field k="Client" v={`${app.client_email}${app.client_phone ? ` · ${app.client_phone}` : ''}`} full />
                <Field k="Submitted" v={formatDateTimeShortUtc(app.submitted_at)} />
                {app.rejected_reason ? <Field k="Rejection reason" v={app.rejected_reason} full /> : null}
              </div>
            </div>

            {/* Timeline */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />TIMELINE</div>
              </div>
              <div style={{padding: '4px 16px 14px'}}>
                {(data?.events ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No events.</div>
                ) : (
                  (data?.events ?? []).map(ev => (
                    <div key={ev.id} className="tl-ev" style={{display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--bd-2)', fontSize: 12}}>
                      <span className="tl-ts" style={{color: 'var(--tx-3)', flexShrink: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5}}>
                        {formatDateTimeShortUtc(ev.created_at)}
                      </span>
                      <span className="tl-who" style={{color: 'var(--acc)', flexShrink: 0, textTransform: 'uppercase', fontSize: 10.5, fontWeight: 700}}>
                        {ev.actor}
                      </span>
                      <span className="tl-msg" style={{color: 'var(--tx-2)', minWidth: 0}}>
                        {ev.message ?? ev.event}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* In-plan mission requests */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />MISSION REQUESTS</div>
                <div className="card-header-act" style={{fontSize: 10.5, color: 'var(--tx-3)'}}>covered by the plan — no charge</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 10}}>
                {(data?.missions ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No requests yet.</div>
                ) : (
                  (data?.missions ?? []).map(m => (
                    <div key={m.id} style={{border: '1px solid var(--bd-2)', borderRadius: 10, padding: '10px 12px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                        <div style={{flex: 1, minWidth: 0, fontWeight: 700, fontSize: 12.5, color: 'var(--tx-1)'}}>
                          {m.mission_dates.length} date{m.mission_dates.length > 1 ? 's' : ''}
                          <span style={{color: 'var(--tx-3)', fontWeight: 400}}>
                            {' '}· by {m.requested_by_name ?? 'client'} · {formatDateTimeShortUtc(m.created_at)}
                          </span>
                        </div>
                        <span className={`pill pill-${m.status === 'SCHEDULED' ? 'ok' : m.status === 'REQUESTED' ? 'warn' : m.status === 'DECLINED' ? 'err' : 'info'}`}>
                          ● {m.status}
                        </span>
                      </div>
                      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8}}>
                        {m.mission_dates.map(d => (
                          <span key={d} style={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--acc)',
                            border: '1px solid var(--bd-2)', borderRadius: 6, padding: '3px 7px',
                          }}>
                            {formatDateUtc(d)}
                          </span>
                        ))}
                      </div>
                      {m.note ? (
                        <div style={{fontSize: 12, color: 'var(--tx-2)', marginTop: 8, fontStyle: 'italic'}}>“{m.note}”</div>
                      ) : null}
                      {m.status === 'SCHEDULED' && m.assigned_team.length > 0 ? (
                        <div style={{fontSize: 11.5, color: 'var(--tx-2)', marginTop: 8}}>
                          {m.assigned_team.map(t => `${t.count}× ${t.role}${t.label ? ` (${t.label})` : ''}`).join(' · ')}
                        </div>
                      ) : null}
                      {m.ops_note ? (
                        <div style={{fontSize: 11.5, color: 'var(--tx-3)', marginTop: 6}}>Note: {m.ops_note}</div>
                      ) : null}
                      {m.status === 'REQUESTED' && canDecide ? (
                        <div style={{display: 'flex', gap: 8, marginTop: 10}}>
                          <button className="btn btn-pri btn-sm" disabled={busy}
                            onClick={() => openScheduleModal(m)}>
                            ASSIGN CPOS →
                          </button>
                          <button className="btn btn-danger btn-sm" disabled={busy}
                            onClick={() => { setMsnDeclineNote(''); setMsnDeclineFor(m); }}>
                            DECLINE
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Protection resources — assigned vehicles + resources (Issue 30) */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />PROTECTION RESOURCES</div>
                {canDecide ? (
                  <div className="card-header-act" style={{display: 'flex', gap: 8}}>
                    <button className="btn btn-sec btn-sm" disabled={busy || !app} onClick={() => openAssign('vehicle')}>+ VEHICLE</button>
                    <button className="btn btn-sec btn-sm" disabled={busy || !app} onClick={() => openAssign('resource')}>+ RESOURCE</button>
                  </div>
                ) : null}
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 14}}>
                {/* Vehicles — plate is the hero field (Issue 30 headline). */}
                <div>
                  <label style={labelStyle}>Vehicles</label>
                  {(vehData?.assignments ?? []).length === 0 ? (
                    <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No vehicle assigned to this plan yet.</div>
                  ) : (
                    <div style={{display: 'grid', gap: 8}}>
                      {(vehData?.assignments ?? []).map(a => (
                        <div key={a.id} style={{border: '1px solid var(--bd-2)', borderRadius: 10, padding: '10px 12px', opacity: a.status === 'ASSIGNED' ? 1 : 0.55}}>
                          <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                            <span style={{
                              fontFamily: 'JetBrains Mono, monospace', fontSize: 13.5, fontWeight: 800,
                              color: 'var(--acc)', border: '1px solid var(--act)', borderRadius: 6,
                              padding: '3px 9px', letterSpacing: 1.5, flexShrink: 0,
                            }}>
                              {a.plate ?? '—'}
                            </span>
                            <div style={{flex: 1, minWidth: 0}}>
                              <div style={{fontWeight: 700, fontSize: 12.5, color: 'var(--tx-1)'}}>
                                {a.call_sign ?? 'Vehicle'}{a.make_model ? ` · ${a.make_model}` : ''}
                              </div>
                              <div style={{fontSize: 10.5, color: 'var(--tx-3)', marginTop: 2}}>
                                {formatDateUtc(a.starts_on)} → {formatDateUtc(a.ends_on)}
                                {a.armored ? ` · Armored${a.armor_grade ? ` ${a.armor_grade}` : ''}` : ''}
                                {a.note ? ` · ${a.note}` : ''}
                              </div>
                            </div>
                            <span className={`pill pill-${a.status === 'ASSIGNED' ? 'ok' : 'warn'}`}>● {a.status}</span>
                            {a.status === 'ASSIGNED' && canDecide ? (
                              <button className="btn btn-danger btn-sm" disabled={busy}
                                onClick={() => setReleaseFor({kind: 'vehicle', id: a.id, label: `${a.call_sign ?? 'vehicle'} (${a.plate ?? '—'})`})}>
                                RELEASE
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Resources — ops sees the identifier (serial); the client does not. */}
                <div>
                  <label style={labelStyle}>Resources</label>
                  {(resAsgData?.assignments ?? []).length === 0 ? (
                    <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No resources assigned to this plan yet.</div>
                  ) : (
                    <div style={{display: 'grid', gap: 8}}>
                      {(resAsgData?.assignments ?? []).map(a => (
                        <div key={a.id} style={{border: '1px solid var(--bd-2)', borderRadius: 10, padding: '10px 12px', opacity: a.status === 'ASSIGNED' ? 1 : 0.55, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                          <span className="pill pill-info" style={{textTransform: 'uppercase', flexShrink: 0}}>{a.kind ?? '—'}</span>
                          <div style={{flex: 1, minWidth: 0}}>
                            <div style={{fontWeight: 700, fontSize: 12.5, color: 'var(--tx-1)'}}>
                              {a.qty > 1 ? `${a.qty}× ` : ''}{a.label ?? 'Resource'}
                            </div>
                            <div style={{fontSize: 10.5, color: 'var(--tx-3)', marginTop: 2}}>
                              {a.identifier ? <span style={{fontFamily: 'JetBrains Mono, monospace'}}>SN {a.identifier} · </span> : null}
                              {formatDateUtc(a.starts_on)} → {formatDateUtc(a.ends_on)}
                              {a.note ? ` · ${a.note}` : ''}
                            </div>
                          </div>
                          <span className={`pill pill-${a.status === 'ASSIGNED' ? 'ok' : 'warn'}`}>● {a.status}</span>
                          {a.status === 'ASSIGNED' && canDecide ? (
                            <button className="btn btn-danger btn-sm" disabled={busy}
                              onClick={() => setReleaseFor({kind: 'resource', id: a.id, label: `${a.qty > 1 ? `${a.qty}× ` : ''}${a.label ?? 'resource'}`})}>
                              RELEASE
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Thread */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />CLIENT THREAD</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 8}}>
                {(data?.messages ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No messages yet.</div>
                ) : (
                  (data?.messages ?? []).map(m => (
                    <div key={m.id} style={{
                      justifySelf: m.sender === 'ops' ? 'end' : 'start',
                      maxWidth: '85%',
                      background: m.sender === 'ops' ? 'rgba(91,141,239,0.12)' : 'var(--surf-3)',
                      border: `1px solid ${m.sender === 'ops' ? 'rgba(91,141,239,0.35)' : 'var(--bd-2)'}`,
                      borderRadius: 10, padding: '8px 12px', fontSize: 12.5, color: 'var(--tx-1)',
                    }}>
                      {m.body}
                      <div style={{fontSize: 9.5, color: 'var(--tx-3)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace'}}>
                        {m.sender.toUpperCase()} · {formatDateTimeShortUtc(m.created_at)}
                      </div>
                    </div>
                  ))
                )}
                <div style={{display: 'flex', gap: 8, marginTop: 4}}>
                  <input
                    style={{...inputStyle, flex: 1}}
                    placeholder="Reply to the client…"
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void sendReply(); }}
                  />
                  <button className="btn btn-sec" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>
                    SEND
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Right: decision + proposals + internal notes ── */}
          <div style={{display: 'grid', gap: 14}}>
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />DECISION</div>
              </div>
              <div style={{padding: '4px 16px 16px', display: 'grid', gap: 10}}>
                {app.status === 'ACTIVE' ? (
                  <div style={{fontSize: 12.5, color: 'var(--ok)'}}>
                    Plan ACTIVE since {app.activated_at ? formatDateTimeShortUtc(app.activated_at) : '—'} ·
                    covered until {(app.covered_until ?? app.current_period_end) ? formatDateUtc((app.covered_until ?? app.current_period_end)!) : '—'}
                  </div>
                ) : app.status === 'ACCEPTED' ? (
                  <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                    Client accepted {latestProposal?.proposal_number ?? 'the proposal'} — awaiting payment & activation.
                  </div>
                ) : app.status === 'EXPIRED' ? (
                  // CA-08 — explicit terminal copy (this fell through to the
                  // "review the requirements" prompt with no possible action).
                  <div style={{fontSize: 12.5, color: 'var(--tx-3)'}}>
                    Coverage ended
                    {(app.covered_until ?? app.current_period_end)
                      ? ` on ${formatDateUtc((app.covered_until ?? app.current_period_end)!)}`
                      : ''} — the client may renew with a fresh application.
                  </div>
                ) : app.status === 'REJECTED' ? (
                  <div style={{fontSize: 12.5, color: 'var(--tx-3)'}}>
                    Application declined
                    {/* IS-02 — WHO decided, resolved to a human identity. */}
                    {app.decided_by ? <> by <b style={{color: 'var(--tx-2)'}}>{app.decided_by_name ?? app.decided_by_email ?? app.decided_by}</b></> : null}
                    {app.decided_at ? ` · ${formatDateTimeShortUtc(app.decided_at)}` : ''}.
                  </div>
                ) : app.status === 'CANCELLED' ? (
                  <div style={{fontSize: 12.5, color: 'var(--tx-3)'}}>
                    Application cancelled
                    {app.decided_by
                      ? <> on the client&apos;s behalf by <b style={{color: 'var(--tx-2)'}}>{app.decided_by_name ?? app.decided_by_email ?? app.decided_by}</b></>
                      : ' (withdrawn by the client)'}
                    {app.decided_at ? ` · ${formatDateTimeShortUtc(app.decided_at)}` : ''}.
                  </div>
                ) : app.status === 'PROPOSAL_CREATED' ? (
                  <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                    Proposal {latestProposal?.proposal_number} (v{latestProposal?.version}) sent —
                    awaiting the client&apos;s decision.
                  </div>
                ) : (
                  <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                    {app.status === 'REVISION_REQUESTED'
                      ? 'The client asked for changes — read the thread, then send a revised proposal.'
                      : 'New application — review the requirements and answer with a proposal.'}
                  </div>
                )}

                {canDecide ? (
                  <>
                    {canOfferProposal ? (
                      <button className="btn btn-pri btn-lg" disabled={busy} onClick={() => setPropOpen(true)}>
                        {app.status === 'REVISION_REQUESTED' ? 'CREATE REVISED PROPOSAL →' : 'CREATE PROPOSAL →'}
                      </button>
                    ) : null}
                    {canReject ? (
                      <button className="btn btn-danger" disabled={busy} onClick={() => { setErr(null); setRejectOpen(true); }}>
                        REJECT APPLICATION
                      </button>
                    ) : null}
                    {canCancel ? (
                      <button className="btn btn-ghost" disabled={busy} onClick={() => { setErr(null); setCancelOpen(true); }}>
                        CANCEL APPLICATION
                      </button>
                    ) : null}
                  </>
                ) : (canOfferProposal || canReject) ? (
                  <div style={{fontSize: 11.5, color: 'var(--tx-3)', border: '1px dashed var(--bd-2)', borderRadius: 8, padding: '10px 12px'}}>
                    READ-ONLY · Decision actions require SUPERVISOR or ADMIN.
                  </div>
                ) : null}
              </div>
            </div>

            {/* Proposal history */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />PROPOSALS</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 10}}>
                {(data?.proposals ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>None yet.</div>
                ) : (
                  (data?.proposals ?? []).map(p => (
                    <div key={p.id} style={{border: '1px solid var(--bd-2)', borderRadius: 10, padding: '10px 12px', fontSize: 12}}>
                      <div style={{display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: 700, color: 'var(--tx-1)'}}>
                        <span>{p.proposal_number} · v{p.version}</span>
                        <span style={{color: 'var(--acc)'}}>{Number(p.total_credits).toLocaleString()} BC total</span>
                      </div>
                      <div style={{color: 'var(--tx-3)', marginTop: 4}}>
                        {formatDateUtc(p.coverage_start)} → {formatDateUtc(p.coverage_end)} · valid until {formatDateUtc(p.valid_until)}
                      </div>
                      <div style={{color: 'var(--tx-2)', marginTop: 4}}>
                        {p.included_services.map(serviceLabel).join(', ') || '—'}
                      </div>
                      <div style={{color: 'var(--tx-3)', marginTop: 4}}>
                        {p.assigned_team.map(t => `${t.count}× ${t.role}`).join(' · ') || '—'}
                      </div>
                      {/* IS-17 — the client-visible terms were write-only for ops. */}
                      {p.terms ? (
                        <details style={{marginTop: 6}}>
                          <summary style={{cursor: 'pointer', color: 'var(--acc)', fontSize: 11}}>Terms</summary>
                          <div style={{color: 'var(--tx-2)', marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.45}}>
                            {p.terms}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* SK-07/IS-03 — linked family members riding (or held off) this plan. */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />LINKED MEMBERS</div>
                <div className="card-header-act" style={{fontSize: 10.5, color: 'var(--tx-3)'}}>ride the owner&apos;s plan unless held</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 8}}>
                {(data?.family ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No linked members.</div>
                ) : (
                  (data?.family ?? []).map(m => {
                    const held = !!m.held_until && new Date(m.held_until).getTime() > Date.now();
                    return (
                      <div key={m.id} style={{border: '1px solid var(--bd-2)', borderRadius: 10, padding: '9px 12px'}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                          <span style={{fontWeight: 700, fontSize: 12.5, color: 'var(--tx-1)', minWidth: 0}}>
                            {m.member_name ?? m.member_email ?? 'Member'}
                          </span>
                          {m.relationship ? (
                            <span style={{fontSize: 10.5, color: 'var(--tx-3)', textTransform: 'capitalize'}}>{m.relationship}</span>
                          ) : null}
                          <span className={`pill pill-${m.status === 'active' ? (held ? 'warn' : 'ok') : 'info'}`} style={{marginLeft: 'auto'}}>
                            ● {m.status === 'active' ? (held ? 'ON HOLD' : 'ACTIVE') : 'PENDING'}
                          </span>
                        </div>
                        {held ? (
                          <div style={{fontSize: 11, color: 'var(--warn)', marginTop: 5}}>
                            Held until {formatDateTimeShortUtc(m.held_until!)} — no owner credits, no plan access.
                          </div>
                        ) : null}
                        <div style={{fontSize: 10.5, color: 'var(--tx-3)', marginTop: 5, fontFamily: 'JetBrains Mono, monospace'}}>
                          {m.spent_credits.toLocaleString()}
                          {m.spend_limit_credits != null ? ` / ${m.spend_limit_credits.toLocaleString()}` : ''} BC spent
                          {m.accepted_at ? ` · joined ${formatDateUtc(m.accepted_at)}` : ` · invited ${formatDateUtc(m.invited_at)}`}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Client history — every application this client ever made. */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />CLIENT HISTORY</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 8}}>
                {(data?.history ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>First application from this client.</div>
                ) : (
                  (data?.history ?? []).map(h => (
                    <button
                      key={h.id}
                      onClick={() => router.push(`/pro-applications/${h.id}`)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                        background: 'none', border: '1px solid var(--bd-2)', borderRadius: 10,
                        padding: '9px 12px', cursor: 'pointer', textAlign: 'left', font: 'inherit',
                      }}>
                      <div style={{flex: 1, minWidth: 0, fontSize: 12, color: 'var(--tx-1)'}}>
                        {intendedUseLabel({intended_use: h.intended_use, intended_use_note: null})}
                        <div style={{fontSize: 10.5, color: 'var(--tx-3)', marginTop: 2}}>
                          {h.coverage_start && h.coverage_end
                            ? `${formatDateUtc(h.coverage_start)} → ${formatDateUtc(h.coverage_end)}`
                            : `Submitted ${formatDateTimeShortUtc(h.submitted_at)}`}
                          {h.total_credits ? ` · ${Number(h.total_credits).toLocaleString()} BC` : ''}
                        </div>
                      </div>
                      <span className={`pill pill-${proStatusTone(h.status)}`}>● {h.status.replace(/_/g, ' ')}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Internal notes */}
            <div className="card">
              <div className="card-header">
                <div className="card-header-title"><span className="bar" />INTERNAL NOTES</div>
                <div className="card-header-act" style={{fontSize: 10.5, color: 'var(--tx-3)'}}>never shown to the client</div>
              </div>
              <div style={{padding: '4px 16px 14px', display: 'grid', gap: 8}}>
                <textarea
                  style={{
                    ...inputStyle, height: 'auto', minHeight: 90, resize: 'vertical',
                    padding: '10px 12px', lineHeight: 1.5,
                  }}
                  placeholder="Pricing math, resourcing considerations, client history…"
                  value={notesDraft ?? app.internal_notes ?? ''}
                  onChange={e => setNotesDraft(e.target.value)}
                />
                {notesDraft !== null && notesDraft !== (app.internal_notes ?? '') ? (
                  <button className="btn btn-sec btn-sm" disabled={busy} onClick={() => void saveNotes()}>
                    {busy ? 'SAVING…' : 'SAVE NOTES'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Proposal builder modal ── */}
      {propOpen && app ? (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)',
            backdropFilter: 'blur(4px)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => { if (!busy) setPropOpen(false); }}>
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{width: 'min(680px, 94vw)', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />
                {app.status === 'REVISION_REQUESTED' ? 'REVISED PROPOSAL' : 'CREATE PROPOSAL'}
              </div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 14}}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div>
                  <label style={labelStyle}>Total Bravo Credits — full period *</label>
                  <input style={inputStyle} inputMode="numeric" placeholder="e.g. 450000"
                    value={credits} onChange={e => setCredits(e.target.value.replace(/[^\d]/g, ''))} />
                </div>
                <div>
                  <label style={labelStyle}>Valid until *</label>
                  <input style={inputStyle} type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Coverage start *</label>
                  <input style={inputStyle} type="date" value={covStart} onChange={e => setCovStart(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Coverage end *</label>
                  <input style={inputStyle} type="date" value={covEnd} onChange={e => setCovEnd(e.target.value)} />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Included services</label>
                <div style={{display: 'flex', flexWrap: 'wrap', gap: 8}}>
                  {PRO_SERVICE_CATALOG.map(key => {
                    const on = services.has(key);
                    return (
                      <button
                        key={key}
                        className={`filter-ch${on ? ' on' : ''}`}
                        onClick={() => setServices(prev => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        })}>
                        {serviceLabel(key)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Assigned team</label>
                <div style={{display: 'grid', gap: 8}}>
                  {team.map((t, i) => (
                    <div key={i} style={{display: 'grid', gridTemplateColumns: '1.4fr 72px 1fr 34px', gap: 8}}>
                      <input style={inputStyle} placeholder="Role (e.g. Close Protection Officer)"
                        value={t.role} onChange={e => setTeam(rows => rows.map((r, j) => j === i ? {...r, role: e.target.value} : r))} />
                      <input style={inputStyle} inputMode="numeric" placeholder="#"
                        value={t.count} onChange={e => setTeam(rows => rows.map((r, j) => j === i ? {...r, count: e.target.value.replace(/[^\d]/g, '')} : r))} />
                      <input style={inputStyle} placeholder="Label (optional, e.g. Lead)"
                        value={t.label} onChange={e => setTeam(rows => rows.map((r, j) => j === i ? {...r, label: e.target.value} : r))} />
                      <button className="btn btn-ghost btn-sm" title="Remove row"
                        onClick={() => setTeam(rows => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{justifySelf: 'start'}}
                    onClick={() => setTeam(rows => [...rows, {role: '', count: '1', label: ''}])}>
                    + ADD ROW
                  </button>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Terms (client-visible)</label>
                <textarea
                  style={{...inputStyle, height: 'auto', minHeight: 80, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                  placeholder="Coverage terms, response times, exclusions…"
                  value={terms} onChange={e => setTerms(e.target.value)} />
              </div>

              <div>
                <label style={labelStyle}>Message to client (optional)</label>
                <input style={inputStyle} placeholder="Added to the application thread with the proposal"
                  value={note} onChange={e => setNote(e.target.value)} />
              </div>

              {proposalValidation ? (
                <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{proposalValidation}</div>
              ) : null}

              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setPropOpen(false)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !!proposalValidation} onClick={() => void submitProposal()}>
                  {busy ? 'SENDING…' : 'SEND PROPOSAL →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Mission schedule modal ── */}
      {msnFor ? (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)',
            backdropFilter: 'blur(4px)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => { if (!busy) setMsnFor(null); }}>
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{width: 'min(600px, 94vw)', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ASSIGN OFFICERS</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 14}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                {msnFor.mission_dates.length} date{msnFor.mission_dates.length > 1 ? 's' : ''}:{' '}
                {msnFor.mission_dates.map(formatDateUtc).join(' · ')}
              </div>
              <div>
                <label style={labelStyle}>Available CPOs for this window</label>
                {msnPool === null ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>Checking availability…</div>
                ) : msnPool.length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>
                    No approved CPOs exist yet — create them under Pro Management.
                  </div>
                ) : (
                  <div style={{display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto'}}>
                    {msnPool.map(c => {
                      const blocked = !c.available;
                      const on = msnPicked.has(c.id);
                      return (
                        <button
                          key={c.id}
                          disabled={blocked}
                          onClick={() => setMsnPicked(prev => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                            return next;
                          })}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                            background: on ? 'rgba(91,141,239,0.12)' : 'none',
                            border: `1px solid ${on ? 'var(--act)' : 'var(--bd-2)'}`,
                            borderRadius: 10, padding: '9px 12px', cursor: blocked ? 'not-allowed' : 'pointer',
                            textAlign: 'left', font: 'inherit', opacity: blocked ? 0.5 : 1,
                          }}>
                          <span style={{
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            border: `1.5px solid ${on ? 'var(--act)' : 'var(--bd-2)'}`,
                            background: on ? 'var(--act)' : 'transparent',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff', fontSize: 11, fontWeight: 800,
                          }}>{on ? '✓' : ''}</span>
                          <span style={{flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--tx-1)'}}>
                            {c.display_name}{c.call_sign ? ` · ${c.call_sign}` : ''}
                            <span style={{color: 'var(--tx-3)'}}> — {c.org_name ?? 'no org'}</span>
                          </span>
                          <span className={`pill pill-${c.suspended_now ? 'err' : c.available ? 'ok' : 'warn'}`}>
                            {c.suspended_now ? 'SUSPENDED' : c.dedicated ? 'DEDICATED' : c.available ? 'AVAILABLE' : 'BUSY'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Note to client (optional)</label>
                <input style={inputStyle} placeholder="Shown on the client's request card"
                  value={msnNote} onChange={e => setMsnNote(e.target.value)} />
              </div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setMsnFor(null)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || msnPicked.size === 0} onClick={() => void submitSchedule()}>
                  {busy ? 'ASSIGNING…' : `ASSIGN ${msnPicked.size || ''} CPO${msnPicked.size === 1 ? '' : 'S'} & SCHEDULE →`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Mission decline modal ── */}
      {msnDeclineFor ? (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)',
            backdropFilter: 'blur(4px)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => { if (!busy) setMsnDeclineFor(null); }}>
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{width: 'min(480px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />DECLINE REQUEST</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <textarea
                style={{...inputStyle, height: 'auto', minHeight: 80, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                placeholder="Optional note shown to the client…"
                value={msnDeclineNote} onChange={e => setMsnDeclineNote(e.target.value)} />
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setMsnDeclineFor(null)}>CANCEL</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void submitMissionDecline()}>
                  {busy ? 'DECLINING…' : 'DECLINE →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Reject modal ── */}
      {rejectOpen && app ? (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)',
            backdropFilter: 'blur(4px)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => { if (!busy) setRejectOpen(false); }}>
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{width: 'min(520px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />REJECT APPLICATION</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                The client is notified with this reason. This is terminal — they must submit a
                fresh application afterwards.
              </div>
              <textarea
                style={{...inputStyle, height: 'auto', minHeight: 90, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                placeholder="Reason shown to the client…"
                value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
              <div style={{fontSize: 10.5, color: 'var(--tx-3)'}}>{rejectReason.trim().length} chars · min 3</div>
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setRejectOpen(false)}>CANCEL</button>
                <button className="btn btn-danger" disabled={busy || rejectReason.trim().length < 3} onClick={() => void submitReject()}>
                  {busy ? 'REJECTING…' : 'REJECT →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Cancel modal (withdrawal on the client's behalf) ── */}
      {cancelOpen && app ? (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)',
            backdropFilter: 'blur(4px)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => { if (!busy) setCancelOpen(false); }}>
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{width: 'min(520px, 92vw)', border: '1px solid var(--bd-2)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />CANCEL APPLICATION</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                Withdraws the application on the client&apos;s behalf (e.g. a phone request).
                Terminal — nothing is charged, the client is notified and can re-apply any time.
              </div>
              <textarea
                style={{...inputStyle, height: 'auto', minHeight: 70, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                placeholder="Optional note for the timeline (e.g. client called to withdraw)…"
                value={cancelNote} onChange={e => setCancelNote(e.target.value)} />
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setCancelOpen(false)}>KEEP IT</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void submitCancel()}>
                  {busy ? 'CANCELLING…' : 'CANCEL APPLICATION →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Assign vehicle / resource modal (Issue 30) ── */}
      {assignOpen && app ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setAssignOpen(false); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ASSIGN PROTECTION RESOURCE</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{display: 'flex', gap: 8}}>
                {(['vehicle', 'resource'] as const).map(m => (
                  <button key={m} className={`filter-ch${assignMode === m ? ' on' : ''}`} onClick={() => { setAssignMode(m); setErr(null); }}>
                    {m === 'vehicle' ? 'VEHICLE' : 'RESOURCE'}
                  </button>
                ))}
              </div>

              {assignMode === 'vehicle' ? (
                <div>
                  <label style={labelStyle}>Vehicle *</label>
                  <select style={{...inputStyle, appearance: 'auto'}} value={assignVehicleId} onChange={e => setAssignVehicleId(e.target.value)}>
                    <option value="">Select…</option>
                    {(fleetCatalog?.vehicles ?? []).map(v => (
                      <option key={v.id} value={v.id}>{v.call_sign} · {v.make_model} · {v.plate}</option>
                    ))}
                  </select>
                  {(fleetCatalog?.vehicles ?? []).length === 0 ? (
                    <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 5}}>No active vehicles — add one under Pro Management · Fleet.</div>
                  ) : null}
                </div>
              ) : (
                <div style={{display: 'grid', gridTemplateColumns: '1fr 90px', gap: 12}}>
                  <div>
                    <label style={labelStyle}>Resource *</label>
                    <select style={{...inputStyle, appearance: 'auto'}} value={assignResourceId} onChange={e => setAssignResourceId(e.target.value)}>
                      <option value="">Select…</option>
                      {(resourceCatalog?.resources ?? []).map(r => (
                        <option key={r.id} value={r.id}>{r.kind} · {r.label}{r.identifier ? ` (${r.identifier})` : ''}</option>
                      ))}
                    </select>
                    {(resourceCatalog?.resources ?? []).length === 0 ? (
                      <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 5}}>No active resources — add one under Pro Management · Resources.</div>
                    ) : null}
                  </div>
                  <div>
                    <label style={labelStyle}>Qty *</label>
                    <input style={inputStyle} inputMode="numeric" value={assignQty} onChange={e => setAssignQty(e.target.value.replace(/[^\d]/g, ''))} />
                  </div>
                </div>
              )}

              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div><label style={labelStyle}>Starts *</label>
                  <input style={inputStyle} type="date" value={assignStart} onChange={e => setAssignStart(e.target.value)} /></div>
                <div><label style={labelStyle}>Ends *</label>
                  <input style={inputStyle} type="date" value={assignEnd} onChange={e => setAssignEnd(e.target.value)} /></div>
              </div>
              <div style={{fontSize: 10.5, color: 'var(--tx-3)'}}>Defaults to the plan coverage window — adjust for a shorter detail.</div>

              <div><label style={labelStyle}>Note (optional)</label>
                <input style={inputStyle} value={assignNote} onChange={e => setAssignNote(e.target.value)} placeholder="Instructions for the file…" /></div>

              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAssignOpen(false)}>CANCEL</button>
                <button className="btn btn-pri"
                  disabled={busy || (assignMode === 'vehicle' ? !assignVehicleId : !assignResourceId) || !assignStart || !assignEnd}
                  onClick={() => void submitAssign()}>
                  {busy ? 'ASSIGNING…' : `ASSIGN ${assignMode === 'vehicle' ? 'VEHICLE' : 'RESOURCE'} →`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Release confirm (Issue 30) ── */}
      {releaseFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setReleaseFor(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(460px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />RELEASE {releaseFor.kind === 'vehicle' ? 'VEHICLE' : 'RESOURCE'}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)', lineHeight: 1.5}}>
                Release {releaseFor.label} from this plan? It stops showing on the client&apos;s Assigned-Team screen
                {releaseFor.kind === 'vehicle' ? ' and frees the vehicle for other dates' : ''}.
              </div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setReleaseFor(null)}>KEEP IT</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => void submitRelease()}>
                  {busy ? 'RELEASING…' : 'RELEASE →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  );
}

function Field({k, v, full}: {k: string; v: string; full?: boolean}) {
  return (
    <div style={full ? {gridColumn: '1 / -1'} : undefined}>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: 1.2,
        color: 'var(--tx-3)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3,
      }}>
        {k}
      </div>
      <div style={{color: 'var(--tx-1)', lineHeight: 1.45, overflowWrap: 'anywhere'}}>{v}</div>
    </div>
  );
}
