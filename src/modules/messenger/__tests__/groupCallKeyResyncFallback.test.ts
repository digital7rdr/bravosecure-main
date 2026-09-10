/**
 * B-340 (companion) — the purged-member self-heal Catch-22.
 *
 * B-337's purge deletes conversations[gid] AND groups[gid]. If the re-add's
 * owner-signed create is ever lost (owner offline, envelope dropped), the
 * re-added member's in-call self-heal `requestGroupKeyResync(conversationId)`
 * silently no-ops: selectKeyResyncCandidates admits the gid, but
 * resolveKeyRequestTargets gets NO participants (row purged) and NO fallback
 * peer — `continue` — so the joiner waits out the full 25 s key window and the
 * call dies with nobody ever asked for the key.
 *
 * The ring already told the joiner who the host is. The fix hands the host to
 * the resync as the fallback target, which resolveKeyRequestTargets was BUILT
 * to accept (the §"Catch-22 fix" in requestGroupKeyResyncImpl).
 *
 * useGroupCall.ts cannot be imported by this Jest project (it mounts RN/WebRTC
 * hooks), so per the repo's static-scan convention this pins the SOURCE. The
 * file is CRLF — no \n-anchored regexes (CLAUDE.md messenger-gate trap).
 */
import * as fs from 'fs';
import * as path from 'path';

const HOOK = fs.readFileSync(
  path.join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8');
const RUNTIME_TYPE = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'runtime.ts'), 'utf8');

/** Comment-stripped copy for absence/shape assertions (repo scan rule). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('B-340 — joiner key-resync passes the ring host as fallback peer', () => {
  test('the runtime contract exposes the fallback-peer parameter', () => {
    expect(RUNTIME_TYPE).toMatch(
      /requestGroupKeyResync\?\(\s*groupId\?:\s*string,\s*fallbackPeer\?:/,
    );
  });

  test('the JOINER key-wait resync hands over opts.hostUserId', () => {
    const src = stripComments(HOOK);
    // Anchor on the joiner branch's wait: the resync call between the
    // "!joined.isHost && !hasKey()" gate and waitForGroupCallKey must carry
    // a hostUserId-derived fallback.
    const joinerIdx = src.indexOf('!joined.isHost && !hasKey()');
    expect(joinerIdx).toBeGreaterThan(-1);
    const windowSrc = src.slice(joinerIdx, joinerIdx + 2500);
    const call = windowSrc.match(/requestGroupKeyResync\(([\s\S]*?)\)\.catch/);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/hostUserId/);
  });

  test('the fallback is userId+deviceId shaped, not a bare string', () => {
    const src = stripComments(HOOK);
    expect(src).toMatch(/hostUserId,\s*deviceId:\s*1/);
  });
});
