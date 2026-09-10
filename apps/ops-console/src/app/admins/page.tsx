'use client';

import {useState} from 'react';
import useSWR from 'swr';
import {Shell} from '@/components/Shell';
import {opsApi, useOpsMe, type AdminAccountRow, type AdminInviteRow} from '@/lib/api';
import {canManageAdmins, type AdminRole} from '@/lib/rbac';
import {formatDateTimeUtc} from '@/lib/datetime';

const ROLES: AdminRole[] = ['OPS', 'SUPERVISOR', 'ADMIN'];

const inputCls =
  'rounded-md border border-bd1 bg-s2 px-3 py-1.5 text-sm text-t2 placeholder:text-t3 focus:border-bd1 focus:outline-none';

function roleBadge(role: AdminRole) {
  const tone = role === 'ADMIN' ? 'text-err border-err/30 bg-err/10'
    : role === 'SUPERVISOR' ? 'text-warn border-warn/30 bg-warn/10'
    : 'text-acc border-act/30 bg-act/10';
  return <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{role}</span>;
}

function statusBadge(status: AdminInviteRow['status']) {
  const tone = status === 'pending' ? 'text-ok border-ok/30'
    : status === 'redeemed' ? 'text-t2 border-bd1'
    : 'text-t3 border-bd2';
  return <span className={`rounded border px-2 py-0.5 text-[11px] uppercase ${tone}`}>{status}</span>;
}

export default function AdminsPage() {
  const {data: me} = useOpsMe();
  const allowed = canManageAdmins(me?.admin.role);

  const {data: admins, error: adminsErr, mutate: mutateAdmins} =
    useSWR(allowed ? 'ops-admins' : null, () => opsApi.listAdmins(), {revalidateOnFocus: false});
  const {data: invites, mutate: mutateInvites} =
    useSWR(allowed ? 'ops-admin-invites' : null, () => opsApi.listAdminInvites(), {revalidateOnFocus: false});

  // Invite form state.
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [callSign, setCallSign] = useState('');
  const [role, setRole] = useState<AdminRole>('OPS');
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  // The raw token is shown ONCE (it is never stored server-side).
  const [mintedLink, setMintedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr(null); setMintedLink(null); setCopied(false);
    try {
      const {token} = await opsApi.createAdminInvite({
        email: email.trim(), display_name: name.trim(), call_sign: callSign.trim(), role,
      });
      setMintedLink(`${window.location.origin}/accept-invite?token=${token}`);
      setEmail(''); setName(''); setCallSign(''); setRole('OPS');
      void mutateInvites();
    } catch (e) {
      const msg = (e as Error).message;
      setFormErr(
        /user_already_exists/.test(msg) ? 'A user with that email already exists.'
        : /call_sign_taken/.test(msg) ? 'That call sign is already in use.'
        : /invite_already_pending/.test(msg) ? 'A pending invite for that email already exists — revoke it first.'
        : msg,
      );
    } finally { setBusy(false); }
  }

  async function changeRole(a: AdminAccountRow, next: AdminRole) {
    if (next === a.role) return;
    if (!window.confirm(`Change ${a.call_sign} from ${a.role} to ${next}? Their sessions are revoked and they must sign in again.`)) return;
    try {
      await opsApi.setAdminRole(a.user_id, next);
      void mutateAdmins();
    } catch (e) {
      const msg = (e as Error).message;
      window.alert(/cannot_demote_last_admin/.test(msg)
        ? 'Refused: that is the last active ADMIN account.' : msg);
    }
  }

  // OC-09 — offboarding. Deactivation revokes the operator's sessions
  // immediately; AdminGuard refuses inactive rows on every request.
  async function toggleActive(a: AdminAccountRow) {
    const next = !a.active;
    const msg = next
      ? `Reinstate ${a.call_sign}? They can sign in again with their existing credentials.`
      : `Deactivate ${a.call_sign}? Their sessions are revoked NOW and every console request is refused until reinstated.`;
    if (!window.confirm(msg)) return;
    try {
      await opsApi.setAdminActive(a.user_id, next);
      void mutateAdmins();
    } catch (e) {
      const msg2 = (e as Error).message;
      window.alert(
        /cannot_deactivate_last_admin/.test(msg2) ? 'Refused: that is the last active ADMIN account.'
        : /cannot_deactivate_self/.test(msg2) ? 'You cannot deactivate your own account.'
        : msg2,
      );
    }
  }

  async function revoke(inv: AdminInviteRow) {
    if (!window.confirm(`Revoke the invite for ${inv.email}?`)) return;
    try {
      await opsApi.revokeAdminInvite(inv.id);
      void mutateInvites();
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  return (
    <Shell>
      <div className="space-y-8 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">Admins</h1>
          <p className="text-sm text-t3">
            Console admin accounts, role changes and single-use invites. Every action here is audited.
          </p>
        </div>

        {!allowed ? (
          <p className="text-sm text-err">Requires the ADMIN role.</p>
        ) : (
          <>
            {/* ── Admin accounts ── */}
            {adminsErr ? <p className="text-sm text-err">{(adminsErr as Error).message}</p> : (
              <div className="overflow-hidden rounded-xl border border-bd2">
                <table className="w-full text-sm">
                  <thead className="bg-s2 text-left text-xs uppercase text-t3">
                    <tr>
                      <th className="px-3 py-2">Call Sign</th><th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Region</th><th className="px-3 py-2">Active</th>
                      <th className="px-3 py-2">Last Active</th><th className="px-3 py-2">Change Role</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-bd2">
                    {(admins ?? []).map(a => (
                      <tr key={a.user_id} className="text-t2">
                        <td className="px-3 py-2 font-mono text-xs">{a.call_sign}</td>
                        <td className="px-3 py-2">{a.display_name}</td>
                        <td className="px-3 py-2 text-t3">{a.email ?? '—'}</td>
                        <td className="px-3 py-2">{roleBadge(a.role)}</td>
                        <td className="px-3 py-2">{a.region}</td>
                        <td className="px-3 py-2">{a.active ? 'yes' : <span className="text-t3">no</span>}</td>
                        <td className="px-3 py-2 text-t3">
                          {a.last_active_at ? formatDateTimeUtc(a.last_active_at) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <select
                              value={a.role}
                              disabled={!a.active}
                              onChange={e => void changeRole(a, e.target.value as AdminRole)}
                              className="rounded-md border border-bd1 bg-s2 px-2 py-1 text-xs text-t2 disabled:opacity-40"
                            >
                              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                            {a.user_id !== me?.admin.user_id && (
                              <button
                                type="button"
                                onClick={() => void toggleActive(a)}
                                className={`rounded border px-2 py-1 text-[11px] font-semibold ${
                                  a.active ? 'border-err/30 text-err hover:bg-err/10' : 'border-ok/30 text-ok hover:bg-ok/10'
                                }`}>
                                {a.active ? 'DEACTIVATE' : 'REINSTATE'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Mint an invite ── */}
            <div className="rounded-xl border border-bd2 p-4">
              <h2 className="mb-1 text-sm font-semibold text-t2">Invite a new admin</h2>
              <p className="mb-3 text-xs text-t3">
                The invite bakes in email, call sign and role — the invitee only sets their own phone and
                password. Single use, expires in 24&nbsp;hours. The link is shown once; share it out-of-band.
              </p>
              <form onSubmit={createInvite} className="flex flex-wrap items-center gap-2">
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@bravo.example"
                  type="email" required className={`w-56 ${inputCls}`}/>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name"
                  required minLength={2} className={`w-44 ${inputCls}`}/>
                <input value={callSign} onChange={e => setCallSign(e.target.value)} placeholder="Call sign (e.g. OPS-07)"
                  required minLength={2} className={`w-44 ${inputCls}`}/>
                <select value={role} onChange={e => setRole(e.target.value as AdminRole)}
                  className={inputCls}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button type="submit" disabled={busy}
                  className="rounded-md bg-t1 px-4 py-1.5 text-sm font-semibold text-canvas disabled:opacity-50">
                  {busy ? 'Minting…' : 'Create invite'}
                </button>
              </form>
              {formErr && <p className="mt-2 text-sm text-err">{formErr}</p>}
              {mintedLink && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-ok/30 bg-ok/10 p-3">
                  <code className="break-all text-xs text-ok">{mintedLink}</code>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(mintedLink).then(() => setCopied(true));
                    }}
                    className="rounded-md border border-ok/30 px-3 py-1 text-xs text-ok hover:bg-ok/15">
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                  <span className="text-[11px] text-ok">Shown once — it is not stored.</span>
                </div>
              )}
            </div>

            {/* ── Invites ── */}
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr>
                    <th className="px-3 py-2">Email</th><th className="px-3 py-2">Call Sign</th>
                    <th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Expires</th><th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {(invites ?? []).length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-3 text-sm text-t3">No invites yet.</td></tr>
                  )}
                  {(invites ?? []).map(inv => (
                    <tr key={inv.id} className="text-t2">
                      <td className="px-3 py-2">{inv.email}</td>
                      <td className="px-3 py-2 font-mono text-xs">{inv.call_sign}</td>
                      <td className="px-3 py-2">{roleBadge(inv.role)}</td>
                      <td className="px-3 py-2">{statusBadge(inv.status)}</td>
                      <td className="px-3 py-2 text-t3">{formatDateTimeUtc(inv.expires_at)}</td>
                      <td className="px-3 py-2 text-t3">{formatDateTimeUtc(inv.created_at)}</td>
                      <td className="px-3 py-2 text-right">
                        {inv.status === 'pending' && (
                          <button onClick={() => void revoke(inv)}
                            className="rounded-md border border-err/30 px-3 py-1 text-xs text-err hover:bg-err/10">
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
