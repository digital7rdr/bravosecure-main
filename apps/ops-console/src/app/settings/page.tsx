'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Shell } from '@/components/Shell';
import { ApiError, opsDataApi, useOpsMe } from '@/lib/api';
import { hasRole, type AdminRole } from '@/lib/rbac';

/**
 * Audit fix 4.6 — Settings was a fake-form stub: a "SAVE CHANGES" button
 * with no handler, hardcoded "Session Timeout: 8 hours" (false — it's
 * 15 min per audit 4.1), and a tab rail that didn't render anything but
 * General. Rewritten as a read-only info card that reflects the real
 * console state. When we add real settings (notification prefs,
 * notification rules, integration tokens), each lands as its own page;
 * the tab rail comes back then.
 */
export default function Settings() {
  const {data: me} = useOpsMe();
  const admin = me?.admin;

  const fields: Array<[string, string]> = [
    ['Console Build',     'Bravo Ops Console · v1.0.0'],
    ['Your Call Sign',    admin?.call_sign ?? '—'],
    ['Your Role',         admin?.role      ?? '—'],
    ['Your Region',       admin?.region    ?? '—'],
    ['Session Timeout',   '15 minutes of inactivity'],
    ['Access Token',      'Rotates silently every 15 min via /auth/session/refresh'],
    ['2FA Requirement',   'Enforced via OTP at login'],
    ['CSRF Protection',   'Double-submit cookie + X-CSRF-Token header'],
    ['Idempotency',       '24h replay protection on approve / dispatch / complete / ack / decide / terminate'],
  ];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Settings</div>
          <h2>Console Settings</h2>
        </div>
      </div>
      <div className="card" style={{padding:24, overflow:'auto'}}>
        <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
          Read-only console info
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
          Values shown are enforced server-side. To change any of them, talk to engineering — there is no client-side toggle.
        </div>

        {fields.map(([label, val]) => (
          <div key={label} style={{
            display:'grid', gridTemplateColumns:'220px 1fr', gap:16,
            padding:'12px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
          }}>
            <div style={{
              fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)',
              letterSpacing:1.2, textTransform:'uppercase', fontWeight:700,
            }}>
              {label}
            </div>
            <div style={{
              fontSize:12.5, color:'var(--tx-1)',
              fontFamily:'Manrope', fontWeight:500,
            }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* OC-12 — the pricing editors are SUPERVISOR/ADMIN server-side; before
          this gate they rendered for OPS too and 403'd on SAVE. */}
      {hasRole(admin?.role as AdminRole | undefined, 'SUPERVISOR') ? (
        <>
          <SubscriptionPricingCard />
          <PackageCatalogCard />
          <ServicePricingCard />
        </>
      ) : (
        <div className="card" style={{padding:24, marginTop:16}}>
          <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',letterSpacing:0.5}}>
            Pricing and catalog editors require the SUPERVISOR or ADMIN role.
          </div>
        </div>
      )}
    </Shell>
  );
}

const SERVICE_PRICE_LABELS: Record<string, string> = {
  eur_per_bc: 'THE ROOT — 1 BC = X EUR',
  transfer_base_rate_bc: 'Secure Transfer base /hr (1 CPO + vehicle + driver)',
  transfer_extra_unit_factor: 'Extra CPO/vehicle (x base, per unit)',
  transfer_driver_only_factor: 'Driver-only multiplier',
  peak_multiplier: 'Peak multiplier (17:00-20:00 local)',
  base_rate_aed: 'AED display anchor (per base rate)',
  exec_cpo_rate_bc: 'Executive: per CPO /hr',
  exec_vehicle_rate_bc: 'Executive: per vehicle + driver /hr',
  exec_driver_only_rate_bc: 'Executive: Bravo driver, client vehicle /hr',
  addon_female_cpo_bc: 'Add-on: Female CPO Team /hr',
  addon_recon_bc: 'Add-on: Advance Assessment Team /hr',
  addon_medical_bc: 'Add-on: Medical Support /hr',
  addon_comms_bc: 'Add-on: Secure Communications /hr',
};

/**
 * Founder 2026-08-26 — the booking price engine's numbers ("prices for 1x
 * CPO, vehicle, female, price per hour — everywhere the price applicable").
 * Read at CHARGE TIME (60 s server cache): an edit prices the next quote;
 * existing bookings keep their stored totals. eur_per_bc is the conversion
 * ROOT for booking charges; the wallet top-up peg (1 fiat = 1 BC) is a
 * separate, deliberately locked rule.
 */
function ServicePricingCard() {
  const {data, mutate, error} = useSWR('ops-service-pricing', () => opsDataApi.servicePricing());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(row: {key: string; value: number; min: number; max: number}) {
    const raw = (drafts[row.key] ?? '').trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < row.min || parsed > row.max) {
      setErr(`Value for ${row.key} must be between ${row.min} and ${row.max}.`);
      return;
    }
    // OC-03 — one SAVE click reprices the platform; make the operator read
    // the from→to once before it lands. The root gets its own louder copy.
    const label = row.key === 'eur_per_bc'
      ? `Change THE ROOT (eur_per_bc) from ${row.value} to ${parsed}? This re-prices every booking charge from the next quote.`
      : `Change ${row.key} from ${row.value} to ${parsed}? Applies from the next quote/charge.`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(label)) return;
    setBusyKey(row.key); setErr(null);
    try {
      await opsDataApi.setServicePrice(row.key, parsed);
      setDrafts(d => ({...d, [row.key]: ''}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Price update failed');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
        Service pricing — bookings
      </div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Charged at charge time — the next quote uses the new number; existing bookings keep
        their stored totals. SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>Could not load service pricing.</div>}
      {err && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>{err}</div>}
      {(data?.pricing ?? []).map(p => (
        <div key={p.key} style={{
          display:'grid', gridTemplateColumns:'minmax(260px,1fr) 110px 150px 110px', gap:16,
          padding:'11px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
          background: p.key === 'eur_per_bc' ? 'rgba(91,141,239,0.05)' : undefined,
        }}>
          <div>
            <div style={{fontSize:12,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:700}}>
              {SERVICE_PRICE_LABELS[p.key] ?? p.key}
            </div>
            <div style={{fontFamily:'JetBrains Mono',fontSize:9,color:'var(--tx-3)',letterSpacing:0.8,marginTop:2}}>
              {p.key} · bounds {p.min}–{p.max}{p.value !== p.default_value ? ` · default ${p.default_value}` : ''}
            </div>
          </div>
          <div style={{fontSize:12.5,color: p.value !== p.default_value ? '#8FB0F7' : 'var(--tx-1)',fontFamily:'JetBrains Mono',fontWeight:700}}>
            {p.value}
          </div>
          <input
            value={drafts[p.key] ?? ''}
            onChange={e => setDrafts(d => ({...d, [p.key]: e.target.value}))}
            placeholder="new value"
            style={{
              background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
              padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'JetBrains Mono',
            }}
          />
          <button
            onClick={() => { void save(p); }}
            disabled={busyKey === p.key || !(drafts[p.key] ?? '').trim()}
            style={{
              border:'1px solid rgba(91,141,239,0.4)', color:'#8FB0F7', background:'transparent',
              borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
              opacity: busyKey === p.key || !(drafts[p.key] ?? '').trim() ? 0.4 : 1,
            }}>
            {busyKey === p.key ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Founder 2026-08-26 — the package cards' display copy (name + description),
 * ops-editable per package. The apps ship the same copy compiled-in as a
 * fail-open fallback, so an edit here is cosmetic-safe: it can rename a card,
 * never blank one.
 */
function PackageCatalogCard() {
  const {data, mutate, error} = useSWR('ops-subscription-catalog', () => opsDataApi.subscriptionCatalog());
  const [drafts, setDrafts] = useState<Record<string, {name?: string; desc?: string}>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(key: string) {
    const d = drafts[key] ?? {};
    const display_name = d.name?.trim();
    const description = d.desc?.trim();
    if (!display_name && !description) {return;}
    if (display_name !== undefined && display_name !== '' && display_name.length > 60) {
      setErr('Name must be 1-60 characters.'); return;
    }
    if (description !== undefined && description.length > 500) {
      setErr('Description must be 500 characters or fewer.'); return;
    }
    // OC-03 — customer-facing copy; a stray paste shouldn't ship silently.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Update the ${key.replace(/_/g, ' ')} card${display_name ? ` name to "${display_name}"` : ''}${display_name && description ? ' and' : ''}${description ? ' description' : ''}? Live on the apps' next catalog fetch.`)) return;
    setBusyKey(key); setErr(null);
    try {
      await opsDataApi.setSubscriptionCatalogEntry({
        key,
        ...(display_name ? {display_name} : {}),
        ...(description ? {description} : {}),
      });
      setDrafts(ds => ({...ds, [key]: {}}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Catalog update failed');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
        Package catalog — names &amp; descriptions
      </div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Edits apply on the apps&apos; next catalog fetch. Prices are edited in the pricing
        card above (one charge-time source). SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>Could not load the catalog.</div>}
      {err && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>{err}</div>}
      {(data?.catalog ?? []).map(p => {
        const d = drafts[p.key] ?? {};
        const dirty = !!(d.name?.trim() || d.desc?.trim());
        return (
          <div key={p.key} style={{
            display:'grid', gridTemplateColumns:'180px 1fr 120px', gap:16,
            padding:'14px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'start',
          }}>
            <div>
              <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase',fontWeight:700}}>
                {p.key.replace(/_/g, ' ')}
              </div>
              <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:700,marginTop:6}}>
                {p.display_name}
              </div>
              <div style={{fontSize:11,color:'var(--tx-3)',marginTop:4,lineHeight:1.5}}>
                {p.description}
              </div>
            </div>
            <div style={{display:'grid', gap:8}}>
              <input
                value={d.name ?? ''}
                onChange={e => setDrafts(ds => ({...ds, [p.key]: {...ds[p.key], name: e.target.value}}))}
                placeholder="new name"
                maxLength={60}
                style={{
                  background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
                  padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'Manrope',
                }}
              />
              <textarea
                value={d.desc ?? ''}
                onChange={e => setDrafts(ds => ({...ds, [p.key]: {...ds[p.key], desc: e.target.value}}))}
                placeholder="new description"
                maxLength={500}
                rows={2}
                style={{
                  background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
                  padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'Manrope', resize:'vertical',
                }}
              />
            </div>
            <div>
              <button
                onClick={() => { void save(p.key); }}
                disabled={busyKey === p.key || !dirty}
                style={{
                  border:'1px solid rgba(91,141,239,0.4)', color:'#8FB0F7', background:'transparent',
                  borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
                  opacity: busyKey === p.key || !dirty ? 0.4 : 1,
                }}>
                {busyKey === p.key ? 'SAVING…' : 'SAVE'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * M1A/S9 — live subscription pricing (SUPERVISOR/ADMIN). Prices are read at
 * CHARGE TIME server-side, so a change applies to every subscribe and every
 * renewal from now on ("from next month" for renewing subscribers) while
 * already-paid periods finish at what they paid.
 */
function SubscriptionPricingCard() {
  const {data, mutate, error} = useSWR('ops-subscription-prices', () => opsDataApi.subscriptionPrices());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(tier: 'pro' | 'enterprise') {
    const raw = drafts[tier];
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
      setErr('Price must be a whole number of BC between 1 and 1,000,000.');
      return;
    }
    // OC-03 — confirm with from→to before repricing every future renewal.
    const current = (data?.prices ?? []).find(p => p.tier === tier)?.price_bc;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Change the ${tier} subscription price from ${current ?? '?'} BC to ${parsed} BC? Applies to every subscribe and renewal from now on.`)) return;
    setBusyTier(tier); setErr(null);
    try {
      await opsDataApi.setSubscriptionPrice(tier, parsed);
      setDrafts(d => ({...d, [tier]: ''}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Price update failed');
    } finally {
      setBusyTier(null);
    }
  }

  const label: Record<string, string> = {pro: 'Messenger Pro', enterprise: 'Enterprise'};

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
        Messenger subscription pricing
      </div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Charged at charge time — a change applies to every new subscribe and every renewal
        from now on; periods already paid finish at the old price. SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>Could not load prices.</div>}
      {(data?.prices ?? []).map(p => (
        <div key={p.tier} style={{
          display:'grid', gridTemplateColumns:'220px 140px 160px 1fr', gap:16,
          padding:'12px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
        }}>
          <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase',fontWeight:700}}>
            {label[p.tier] ?? p.tier} / 30 days
          </div>
          <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:700}}>
            {p.price_bc.toLocaleString()} BC
          </div>
          <input
            value={drafts[p.tier] ?? ''}
            onChange={e => setDrafts(d => ({...d, [p.tier]: e.target.value}))}
            placeholder="new price (BC)"
            style={{
              background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
              padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'JetBrains Mono',
            }}
          />
          <div>
            <button
              onClick={() => { void save(p.tier); }}
              disabled={busyTier === p.tier || !(drafts[p.tier] ?? '').trim()}
              style={{
                border:'1px solid rgba(91,141,239,0.4)', color:'#8FB0F7', background:'transparent',
                borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
                opacity: busyTier === p.tier || !(drafts[p.tier] ?? '').trim() ? 0.4 : 1,
              }}>
              {busyTier === p.tier ? 'SAVING…' : 'SAVE'}
            </button>
          </div>
        </div>
      ))}
      {err && <div style={{fontSize:12,color:'#f87171',marginTop:12}}>{err}</div>}
    </div>
  );
}
