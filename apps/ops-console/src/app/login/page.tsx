'use client';

import {useState, useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {authApi, deviceId, type LoginStartResult} from '@/lib/api';
import QRCode from 'qrcode';
import {AuthLayout, Field, Note, Err, authCol} from '@/components/auth-primitives';

export default function LoginPage() {
  const router = useRouter();
  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');
  const [otp,      setOtp]      = useState('');
  const [step,     setStep]     = useState<LoginStartResult | null>(null);   // non-null once the password step passed
  const [qr,       setQr]       = useState<string | null>(null);              // data-URL of the enrolment QR
  const [saved,    setSaved]    = useState(false);                            // "I saved my backup codes"
  const userId = step?.userId ?? null;
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [idleNote, setIdleNote] = useState(false);

  // OC-17 — the Shell has stamped this flag on idle logout since audit 4.1,
  // but nothing ever read it: operators were silently dumped at /login with
  // no explanation. Read-and-clear so the notice shows exactly once.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('bravo_ops_idle_logout') === '1') {
      window.sessionStorage.removeItem('bravo_ops_idle_logout');
      setIdleNote(true);
    }
  }, []);

  // Audit fix 0.4 — token is in an httpOnly cookie now; we can't probe
  // it directly. The CSRF cookie (set in pair with the token cookie)
  // is JS-readable, so we use its presence as the "already logged in"
  // signal and bounce to dashboard.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (/(?:^|;\s*)bravo_ops_csrf=/.test(document.cookie)) {
      router.replace('/');
    }
  }, [router]);

  useEffect(() => {
    if (!step?.enrol) { setQr(null); return; }
    let live = true;
    QRCode.toDataURL(step.enrol.uri, {margin: 1, width: 196, color: {dark: '#F2F4F8', light: '#0E1320'}})
      .then(url => { if (live) setQr(url); })
      .catch(() => { if (live) setQr(null); });   // manual key is always shown as the fallback
    return () => { live = false; };
  }, [step]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await authApi.loginStart(phone, password);
      if (!res.userId) {
        setErr('Wrong phone or password.');
        return;
      }
      setSaved(false);
      setStep(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !userId) return;
    setBusy(true); setErr(null);
    try {
      const res = await authApi.loginVerify(userId, otp, deviceId(), step?.challengeId);
      // Audit fix 0.4 — no client-side session persistence: the auth-service
      // set the httpOnly cookies on /auth/verify; the tokens in `res` are
      // never stored by JS.
      // Audit fix 4.1 — stash the access TTL (NOT the token) so the Shell
      // can schedule its silent refresh ahead of expiry. sessionStorage
      // so it dies with the tab; not security-sensitive (the value is
      // just a duration in seconds).
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bravo_ops_access_expires_at', String(Date.now() + res.expiresIn * 1000));
      }
      router.replace('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <AuthLayout subtitle="Sign in to the ops console">
      {idleNote && (
        <Note>Signed out after 15 minutes of inactivity. Sign in to continue.</Note>
      )}
      {!step && (
        <form onSubmit={onLogin} style={authCol(12)}>
          <Field label="Phone (E.164)" placeholder="+919876543210"
            value={phone} onChange={setPhone} autoFocus inputMode="tel"/>
          <Field label="Password" type="password" value={password} onChange={setPassword}/>
          {err && <Err msg={err}/>}
          <button className="btn btn-pri" disabled={busy || !phone || !password}
            type="submit"
            style={{height:42,justifyContent:'center',fontSize:13,marginTop:6}}>
            {busy ? 'CHECKING…' : 'CONTINUE'}
          </button>
          {/* Audit fix 0.1 — public admin self-registration removed. New
              admins are added by an existing ADMIN via an invite flow
              (see auth.controller.ts admin-register/verify). */}
        </form>
      )}

      {step && (
        <form onSubmit={onVerify} style={authCol(12)}>
          {step.secondFactor === 'totp_enrol' && step.enrol && (
            <>
              <Note>
                This account has no authenticator yet. Scan the code with
                <b style={{color:'var(--tx-1)'}}> Google Authenticator</b>, Aegis, 1Password or
                any TOTP app, then enter the 6-digit code it shows.
              </Note>
              <div style={{display:'flex',gap:14,alignItems:'flex-start'}}>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data-URL; nothing for next/image to fetch or optimise */}
                {qr
                  ? <img src={qr} alt="Authenticator enrolment QR" width={148} height={148}
                      style={{borderRadius:8,border:'1px solid var(--ln-1)',flex:'0 0 auto'}}/>
                  : <div style={{width:148,height:148,borderRadius:8,border:'1px dashed var(--ln-1)',
                      display:'grid',placeItems:'center',fontSize:11,color:'var(--tx-3)'}}>QR unavailable</div>}
                <div style={{fontSize:12,color:'var(--tx-2)',minWidth:0}}>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:10.5,letterSpacing:0.5,color:'var(--tx-3)',marginBottom:4}}>
                    CAN&apos;T SCAN? ENTER THIS KEY
                  </div>
                  <code style={{display:'block',fontFamily:'JetBrains Mono',fontSize:12,wordBreak:'break-all',
                    padding:'6px 8px',borderRadius:6,background:'var(--bg-2)',border:'1px solid var(--ln-1)',userSelect:'all'}}>
                    {step.enrol.secret}
                  </code>
                  <div style={{fontFamily:'JetBrains Mono',fontSize:10.5,letterSpacing:0.5,color:'var(--tx-3)',margin:'10px 0 4px'}}>
                    BACKUP CODES — SHOWN ONCE
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'2px 10px',fontFamily:'JetBrains Mono',fontSize:11.5,userSelect:'all'}}>
                    {step.enrol.backupCodes.map(c => <span key={c}>{c}</span>)}
                  </div>
                </div>
              </div>
              <label style={{display:'flex',gap:8,alignItems:'center',fontSize:12,color:'var(--tx-2)',cursor:'pointer'}}>
                <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>
                I have saved the backup codes somewhere safe.
              </label>
            </>
          )}
          {step.secondFactor === 'totp' && (
            <Note>Enter the 6-digit code from your authenticator app, or an 8-character backup code.</Note>
          )}
          {(step.secondFactor === 'sms' || step.secondFactor === null) && (
            <Note>OTP sent to <b style={{color:'var(--tx-1)'}}>{step.otpSentTo ?? phone}</b>.</Note>
          )}
          <Field label={step.secondFactor?.startsWith('totp') ? 'Authenticator code' : 'One-time code'} placeholder="123456"
            value={otp} onChange={setOtp} autoFocus inputMode={step.secondFactor === 'totp' ? 'text' : 'numeric'}/>
          {err && <Err msg={err}/>}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <button type="button" className="btn btn-ghost"
              onClick={() => { setStep(null); setOtp(''); setErr(null); }}
              style={{height:42,justifyContent:'center',fontSize:13}}>
              BACK
            </button>
            <button className="btn btn-pri"
              disabled={busy || otp.length < 4 || (step.secondFactor === 'totp_enrol' && !saved)}
              type="submit"
              style={{height:42,justifyContent:'center',fontSize:13}}>
              {busy ? 'VERIFYING…' : step.secondFactor === 'totp_enrol' ? 'ENROL & SIGN IN' : 'SIGN IN'}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
