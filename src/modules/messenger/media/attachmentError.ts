/**
 * Media-parity M17 (2026-07-03) — attachment failure classification,
 * kept in its own tiny module (no RNFS/runtime imports) so it can be
 * unit-tested and reused without dragging in native modules.
 */

import {MediaHttpError} from './mediaClient';
import {NoFreeSpaceError} from './freeSpace';

export type AttachmentErrorReason = 'forbidden' | 'gone' | 'offline' | 'no_space' | 'unavailable';

/** Map a download failure to a user-facing reason class. */
export function classifyAttachmentError(e: unknown): AttachmentErrorReason {
  // MD-08 — the proactive precheck, plus the reactive write failure the
  // filesystem reports when the disk fills mid-write.
  if (e instanceof NoFreeSpaceError) {return 'no_space';}
  if (e instanceof MediaHttpError) {
    if (e.status === 403) {return 'forbidden';}
    if (e.status === 404) {return 'gone';}
    if (e.status === 0)   {return 'offline';}
    return 'unavailable';
  }
  const msg = e instanceof Error ? e.message : '';
  if (/enospc|no space|disk full/i.test(msg)) {return 'no_space';}
  if (/network|abort|timeout|failed to fetch/i.test(msg)) {return 'offline';}
  return 'unavailable';
}

/** Human copy for each failure class — shared by bubble + viewer. */
export function attachmentErrorText(reason: AttachmentErrorReason | null): string {
  switch (reason) {
    case 'forbidden': return 'No access — ask the sender to resend';
    case 'gone':      return 'Expired — ask the sender to resend';
    case 'offline':   return 'No connection — tap to retry';
    case 'no_space':  return 'Not enough storage — free up space';
    default:          return 'Tap to retry';
  }
}
