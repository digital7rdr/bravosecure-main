'use client';

import {useState} from 'react';

/**
 * IS-22 (audit 2026-08-07) — one-click copy for identities (booking / mission /
 * user / application ids, minted credentials). Deliberately style-neutral
 * (inline, inherits font/colour) so it drops into both console dialects.
 */
export function CopyId({value, title}: {value: string; title?: string}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (permissions / non-secure context) — leave the
      // affordance silent; the value is still visible on the page.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? 'Copied' : (title ?? `Copy ${value}`)}
      aria-label={title ?? 'Copy to clipboard'}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px',
        font: 'inherit', fontSize: '0.85em', lineHeight: 1, verticalAlign: 'baseline',
        color: copied ? 'var(--ok, #34d399)' : 'inherit', opacity: copied ? 1 : 0.55,
      }}>
      {copied ? '✓' : '⧉'}
    </button>
  );
}
