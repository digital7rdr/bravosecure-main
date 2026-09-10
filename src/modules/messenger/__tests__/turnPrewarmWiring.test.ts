/**
 * Audit Step 2.1/2.3 wiring pins (source scans — these files can't be imported
 * by the node project).
 *
 *  - CallScreen no longer contains a RAW `webrtc/turn-credentials` fetch; it
 *    consumes the shared cache module.
 *  - the prewarm is wired at the ring/wake/foreground sites and invalidated on
 *    signOut.
 *  - ensureLocalMedia is single-flight (no double camera open), and
 *    getLocalMedia only prompts when a permission is actually missing.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');

describe('TURN cache + prewarm wiring (audit Step 2.1/2.3)', () => {
  it('CallScreen no longer holds a raw turn-credentials fetch; it consumes turnCredentials.getIceServers', () => {
    const src = strip(read('src/screens/messenger/CallScreen.tsx'));
    expect(src).not.toMatch(/webrtc\/turn-credentials/);        // no raw endpoint
    expect(src).not.toMatch(/fetchWithRefresh\(/);              // no raw fetch on this screen
    expect(src).toContain("require('@/modules/messenger/webrtc/turnCredentials')");
    expect(src).toContain('getIceServers({ceilingMs: TURN_FETCH_CEILING_MS})');
  });

  it('prewarmIceServers is fired at the ring, group-ring, foreground and BOTH voip-wake lanes, only after HMAC verify', () => {
    const mn = strip(read('src/navigation/MainNavigator.tsx'));
    // the 1:1 offer handler, the group ring handler, and the AppState-active listener
    expect((mn.match(/prewarmIceServers\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const fcm = strip(read('src/modules/messenger/push/fcmBootstrap.ts'));
    // Both the foreground and the background voip-wake lanes warm TURN.
    const warms = [...fcm.matchAll(/prewarmIceServers\(\)/g)].map(m => m.index ?? -1);
    expect(warms.length).toBeGreaterThanOrEqual(2);
    // EVERY prewarm sits AFTER a verified `!verdict.ok` drop of its own lane
    // (a replayed wake returns before it) — check each warm has a `DROPPED`
    // verify BEFORE it and NO un-verified navigate between them.
    const dropSites = [...fcm.matchAll(/voip-wake DROPPED/g)].map(m => m.index ?? -1);
    for (const w of warms) {
      const priorDrop = dropSites.filter(d => d < w).pop();
      expect(priorDrop).toBeGreaterThan(-1);
      // no navigate to a call screen between the verify and the warm
      expect(fcm.slice(priorDrop as number, w)).not.toMatch(/navigateToMessengerScreen/);
    }
  });

  it('the KILLED-app headless voip-wake lane warms TURN after HMAC verify and before the ring is presented (Step 5.1)', () => {
    const fcm = strip(read('src/modules/messenger/push/fcmHeadless.ts'));
    const warm = fcm.indexOf('prewarmIceServers()');
    expect(warm).toBeGreaterThan(-1);
    // AFTER its own lane's verified `voip-wake DROPPED` early-return…
    const drop = fcm.indexOf('voip-wake DROPPED');
    expect(drop).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(drop);
    // …and BEFORE the ring is presented (the incoming-call cache seed that
    // gates the notifee card), so the fetch starts at wake, not at the tap.
    const present = fcm.indexOf('setIncomingCallPayload(');
    expect(present).toBeGreaterThan(-1);
    expect(warm).toBeLessThan(present);
  });

  it('signOut invalidates the TURN cache', () => {
    const src = strip(read('src/store/authStore.ts'));
    expect(src).toContain('invalidateIceServers()');
  });

  it('ensureLocalMedia is SINGLE-FLIGHT (concurrent callers share one getUserMedia — camera opens once)', () => {
    const uc = strip(read('src/modules/messenger/webrtc/useCall.ts'));
    expect(uc).toContain('let acquiringMedia: Promise<AcquiredMedia> | null = null;');
    expect(uc).toContain('if (acquiringMedia) {return acquiringMedia;}');
  });

  it('getLocalMedia calls requestMultiple ONLY inside the pending>0 guard, and fails safe when check() throws (2.3)', () => {
    const src = strip(read('src/modules/messenger/webrtc/peerConnectionFactory.ts'));
    const guardIdx = src.indexOf('if (pending.length > 0) {');
    const requestIdx = src.indexOf('PermissionsAndroid.requestMultiple(perms)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(requestIdx).toBeGreaterThan(guardIdx);
    // Brace-balance the guard block: the request must be reached with the
    // guard's `{` still OPEN (i.e. between guard and request, opens >= closes).
    // This is what makes the revert (request moved outside the guard) fail.
    const between = src.slice(guardIdx + 'if (pending.length > 0) {'.length, requestIdx);
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    expect(opens - closes).toBeGreaterThanOrEqual(0);   // guard brace not yet closed at the request
    // Fail-safe: `pending` seeds to ALL perms so a check()-throw still prompts.
    expect(src).toContain('let pending: string[] = perms.map(String);');
  });
});
