import Link from 'next/link';

/** OC-05 — branded 404 instead of Next's default screen. */
export default function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
      background: 'var(--bg-0, #07090D)',
    }}>
      <div style={{fontFamily: 'JetBrains Mono, monospace', fontSize: 11, letterSpacing: 2, color: 'var(--tx-3, #8A94A8)'}}>
        404 — NOT FOUND
      </div>
      <div style={{fontFamily: 'Manrope, sans-serif', fontSize: 15, fontWeight: 700, color: 'var(--tx-1, #E8ECF4)'}}>
        This page does not exist.
      </div>
      <Link
        href="/dashboard"
        style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 6,
          border: '1px solid var(--bd-2, #2A3242)', color: 'var(--acc, #5B8DEF)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
          letterSpacing: 1, textDecoration: 'none',
        }}>
        GO TO DASHBOARD →
      </Link>
    </div>
  );
}
