'use client';

import {useEffect} from 'react';

/**
 * OC-05 — last-resort boundary for throws in the root layout itself. Must
 * render its own <html>/<body> because the layout is what crashed.
 */
export default function GlobalError({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
  useEffect(() => {
    console.error('[ops-console] global error', error.digest ?? '', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{
        margin: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12,
        background: '#07090D', color: '#E8ECF4', fontFamily: 'ui-monospace, monospace',
      }}>
        <div style={{fontSize: 11, letterSpacing: 2, color: '#DC2626'}}>CONSOLE ERROR</div>
        <div style={{fontSize: 15, fontWeight: 700}}>The ops console failed to render.</div>
        {error.digest && <div style={{fontSize: 11, color: '#8A94A8'}}>Reference: {error.digest}</div>}
        <button
          onClick={reset}
          style={{
            marginTop: 8, padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
            background: 'transparent', border: '1px solid #2A3242', color: '#B9C2D4',
            fontSize: 11, fontWeight: 700, letterSpacing: 1,
          }}>
          RELOAD
        </button>
      </body>
    </html>
  );
}
