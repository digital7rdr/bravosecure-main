/**
 * B-337 — being removed from a group must REMOVE the group from your device.
 *
 * Founder report (2026-07-30): "if I remove someone from the group, that group
 * stays in his list — it should be gone. And when I add that person back he can
 * see all the previous messages we did; it should not be like that."
 *
 * Both halves are ONE defect. Removal only shrank the crypto roster and
 * appended a `member_removed` system line (B-255); the removed device kept:
 *   - the `conversations[groupId]` row → the group stayed in their chat list;
 *   - every persisted message for it → so a later re-add showed the WHOLE
 *     pre-removal transcript, defeating the point of the remove+rekey.
 *
 * The relay never backfills history to a re-added member (addGroupMember rekeys
 * precisely so a new member cannot read prior epochs), so the transcript the
 * founder saw was purely the LOCAL copy surviving removal. Purging on removal
 * therefore closes both symptoms with one change, and is strictly MORE
 * forward-secret than before.
 *
 * `applyGroupAdmin.ts` and `productionRuntime.ts` cannot be imported by the
 * node project (the whole receive path), so — like `receivePersistenceInvariants`
 * and `missionOpsRoomStaticScan` — these are comment-stripped source scans.
 * Both files are CRLF: nothing here is `\n`-anchored (a `\n` anchor matches
 * nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const adminSrc = (): string =>
  strip('src', 'modules', 'messenger', 'runtime', 'applyGroupAdmin.ts');
const runtimeSrc = (): string =>
  strip('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

describe('B-337 — the admin lane reports "I was removed"', () => {
  it('the REMOVE branch compares the removed user against ownUserId and signals', () => {
    const s = adminSrc();
    const at = s.indexOf("action.type === 'remove'");
    expect(at).toBeGreaterThan(-1);
    // Scoped to the remove region so an unrelated ownUserId use can't satisfy it.
    const region = s.slice(at, at + 1800);
    expect(region).toMatch(/action\.userId\s*===\s*deps\.ownUserId/);
    // Routed through the EXISTING group-key signal seam (as leave-rekey is), so
    // handleIncoming's parameter list is not widened — MESSAGE_LOOP §5.
    expect(region).toMatch(/emitGroupKeySignal\(\{\s*kind:\s*'purge-self-removed'/);
  });

  it('the dep type admits the new signal — a narrowed type would not compile', () => {
    expect(adminSrc()).toMatch(/kind:\s*'purge-self-removed';\s*groupId:\s*string/);
  });
});

describe('B-337 — the runtime purges the group on self-removal', () => {
  const region = (): string => {
    const s = runtimeSrc();
    const at = s.indexOf("sig.kind === 'purge-self-removed'");
    expect(at).toBeGreaterThan(-1);
    return s.slice(at, at + 2200);
  };

  it('drops BOTH the conversation row and the crypto state', () => {
    // The chat list is driven by the conversation row…
    expect(region()).toMatch(/removeConversation\(/);
    // …and leaving the master key behind would let surviving local ciphertext
    // keep decrypting (the missionOpsRoomStaticScan M3 lesson).
    expect(region()).toMatch(/removeGroupState\(/);
  });

  it('purges persisted messages AND the outbox, or the transcript survives a re-add', () => {
    // In-memory removal alone leaves SQLCipher rows that rehydrate on next boot
    // — which is exactly the "he can see all the previous messages" report.
    expect(region()).toMatch(/sqlMessages[\s\S]{0,120}deleteByConversation\(/);
    expect(region()).toMatch(/sqlOutbox[\s\S]{0,160}deleteByConversation\(/);
  });

  it('the signal union carries the kind, so the handler cannot silently go stale', () => {
    expect(runtimeSrc()).toMatch(/\|\s*\{kind:\s*'purge-self-removed';\s*groupId:\s*string\}/);
  });

  /**
   * B-339 — regression guard on B-337's own purge.
   *
   * The purge evicts the group's master key (`removeGroupState` clears the
   * in-process keyCache, Audit P1-G5) and deletes `conversations[groupId]`,
   * which `GroupCallScreen` reads. If a removal lands while THAT group's call
   * is live, the member loses the key their FrameCryptor is using and the row
   * their screen renders from — media dies but the call surface stays up, i.e.
   * "stuck in the call". Before B-337 they simply kept both.
   *
   * So the purge must eject from a live call for this group FIRST, then purge.
   */
  it('B-339: ejects from a LIVE call for this group before pulling its key/row', () => {
    const r = region();
    expect(r).toMatch(/getActiveGroupCall\(\)/);
    expect(r).toMatch(/endActiveGroupCall\(/);
    // The eject must be scoped to THIS group — ending an unrelated call would
    // be a far worse bug than the one being fixed.
    expect(r).toMatch(/conversationId\s*===\s*gid|gid\s*===\s*[a-zA-Z.]*conversationId/);
  });

  it('B-339: the eject is ordered BEFORE the store purge, not after', () => {
    const r = region();
    const endAt   = r.indexOf('endActiveGroupCall(');
    const purgeAt = r.indexOf('removeConversation(');
    expect(endAt).toBeGreaterThan(-1);
    expect(purgeAt).toBeGreaterThan(-1);
    expect(endAt).toBeLessThan(purgeAt);
  });
});
