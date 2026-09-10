/**
 * sqa.md bug register — this suite pins: B-162, B-164, B-183.
 *
 * BUG-A defer-publish reset = B-162 · BUG-C background msg-wake restore-mode gate = B-164 · BUG-8 H-2 marker armed in the identity phase = B-183.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BR-1 / audit 2026-07-23 — static source scans for the backup screens,
 * push handler, and boot path. These files cannot be imported by the
 * node Jest project (react-native / navigation), so — per the messenger
 * regression contract — the wiring that fixed screen-level bugs is
 * pinned by scanning the source itself:
 *
 *   • BUG-A — every exit from the deferred-bundle-publish window resets
 *     the flag (a leak left the fresh identity unpublished → silent
 *     inbound loss for the rest of the session).
 *   • BR-1 — both restore entry points hand the message walk to the
 *     background runner and no longer run restoreAllMessages inline.
 *   • BUG-6/B-3 — both forget/wipe paths tear down the live mirror and
 *     stop the background runner; I5 (ledger purge) still holds.
 *   • BUG-C — the BACKGROUND msg-wake runtime boot is restore-mode
 *     gated (the foreground guard alone shipped the Round-8 loss).
 *   • BR-2 — boot arms restore mode before navigating into the RESTORE
 *     gate and has the silent RESTORE-RESUME-AUTO lane.
 *
 * Scan rules (learned the hard way — see CLAUDE.md):
 *   • comments are STRIPPED before any assertion (prose mentioning a
 *     banned symbol is the #1 false-result source here);
 *   • these files are CRLF — all scanning is line-based, never
 *     \n-anchored regex.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');

function stripComments(src: string): string {
  // Block comments first (multiline), then line comments. String
  // literals containing '//' (URLs) are rare in these files and none of
  // the scanned tokens appear in them.
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

function loadStripped(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

describe('backup wiring — static source scans', () => {
  const restoreScreen = loadStripped('src/screens/messenger/BackupRestoreScreen.tsx');
  const setupScreen   = loadStripped('src/screens/messenger/BackupSetupScreen.tsx');
  const fcm           = loadStripped('src/modules/messenger/push/fcmBootstrap.ts');
  const boot          = loadStripped('src/modules/messenger/backup/backupBoot.ts');

  it('BR-1 — both entry points hand off to the background runner and navigate home', () => {
    expect(count(restoreScreen, 'startBackgroundRestore(')).toBeGreaterThanOrEqual(1);
    expect(restoreScreen).toContain("navigation.replace('MessengerHome')");
    expect(count(setupScreen, 'startBackgroundRestore(')).toBeGreaterThanOrEqual(1);
    expect(setupScreen).toContain("navigation.replace('MessengerHome')");
  });

  it('BR-1 — no screen runs the message walk inline any more', () => {
    expect(restoreScreen).not.toContain('restoreAllMessages(');
    expect(setupScreen).not.toContain('restoreAllMessages(');
  });

  it('BUG-A — every exit from the deferred-publish window resets the flag', () => {
    // One arm (true) and at least three resets: runtime-boot catch,
    // store-null early return, restoreBackup catch, publish finally.
    expect(count(restoreScreen, 'setDeferBundlePublish(true)')).toBe(1);
    expect(count(restoreScreen, 'setDeferBundlePublish(false)')).toBeGreaterThanOrEqual(3);
  });

  it('BUG-8 — the H-2 marker is armed in the identity phase, not only when the walk starts', () => {
    expect(count(restoreScreen, 'markRestoreIncomplete(')).toBeGreaterThanOrEqual(1);
    expect(count(setupScreen, 'markRestoreIncomplete(')).toBeGreaterThanOrEqual(1);
  });

  it('BUG-6/B-3 + I5 — both wipe paths stop the runner, tear down the mirror, and purge the ledger', () => {
    for (const src of [restoreScreen, setupScreen]) {
      expect(count(src, 'stopBackgroundRestore()')).toBeGreaterThanOrEqual(1);
      expect(count(src, 'resetMirrorForWipe()')).toBeGreaterThanOrEqual(1);
      expect(count(src, 'clearFlushedForOwner')).toBeGreaterThanOrEqual(1);
    }
    // BUG-6 — the rotation path also kills in-flight old-key flushes.
    expect(count(setupScreen, 'resetMirrorForWipe()')).toBeGreaterThanOrEqual(2);
  });

  it('BUG-C — the background msg-wake runtime boot is restore-mode gated', () => {
    // Foreground guard + bg call-ring guard existed; the bg msg-wake pull
    // makes at least three sites consulting the flag.
    expect(count(fcm, 'isRestoreModeActive()')).toBeGreaterThanOrEqual(3);
  });

  it('BR-2 — boot arms restore mode at the RESTORE gate and has the silent resume lane', () => {
    expect(count(boot, 'setRestoreModeActive(true)')).toBeGreaterThanOrEqual(1);
    expect(boot).toContain('RESTORE-RESUME-AUTO');
    expect(count(boot, 'startBackgroundRestore(')).toBeGreaterThanOrEqual(1);
  });

  it('MessengerHome renders the restore banner', () => {
    const home = loadStripped('src/screens/messenger/MessengerHomeScreen.tsx');
    expect(home).toContain('<RestoreActivityBanner />');
  });
});
