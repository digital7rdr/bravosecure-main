'use client';

import {useState, type ReactNode} from 'react';
import Link from 'next/link';
import {useParams, useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {Redacted} from '@/components/Redacted';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {CopyId} from '@/components/CopyId';
import {ApiError, opsDataApi, useOpsMe, useOpsUserDetail, useUserFamily, type OpsUserDetail} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';
import {hasRole, type AdminRole} from '@/lib/rbac';

function holdActive(heldUntil: string | null): boolean {
  return !!heldUntil && new Date(heldUntil).getTime() > Date.now();
}

type DeviceRow = OpsUserDetail['devices'][number];

function deviceStatus(d: DeviceRow): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (d.revoked_at) return 'REVOKED';
  if (d.expires_at && new Date(d.expires_at).getTime() < Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

const DEVICE_STATE_CLASS: Record<string, string> = {
  ACTIVE: 'text-ok',
  REVOKED: 'text-err',
  EXPIRED: 'text-t3',
};

function Card({title, right, flush, children}: {title: string; right?: ReactNode; flush?: boolean; children: ReactNode}) {
  return (
    <div className="overflow-hidden rounded-xl border border-bd2">
      <div className="flex items-center justify-between bg-s2 px-4 py-2.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-t3">{title}</div>
        {right}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </div>
  );
}

function Row({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-1 text-sm">
      <div className="pt-0.5 text-xs uppercase tracking-wider text-t3">{label}</div>
      <div className="break-all text-t2">{children}</div>
    </div>
  );
}

/**
 * M1A/S9 — inline subscription-tier editor (comp grants / support fixes).
 * Days blank = permanent grant (RS-17); 'lite' also cancels every renewal
 * path server-side so a live card sub can't silently re-upgrade the user.
 */
function TierEditor({user, onChanged}: {user: OpsUserDetail['user']; onChanged: () => void}) {
  // OC-12 — the endpoint is SUPERVISOR/ADMIN; don't render a control that 403s.
  const {data: me} = useOpsMe();
  const canEditTier = hasRole(me?.admin.role as AdminRole | undefined, 'SUPERVISOR');
  const [tier, setTier] = useState<'lite' | 'pro' | 'enterprise'>(
    (['lite', 'pro', 'enterprise'].includes(user.subscription_tier) ? user.subscription_tier : 'lite') as 'lite' | 'pro' | 'enterprise',
  );
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = tier !== user.subscription_tier || days !== '';

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const parsed = days.trim() === '' ? null : Number(days);
      if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650)) {
        setErr('Days must be 1–3650, or blank for a permanent grant.');
        return;
      }
      // OC-03 — a tier change is a comp grant / paid-feature removal; confirm
      // the from→to before it lands (a lite downgrade also kills auto-renew).
      const span = tier === 'lite' ? '' : parsed === null ? ' (permanent grant)' : ` for ${parsed} days`;
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Change ${user.display_name ?? user.id.slice(0, 8)}'s tier: ${user.subscription_tier} → ${tier}${span}?${tier === 'lite' ? ' This also cancels any live auto-renew.' : ''}`)) {
        return;
      }
      await opsDataApi.setUserTier(user.id, {tier, days: parsed});
      setDays('');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Tier change failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canEditTier) {
    return (
      <span className="text-xs capitalize text-t2">
        {user.subscription_tier}
        <span className="ml-2 text-t3">(SUPERVISOR/ADMIN can change)</span>
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={tier}
        onChange={e => setTier(e.target.value as 'lite' | 'pro' | 'enterprise')}
        disabled={busy}
        className="rounded-md border border-bd1 bg-s2 px-2 py-1 text-xs capitalize text-t2">
        <option value="lite">lite</option>
        <option value="pro">pro</option>
        <option value="enterprise">enterprise</option>
      </select>
      {tier !== 'lite' && (
        <input
          value={days}
          onChange={e => setDays(e.target.value)}
          disabled={busy}
          placeholder="days (blank = permanent)"
          className="w-44 rounded-md border border-bd1 bg-s2 px-2 py-1 text-xs text-t2 placeholder:text-t3"
        />
      )}
      <button
        onClick={() => { void apply(); }}
        disabled={busy || !dirty}
        className="rounded-md border border-act/40 px-3 py-1 text-xs font-semibold text-acc hover:bg-act/10 disabled:opacity-40">
        {busy ? 'APPLYING…' : 'APPLY'}
      </button>
      {user.pro_active_until && (
        <span className="text-xs text-t3">until {formatDateTimeUtc(user.pro_active_until)}</span>
      )}
      {err && <span className="text-xs text-err">{err}</span>}
    </div>
  );
}

export default function UserDetailPage() {
  const {id} = useParams<{id: string}>();
  const router = useRouter();
  const {data, isLoading, error, mutate} = useOpsUserDetail(id);
  const {data: me} = useOpsMe();
  // OC-12 — route through the shared rbac module (was a hand-rolled dialect
  // that would drift from any capability change made there).
  const role = me?.admin.role as AdminRole | undefined;
  const canRevoke = hasRole(role, 'SUPERVISOR');
  const canErase = hasRole(role, 'ADMIN');
  const {data: family} = useUserFamily(id);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctErr, setAcctErr] = useState<string | null>(null);
  // IS-15 — validated confirm modals replace the window.prompt flows.
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);

  async function revoke(rowId: string) {
    if (busyDevice) return;
    if (!window.confirm('Revoke this session? The device will be signed out and must authenticate again.')) return;
    setBusyDevice(rowId);
    setDeviceErr(null);
    try {
      await opsDataApi.revokeUserDevice(id, rowId);
      await mutate();
    } catch (e) {
      setDeviceErr((e as Error).message);
    } finally {
      setBusyDevice(null);
    }
  }

  async function runAccountAction(fn: () => Promise<unknown>) {
    if (acctBusy) return;
    setAcctBusy(true);
    setAcctErr(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setAcctErr((e as Error).message);
    } finally {
      setAcctBusy(false);
    }
  }

  function confirmSuspend(reason: string) {
    setSuspendOpen(false);
    void runAccountAction(() => opsDataApi.suspendUser(id, reason));
  }

  function restore() {
    if (!window.confirm('Lift the suspension and allow this user to sign in again?')) return;
    void runAccountAction(() => opsDataApi.restoreUser(id));
  }

  function confirmErase(reason: string) {
    // Erase keeps its double-confirm: validated reason first, then a final
    // irreversible-action gate.
    if (!window.confirm('This cannot be undone. Erase this user now?')) return;
    setEraseOpen(false);
    void runAccountAction(() => opsDataApi.eraseUser(id, reason));
  }

  if (isLoading) {
    return <Shell><p className="p-6 text-sm text-t3">Loading…</p></Shell>;
  }
  if (error || !data) {
    const msg = error instanceof ApiError && error.status === 403
      ? 'Requires SUPERVISOR or ADMIN role.'
      : ((error as Error | undefined)?.message ?? 'User not found.');
    return <Shell><p className="p-6 text-sm text-err">{msg}</p></Shell>;
  }

  const {user, devices, balance, bookings, agent} = data;

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-t1">
              {user.display_name ?? user.id.slice(0, 8)}
              {user.deleted_at && (
                <span className="ml-2 rounded bg-err/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-err">
                  deleted {formatDateTimeUtc(user.deleted_at)}
                </span>
              )}
              {!user.deleted_at && user.suspended_at && (
                <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-warn">
                  suspended {formatDateTimeUtc(user.suspended_at)}
                </span>
              )}
            </h1>
            <p className="text-sm text-t3">User record, wallet, sessions and recent bookings.</p>
          </div>
          <div className="flex items-center gap-2">
            {canRevoke && !user.deleted_at && (
              user.suspended_at ? (
                <button onClick={restore} disabled={acctBusy}
                  className="rounded-md border border-ok/40 px-3 py-1.5 text-xs font-semibold text-ok hover:bg-ok/10 disabled:opacity-50">
                  RESTORE
                </button>
              ) : (
                <button onClick={() => setSuspendOpen(true)} disabled={acctBusy}
                  className="rounded-md border border-warn/40 px-3 py-1.5 text-xs font-semibold text-warn hover:bg-warn/10 disabled:opacity-50">
                  SUSPEND
                </button>
              )
            )}
            {canErase && !user.deleted_at && (
              <button onClick={() => setEraseOpen(true)} disabled={acctBusy}
                className="rounded-md border border-err/40 px-3 py-1.5 text-xs font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                ERASE
              </button>
            )}
            <Link href="/users" className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
              ← BACK
            </Link>
          </div>
        </div>
        {acctErr && <p className="text-sm text-err">{acctErr}</p>}
        {user.suspended_at && user.suspended_reason && (
          <div className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">
            Suspended: {user.suspended_reason}
          </div>
        )}

        <Card title="Profile">
          <Row label="Display Name">{user.display_name ?? '—'}</Row>
          <Row label="Role"><span className="capitalize">{roleLabel(user.role)}</span></Row>
          <Row label="Messenger tier"><TierEditor user={user} onChanged={() => { void mutate(); }} /></Row>
          <Row label="KYC"><span className="capitalize">{user.kyc_status}</span></Row>
          <Row label="Region">{user.home_region ?? user.country_code ?? '—'}</Row>
          <Row label="Lang / Currency">{user.language ?? '—'} / {user.currency ?? '—'}</Row>
          <Row label="Phone"><Redacted value={user.phone_e164} kind="phone" subject={user.id} /></Row>
          <Row label="Email"><Redacted value={user.email} kind="email" subject={user.id} /></Row>
          <Row label="Created">{formatDateTimeUtc(user.created_at)}</Row>
          <Row label="ID"><span className="font-mono text-xs text-t3">{user.id}<CopyId value={user.id} title="Copy user id" /></span></Row>
        </Card>

        <Card title="Wallet">
          <Row label="Balance">
            {balance ? `${balance.bravo_credits.toLocaleString()} BC` : '—'}
          </Row>
          <Row label="Updated">{balance ? formatDateTimeUtc(balance.updated_at) : '—'}</Row>
          <p className="mt-2 text-xs text-t3">
            Balance changes go through <Link href="/finance" className="text-acc hover:underline">adjust via Finance</Link>.
          </p>
        </Card>

        <Card title="Devices / Sessions" right={<span className="text-xs text-t3">{devices.length}</span>} flush>
          {deviceErr && <p className="px-4 pt-3 text-sm text-err">{deviceErr}</p>}
          {devices.length === 0 ? (
            <p className="p-4 text-sm text-t3">No sessions on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-s2 text-left text-xs uppercase text-t3">
                <tr>
                  <th className="px-3 py-2">Platform</th><th className="px-3 py-2">Device</th>
                  <th className="px-3 py-2">Signal</th><th className="px-3 py-2">Last Used</th>
                  <th className="px-3 py-2">Expires</th><th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-bd2">
                {devices.map(d => {
                  const state = deviceStatus(d);
                  return (
                    <tr key={d.id} className="text-t2">
                      <td className="px-3 py-2 capitalize">{d.platform ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-t3" title={d.device_id}>
                        {d.device_id.length > 16 ? `${d.device_id.slice(0, 16)}…` : d.device_id}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-t3">{d.signal_device_id ?? '—'}</td>
                      <td className="px-3 py-2 text-t3">{formatDateTimeUtc(d.last_used_at)}</td>
                      <td className="px-3 py-2 text-t3">{formatDateTimeUtc(d.expires_at)}</td>
                      <td className={`px-3 py-2 font-semibold ${DEVICE_STATE_CLASS[state]}`}>{state}</td>
                      <td className="px-3 py-2 text-right">
                        {canRevoke && state === 'ACTIVE' && (
                          <button
                            onClick={() => revoke(d.id)}
                            disabled={busyDevice === d.id}
                            className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                            {busyDevice === d.id ? 'REVOKING…' : 'REVOKE'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent Bookings" right={<span className="text-xs text-t3">{bookings.length}</span>} flush>
          {bookings.length === 0 ? (
            <p className="p-4 text-sm text-t3">No bookings on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-s2 text-left text-xs uppercase text-t3">
                <tr>
                  <th className="px-3 py-2">Status</th><th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2">Region</th><th className="px-3 py-2">Pickup</th>
                  <th className="px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bd2">
                {bookings.map(b => (
                  <tr
                    key={b.id}
                    onClick={() => router.push(`/bookings/${b.id}`)}
                    className="cursor-pointer text-t2 hover:bg-s1">
                    <td className="px-3 py-2 uppercase text-t3">{b.status.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 capitalize">{b.service.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-t3">{b.region_code}</td>
                    <td className="px-3 py-2 text-t3">{formatDateTimeUtc(b.pickup_time)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{parseFloat(b.total_eur).toLocaleString()} BC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* SK-07/IS-03 — family linkage, both directions. */}
        {family && (family.owner_of.length > 0 || family.member_of.length > 0) && (
          <Card
            title="Family"
            right={<span className="text-xs text-t3">{family.owner_of.length + family.member_of.length}</span>}>
            {family.member_of.map(m => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className="rounded bg-act/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-acc">member of</span>
                <Link href={`/users/${m.holder_id}`} className="font-semibold text-t1 hover:underline">
                  {m.holder_name ?? m.holder_email ?? m.holder_id.slice(0, 8)}
                </Link>
                {m.relationship && <span className="text-xs capitalize text-t3">{m.relationship}</span>}
                <span className={`text-xs uppercase ${m.status === 'active' ? 'text-ok' : 'text-warn'}`}>{m.status}</span>
                {holdActive(m.held_until) && (
                  <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                    on hold until {formatDateTimeUtc(m.held_until!)}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs text-t3">
                  {m.spent_credits.toLocaleString()}{m.spend_limit_credits != null ? ` / ${m.spend_limit_credits.toLocaleString()}` : ''} BC spent
                </span>
              </div>
            ))}
            {family.owner_of.map(m => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className="rounded bg-s1 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-t2">owner of</span>
                {m.member_id ? (
                  <Link href={`/users/${m.member_id}`} className="font-semibold text-t1 hover:underline">
                    {m.member_name ?? m.member_email ?? m.member_id.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="font-semibold text-t1">{m.member_name ?? 'Invited member'}</span>
                )}
                {m.relationship && <span className="text-xs capitalize text-t3">{m.relationship}</span>}
                <span className={`text-xs uppercase ${m.status === 'active' ? 'text-ok' : 'text-warn'}`}>{m.status}</span>
                {holdActive(m.held_until) && (
                  <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                    on hold until {formatDateTimeUtc(m.held_until!)}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs text-t3">
                  {m.spent_credits.toLocaleString()}{m.spend_limit_credits != null ? ` / ${m.spend_limit_credits.toLocaleString()}` : ''} BC spent
                </span>
              </div>
            ))}
          </Card>
        )}

        {agent && (
          <Card
            title="Agent Record"
            right={
              <Link href={`/agents/${agent.user_id}`} className="text-xs font-semibold text-acc hover:underline">
                VIEW AGENT →
              </Link>
            }>
            <Row label="Call Sign">{agent.call_sign ?? '—'}</Row>
            <Row label="Type"><span className="uppercase">{agent.type}</span></Row>
            <Row label="Status"><span className="uppercase">{agent.status.replace(/_/g, ' ')}</span></Row>
            <Row label="On Duty">{agent.on_duty ? <span className="text-ok">YES</span> : 'NO'}</Row>
          </Card>
        )}
      </div>

      <ConfirmReasonModal
        open={suspendOpen}
        title="Suspend this account?"
        description="Locks login and signs out every device immediately. Reversible via RESTORE."
        reasonLabel="Suspend reason"
        reasonPlaceholder="e.g. Chargeback investigation; abusive conduct report…"
        confirmLabel="SUSPEND ACCOUNT"
        danger
        busy={acctBusy}
        onConfirm={confirmSuspend}
        onCancel={() => setSuspendOpen(false)}
      />
      <ConfirmReasonModal
        open={eraseOpen}
        title="Irreversible erasure"
        description="Scrubs name / email / phone / avatar and permanently blocks login. Booking and wallet history is retained for audit. This cannot be undone."
        reasonLabel="Erasure reason"
        reasonPlaceholder="e.g. GDPR erasure request ref #…"
        confirmLabel="ERASE USER"
        danger
        busy={acctBusy}
        onConfirm={confirmErase}
        onCancel={() => setEraseOpen(false)}
      />
    </Shell>
  );
}
