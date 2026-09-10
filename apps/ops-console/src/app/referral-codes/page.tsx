'use client';

import {useState} from 'react';
import useSWR from 'swr';
import {Shell} from '@/components/Shell';
import {opsApi, useOpsMe, type ReferralCodeRow} from '@/lib/api';
import {canManageReferralCodes} from '@/lib/rbac';
import {formatDateTimeUtc} from '@/lib/datetime';

const inputCls =
  'rounded-md border border-bd1 bg-s2 px-3 py-1.5 text-sm text-t2 placeholder:text-t3 focus:border-bd1 focus:outline-none';

function statusBadge(status: ReferralCodeRow['status']) {
  const tone = status === 'active' ? 'text-ok border-ok/30'
    : status === 'expired' ? 'text-warn border-warn/30'
    : 'text-t3 border-bd2';
  return <span className={`rounded border px-2 py-0.5 text-[11px] uppercase ${tone}`}>{status}</span>;
}

export default function ReferralCodesPage() {
  const {data: me} = useOpsMe();
  const canManage = canManageReferralCodes(me?.admin.role);

  const {data: codes, error: listErr, mutate} =
    useSWR('ops-referral-codes', () => opsApi.listReferralCodes(), {revalidateOnFocus: false});

  // Mint form state.
  const [codeInput, setCodeInput] = useState('');
  const [kind, setKind] = useState<'partner' | 'owner'>('partner');
  const [partnerName, setPartnerName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [expires, setExpires] = useState(''); // yyyy-mm-dd from <input type="date">
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr(null); setMinted(null);
    try {
      const row = await opsApi.createReferralCode({
        code: codeInput.trim(),
        ...(kind === 'partner'
          ? {partner_name: partnerName.trim()}
          : {owner_user_id: ownerUserId.trim()}),
        ...(purpose.trim() ? {purpose: purpose.trim()} : {}),
        // End of the chosen day, UTC — matches the console's UTC-everywhere rule.
        ...(expires ? {expires_at: `${expires}T23:59:59.999Z`} : {}),
      });
      setMinted(row.code);
      setCodeInput(''); setPartnerName(''); setOwnerUserId(''); setPurpose(''); setExpires('');
      void mutate();
    } catch (e) {
      const msg = (e as Error).message;
      setFormErr(
        /code_already_exists/.test(msg) ? 'That code already exists.'
        : /owner_not_found/.test(msg) ? 'No live user with that ID.'
        : /owner_or_partner_required/.test(msg) ? 'Provide exactly one: a partner name OR a provider user ID.'
        : /referral_code_invalid_format/.test(msg) ? 'Codes are letters, digits and dashes, starting with a letter or digit.'
        : /expires_at_in_past/.test(msg) ? 'The expiry date is in the past.'
        : msg,
      );
    } finally { setBusy(false); }
  }

  async function toggleActive(c: ReferralCodeRow) {
    const next = !c.active;
    const lapsed = !!c.expires_at && new Date(c.expires_at).getTime() <= Date.now();
    if (!window.confirm(next
      ? lapsed
        ? `Reactivate ${c.code}? Its expiry has lapsed, so reactivating also removes the expiry date — clients can then submit it again immediately.`
        : `Reactivate ${c.code}? Clients can submit it again immediately.`
      : `Deactivate ${c.code}? New bookings with this code will be rejected; past attributions keep it.`)) return;
    try {
      await opsApi.setReferralCodeActive(c.id, next);
      void mutate();
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  return (
    <Shell>
      <div className="space-y-8 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Referral Codes</h1>
          <p className="text-sm text-t3">
            Partner / preferred-provider attribution codes for the booking flow. Attribution only —
            a code never changes pricing, availability or who is assigned. Every action here is audited.
          </p>
        </div>

        {/* ── Mint ── */}
        {canManage && (
          <div className="rounded-xl border border-bd2 p-4">
            <h2 className="mb-1 text-sm font-semibold text-t2">Mint a code</h2>
            <p className="mb-3 text-xs text-t3">
              Codes are stored upper-case and matched case-insensitively. Attribute to an external
              partner by name, or to a provider account by user ID — exactly one.
            </p>
            <form onSubmit={mint} className="flex flex-wrap items-center gap-2">
              <input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())}
                placeholder="CODE (e.g. TRAVELCO-01)" required minLength={2} maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9-]*" className={`w-52 font-mono ${inputCls}`}/>
              <select value={kind} onChange={e => setKind(e.target.value as 'partner' | 'owner')}
                className={inputCls}>
                <option value="partner">External partner</option>
                <option value="owner">Provider account</option>
              </select>
              {kind === 'partner' ? (
                <input value={partnerName} onChange={e => setPartnerName(e.target.value)}
                  placeholder="Partner name (e.g. TravelCo Dubai)" required maxLength={120}
                  className={`w-56 ${inputCls}`}/>
              ) : (
                <input value={ownerUserId} onChange={e => setOwnerUserId(e.target.value)}
                  placeholder="Provider user ID (UUID)" required className={`w-72 font-mono ${inputCls}`}/>
              )}
              <input value={purpose} onChange={e => setPurpose(e.target.value)}
                placeholder="Purpose (optional)" maxLength={200} className={`w-56 ${inputCls}`}/>
              <label className="flex items-center gap-1.5 text-xs text-t3">
                Expires (end of day, UTC)
                <input type="date" value={expires} onChange={e => setExpires(e.target.value)}
                  className={inputCls}/>
              </label>
              <button type="submit" disabled={busy}
                className="rounded-md bg-t1 px-4 py-1.5 text-sm font-semibold text-canvas disabled:opacity-50">
                {busy ? 'Minting…' : 'Mint code'}
              </button>
            </form>
            {formErr && <p className="mt-2 text-sm text-err">{formErr}</p>}
            {minted && (
              <p className="mt-2 text-sm text-ok">
                <code className="font-mono">{minted}</code> is live — clients can submit it on the
                Team &amp; Add-ons step now.
              </p>
            )}
          </div>
        )}

        {/* ── Codes ── */}
        {listErr ? <p className="text-sm text-err">{(listErr as Error).message}</p> : (
          <div className="overflow-hidden rounded-xl border border-bd2">
            <table className="w-full text-sm">
              <thead className="bg-s2 text-left text-xs uppercase text-t3">
                <tr>
                  <th className="px-3 py-2">Code</th><th className="px-3 py-2">Attributed To</th>
                  <th className="px-3 py-2">Purpose</th><th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" title="Bookings submitted with this code (any status, incl. cancelled)">Bookings</th>
                  <th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Created</th><th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bd2">
                {!codes && (
                  <tr><td colSpan={8} className="px-3 py-3 text-sm text-t3">Loading…</td></tr>
                )}
                {codes && codes.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-3 text-sm text-t3">
                    No codes yet{canManage ? ' — mint the first one above.' : '.'}
                  </td></tr>
                )}
                {(codes ?? []).map(c => (
                  <tr key={c.id} className="text-t2">
                    <td className="px-3 py-2 font-mono text-xs">{c.code}</td>
                    <td className="px-3 py-2">
                      {c.partner_name ?? c.owner_name ?? (
                        c.owner_user_id
                          ? <span className="font-mono text-xs text-t3">{c.owner_user_id}</span>
                          : '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-t3">{c.purpose ?? '—'}</td>
                    <td className="px-3 py-2">{statusBadge(c.status)}</td>
                    <td className="px-3 py-2">{c.booking_count}</td>
                    <td className="px-3 py-2 text-t3">
                      {c.expires_at ? formatDateTimeUtc(c.expires_at) : 'never'}
                    </td>
                    <td className="px-3 py-2 text-t3">{formatDateTimeUtc(c.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      {canManage && (
                        <button onClick={() => void toggleActive(c)}
                          className={c.active
                            ? 'rounded-md border border-err/30 px-3 py-1 text-xs text-err hover:bg-err/10'
                            : 'rounded-md border border-ok/30 px-3 py-1 text-xs text-ok hover:bg-ok/15'}>
                          {c.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  );
}
