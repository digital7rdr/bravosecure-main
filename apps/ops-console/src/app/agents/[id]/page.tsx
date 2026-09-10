'use client';

import { use, useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import Link from 'next/link';
import { opsApi, useAgentDetail, useAgentStats, useOpsMe, type AgentDetail, type AgentStats } from '@/lib/api';
import { Redacted } from '@/components/Redacted';
import { canTerminateAgent, canDecideAgent } from '@/lib/rbac';
import { bcFromAed, earningsBc } from '@/lib/bc';
import { formatDateUtc, formatDateTimeUtc } from '@/lib/datetime';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Audit PAGE-11 — reverse-geocode a close-protection agent's position via
// Mapbox (already the console's map provider and a CSP-allowed host)
// instead of streaming raw coordinates to the public OSM/Nominatim
// endpoint. Coordinates are rounded to ~1 km (2 dp) and the effect is
// keyed on the rounded value, so we neither leak a fine-grained location
// trail nor re-fetch on every 2 s GPS poll. (The old Nominatim call also
// set a browser-forbidden User-Agent header and was CSP-blocked dead code.)
function usePlaceName(lat: number | null, lng: number | null): string {
  const [place, setPlace] = useState('');
  const rLat = lat === null ? null : Number(lat.toFixed(2));
  const rLng = lng === null ? null : Number(lng.toFixed(2));
  useEffect(() => {
    if (rLat === null || rLng === null || !MAPBOX_TOKEN) { setPlace(''); return; }
    setPlace('');
    let cancelled = false;
    fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${rLng},${rLat}.json` +
      `?types=place,locality,region,country&limit=1&access_token=${MAPBOX_TOKEN}`,
    )
      .then(r => r.json())
      .then((d: {features?: Array<{place_name?: string}>}) => {
        if (cancelled) return;
        setPlace(d.features?.[0]?.place_name ?? '');
      })
      .catch(() => { if (!cancelled) setPlace(''); });
    return () => { cancelled = true; };
  }, [rLat, rLng]);
  return place;
}

const KYC_LABEL: Record<string, string> = {
  gov_id: 'Gov ID', proof_address: 'Proof of Address',
  sia_licence: 'Security License', police: 'Police / DBS',
};
const KYC_ICON: Record<string, string> = {
  gov_id: 'ID', proof_address: 'PoA', sia_licence: 'SIA', police: 'DBS',
};
const STEP_LABEL: Record<string, string> = {
  submit: '1. Application Submitted', docs: '2. Document Review',
  kyc: '3. KYC Background Check', ops: '4. Ops Team Assessment', partner: '5. Partner Approval',
};
const PILL_BY_STATUS: Record<string, string> = {
  ACTIVE: 'pill-ok', APPROVED: 'pill-info', UNDER_REVIEW: 'pill-warn',
  SUBMITTED: 'pill-warn', DOCS_PENDING: 'pill-warn', KYC_PENDING: 'pill-warn', REJECTED: 'pill-err',
};
const MISSION_COLOR: Record<string, string> = {
  LIVE: 'var(--ok)', DISPATCHED: 'var(--acc)', PICKUP: 'var(--warn)',
  SOS: 'var(--err)', COMPLETED: 'var(--tx-3)', ABORTED: 'var(--err)',
};

// Audit PAGE-09 — render in UTC so an agent-profile timestamp matches the
// same event on the bookings/live pages regardless of operator timezone.
function fmtDate(d: string | null): string {
  return d ? formatDateUtc(d).toUpperCase() : '—';
}
function fmtDateTime(d: string | null): string {
  return d ? formatDateTimeUtc(d).toUpperCase() : '—';
}

function FilePreview({url}: {url: string | null}) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) {
    return <a href={url} target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{fontSize:9}}>VIEW</a>;
  }
  const name = decodeURIComponent(url.split('/').pop() ?? url).replace(/^\d+-?/, '');
  return (
    <span title={name} style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:0.4}}>
      {name.length > 22 ? `${name.slice(0,20)}…` : name}
    </span>
  );
}

function LocationBlock({lat, lng, label, recorded_at, live}: {
  lat: number | null; lng: number | null;
  label: string; recorded_at: string | null; live: boolean;
}) {
  const place = usePlaceName(lat, lng);

  if (lat === null || lng === null) {
    return (
      <div style={{background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8,padding:10,marginTop:4}}>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',marginBottom:4}}>
          {label}
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)'}}>No location data</div>
      </div>
    );
  }
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  return (
    <div style={{background:'var(--surf-3)',border:`1px solid ${live ? 'var(--ok)' : 'var(--bd-2)'}`,borderRadius:8,padding:10,marginTop:4}}>
      {/* Header row */}
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
        <span style={{width:6,height:6,borderRadius:'50%',background:live ? 'var(--ok)' : 'var(--tx-3)',flexShrink:0}}/>
        <span style={{fontFamily:'JetBrains Mono',fontSize:9,color:live ? 'var(--ok)' : 'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',flex:1}}>{label}</span>
        {recorded_at && <span style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)'}}>{fmtDateTime(recorded_at)}</span>}
      </div>
      {/* Place name */}
      {place ? (
        <div style={{fontFamily:'Manrope',fontSize:13,fontWeight:700,color:'var(--tx-1)',marginBottom:4,letterSpacing:0.1}}>
          {place}
        </div>
      ) : (
        <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',marginBottom:4,letterSpacing:0.3}}>Resolving address…</div>
      )}
      {/* Coordinates + map link */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
        <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.4}}>
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </div>
        <a href={mapsUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{fontSize:9,flexShrink:0}}>MAP ↗</a>
      </div>
    </div>
  );
}

// ─── Shared agent profile card (left column) ──────────────────────────────────

function AgentProfileCard({agent, profile, contact}: {
  agent: AgentDetail['agent'];
  profile: AgentDetail['profile'];
  contact: AgentDetail['contact'];
}) {
  const display = agent.display_name ?? contact.email ?? agent.user_id.slice(0,8);
  const callSign = agent.call_sign ?? `AGT-${agent.user_id.slice(0,6).toUpperCase()}`;
  const initials = display.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
  const statusPill = PILL_BY_STATUS[agent.status] ?? '';

  return (
    <div style={{padding:14}}>
      <div style={{width:60,height:60,borderRadius:14,background:'linear-gradient(135deg,var(--act),var(--acc))',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'Manrope',fontSize:20,fontWeight:800,color:'#fff',marginBottom:12}}>{initials}</div>
      <div style={{fontFamily:'Manrope',fontSize:16,fontWeight:800,letterSpacing:0.4}}>{display}</div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:11,color:'var(--acc)',letterSpacing:0.8,marginTop:3,fontWeight:700}}>{callSign} · {agent.type.toUpperCase()}</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:10}}>
        <span className={`pill ${statusPill}`}>● {agent.status.replace(/_/g,' ')}</span>
        {agent.on_duty && <span className="pill pill-ok">ON DUTY</span>}
        {agent.tier > 0 && <span className="pill pill-info">{agent.type.toUpperCase()} · TIER {agent.tier}</span>}
      </div>
      {/* Audit fix 4.2 — Email + Phone behind click-to-reveal. The other
          rows render plain. Subject = the agent's user_id. */}
      <div style={{display:'grid',gridTemplateColumns:'90px 1fr',gap:6,fontSize:11.5,marginTop:14}}>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>Region</div>
        <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-all'}}>
          {profile.coverage?.countries?.filter(c=>c.on).map(c=>c.code).join(' · ') || '—'}
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>Email</div>
        <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-all'}}>
          <Redacted value={contact.email} kind="email" subject={agent.user_id} />
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>Phone</div>
        <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-all'}}>
          <Redacted value={contact.phone} kind="phone" subject={agent.user_id} />
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>Rate</div>
        <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-all'}}>
          {agent.rate_aed_per_hour ? `${bcFromAed(parseFloat(agent.rate_aed_per_hour))} BC/hr` : '—'}
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>Approved</div>
        <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-all'}}>
          {fmtDate(agent.approved_at)}
        </div>
      </div>
    </div>
  );
}

// ─── Operational view — ACTIVE / APPROVED ────────────────────────────────────

function OperationalView({id, data, stats, mutateDetail}: {
  id: string;
  data: AgentDetail;
  stats: AgentStats | null | undefined;
  mutateDetail: () => void;
}) {
  const {agent, profile, contact, kyc, documents, deployment} = data;
  const managedBy = (data as AgentDetail & {managed_by?: ManagedBy}).managed_by ?? null;
  const [termNotes, setTermNotes] = useState('');
  const [termConfirm, setTermConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Audit fix 4.2 — terminate requires SUPERVISOR/ADMIN.
  const {data: me} = useOpsMe();
  const role = me?.admin.role;

  // BC via the canonical platform ratio (350 AED ≡ 86 BC, pricing.service.ts).
  // Audit PAGE-19 — round once at the end, not the per-hour rate first.
  const earningsEst = earningsBc(parseFloat(agent.rate_aed_per_hour ?? '0'), agent.duty_hours_mtd ?? 0);
  const mission = stats?.activeMission ?? null;
  const recent = stats?.recentMissions ?? [];

  const terminate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await opsApi.terminateAgent(id, termNotes || 'Terminated by ops admin');
      await mutateDetail();
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Terminate failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setTermConfirm(false);
    }
  };

  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1.6fr 1fr',gap:16,flex:1,minHeight:0}}>

      {/* Left — profile + KYC */}
      <div className="card" style={{overflow:'auto'}}>
        <AgentProfileCard agent={agent} profile={profile} contact={contact} />
        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>KYC Status</div>
          <div className="card-header-act">{kyc.filter(k=>k.state==='done').length}/{kyc.length}</div>
        </div>
        {kyc.map(row => {
          const colour = row.state==='done' ? 'var(--ok)' : row.state==='failed' ? 'var(--err)' : 'var(--tx-3)';
          return (
            <div key={row.kind} style={{display:'grid',gridTemplateColumns:'28px 1fr auto',padding:'8px 14px',borderBottom:'1px solid var(--bd-2)',alignItems:'center',gap:8}}>
              <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:0.5,textAlign:'center'}}>{KYC_ICON[row.kind]}</div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-2)',letterSpacing:0.5}}>{KYC_LABEL[row.kind]}</div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,fontWeight:700,color:colour}}>{row.state.toUpperCase()}</div>
            </div>
          );
        })}

        {/* Full record — everything the DB holds for the officer */}
        <ProviderCard managedBy={managedBy} />

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>Coverage & Services</div>
          <div className="card-header-act">{(profile.availability?.mode ?? '—').toUpperCase()}</div>
        </div>
        <div style={{padding:'10px 14px 14px',display:'flex',flexDirection:'column',gap:10}}>
          <ChipRow label="COUNTRIES" items={(profile.coverage?.countries ?? []).filter(c=>c.on).map(c=>c.code)} empty="No coverage set" />
          <ChipRow label="SERVICES"  items={(profile.coverage?.services ?? []).filter(s=>s.on).map(s=>s.key.toUpperCase())} empty="No services enabled" />
          <ChipRow label="LOADOUT"   items={(profile.availability?.loadout ?? []).map(l=>l.toUpperCase())} empty="No loadout declared" />
          <ChipRow label="CAPABILITIES" items={profile.capabilities ?? []} empty="None on file" />
        </div>

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>Compliance Pack</div>
          <div className="card-header-act">{documents.filter(d=>d.state==='done').length}/{documents.length}</div>
        </div>
        <div style={{padding:'8px 14px',display:'flex',flexDirection:'column',gap:6}}>
          {documents.map(d => (
            <div key={d.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,color:'var(--tx-1)',fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.title}</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:d.state==='done'?'var(--ok)':'var(--tx-3)',letterSpacing:0.4}}>
                  {d.required?'REQ':'OPT'} · {d.state==='done'?`Uploaded ${fmtDate(d.uploaded_at)}`:d.state.toUpperCase()}
                </div>
              </div>
              {d.file_url && /^https?:\/\//i.test(d.file_url) && (
                <button className="btn btn-sm btn-ghost" style={{fontSize:9,flexShrink:0}}
                  onClick={() => window.open(d.file_url!, '_blank', 'noopener')}>VIEW</button>
              )}
            </div>
          ))}
        </div>

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>Deployment Checks</div>
          <div className="card-header-act">{(deployment ?? []).filter(d=>d.state==='passed').length}/{(deployment ?? []).length}</div>
        </div>
        <div style={{padding:'8px 14px 14px',display:'flex',flexDirection:'column'}}>
          {(deployment ?? []).map(d => (
            <div key={d.check_key} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'7px 2px',borderBottom:'1px solid var(--bd-2)'}}>
              <span style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-2)',letterSpacing:0.8,textTransform:'uppercase'}}>{d.check_key}</span>
              <span style={{fontFamily:'JetBrains Mono',fontSize:9.5,fontWeight:700,
                color:d.state==='passed'?'var(--ok)':d.state==='failed'?'var(--err)':'var(--tx-3)'}}>
                {d.state.toUpperCase()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Middle — current mission + recent missions */}
      <div className="card" style={{overflow:'auto'}}>
        <div className="card-header">
          <div className="card-header-title"><span className="bar"/>Current Mission</div>
          <div className="card-header-act" style={{color: mission ? (MISSION_COLOR[mission.status] ?? 'var(--acc)') : 'var(--tx-3)'}}>
            {mission ? mission.status : 'IDLE'}
          </div>
        </div>

        {mission ? (
          <div style={{padding:14}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
              <div style={{background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8,padding:10}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',marginBottom:4}}>Mission</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:15,color:'var(--acc)',fontWeight:700,letterSpacing:1}}>{mission.short_code}</div>
              </div>
              <div style={{background:'var(--surf-3)',border:`1px solid ${MISSION_COLOR[mission.status]??'var(--bd-2)'}`,borderRadius:8,padding:10}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',marginBottom:4}}>Status</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:15,fontWeight:700,color:MISSION_COLOR[mission.status]??'var(--tx-1)'}}>{mission.status}</div>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'90px 1fr',gap:6,fontSize:11.5}}>
              {([
                ['Risk', mission.risk_level ?? '—'],
                ['Started', fmtDateTime(mission.started_at)],
                ['From', mission.pickup_address ?? '—'],
                ['To', mission.dropoff_address ?? '—'],
              ] as [string,string][]).map(([k,v]) => (
                <div key={k} style={{display:'contents'}}>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase',fontWeight:700,paddingTop:1}}>{k}</div>
                  <div style={{color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:500,wordBreak:'break-word',fontSize:11.5}}>{v}</div>
                </div>
              ))}
            </div>
            {/* Live location inside active mission */}
            <LocationBlock
              lat={mission.current_lat} lng={mission.current_lng}
              label="Live Location" recorded_at={null} live
            />
          </div>
        ) : (
          <div style={{padding:'20px 14px 14px'}}>
            <div style={{textAlign:'center',padding:'12px 0 16px'}}>
              <div style={{fontFamily:'JetBrains Mono',fontSize:28,color:'var(--tx-3)',letterSpacing:2,marginBottom:8}}>◎</div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:1.2}}>
                {agent.on_duty ? 'ON DUTY · AWAITING DISPATCH' : 'IDLE · NOT ON DUTY'}
              </div>
            </div>
            {/* Last known location when idle */}
            <LocationBlock
              lat={stats?.lastLocation?.lat ?? null}
              lng={stats?.lastLocation?.lng ?? null}
              label="Last Known Location"
              recorded_at={stats?.lastLocation?.recorded_at ?? null}
              live={false}
            />
          </div>
        )}

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)',marginTop:4}}>
          <div className="card-header-title"><span className="bar"/>Recent Jobs</div>
          <div className="card-header-act">{recent.length > 0 ? recent.length : '—'}</div>
        </div>

        {recent.length === 0 ? (
          <div style={{padding:'12px 14px',fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.5}}>No missions on record</div>
        ) : (
          <div style={{padding:'8px 14px',display:'flex',flexDirection:'column',gap:6}}>
            {recent.map(m => (
              <div key={m.id} style={{display:'grid',gridTemplateColumns:'auto 1fr auto',gap:10,padding:'8px 10px',background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8,alignItems:'center'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--acc)',fontWeight:700,letterSpacing:0.8}}>{m.short_code}</div>
                <div>
                  <div style={{fontSize:11,color:'var(--tx-1)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:150}}>{m.pickup_address ?? '—'}</div>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:0.3,marginTop:2}}>{fmtDate(m.started_at)}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:10,fontWeight:700,color:MISSION_COLOR[m.status]??'var(--tx-3)'}}>{m.status}</div>
                  {m.total_eur && <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--ok)',marginTop:2}}>{parseFloat(m.total_eur).toLocaleString()} BC</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right — stats + terminate */}
      <div style={{display:'flex',flexDirection:'column',gap:12,overflow:'auto'}}>
        <div className="card">
          <div className="card-header"><div className="card-header-title"><span className="bar"/>Performance</div></div>
          <div style={{padding:14,display:'flex',flexDirection:'column',gap:8}}>
            {([
              ['Total Jobs', String(agent.jobs_total ?? 0)],
              ['Duty Hrs (MTD)', `${(agent.duty_hours_mtd ?? 0).toFixed(1)} hrs`],
              ['Est. Earnings', earningsEst > 0 ? `${earningsEst.toLocaleString()} BC` : '—'],
              ['Rating', agent.rating ? `★ ${parseFloat(agent.rating).toFixed(2)} / 5.00` : 'Not rated'],
            ] as [string,string][]).map(([k,v]) => (
              <div key={k} style={{display:'grid',gridTemplateColumns:'1fr auto',padding:'9px 10px',background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8,alignItems:'center',gap:8}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1,textTransform:'uppercase'}}>{k}</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:12,fontWeight:700,color:'var(--tx-1)'}}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {canTerminateAgent(role) && (
          <div className="card">
            <div className="card-header"><div className="card-header-title"><span className="bar"/>Terminate Agent</div></div>
            <div style={{padding:14,display:'flex',flexDirection:'column',gap:10}}>
              {!termConfirm ? (
                <button className="btn btn-danger" style={{width:'100%',justifyContent:'center',height:42,fontSize:12}} onClick={() => setTermConfirm(true)}>
                  TERMINATE
                </button>
              ) : (
                <>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--err)',letterSpacing:0.5,lineHeight:1.6}}>
                    Sets status to REJECTED and removes from duty. Cannot be undone.
                  </div>
                  <textarea
                    value={termNotes}
                    onChange={e => setTermNotes(e.target.value)}
                    placeholder="Reason for termination…"
                    style={{width:'100%',minHeight:70,background:'var(--surf-3)',border:'1px solid var(--err)',borderRadius:8,padding:8,color:'var(--tx-1)',fontFamily:'Manrope',fontSize:11,resize:'none'}}
                  />
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                    <button className="btn btn-ghost" style={{justifyContent:'center',height:36,fontSize:11}} onClick={() => { setTermConfirm(false); setTermNotes(''); }}>CANCEL</button>
                    <button className="btn btn-danger" disabled={busy} style={{justifyContent:'center',height:36,fontSize:11,opacity:busy?0.6:1}} onClick={terminate}>
                      {busy ? 'TERMINATING…' : 'CONFIRM'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Approval view — all other statuses ──────────────────────────────────────

// Provider linkage — present when the CPO was onboarded by a service-provider
// org (agents.managed_by_org_id). Typed locally until lib/api.ts AgentDetail
// picks it up; the backend returns null for legacy self-registered agents.
type ManagedBy = {
  org_user_id: string;
  company: string | null;
  email: string | null;
  org_status: string | null;
  member_status: string | null;
  member_call_sign: string | null;
} | null;

// Labelled chip row for jsonb-derived lists (coverage, services, loadout…).
function ChipRow({label, items, empty}: {label: string; items: string[]; empty: string}) {
  return (
    <div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:1,marginBottom:5}}>{label}</div>
      {items.length === 0 ? (
        <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)'}}>{empty}</div>
      ) : (
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {items.map(it => (
            <span key={it} style={{fontFamily:'JetBrains Mono',fontSize:9.5,fontWeight:700,letterSpacing:0.6,
              color:'var(--acc)',padding:'3px 9px',borderRadius:999,
              background:'rgba(59,130,246,0.08)',border:'1px solid rgba(59,130,246,0.3)'}}>
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Card shown on the approval view so ops can verify WHICH provider vouches
// for this officer (and that the provider itself is an active partner)
// before approving.
function ProviderCard({managedBy}: {managedBy: ManagedBy}) {
  if (!managedBy) return null;
  const orgOk = managedBy.org_status === 'ACTIVE' || managedBy.org_status === 'APPROVED';
  return (
    <>
      <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
        <div className="card-header-title"><span className="bar"/>Service Provider</div>
        <div className="card-header-act" style={{color: orgOk ? 'var(--ok)' : 'var(--warn)'}}>
          {managedBy.org_status ?? 'NO PARTNER RECORD'}
        </div>
      </div>
      <div style={{padding:'10px 14px 14px',display:'flex',flexDirection:'column',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 11px',background:'var(--surf-3)',border:`1px solid ${orgOk?'var(--bd-2)':'var(--warn)'}`,borderRadius:8}}>
          <div style={{width:32,height:32,borderRadius:8,background:'var(--surf-2)',border:'1px solid var(--bd-2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,flexShrink:0}}>🏢</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12,color:'var(--tx-1)',fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
              {managedBy.company ?? 'Unknown provider'}
            </div>
            <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:0.4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
              {managedBy.email ?? '—'}{managedBy.member_call_sign ? ` · roster: ${managedBy.member_call_sign}` : ''}
              {managedBy.member_status && managedBy.member_status !== 'active' ? ` · MEMBER ${managedBy.member_status.toUpperCase()}` : ''}
            </div>
          </div>
          <a className="btn btn-sm btn-ghost" style={{fontSize:9,flexShrink:0}} href={`/agents/${managedBy.org_user_id}`}>
            VIEW PROVIDER
          </a>
        </div>
        {!orgOk && (
          <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--warn)',letterSpacing:0.4,lineHeight:1.5}}>
            ⚠ Provider is not an approved partner ({managedBy.org_status ?? 'no record'}) — verify the
            org before approving its officers.
          </div>
        )}
      </div>
    </>
  );
}

function ApprovalView({id, data, mutate}: {id: string; data: AgentDetail; mutate: () => void}) {
  const {agent, profile, contact, kyc, documents, review} = data;
  const managedBy = (data as AgentDetail & {managed_by?: ManagedBy}).managed_by ?? null;
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<'approve'|'reject'|null>(null);
  // Audit fix 4.2 — approve/reject decisions require SUPERVISOR/ADMIN.
  const {data: me} = useOpsMe();
  const role = me?.admin.role;

  const decide = async (decision: 'APPROVED'|'REJECTED') => {
    if (busy) return;
    // OC-12 — REJECT had no confirmation step (every sibling destructive
    // action has one); a mis-click bounced a provider application silently.
    if (decision === 'REJECTED') {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Reject ${agent.call_sign ?? 'this agent'}'s application?${notes ? '' : ' No notes entered — the applicant gets no reason.'}`)) {
        return;
      }
    }
    setBusy(decision === 'APPROVED' ? 'approve' : 'reject');
    try {
      await opsApi.decideAgent(agent.user_id, decision, notes || undefined);
      await mutate();
      setNotes('');
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Decision failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  async function viewAndReview(type: 'doc'|'kyc', key: string, url: string|null) {
    if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    // OC-04 — the "reviewed" stamp now requires SUPERVISOR/ADMIN server-side
    // (it feeds the approve decision). OPS can still VIEW the document; only
    // the stamp is skipped, instead of alert-flashing a 403 on every view.
    if (!canDecideAgent(role)) return;
    try {
      if (type === 'doc') await opsApi.reviewDoc(id, key);
      else                await opsApi.reviewKyc(id, key);
      await mutate();
    } catch (e) {
      // Audit PAGE-23 — don't silently swallow: the operator would believe
      // the document is marked reviewed when the write actually failed.
      // eslint-disable-next-line no-alert
      alert(`Couldn't mark ${type === 'doc' ? 'document' : 'KYC'} reviewed: ${(e as Error).message}`);
    }
  }

  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1.6fr 1fr',gap:16,flex:1,minHeight:0}}>

      {/* Left */}
      <div className="card" style={{overflow:'auto'}}>
        <AgentProfileCard agent={agent} profile={profile} contact={contact} />

        <ProviderCard managedBy={managedBy} />

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>KYC Documents</div>
          <div className="card-header-act">{kyc.filter(k=>k.state==='done').length}/{kyc.length}</div>
        </div>
        <div style={{padding:'8px 14px',display:'flex',flexDirection:'column',gap:6}}>
          {kyc.map(k => (
            <div key={k.kind} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 10px',background:'var(--surf-3)',border:`1px solid ${k.reviewed_at?'var(--ok)':'var(--bd-2)'}`,borderRadius:8}}>
              <div style={{width:32,height:28,borderRadius:6,background:'var(--surf-2)',border:'1px solid var(--bd-2)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--tx-2)',flexShrink:0,fontSize:9,fontFamily:'JetBrains Mono',fontWeight:700,letterSpacing:0.5}}>{KYC_ICON[k.kind]}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11.5,color:'var(--tx-1)',fontWeight:500}}>{KYC_LABEL[k.kind]}</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:k.reviewed_at?'var(--ok)':k.state==='done'?'var(--tx-2)':'var(--tx-3)',letterSpacing:0.4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                  {k.reviewed_at ? `✓ REVIEWED · ${fmtDate(k.reviewed_at)}` : k.state==='done' ? (k.subject??'Submitted')+(k.uploaded_at?` · ${fmtDate(k.uploaded_at)}`:'') : k.state.toUpperCase()}
                </div>
              </div>
              {k.file_url && /^https?:\/\//i.test(k.file_url) ? (
                <button className={`btn btn-sm ${k.reviewed_at?'btn-ok':'btn-ghost'}`} style={{fontSize:9,flexShrink:0}} onClick={() => viewAndReview('kyc', k.kind, k.file_url)}>
                  {k.reviewed_at ? 'REVIEWED' : 'VIEW'}
                </button>
              ) : <FilePreview url={k.file_url}/>}
              {k.reviewed_at && <span style={{width:16,height:16,borderRadius:'50%',background:'var(--ok)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'#07090D',flexShrink:0}}>✓</span>}
            </div>
          ))}
        </div>

        <div className="card-header" style={{borderTop:'1px solid var(--bd-2)'}}>
          <div className="card-header-title"><span className="bar"/>Compliance Pack</div>
          <div className="card-header-act">{documents.filter(d=>d.state==='done').length}/{documents.length}</div>
        </div>
        <div style={{padding:'8px 14px 14px 14px',display:'flex',flexDirection:'column',gap:6}}>
          {documents.map(d => (
            <div key={d.id} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 10px',background:'var(--surf-3)',border:`1px solid ${d.reviewed_at?'var(--ok)':'var(--bd-2)'}`,borderRadius:8}}>
              <div style={{width:28,height:28,borderRadius:6,background:'var(--surf-2)',border:'1px solid var(--bd-2)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--tx-2)',flexShrink:0,fontSize:14}}>📄</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11.5,color:'var(--tx-1)',fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.title}</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:d.reviewed_at?'var(--ok)':d.state==='done'?'var(--tx-2)':'var(--tx-3)',letterSpacing:0.4}}>
                  {d.reviewed_at ? `✓ REVIEWED · ${fmtDate(d.reviewed_at)}` : `${d.required?'REQ':'OPT'} · ${d.state==='done'?`Uploaded ${fmtDate(d.uploaded_at)}`:d.state==='rejected'?'REJECTED':'Not uploaded'}`}
                </div>
              </div>
              {d.file_url && /^https?:\/\//i.test(d.file_url) ? (
                <button className={`btn btn-sm ${d.reviewed_at?'btn-ok':'btn-ghost'}`} style={{fontSize:9,flexShrink:0}} onClick={() => viewAndReview('doc', d.slot, d.file_url)}>
                  {d.reviewed_at ? 'REVIEWED' : 'VIEW'}
                </button>
              ) : <FilePreview url={d.file_url}/>}
              {d.reviewed_at && <span style={{width:16,height:16,borderRadius:'50%',background:'var(--ok)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'#07090D',flexShrink:0}}>✓</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Middle — pipeline */}
      <div className="card" style={{overflow:'auto'}}>
        <div className="card-header"><div className="card-header-title"><span className="bar"/>Review Pipeline</div><div className="card-header-act">5 STEPS</div></div>
        {review.map((step, i) => {
          const cls = {done:'done', in_progress:'cur', rejected:'err', pending:''}[step.state] ?? '';
          return (
            <div key={step.step} className={`pl-step ${cls}`}>
              <div className="pl-step-head">
                <div className="pl-dot">{step.state==='done' ? '✓' : (i+1)}</div>
                <div style={{flex:1}}>
                  <div className="pl-step-title">{STEP_LABEL[step.step]}</div>
                  <div className="pl-step-sub">
                    {step.state==='done' ? `Completed · ${fmtDate(step.settled_at)}` : step.state==='in_progress' ? 'In progress…' : step.state==='rejected' ? 'Rejected' : 'Pending'}
                  </div>
                  {step.notes && <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',marginTop:4,letterSpacing:0.3}}>&quot;{step.notes}&quot;</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Right — decision + KYC status */}
      <div style={{display:'flex',flexDirection:'column',gap:12,overflow:'auto'}}>
        {canDecideAgent(role) ? (
          <div className="card">
            <div className="card-header"><div className="card-header-title"><span className="bar"/>Decision</div></div>
            <div style={{padding:14,display:'flex',flexDirection:'column',gap:10}}>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                style={{width:'100%',minHeight:100,background:'var(--surf-3)',border:'1px solid var(--bd-2)',borderRadius:8,padding:10,color:'var(--tx-1)',fontFamily:'Manrope',fontSize:12,resize:'none'}}
                placeholder="Add review notes…" />
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
                <button className="btn btn-ok" disabled={busy!==null||agent.status==='APPROVED'||agent.status==='ACTIVE'} onClick={() => decide('APPROVED')} style={{width:'100%',justifyContent:'center',height:46,fontSize:13,opacity:busy?0.6:1}}>
                  {busy==='approve' ? 'APPROVING…' : 'APPROVE'}
                </button>
                <button className="btn btn-danger" disabled={busy!==null||agent.status==='REJECTED'} onClick={() => decide('REJECTED')} style={{width:'100%',justifyContent:'center',height:46,fontSize:13,opacity:busy?0.6:1}}>
                  {busy==='reject' ? 'REJECTING…' : 'REJECT'}
                </button>
              </div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.5,lineHeight:1.5}}>
                Approving moves the agent to <b style={{color:'var(--ok)'}}>APPROVED</b>. They will be prompted to complete in-person onboarding.
              </div>
            </div>
          </div>
        ) : (
          <div className="card" style={{padding:14, fontFamily:'JetBrains Mono', fontSize:11, color:'var(--tx-3)', letterSpacing:0.4, lineHeight:1.5}}>
            <b style={{color:'var(--tx-2)'}}>READ-ONLY ·</b> Approve / reject decisions require SUPERVISOR or ADMIN.
          </div>
        )}
        <div className="card">
          <div className="card-header"><div className="card-header-title"><span className="bar"/>KYC Status</div></div>
          {kyc.map(row => {
            const colour = row.state==='done'?'var(--ok)':row.state==='failed'?'var(--err)':row.state==='running'?'var(--warn)':'var(--tx-3)';
            const symbol = row.state==='done'?'●':row.state==='failed'?'✗':row.state==='running'?'⏳':'○';
            return (
              <div key={row.kind} style={{display:'grid',gridTemplateColumns:'1fr auto',padding:'10px 14px',borderBottom:'1px solid var(--bd-2)',alignItems:'center'}}>
                <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.8}}>{KYC_LABEL[row.kind]}</div>
                <div style={{fontFamily:'JetBrains Mono',fontSize:10,fontWeight:700,color:colour}}>{symbol} {row.state.toUpperCase()}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Page entry point ─────────────────────────────────────────────────────────

export default function AgentDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading, error, mutate} = useAgentDetail(id);
  const {data: stats} = useAgentStats(id);

  if (isLoading) {
    return <Shell><div style={{padding:32,color:'var(--tx-3)'}}>Loading agent…</div></Shell>;
  }
  if (error || !data) {
    return <Shell><div style={{padding:32,color:'var(--err)'}}>Failed to load agent · {String((error as Error)?.message ?? 'not found')}</div></Shell>;
  }

  const {agent} = data as AgentDetail;
  const callSign = agent.call_sign ?? `AGT-${agent.user_id.slice(0,6).toUpperCase()}`;
  const isOperational = agent.status === 'ACTIVE' || agent.status === 'APPROVED';

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Agents · <span style={{color:'var(--tx-2)'}}>{callSign}</span></div>
          <h2>
            {isOperational ? 'Agent Profile' : 'Agent Approval'} —{' '}
            <span className="mono" style={{color:'var(--acc)'}}>{callSign}</span>
          </h2>
        </div>
        <div className="page-head-right">
          <Link href="/agents" className="btn btn-ghost">← BACK</Link>
        </div>
      </div>

      {isOperational
        ? <OperationalView id={id} data={data as AgentDetail} stats={stats} mutateDetail={mutate} />
        : <ApprovalView id={id} data={data as AgentDetail} mutate={mutate} />
      }
    </Shell>
  );
}
