/**
 * B-642 — every dead-boot exit owes the same cleanup.
 *
 * `useGroupCall`'s boot IIFE ends in a catch that performs four teardown steps.
 * THREE sites never reach it: the two FrameCryptor refusals (S6/B-111) and the
 * group-key-lane catch all `setState('failed')` and **`return`** rather than
 * throw. So the two steps that matter to them never ran:
 *
 *   - the B-343 media release, whose own comment calls the consequence
 *     *"the 'Call failed' loop"* — tracks are acquired at step 2, long before
 *     the key lane, and a bypassed release leaves the camera held, wedging
 *     every subsequent `getUserMedia`;
 *   - the BS-MINIMIZE-RING registry clear, whose comment names *"key-wait
 *     failure"* explicitly — i.e. exactly the site that could not reach it.
 *
 * The group-key-lane catch is the dominant failure in a mission Ops Room (a
 * keyless member re-throws after the 25 s wait), so this is the path a real
 * "Call failed" report takes.
 *
 * ── WHY THIS IS A SOURCE SCAN ─────────────────────────────────────────────
 *
 * These sites live inside one large `useEffect` IIFE that acquires media,
 * opens a WS, joins an SFU room and builds a mediasoup pipeline. No unit test
 * in this project drives that. The scan is therefore the gate — so it is
 * written to the house rules: comments are STRIPPED (prose containing the
 * banned token is the commonest false result in this repo), the split is
 * `\r?\n` (a `\n`-anchored regex passes VACUOUSLY on a CRLF file), and every
 * ordering assertion is anchored INSIDE the executing closure by its own warn
 * string rather than by a file-wide `indexOf` (a `lastIndexOf` scan once
 * matched a sibling function and passed vacuously — see CLAUDE.md).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HOOK = join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts');

/** Source with comment lines removed. Line-based, CRLF-safe. */
function stripped(): string {
  return readFileSync(HOOK, 'utf8')
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * The executing region that follows a site's own warn string, up to and
 * including its `return`. Anchoring on the warn text is what keeps this
 * pinned to the real closure rather than to any similarly-shaped sibling.
 */
function exitRegion(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) {throw new Error(`anchor not found (did the warn text change?): ${marker}`);}
  const rest = src.slice(at);
  const end = rest.indexOf('return;');
  if (end < 0) {throw new Error(`no return after anchor: ${marker}`);}
  return rest.slice(0, end + 'return;'.length);
}

/**
 * The BOOT-IIFE sites that set a terminal state and `return` without reaching
 * the outer catch, by their release-visible warns.
 *
 * ⚠️ SCOPE IS THE BOOT IIFE. `room_full` was missed by the first draft — it is
 * the same class (media held from step 2, same blocker card, no leave). The
 * mid-call exits (reconnect-budget exhaustion, and the transport handler that
 * fails before `joined`) are NOT boot-IIFE returns and are NOT covered here;
 * they are recorded as a known gap in `docs/planning/CLIENT_BATCH_2026-08-23.md`
 * rather than silently implied by a suite name.
 */
const BYPASS_SITES: ReadonlyArray<{name: string; marker: string}> = [
  {
    name: 'pre-join FrameCryptor refusal (S6/B-111)',
    marker: 'pre-join: FrameCryptor unavailable on this build',
  },
  {
    name: 'post-join FrameCryptor refusal (S6)',
    marker: 'step=3 FrameCryptor unavailable on this build',
  },
  {
    name: 'group-key lane catch — the dominant Ops Room failure',
    marker: 'step=3b FrameCryptor init failed',
  },
  {
    name: 'room_full',
    marker: 'step=3 FAIL room_full',
  },
];

describe('B-642 — a dead boot releases the camera and clears the bubble', () => {
  it.each(BYPASS_SITES)('$name calls releaseDeadBoot before returning', ({marker}) => {
    const region = exitRegion(stripped(), marker);
    expect(region).toContain('releaseDeadBoot()');
    // Ordering is the whole point: after the `return` it would never run.
    expect(region.indexOf('releaseDeadBoot()')).toBeLessThan(region.indexOf('return;'));
  });

  /**
   * The helper's body, bounded by its own closing `};` at column 4.
   *
   * ⚠️ NOT a byte count. The first draft used `slice(at, at + 900)`, which
   * overran the ~500-char helper by ~400 chars into the resume path — so
   * `toContain('getActiveGroupCall()')` could be satisfied by a call OUTSIDE
   * the helper, and the two `not.toContain` assertions would go false-RED the
   * moment unrelated code landed nearby. Both directions of wrong.
   */
  function helperBody(src: string): string {
    const at = src.indexOf('const releaseDeadBoot');
    if (at < 0) {throw new Error('releaseDeadBoot helper not found');}
    const rest = src.slice(at);
    const end = rest.indexOf('\n    };');
    if (end < 0) {throw new Error('helper close brace not found — did its indentation change?');}
    return rest.slice(0, end);
  }

  it('is defined INSIDE the boot effect, so it closes over the refs and the call key', () => {
    // Hoisted to module scope it would lose `groupKeyRef`/`audioTrackRef` and
    // the scan below would still pass — so pin the nesting, not just the text.
    const src = stripped();
    const at = src.indexOf('const releaseDeadBoot');
    const line = src.slice(src.lastIndexOf('\n', at) + 1, at + 'const releaseDeadBoot'.length);
    expect(line.startsWith('    const releaseDeadBoot')).toBe(true); // effect-body indentation
  });

  it('the helper stops BOTH tracks and drops the local stream (B-343)', () => {
    const body = helperBody(stripped());
    expect(body).toMatch(/audioTrackRef\.current\?\.stop\(\)/);
    expect(body).toMatch(/audioTrackRef\.current = null/);
    expect(body).toMatch(/videoTrackRef\.current\?\.stop\(\)/);
    expect(body).toMatch(/videoTrackRef\.current = null/);
    expect(body).toMatch(/setLocalStream\(null\)/);
  });

  /**
   * ⛔ THE ASSERTION THE FIRST DRAFT OF THIS TEST MISSED, and it was the single
   * most dangerous mutation available.
   *
   * The helper originally matched the registry entry on
   * `reg.conversationId === opts.conversationId`. That is NOT an identity:
   * several rooms and several generations share one conversation, and
   * `launchCall` EXPLICITLY permits a second call in the same group
   * (`rejoiningOwnGroup`). A boot stuck in the 25 s key wait would therefore
   * have ended the call the user started AFTERWARDS. `leaveInternal` already
   * learned this (WI-1.5, `useGroupCall.ts:5675`).
   *
   * Deleting the guard left every other assertion green, so it is pinned
   * explicitly here.
   */
  it('ends the registry entry ONLY when it is THIS boot (roomId + gen), never by conversation', () => {
    const body = helperBody(stripped());
    expect(body).toContain('groupKeyRef.current');
    expect(body).toMatch(/reg\.roomId === ours\.roomId/);
    expect(body).toMatch(/reg\.gen === ours\.gen/);
    expect(body).toContain('endActiveGroupCall(reg.roomId)');
    // The weaker test must not come back.
    expect(body).not.toContain('conversationId');
  });

  it('does NOT stop tracks a NEWER registry entry has adopted', () => {
    // The resume path adopts the previous instance's track OBJECTS and inherits
    // its gen, so a stale twin must not stop the live call's mic/camera.
    const body = helperBody(stripped());
    expect(body).toMatch(/reg\.audioTrack === audioTrackRef\.current/);
    expect(body).toMatch(/reg\.videoTrack === videoTrackRef\.current/);
  });

  it('the helper does NOT emit its own sfu.leave — the call sites own that', () => {
    // Each bypass site already sends `sfu.leave` with its own roomId. A second
    // leave from here risks the roomId-less path, where the gateway drops EVERY
    // tag on the socket.
    expect(helperBody(stripped())).not.toContain('sfu.leave');
  });

  it('every sfu.leave at a bypass site still names its roomId', () => {
    const src = stripped();
    for (const {marker} of BYPASS_SITES) {
      const region = exitRegion(src, marker);
      if (region.includes('sfu.leave')) {
        expect(region).toMatch(/sfu\.leave',\s*\{roomId:/);
      }
    }
  });

  it('does not reap the room from the helper — that guard stays where it is', () => {
    // The reap is guarded by `neverJoined`; relaxing it so a JOINED failure
    // "leaves properly" makes the frame take the gateway's host path with
    // hostTerminatesRoom and evict every peer in the room.
    //
    // ⚠️ This asserts only that the helper does not take that decision. It
    // deliberately does NOT assert the reap is unnecessary — at the pre-join
    // site `neverJoined` really is true, so a room can still be left behind
    // there. An earlier version of this test cemented the opposite claim.
    const src = stripped();
    expect(src).toMatch(/const neverJoined = !participantTagRef\.current/);
    const body = helperBody(src);
    expect(body).not.toContain('neverJoined');
    expect(body).not.toContain('endRoomIfEmptyByHost');
  });

  /**
   * ⛔ The guard that makes the whole helper safe after a real teardown.
   *
   * `cancelled` is set only in the cleanup's REAL branch, which runs
   * `leaveInternal` — that already stops both refs and nulls the slot under its
   * own gen check. So past that point the helper has nothing to do, and before
   * the gen guard existed it could actively end a healthy retry call. The
   * MINIMIZE path returns from the cleanup before setting `cancelled`, so the
   * case this helper exists for is unaffected.
   */
  it('bails out entirely once the effect was really torn down', () => {
    const body = helperBody(stripped());
    expect(body).toMatch(/if \(cancelled\) \{return;\}/);
    // …and it must be the FIRST thing, before any registry read or track stop.
    expect(body.indexOf('if (cancelled)')).toBeLessThan(body.indexOf('getActiveGroupCall()'));
    expect(body.indexOf('if (cancelled)')).toBeLessThan(body.indexOf('audioTrackRef.current?.stop()'));
  });
});
