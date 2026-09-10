'use client';

import {useState} from 'react';
import {opsApi} from '@/lib/api';

/**
 * Audit fix 4.2 — click-to-reveal PII wrapper.
 *
 * Phone/email/address render as a masked placeholder by default. Hover
 * tooltip + click reveals the value AND fires an ops-audit event so we
 * have a paper trail of which admin viewed which customer's contact
 * info. The audit row is `subject_type='pii', action='pii.reveal',
 * metadata={kind:'phone'|'email'|'address', subject_id:<bookingId>}`.
 *
 * The masked string is computed in JS — the backend still returns the
 * raw value (the redaction is presentational only). If an admin role
 * needs the value plain, surface them via the auto-reveal prop so the
 * mask never paints.
 *
 * NOTE: not all callers have a useful `subject` — for those we still
 * mask but don't audit (passing undefined skips the API call).
 */
export function Redacted({
  value,
  kind,
  subject,
  autoReveal = false,
  placeholder,
}: {
  value: string | null | undefined;
  kind: 'phone' | 'email' | 'address';
  /** Subject (booking id, agent id, mission id) for the audit row. */
  subject?: string;
  /** Skip the mask entirely (e.g. for the booking owner viewing their own data). */
  autoReveal?: boolean;
  /** Fallback when value is null/empty. Defaults to em-dash. */
  placeholder?: string;
}) {
  const [revealed, setRevealed] = useState(autoReveal);

  if (!value) return <>{placeholder ?? '—'}</>;

  if (revealed) return <>{value}</>;

  const masked = maskByKind(value, kind);

  return (
    <button
      type="button"
      onClick={() => {
        setRevealed(true);
        if (subject) {
          // Fire-and-forget audit — never blocks the reveal.
          opsApi.auditPiiReveal({kind, subject}).catch(() => {
            // Silently swallow — failing to log shouldn't refuse the reveal.
            // The audit middleware on the server still backstops every action.
          });
        }
      }}
      style={{
        background: 'transparent',
        border: 0,
        padding: 0,
        margin: 0,
        font: 'inherit',
        color: 'var(--tx-3)',
        cursor: 'pointer',
        textDecoration: 'underline dotted',
        textUnderlineOffset: 3,
        textDecorationColor: 'var(--bd-2)',
      }}
      title={`Click to reveal ${kind} (audited)`}
      aria-label={`Reveal masked ${kind} — this action will be audited`}>
      {masked}
    </button>
  );
}

function maskByKind(v: string, kind: 'phone' | 'email' | 'address'): string {
  switch (kind) {
    case 'phone': {
      // +971 XX XXX XX 84 → keep first 4 + last 2.
      if (v.length <= 6) return '••••••';
      return `${v.slice(0, 4)} •••• ${v.slice(-2)}`;
    }
    case 'email': {
      const at = v.indexOf('@');
      if (at < 2) return '•••@•••';
      return `${v[0]}${'•'.repeat(Math.min(at - 1, 6))}@${v.slice(at + 1)}`;
    }
    case 'address': {
      // Reveal only the country/city tail, mask the street.
      const parts = v.split(',').map(s => s.trim());
      if (parts.length <= 1) return '••• ' + (v.slice(-12) || '');
      return `••• ${parts.slice(-2).join(', ')}`;
    }
  }
}
