'use client';

import {useEffect, useState, type ReactNode} from 'react';

/**
 * IS-15 (audit 2026-08-07) — the one confirm-with-reason dialog. Replaces every
 * remaining window.prompt on destructive actions: validated reason, explicit
 * confirm step, ESC/backdrop cancel, busy lock. Tailwind layout + design-system
 * color tokens (IS-10) — same surface/ink as the token-dialect cards.
 */
export interface ConfirmReasonModalProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Render a reason field with this label; omit for a plain confirm. */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Reason is required (min length below) — default true when a reason field renders. */
  reasonRequired?: boolean;
  minReasonLength?: number;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function ConfirmReasonModal({
  open, title, description, reasonLabel, reasonPlaceholder,
  reasonRequired = true, minReasonLength = 3,
  confirmLabel, danger, busy, onConfirm, onCancel,
}: ConfirmReasonModalProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const needsReason = !!reasonLabel && reasonRequired;
  const valid = !needsReason || reason.trim().length >= minReasonLength;

  return (
    <div
      onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-md rounded-xl border bg-s2 shadow-2xl ${danger ? 'border-err/40' : 'border-bd1'}`}>
        <div className="border-b border-bd2 px-5 py-4">
          <div className={`text-xs font-bold uppercase tracking-widest ${danger ? 'text-err' : 'text-t3'}`}>
            Bravo Ops · Confirm
          </div>
          <div className="mt-1 text-lg font-bold text-t1">{title}</div>
          {description && <div className="mt-2 text-sm leading-relaxed text-t3">{description}</div>}
        </div>

        {reasonLabel && (
          <div className="px-5 py-4">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3">
              {reasonLabel}{needsReason ? '' : ' (optional)'}
            </div>
            <textarea
              autoFocus
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={reasonPlaceholder}
              maxLength={1024}
              rows={3}
              className="w-full resize-y rounded-lg border border-bd1 bg-s3 px-3 py-2 text-sm text-t1 placeholder:text-t3"
            />
            {needsReason && (
              <div className="mt-1 text-[10px] text-t3">
                {reason.trim().length} chars · min {minReasonLength} to confirm
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3.5">
          <button
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
            CANCEL
          </button>
          <button
            disabled={busy || !valid}
            onClick={() => onConfirm(reason.trim())}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
              danger ? 'bg-err-solid text-white hover:bg-err-solid/80' : 'bg-ok text-canvas hover:bg-ok/80'
            }`}>
            {busy ? 'WORKING…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
