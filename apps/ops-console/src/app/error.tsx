'use client';

import {useEffect} from 'react';

/**
 * OC-05 — route-segment error boundary. Before this file existed, ANY render
 * throw unmounted the whole tree to Next's default screen and nobody found
 * out except the operator. console.error survives the prod build (next.config
 * keeps error/warn), so the failure is at least visible in devtools/support.
 */
export default function RouteError({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
  useEffect(() => {
    console.error('[ops-console] route error', error.digest ?? '', error);
  }, [error]);

  return (
    <div style={{
      minHeight: '60vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
    }}>
      <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, letterSpacing: 2, color: 'var(--err, #DC2626)'}}>
        PAGE ERROR
      </div>
      <div style={{fontFamily: 'Manrope, sans-serif', fontSize: 15, fontWeight: 700, color: 'var(--tx-1, #E8ECF4)'}}>
        This page hit an unexpected error.
      </div>
      <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--tx-3, #8A94A8)', maxWidth: 480, textAlign: 'center'}}>
        The rest of the console is unaffected — use the left rail to keep working.
        {error.digest ? ` Reference: ${error.digest}` : ''}
      </div>
      <button
        onClick={reset}
        style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent', border: '1px solid var(--bd-2, #2A3242)',
          color: 'var(--tx-2, #B9C2D4)', fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11, fontWeight: 700, letterSpacing: 1,
        }}>
        TRY AGAIN
      </button>
    </div>
  );
}
