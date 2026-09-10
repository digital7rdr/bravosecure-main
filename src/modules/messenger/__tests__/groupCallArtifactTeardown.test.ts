/**
 * B-595 — the artifacts a GROUP call leaves behind, and who is required to
 * clear them.
 *
 * The founder's "we end the call and the call thing is still in the
 * notification" had TWO independent causes, and only one of them is about the
 * foreground service:
 *
 *  1. The End button called `call.leave()` and NOT `endActiveGroupCall`, so the
 *     single funnel that owns every external artifact was never reached.
 *  2. RNCallKeep's Telecom connection — raised by `reportIncomingCall(roomId)`
 *     on BOTH group ring lanes (backgrounded `fcmBootstrap`, killed
 *     `fcmHeadless`) — posts its own ongoing "call in progress" notification,
 *     and `reportEnded` is the ONLY thing that removes it. It had ZERO group
 *     call sites: the 1:1 registry ended its connection, the group registry
 *     never did.
 *
 * These are wiring facts across RN screens and a native bridge that no node
 * test can mount, so they are pinned as a source scan. Comments are stripped
 * first: every rule below is also stated in prose beside the code, and matching
 * the prose would pass vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const REGISTRY = join('src', 'modules', 'messenger', 'runtime', 'groupCallRegistry.ts');
const SCREEN   = join('src', 'screens', 'messenger', 'GroupCallScreen.tsx');
const INCOMING = join('src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx');

/** Line-based strip — the house block-comment regex eats code holding `/*`. */
function code(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('the scan reads real code', () => {
  it.each([REGISTRY, SCREEN, INCOMING])('%s is non-trivial', rel => {
    expect(code(rel).length).toBeGreaterThan(2_000);
  });
});

describe('the End button reaches the teardown funnel', () => {
  it('hangup ends through the REGISTRY, not `call.leave()` alone', () => {
    /**
     * The mutation this catches: reverting `hangup` to `await call.leave()`
     * leaves every artifact — ring card, Telecom connection, incoming payload,
     * push notify, audio session, foreground service — to a screen cleanup that
     * owns only two of them.
     */
    const src = code(SCREEN);
    expect(src).toMatch(/const hangup = useCallback\(async \(\) => \{[\s\S]{0,1400}endActiveGroupCall\(/);
  });

  it('…and ALWAYS leaves, whatever the registry answered', () => {
    /**
     * The review caught this: `endActiveGroupCall` returns `'ended'` having
     * cleaned NOTHING when the slot is null, and the entry is not published
     * until after `getLocalMedia()`. Ending in that window skipped `leave()`,
     * left `isLeavingRef` unset, and the boot went on to JOIN THE SFU with a
     * hot mic and no screen. `leave()` is idempotent, so it is unconditional.
     */
    const src = code(SCREEN);
    const hangup = src.slice(src.indexOf('const hangup = useCallback'));
    const end = hangup.indexOf('endActiveGroupCall(');
    const leave = hangup.indexOf('await call.leave()');
    expect(end).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(end);
    // Not conditional on an outcome — that was the hole.
    expect(hangup.slice(0, leave)).not.toMatch(/outcome === 'refused'/);
  });

  it('ends KEYED, never "end whatever is live"', () => {
    // WI-1.5: omitting the room id is not a convenience — an unkeyed End from
    // a screen with no room yet tears down whatever call took the slot.
    const src = code(SCREEN);
    expect(src).toMatch(/if \(call\.roomId\) \{ await endActiveGroupCall\(call\.roomId\); \}/);
    expect(src).not.toMatch(/endActiveGroupCall\(call\.roomId \?\? undefined\)/);
  });

  it('does NOT release the in-flight latch — it is a one-shot pop guard', () => {
    /**
     * Round 2: releasing it reverses the guard's documented purpose. A second
     * resolution firing goBack() from a stale navigation prop against an
     * already-popped screen POPS THE PARENT, ejecting the user out of the
     * messenger stack. The handler now completes within a tick, so an
     * ordinary double-tap would land right after a reset.
     */
    expect(code(SCREEN)).not.toMatch(/hangupInFlightRef\.current = false/);
  });
});

describe('the Telecom connection is ended for GROUP calls too', () => {
  it('ONE funnel clears every artifact, and the teardown uses it', () => {
    /**
     * THE HALF NO FOREGROUND-SERVICE FIX WOULD HAVE TOUCHED. Both group ring
     * lanes call `reportIncomingCall({callId: roomId})`; only `reportEnded`
     * removes the connection service's own ongoing notification, and it had
     * ZERO group call sites.
     */
    const src = code(REGISTRY);
    expect(src).toMatch(/export function clearGroupCallArtifacts\(roomId: string\): void/);
    expect(src).toMatch(/bridge\.reportEnded\(roomId/);
    expect(src).toMatch(/clearGroupCallArtifacts\(entry\.roomId\)/);
  });

  it('the remote-lane clear is GATED on the successor test, not merely after it', () => {
    /**
     * Round 2: `rid` is the STALE instance's room, and a same-room successor
     * is a documented shape (reconnect-while-minimized fires the old
     * instance's leave for the same roomId). Ungated, that stale leave ends
     * the LIVE call's Telecom connection and clears its accept latch
     * mid-call. Identity is `gen`, matching the slot null above it.
     */
    const hook = code(join('src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'));
    expect(hook).toMatch(/const supersededByNewer = [^;]*reg\.gen !== ours\.gen/);
    expect(hook).toMatch(/if \(rid && !supersededByNewer\)/);
  });

  it('the REMOTE-end lanes clear them too, not just the End button', () => {
    /**
     * `sfu.room.ended` (the host hung up) and `sfu.kicked` call `leaveInternal`
     * directly and never route through `endActiveGroupCall` — so every OTHER
     * participant, the ones who pressed nothing, kept the card and the Telecom
     * notification. Wiring only the teardown fixed it for one person.
     */
    const hook = code(join('src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'));
    expect(hook).toMatch(/clearGroupCallArtifacts\(rid\)/);
  });

  it('the ring FUNNEL clears them, not just the decline callback', () => {
    /**
     * `dismissRing` is the documented single funnel for every non-accept exit
     * (decline, host cancel, roomMissing, the FrameCryptor bail, the 45 s
     * timeout). The first draft put the cleanup in the decline callback one
     * level above, leaving four of the five lanes stranded.
     */
    const src = code(INCOMING);
    const funnel = src.indexOf('const dismissRing = useCallback');
    const clear = src.indexOf('clearGroupCallArtifacts(roomId)');
    expect(funnel).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(funnel);
  });

  it('the Telecom end is ANDROID-ONLY — a roomId is not a formatted UUID', () => {
    /**
     * On iOS `[[NSUUID alloc] initWithUUIDString:]` returns nil for a 16-byte
     * hex roomId, and the nil reaches CXProvider inside a native bridge call
     * that a JS try/catch cannot contain. Android's module warns and returns.
     */
    const src = code(REGISTRY);
    const gate = src.indexOf("Platform.OS === 'android'");
    const report = src.indexOf('bridge.reportEnded(');
    expect(gate).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(gate);
  });
});

describe('the release cleanup is ALWAYS armed', () => {
  it('the already-started gate skips only the START, never the cleanup', () => {
    /**
     * The old form `if (!markGroupAudioSessionStarted(roomKey)) {return;}`
     * registered NO cleanup function, so the release path vanished on two
     * everyday sequences — minimize→restore→End, and any
     * joined→reconnecting→joined round trip. From then on End released nothing,
     * and the stranded flag ALSO made the next call in that room skip its own
     * audio session and foreground service entirely.
     */
    const src = code(SCREEN);
    expect(src).toMatch(/const startedHere = markGroupAudioSessionStarted\(roomKey\)/);
    // No bare early-return on the gate any more.
    expect(src).not.toMatch(/if \(!markGroupAudioSessionStarted\(roomKey\)\) \{[\s\S]{0,120}return;/);
    // …and the cleanup is returned after the start block closes.
    const gate = src.indexOf('const startedHere =');
    const ret  = src.indexOf('return () => {', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(gate);
  });

  it('the cleanup requires the FGS stop itself rather than closing over the start block', () => {
    // The binding used to be destructured beside `startCallForegroundService`
    // inside the block that is now skipped on a re-entry.
    const src = code(SCREEN);
    const ret = src.indexOf('return () => {');
    expect(src.slice(ret)).toMatch(/const \{stopCallForegroundService\} = require\(/);
  });

  it('the release decision comes from the pure module, not an inline guard', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/shouldReleaseSharedCallResources\(\{/);
    // The two old guards must be gone — they are what skipped the stop.
    expect(src).not.toMatch(/if \(live && live\.roomId === roomKey\) \{ return; \}/);
  });

  it('the decision reads the LIVE state through a ref, never the stale closure', () => {
    // The cleanup closure is created on a `joined` render, so `call.state`
    // inside it can never show the end that just happened.
    expect(code(SCREEN)).toMatch(/state: liveStateRef\.current/);
  });
});

describe('what must NOT change (regression landmines)', () => {
  it('the group end still DROPS the incoming payload, never tombstones it', () => {
    // B-502 — the gateway reuses a roomId across re-rings; a tombstone makes a
    // member who left a live call unreachable on the killed-app lane.
    const src = code(REGISTRY);
    expect(src).toMatch(/dropIncomingCallPayload\(roomId\)/);
    expect(src).not.toMatch(/clearIncomingCallPayload\(roomId\)/);
  });

  it('the foreground-service and audio stops stay ARBITRATED by owner', () => {
    // One service, two call stacks: an unarbitrated stop rips them off a live
    // 1:1 call (B-243/B-256).
    const src = code(REGISTRY);
    expect(src).toMatch(/stopCallForegroundService\('group'\)/);
    expect(src).toMatch(/stopSharedAudioSession\('group'\)/);
    expect(code(SCREEN)).toMatch(/stopCallForegroundService\('group'\)/);
  });
});
