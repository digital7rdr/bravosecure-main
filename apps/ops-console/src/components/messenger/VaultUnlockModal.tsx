'use client';

/**
 * Vault unlock dialog. Shown the first time the admin tries to use the
 * encrypted messenger (first run = create vault) and on every browser
 * session reopen (subsequent runs = decrypt the vault canary).
 *
 * The passphrase never leaves this component — it's passed straight to
 * MessengerRuntime.unlock() which derives an AES-GCM key via PBKDF2.
 */

import {useEffect, useRef, useState, type FormEvent} from 'react';
import {openMessengerDb} from '@/lib/messenger/idb';
import {checkPassphraseStrength, MIN_PASSPHRASE_LENGTH} from '@/lib/messenger/crypto';

interface Props {
  state: 'absent' | 'locked' | 'unlocking' | 'unlocked' | 'error';
  error: string | null;
  userId: string | null;
  onClose: () => void;
  onSubmit: (passphrase: string) => Promise<void>;
}

export function VaultUnlockModal({state, error, userId, onClose, onSubmit}: Props) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Detect first-run vs returning. We open the schema-aware DB
  // (so the upgrade callback creates the object stores on a fresh
  // install) and check for an existing vault row. Cancelled when
  // the modal unmounts mid-open.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const db = await openMessengerDb(userId);
        if (cancelled) { db.close(); return; }
        const row = await db.get('vault', 1);
        if (!cancelled) setHasVault(!!row);
        db.close();
      } catch (e) {
        console.warn('[messenger] vault probe failed', e);
        if (!cancelled) setHasVault(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const isCreate = hasVault === false;
  // Audit OPS-MSG-08 — mirror the real gate enforced in crypto.ts
  // (>= 12 chars + 3 character classes) instead of the stale 8-char hint.
  // Only block *creation* on strength; unlocking an existing vault defers
  // to the runtime so a legacy passphrase still gets a clean attempt.
  const strength  = checkPassphraseStrength(pass);
  const passWeak  = isCreate && pass.length > 0 && strength !== 'ok';
  const mismatch  = isCreate && pass !== confirm;
  const disabled  = submitting || pass.length === 0 || passWeak || mismatch;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setSubmitting(true);
    try { await onSubmit(pass); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true">
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <span style={{fontFamily:'JetBrains Mono', fontSize:10, letterSpacing:1.4, color:'var(--glow)', fontWeight:700}}>
            BRAVO MESSENGER VAULT
          </span>
          <button onClick={onClose} style={closeBtn} disabled={submitting}>×</button>
        </div>
        <div style={{padding:'18px 22px'}}>
          <h3 style={title}>
            {hasVault === null ? 'Loading…' : isCreate ? 'Set vault passphrase' : 'Unlock vault'}
          </h3>
          <p style={blurb}>
            {isCreate
              ? 'This passphrase encrypts your Signal identity in this browser. You\'ll enter it again every time you open the console. There is no recovery — losing it wipes the vault.'
              : 'Enter the passphrase you set the first time you opened this browser. Wrong passphrase fails cleanly — no data is destroyed on a miss.'}
          </p>
          <form onSubmit={submit} style={{display:'flex', flexDirection:'column', gap:10, marginTop:14}}>
            <label style={label}>
              <span style={lk}>Passphrase</span>
              <input
                ref={inputRef}
                type="password"
                value={pass}
                onChange={e => setPass(e.target.value)}
                disabled={submitting}
                autoComplete={isCreate ? 'new-password' : 'current-password'}
                style={input}
              />
            </label>
            {isCreate && (
              <label style={label}>
                <span style={lk}>Confirm</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                  style={input}
                />
              </label>
            )}
            {isCreate && pass && strength === 'too_short' && (
              <div style={hint}>Use at least {MIN_PASSPHRASE_LENGTH} characters.</div>
            )}
            {isCreate && pass && strength === 'too_simple' && (
              <div style={hint}>Mix at least 3 of: uppercase, lowercase, digits, symbols.</div>
            )}
            {mismatch && (
              <div style={hint}>Confirmation doesn&apos;t match.</div>
            )}
            {error && (
              <div style={errorBox}>{error}</div>
            )}
            <div style={{display:'flex', gap:8, marginTop:6}}>
              <button type="submit" className="btn btn-sec" disabled={disabled} style={{flex:1, fontWeight:800}}>
                {submitting
                  ? '…'
                  : state === 'unlocking'
                    ? 'UNLOCKING…'
                    : isCreate ? 'CREATE VAULT' : 'UNLOCK'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                CANCEL
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position:'fixed', inset:0, background:'rgba(0,0,0,0.65)',
  display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
};
const card: React.CSSProperties = {
  width:'min(440px, 92vw)', background:'var(--surf-1)',
  border:'1px solid var(--bd-1)', borderRadius:10,
  boxShadow:'0 16px 48px rgba(0,0,0,0.55)', overflow:'hidden',
};
const head: React.CSSProperties = {
  display:'flex', alignItems:'center', justifyContent:'space-between',
  padding:'10px 14px', background:'var(--surf-2)',
  borderBottom:'1px solid var(--bd-2)',
};
const closeBtn: React.CSSProperties = {
  background:'none', border:'none', color:'var(--tx-3)', cursor:'pointer', fontSize:18, padding:0,
};
const title: React.CSSProperties = {
  margin:0, fontFamily:'Manrope', fontSize:18, fontWeight:800, color:'var(--tx-1)',
};
const blurb: React.CSSProperties = {
  margin:'8px 0 0', fontFamily:'JetBrains Mono', fontSize:11, lineHeight:1.5, color:'var(--tx-3)',
};
const label: React.CSSProperties = {display:'flex', flexDirection:'column', gap:4};
const lk: React.CSSProperties = {
  fontFamily:'JetBrains Mono', fontSize:9, color:'var(--tx-3)',
  letterSpacing:1, textTransform:'uppercase', fontWeight:700,
};
const input: React.CSSProperties = {
  background:'var(--surf-3)', border:'1px solid var(--bd-1)', borderRadius:6,
  padding:'9px 11px', fontFamily:'JetBrains Mono', fontSize:13,
  color:'var(--tx-1)', outline:'none',
};
const hint: React.CSSProperties = {
  fontFamily:'JetBrains Mono', fontSize:10, color:'var(--warn)',
};
const errorBox: React.CSSProperties = {
  padding:'8px 10px', background:'rgba(220,38,38,0.1)',
  border:'1px solid var(--err)', borderRadius:6,
  color:'#FFB4B4', fontFamily:'JetBrains Mono', fontSize:11,
};
