/**
 * WI-3.7 — the surviving unguarded group-call timers must be ROOM-SCOPED.
 *
 * Phase 1 keyed the registries, but three timers still fired against
 * "whatever call is live now" rather than the call that armed them. Each one
 * outlives its own room in a real flow (hang up and immediately join another;
 * a rejoin re-pointing the transport refs mid-flight):
 *
 *   • the `+5 s dumpSelectedPair` re-snapshot reads the LIVE transport refs,
 *     so its ICE diagnostics get filed against the wrong room — in the one
 *     lane whose whole job is telling those cases apart;
 *   • `rebuildVideoConsumer`, driven by a 500 ms stats poll, TEARS DOWN a live
 *     consumer and re-consumes it, so firing it against a successor call
 *     blanks a tile the user is actively watching;
 *   • the header's duration tick read `getActiveGroupCall()?.joinedAtMs` with
 *     no room comparison at all, so a successor call's clock was painted into
 *     the previous screen's header.
 *
 * SOURCE SCAN for the two screen-side facts (GroupCallScreen mounts RN views
 * and useGroupCall imports mediasoup, so neither loads in the node project).
 * Comments are stripped first — the fixes' own comments name the symbols
 * being asserted, and an unstripped scan would match the prose.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HOOK = join(
  process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts',
);
const SCREEN = join(
  process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx',
);

/** Whole-line comments only — the conservative stripper (see WI-3.5 scan). */
function strip(src: string): string {
  return src
    .split(/\r?\n/)
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const HOOK_CODE   = strip(readFileSync(HOOK, 'utf8'));
const SCREEN_CODE = strip(readFileSync(SCREEN, 'utf8'));

describe('WI-3.7 — the +5s selected-pair re-snapshot', () => {
  /**
   * Anchor on the deferred CALL, not on `}, 5000);`.
   *
   * The bare delay is ambiguous — the B-365 roster refresh uses the same 5 s
   * and appears EARLIER in the file, so an `indexOf('}, 5000);')` window
   * scanned a completely unrelated effect and reported a missing guard that
   * was actually present. (Caught by this suite on its first run; the same
   * class as the `INSERT INTO public.org_members` anchor in CLAUDE.md.)
   */
  const DEFERRED = "void dumpSelectedPair(kind === 'send'";

  it('the deferred snapshot still exists', () => {
    expect(HOOK_CODE).toContain('const dumpSelectedPair =');
    expect(HOOK_CODE).toContain(DEFERRED);
  });

  it('it checks the room before re-reading the live transport refs', () => {
    const at = HOOK_CODE.indexOf(DEFERRED);
    expect(at).toBeGreaterThan(-1);
    const block = HOOK_CODE.slice(Math.max(0, at - 500), at);
    expect(block).toContain('roomIdRef.current !== rid');
    // and the pre-existing teardown guards are preserved, not replaced
    expect(block).toContain('isLeavingRef.current');
  });

  it('the guarded snapshot really is the 5 s deferred one', () => {
    // Pin the window's other end so a future edit can't satisfy the guard
    // assertion from some other timer's body.
    const at = HOOK_CODE.indexOf(DEFERRED);
    expect(HOOK_CODE.slice(at, at + 300)).toMatch(/\}, 5000\);/);
  });
});

describe('WI-3.7 — rebuildVideoConsumer', () => {
  it('refuses to rebuild once the registry has moved to another room', () => {
    const i = HOOK_CODE.indexOf('const rebuildVideoConsumer = useCallback(');
    expect(i).toBeGreaterThan(-1);
    const block = HOOK_CODE.slice(i, i + 700);
    expect(block).toContain('getActiveGroupCall()');
    expect(block).toMatch(/liveRoom\.roomId !== ridNow/);
    // The guard must sit BEFORE the destructive tile lookup + teardown.
    const guardAt = block.indexOf('liveRoom.roomId !== ridNow');
    const tearAt  = block.indexOf('consumerCleanupsByPid.current.get');
    expect(tearAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(tearAt);
  });

  it('the pre-existing leaving guard survives', () => {
    const i = HOOK_CODE.indexOf('const rebuildVideoConsumer = useCallback(');
    expect(HOOK_CODE.slice(i, i + 200)).toContain('isLeavingRef.current');
  });
});

describe('WI-3.7 — the header duration tick', () => {
  it('CallDurationTimer takes the roomId it is rendering for', () => {
    expect(SCREEN_CODE).toMatch(/function CallDurationTimer\(\{roomId\}/);
  });

  it('it compares the registry entry against that roomId before painting', () => {
    const i = SCREEN_CODE.indexOf('function CallDurationTimer(');
    expect(i).toBeGreaterThan(-1);
    const block = SCREEN_CODE.slice(i, i + 900);
    expect(block).toMatch(/live\.roomId !== roomId/);
    // and it reads joinedAtMs off the VERIFIED entry, not a second lookup
    expect(block).toContain('live.joinedAtMs');
    expect(block).not.toMatch(/getActiveGroupCall\(\)\?\.joinedAtMs/);
  });

  it('the effect re-keys on roomId so a room change re-baselines the clock', () => {
    const i = SCREEN_CODE.indexOf('function CallDurationTimer(');
    const block = SCREEN_CODE.slice(i, i + 900);
    expect(block).toMatch(/\}, \[roomId\]\);/);
  });

  it('the call site passes a roomId', () => {
    expect(SCREEN_CODE).toMatch(/<CallDurationTimer roomId=\{/);
  });
});
