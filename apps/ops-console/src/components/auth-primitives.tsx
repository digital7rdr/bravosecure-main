'use client';

import type {InputHTMLAttributes, CSSProperties, ReactNode} from 'react';
import {BravoLogo} from './BrandLogo';

const col = (gap: number) => ({display:'flex' as const,flexDirection:'column' as const,gap});

export function AuthLayout({subtitle, children}: {subtitle: string; children: ReactNode}) {
  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:24,
      // bravo-secure.com's dark sections: flat deep navy. A single soft
      // accent bloom behind the card gives depth without a gradient wash.
      background:'radial-gradient(900px 520px at 50% 0%, rgba(30,136,255,0.16), transparent 60%), var(--bg-canvas)',
    }}>
      <div style={{width:420, display:'flex', flexDirection:'column', alignItems:'center', gap:22}}>
        <BravoLogo width={168} style={{color:'var(--tx-1)', filter:'drop-shadow(0 8px 24px rgba(30,136,255,0.28))'}}/>
        <div className="card" style={{width:'100%', padding:'28px 28px 26px', borderRadius:16,
          boxShadow:'0 30px 70px -25px rgba(4,14,34,0.9), inset 0 1px 0 rgba(255,255,255,0.05)'}}>
          <div style={{fontFamily:'JetBrains Mono', fontSize:10, letterSpacing:1.6, color:'var(--tx-3)', fontWeight:700}}>
            OPS CONSOLE
          </div>
          <h2 style={{fontFamily:'Manrope', fontSize:20, fontWeight:800, letterSpacing:-0.3, marginTop:6, marginBottom:22, color:'var(--tx-1)'}}>{subtitle}</h2>
          {children}
        </div>
        <div style={{fontFamily:'Manrope', fontSize:11.5, color:'var(--tx-3)', letterSpacing:0.2}}>
          Restricted system · Authorised operators only
        </div>
      </div>
    </div>
  );
}

export function Field({
  label, value, onChange, ...rest
}: {label: string; value: string; onChange: (v: string) => void} & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label style={col(6)}>
      <span style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>{label}</span>
      <input
        {...rest}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="auth-input"
      />
    </label>
  );
}

export function Select({
  label, value, onChange, options,
}: {label: string; value: string; onChange: (v: string) => void; options: string[]}) {
  return (
    <label style={col(6)}>
      <span style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,fontWeight:700,textTransform:'uppercase'}}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="auth-input">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export function Note({children}: {children: ReactNode}) {
  return (
    <div style={{fontFamily:'JetBrains Mono',fontSize:10.5,color:'var(--tx-3)',letterSpacing:0.5,lineHeight:1.5}}>
      {children}
    </div>
  );
}

export function Err({msg}: {msg: string}) {
  return (
    <div style={{padding:'10px 12px',background:'rgba(220,38,38,0.12)',border:'1px solid var(--err)',borderRadius:6,fontSize:11.5,color:'var(--tx-1)',fontFamily:'JetBrains Mono'}}>
      {msg}
    </div>
  );
}

export const authCol = col;
export const authHint: CSSProperties = {fontFamily:'JetBrains Mono',fontSize:10.5,color:'var(--tx-3)',letterSpacing:0.5,textAlign:'center',marginTop:4};
