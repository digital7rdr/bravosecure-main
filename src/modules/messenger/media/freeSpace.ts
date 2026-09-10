/**
 * MD-08 — proactive free-disk-space probes.
 *
 * Two consumers, two postures:
 *  - media download (`assertFreeSpaceFor`): throws `NoFreeSpaceError` BEFORE
 *    spending network + decrypt on bytes the disk cannot hold; the bubble
 *    surfaces it as the 'no_space' attachmentError reason.
 *  - restore start (`lowSpaceWarning`): WARN-ONLY. BACKUP_LOOP forbids new
 *    restore dead-end classes, so a low-disk restore surfaces the existing
 *    error banner and PROCEEDS (an interrupted restore already heals via the
 *    boot resume).
 *
 * Both FAIL OPEN: a probe that cannot read the free-space number must never
 * block anything. expo-file-system's API split (legacy vs Paths) is handled
 * defensively for the same reason.
 */

export class NoFreeSpaceError extends Error {
  constructor(
    public readonly neededBytes: number,
    public readonly freeBytes: number,
  ) {
    // Numbers only — never a filename or key (logAudit posture).
    super(`insufficient_storage need=${neededBytes} free=${freeBytes}`);
    this.name = 'NoFreeSpaceError';
  }
}

/** Never fill the disk to the brim — the OS and SQLCipher need working room. */
export const FREE_SPACE_HEADROOM_BYTES = 50 * 1024 * 1024;

/** Restore-start warning floor (headroom ×2 — history + media cache both grow). */
export const RESTORE_LOW_SPACE_BYTES = FREE_SPACE_HEADROOM_BYTES * 2;

async function readFreeBytes(): Promise<number | null> {
  // expo-file-system 19 split the API: the legacy entry keeps
  // getFreeDiskStorageAsync; the new one exposes Paths.availableDiskSpace.
  // Probe both shapes; any miss reads as "unknown" (fail open).
  try {
    const legacy = require('expo-file-system/legacy') as {getFreeDiskStorageAsync?: () => Promise<number>};
    if (typeof legacy?.getFreeDiskStorageAsync === 'function') {
      return await legacy.getFreeDiskStorageAsync();
    }
  } catch { /* fall through */ }
  try {
    const fs = require('expo-file-system') as {
      getFreeDiskStorageAsync?: () => Promise<number>;
      Paths?: {availableDiskSpace?: number};
    };
    if (typeof fs?.getFreeDiskStorageAsync === 'function') {
      return await fs.getFreeDiskStorageAsync();
    }
    const avail = fs?.Paths?.availableDiskSpace;
    if (typeof avail === 'number') {return avail;}
  } catch { /* fall through */ }
  return null;
}

/**
 * Throws `NoFreeSpaceError` when the disk clearly cannot hold `bytes` plus
 * the headroom. Unknown size still guards a near-full disk (headroom-only).
 * Fail OPEN: probe failures resolve silently.
 */
export async function assertFreeSpaceFor(bytes?: number): Promise<void> {
  let free: number | null = null;
  try {
    free = await readFreeBytes();
  } catch {
    return;
  }
  if (typeof free !== 'number' || !Number.isFinite(free) || free <= 0) {return;}
  const need = Math.max(0, bytes ?? 0) + FREE_SPACE_HEADROOM_BYTES;
  if (free < need) {
    throw new NoFreeSpaceError(need, free);
  }
}

/**
 * Warn-only probe: the free byte count when it is below `minBytes`, else
 * null. Fail OPEN: unknown reads as "not low".
 */
export async function lowSpaceWarning(minBytes: number = RESTORE_LOW_SPACE_BYTES): Promise<number | null> {
  try {
    const free = await readFreeBytes();
    if (typeof free === 'number' && Number.isFinite(free) && free > 0 && free < minBytes) {
      return free;
    }
  } catch { /* fail open */ }
  return null;
}
