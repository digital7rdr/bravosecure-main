/**
 * 2026-08-12 group-call entry contract — three founder-reported symptoms,
 * root-caused from a 3-device logcat capture.
 *
 * These are SOURCE SCANS, not unit tests, and deliberately so: none of the
 * three files below can be imported by the node Jest project (launchCall
 * pulls React Navigation, CallScreen mounts an RN tree with the WebRTC /
 * InCallManager native surface, useGroupCall is the hook itself — the same
 * precedent as CallScreen.deadOffer.test.ts and inAppRingOwnership.test.ts).
 * A green unit suite has never been able to see any of this code.
 *
 * House rules for scans in this repo, all of which have cost a session:
 *  - strip comments BEFORE any assertion, or the prose explaining a bug
 *    satisfies a scan looking for the bug's fix;
 *  - these files are CRLF, so a \n-anchored regex matches nothing and the
 *    test passes VACUOUSLY — everything here is line-based;
 *  - anchor at the DECISION SITE, never "the token exists somewhere in the
 *    file". Each assertion below slices to the exact region first.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * Line-based comment strip. Deliberately NOT the regex stripper used
 * elsewhere in this repo — that one treats `/*` inside a string or inside a
 * `//` line as a block-comment opener and has silently deleted up to 241
 * lines of REAL code, which makes every absence assertion downstream pass
 * over code that is present (see src/__tests__/sourceScanSafety.test.ts).
 */
function stripComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out;
}

function codeLines(rel: string): string[] {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

/** Index of the first line matching `re`, or -1. */
function lineIndex(lines: string[], re: RegExp): number {
  return lines.findIndex(l => re.test(l));
}

describe('symptom 2 — "others start a call and nobody gets the ring"', () => {
  /**
   * launchCall decided ring-vs-join from whether the server returned a room
   * ID AT ALL. The server hands out a zero-participant room for a 30s grace,
   * and a boot that dies before sfu.join leaves exactly that corpse — so the
   * second person to tap Call was handed a dead room, flipped to
   * direction:'incoming', and rang NOBODY while their own screen said they
   * had started a call. `direction` is the sole gate on the boot ring.
   *
   * The admin looked special only because they habitually tapped first.
   */
  const LAUNCH = 'src/modules/messenger/webrtc/launchCall.ts';

  it('decides direction from room LIVENESS, not from room existence', () => {
    const lines = codeLines(LAUNCH);
    const navAt = lineIndex(lines, /nav\.navigate\('GroupCallScreen'/);
    expect(navAt).toBeGreaterThan(-1);

    // The decision site: the navigate call's own argument object.
    const region = lines.slice(navAt, navAt + 30).join('\n');
    const directionLine = region.split('\n').find(l => /^\s*direction:/.test(l));
    expect(directionLine).toBeDefined();

    // Must key on the liveness flag the server now returns...
    expect(directionLine).toMatch(/live\??\.live/);
    // ...and must NOT key on mere existence of a room id. This is the exact
    // pre-fix expression; if it comes back, so does the silent call.
    expect(directionLine).not.toMatch(/liveRoomId\s*\?/);
  });

  it('treats a relay that omits `live` as NOT live, so an old server still rings', () => {
    // Defaulting the other way would reinstate the bug against any relay
    // that has not been redeployed yet. A redundant ring is harmless (the
    // server strips self + duplicates); a missing one is the bug.
    const lines = codeLines(LAUNCH);
    const at = lineIndex(lines, /return \{roomId: body\.roomId/);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at]).toMatch(/live:\s*body\.live === true/);
  });
});

describe('symptom 3 — "the 1:1 became a group call and the other person cannot enter"', () => {
  /**
   * B-301 keeps the 1:1 alive across the escalation so a failure has
   * something to roll back to — but it stopped releasing the CAMERA, which
   * the group boot immediately asks for. rn-webrtc serialises camera opens,
   * so the boot queues behind a holder that never lets go, dies at the 15s
   * bound, and because the boot ring is sent AFTER sfu.join, nobody is rung.
   *
   * Before 0bc67a62 this was masked by a `liveCall.hangup()` that stopped
   * both tracks. Removing the hangup was right; dropping the device release
   * with it was not.
   */
  const CALLSCREEN = 'src/screens/messenger/CallScreen.tsx';

  it('releases the 1:1 camera BEFORE replacing the screen with the group call', () => {
    const lines = codeLines(CALLSCREEN);
    const anchorAt = lineIndex(lines, /const pendingDirectCallId/);
    const replaceAt = lineIndex(lines, /navigation\.replace\('GroupCallScreen'/);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(replaceAt).toBeGreaterThan(anchorAt);

    // Ordering is the whole point — a release AFTER the replace is useless,
    // because this screen is unmounted by then.
    const between = lines.slice(anchorAt, replaceAt).join('\n');
    expect(between).toMatch(/videoTrack:\s*null/);
    expect(between).toMatch(/isVideoOff:\s*true/);
    expect(between).toMatch(/\.stop\(\)/);
  });

  it('does NOT release the mic — that would mute a call that is still live', () => {
    /**
     * The 1:1 is the rollback target. Killing its audio would silently break
     * a working call to fix a camera contention. Camera-off is visible and
     * recoverable; a dead mic is neither.
     */
    const lines = codeLines(CALLSCREEN);
    const anchorAt = lineIndex(lines, /const pendingDirectCallId/);
    const replaceAt = lineIndex(lines, /navigation\.replace\('GroupCallScreen'/);
    const between = lines.slice(anchorAt, replaceAt).join('\n');

    expect(between).not.toMatch(/audioTrack\s*\.\s*stop\(\)/);
    expect(between).not.toMatch(/audioTrack:\s*null/);
  });
});

describe('the corpse supply — a dead boot must release the room it created', () => {
  /**
   * Boot order is create-room (step 1) → acquire media (step 2) → join
   * (step 3). Any failure in between leaves a server-side room with this
   * user as host and nobody in it, and nothing reaped it: sfu.leave matched
   * no participant tag because we never joined. The server then advertised
   * that corpse to every other member for its fresh-room grace — which is
   * what manufactured the rooms symptom 2 tripped over.
   */
  const HOOK = 'src/modules/messenger/webrtc/useGroupCall.ts';

  it('sends sfu.leave from the boot-failure path', () => {
    const lines = codeLines(HOOK);
    const catchAt = lineIndex(lines, /\[useGroupCall\] boot failed:/);
    expect(catchAt).toBeGreaterThan(-1);

    // Bounded slice so this cannot be satisfied by leaveInternal's own
    // sfu.leave hundreds of lines away.
    const region = lines.slice(catchAt, catchAt + 45).join('\n');
    expect(region).toMatch(/'sfu\.leave'/);
  });

  it('still releases the camera/mic on that same path (B-343 must not regress)', () => {
    const lines = codeLines(HOOK);
    const catchAt = lineIndex(lines, /\[useGroupCall\] boot failed:/);
    const region = lines.slice(catchAt, catchAt + 45).join('\n');
    expect(region).toMatch(/audioTrackRef\.current\?\.stop\(\)/);
    expect(region).toMatch(/videoTrackRef\.current\?\.stop\(\)/);
  });

  it('sends the leave AFTER the ring-cancel, never before', () => {
    /**
     * Ordering is load-bearing and the first version got it wrong.
     * Leaving DELETES the room, and `sfu.ring.cancel` is host-gated on a
     * room that still exists — so reaping first made the cancel fail
     * `not_host` and everyone we had already rung kept ringing the full
     * 30s window at a room that no longer existed.
     */
    const lines = codeLines(HOOK);
    const catchAt = lineIndex(lines, /\[useGroupCall\] boot failed:/);
    const after = lines.slice(catchAt);
    const cancelAt = after.findIndex(l => /sendRingCancelFrame\(/.test(l));
    const leaveAt  = after.findIndex(l => /'sfu\.leave'/.test(l));
    expect(cancelAt).toBeGreaterThan(-1);
    expect(leaveAt).toBeGreaterThan(-1);
    expect(leaveAt).toBeGreaterThan(cancelAt);
  });

  it('only releases the room when we NEVER joined, and only on an open socket', () => {
    /**
     * With a participant tag the frame takes the gateway's normal tag path,
     * which runs `hostTerminatesRoom` — so a boot that threw after a peer
     * had already answered would evict that peer from a working call.
     *
     * And it must not go through `wsRequest`, which parks up to 10s waiting
     * for the socket: a boot failure is exactly when the socket is likely
     * down, and a frame that lands minutes later reaps the room the user's
     * own retry has since created (createRoom is idempotent in the grace,
     * so the retry reuses that id).
     */
    const lines = codeLines(HOOK);
    const catchAt = lineIndex(lines, /\[useGroupCall\] boot failed:/);
    const after = lines.slice(catchAt);
    const leaveAt = after.findIndex(l => /'sfu\.leave'/.test(l));
    const guard = after.slice(Math.max(0, leaveAt - 12), leaveAt + 2).join('\n');

    expect(guard).toMatch(/!participantTagRef\.current/);
    expect(guard).toMatch(/state\s*===\s*'connected'/);
    // Direct emit, NOT the parking helper.
    expect(after[leaveAt]).toMatch(/emitWithAck/);
    expect(after[leaveAt]).not.toMatch(/wsRequest/);
  });
});

describe('a vanished room must not cost the second caller their call', () => {
  /**
   * The by-conversation probe hands out a room before anyone is in it, and
   * the creator's own boot can fail and reap it during the 2-10s the second
   * caller spends acquiring media. Without recovery that caller just gets
   * "Call failed" — the same dead end, one layer along.
   */
  const HOOK = 'src/modules/messenger/webrtc/useGroupCall.ts';

  it('re-creates the room ONCE and retries the join, for an outgoing boot only', () => {
    const lines = codeLines(HOOK);
    const at = lineIndex(lines, /step=3 room vanished/);
    expect(at).toBeGreaterThan(-1);

    const before = lines.slice(Math.max(0, at - 8), at).join('\n');
    // Gated on the error AND on the user having tapped Call. An incoming
    // boot must never mint a room (P1-BR-1) — its room belongs to the host.
    expect(before).toMatch(/room_not_found/);
    expect(before).toMatch(/opts\.direction !== 'outgoing'/);

    /**
     * Anchored on the retry marker, not a fixed line count from the start.
     * A `+20`-line window broke the moment the retry legitimately grew the
     * re-pointing block below — the same slide that hit
     * escalationRouteHandoff. Bound the region by the two real markers.
     */
    const retryAt = lines.findIndex((l, i) => i > at && /step=3 retry sfu\.join/.test(l));
    expect(retryAt).toBeGreaterThan(at);
    const region = lines.slice(at, retryAt).join('\n');
    expect(region).toMatch(/sfu\/rooms/);
  });

  it('re-points every room-scoped binding at the room it actually joined', () => {
    /**
     * The retry changes `rid` AFTER the pre-join bindings were made against
     * the room that has since been reaped. `registerSfuHandler` keys
     * strictly on roomId, so leaving it pointed at the dead room means the
     * device joins the new one and then receives NONE of its frames — no
     * new-producer, no participant.left, no room.ended. It would connect to
     * a grid that never populates: the original symptom, recreated by the
     * recovery for it.
     */
    const lines = codeLines(HOOK);
    const at = lineIndex(lines, /step=3 room vanished/);
    const retryAt = lines.findIndex((l, i) => i > at && /step=3 retry sfu\.join/.test(l));
    const region = lines.slice(at, retryAt).join('\n');

    expect(region).toMatch(/cleanupSubRef\.current\?\.\(\)/);
    expect(region).toMatch(/registerFramesFor\(rid\)/);
    expect(region).toMatch(/markPresenceSent\(rid/);
    // WI-1.5 — the registry re-point is now an explicit rename keyed on the id
    // the registry actually HOLDS. `patchActiveGroupCall(rid, {roomId: rid})`
    // would be a silent no-op (the slot still says the reaped room) and strand
    // the entry exactly as this test exists to prevent.
    expect(region).toMatch(/renameActiveGroupCallRoom\(priorRid, rid\)/);
    // …and `priorRid` must be captured BEFORE `rid` moves to the new room, or
    // it holds the new id and the rename keys itself against its own target.
    const capturedAt   = region.indexOf('const priorRid = rid;');
    const reassignedAt = region.indexOf('rid = reBody.roomId;');
    expect(capturedAt).toBeGreaterThan(-1);
    expect(reassignedAt).toBeGreaterThan(capturedAt);
  });
});

describe('host authority is never assumed before the server grants it', () => {
  const HOOK = 'src/modules/messenger/webrtc/useGroupCall.ts';

  it('seeds the registry isHost FALSE rather than inferring it from direction', () => {
    /**
     * "outgoing" used to imply "I created this room". It no longer does — a
     * caller handed an existing room also boots outgoing — so inferring host
     * from it showed host-only controls for a call the user does not own.
     */
    const lines = codeLines(HOOK);
    const seedAt = lineIndex(lines, /isHost:\s*false,/);
    expect(seedAt).toBeGreaterThan(-1);
    expect(lines.some(l => /isHost:\s*opts\.direction === 'outgoing'/.test(l))).toBe(false);
  });
});

describe('release-visible diagnostics', () => {
  /**
   * Every lane of the 2026-08-12 investigation had to infer whether a device
   * CREATED a room or JOINED an existing one, because both markers were
   * console.log and babel strips `log` in release while keeping `warn`.
   * That single missing bit cost hours across four parallel investigations.
   */
  const HOOK = 'src/modules/messenger/webrtc/useGroupCall.ts';

  it('logs create-vs-join at warn level so a release build shows it', () => {
    const lines = codeLines(HOOK);
    const created = lines.find(l => /step=1 room created/.test(l));
    const joining = lines.find(l => /step=1 joining existing room/.test(l));
    expect(created).toBeDefined();
    expect(joining).toBeDefined();
    expect(created).toMatch(/console\.warn/);
    expect(joining).toMatch(/console\.warn/);
    // The join marker must say WHICH direction it took — that is the bit
    // that distinguishes a silent join from a ringing one.
    expect(joining).toMatch(/direction=/);
  });
});
