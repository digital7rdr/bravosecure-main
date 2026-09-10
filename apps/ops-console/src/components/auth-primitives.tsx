'use client';

import type {InputHTMLAttributes, CSSProperties, ReactNode} from 'react';

const col = (gap: number) => ({display:'flex' as const,flexDirection:'column' as const,gap});

export function AuthLayout({subtitle, children}: {subtitle: string; children: ReactNode}) {
  return (
    <div style={{minHeight:'100vh',background:'var(--bg-canvas)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div className="card" style={{width:400,padding:28}}>
        <div style={{fontFamily:'JetBrains Mono',fontSize:10,letterSpacing:1.5,color:'var(--tx-3)',fontWeight:700}}>
          BRAVO · OPS CONSOLE
        </div>
        <h2 style={{fontFamily:'Manrope',fontSize:18,fontWeight:800,marginTop:6,marginBottom:24}}>{subtitle}</h2>
        {children}
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
        style={{height:38,borderRadius:8,background:'var(--surf-3)',border:'1px solid var(--bd-2)',padding:'0 12px',color:'var(--tx-1)',fontFamily:'Manrope',fontSize:13,outline:'none'}}
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
        style={{height:38,borderRadius:8,background:'var(--surf-3)',border:'1px solid var(--bd-2)',padding:'0 12px',color:'var(--tx-1)',fontFamily:'Manrope',fontSize:13,outline:'none'}}>
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
