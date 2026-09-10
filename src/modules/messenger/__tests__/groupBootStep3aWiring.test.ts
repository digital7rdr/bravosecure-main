/**
 * Audit Step 3a wiring pins (source scans — useGroupCall.ts / GroupCallScreen.tsx
 * cannot be imported by the node project).
 *
 *  3a.1 (B-598): the group TURN fetch is delegated to the shared, ceiling'd,
 *       cached module — no bare `/webrtc/turn-credentials` fetch remains.
 *  3a.2: the presence broadcast is fire-and-forget (also hook-pinned in
 *       groupCallHookBoot "reaches JOINED even while presence is in flight").
 *  3a.3 (B-600): the audio session no longer returns early on !btPermResolved,
 *       and starts at 'joining' (not only 'joined').
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');

describe('Step 3a — group boot de-serialization wiring', () => {
  const ug = () => strip(read('src/modules/messenger/webrtc/useGroupCall.ts'));

  it('3a.1 — useGroupCall holds NO bare turn-credentials fetch; fetchTurnCredentials delegates to the ceiling\'d shared cache', () => {
    const s = ug();
    expect(s).not.toMatch(/webrtc\/turn-credentials/);   // no raw endpoint anywhere
    expect(s).toContain("require('./turnCredentials')");
    expect(s).toContain('await getIceServers({ceilingMs: TURN_FETCH_CEILING_MS})');
  });

  it('3a.2 — the STEP-10 presence broadcast is fire-and-forget (not awaited before joined)', () => {
    const s = ug();
    // Anchor on the UNIQUE step-10 call (its `opts.recipientUserIds` arg) — NOT
    // the pre-existing B-365b roster-heal void at another site (which would make
    // this pin pass on a revert). This is the one the boot used to await.
    const i = s.indexOf('broadcastGroupCallPresence(opts.recipientUserIds');
    expect(i).toBeGreaterThan(-1);
    // It sits inside a `void (async () => {` block (fire-and-forget), so the
    // NEAREST `void (async` before it is closer than the nearest bare `await rt`.
    const before = s.slice(Math.max(0, i - 300), i);
    const voidAt = before.lastIndexOf('void (async () => {');
    expect(voidAt).toBeGreaterThan(-1);
    // and the marker + failure warn moved inside that IIFE.
    const iife = s.slice(i - 300, i + 600);
    expect(iife).toContain('presence broadcast failed');
  });

  it('3a.3 — the audio session does NOT gate on btPermResolved and starts at joining (B-600)', () => {
    const s = strip(read('src/screens/messenger/GroupCallScreen.tsx'));
    // the OLD `if (!btPermResolved) { … return; }` early-out is gone.
    expect(s).not.toMatch(/if \(!btPermResolved\) \{[\s\S]{0,400}?return;/);
    // the state gate now admits 'joining' as well as 'joined'.
    expect(s).toContain("if (call.state !== 'joining' && call.state !== 'joined') {return;}");
    // mic permission is still required (FGS would crash without RECORD_AUDIO).
    expect(s).toContain('if (!micPermGranted)  {return;}');
  });
});

describe('Step 3b.1 — parallel consume of existing producers (B-599)', () => {
  const ug = () => strip(read('src/modules/messenger/webrtc/useGroupCall.ts'));

  it('the step-9 boot burst consumes in PARALLEL (Promise.all), not one await at a time', () => {
    const s = ug();
    const start = s.indexOf("latG('consume:start'");
    const done  = s.indexOf("latG('consume:done')");
    expect(start).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(start);
    const block = s.slice(start, done);
    // parallel, audio-kicked-first
    expect(block).toMatch(/await Promise\.all\(ordered\.map\(ep =>/);
    // (the `/* batch */` inline comment is stripped, so match the tokens around it)
    expect(block).toMatch(/consumeProducer\(ep\.producerId, ep\.participantTag, ep\.kind,\s*true\)/);
    expect(block).toMatch(/\.sort\(\s*[\s\S]*?a\.kind === 'audio'/);
    // the serial `for (const ep …) { await consumeProducer(… true) }` must be GONE from the burst
    expect(block).not.toMatch(/for \(const ep of ordered\) \{[\s\S]*?await consumeProducer/);
  });

  it('the concurrency-safety dedup guards are intact (consumeProducer skips in-flight / already-consumed)', () => {
    const s = ug();
    expect(s).toContain('if (inFlightSet.has(producerId)) {');
    expect(s).toMatch(/if\s*\(\s*consumedProducerIdsRef\.current\.has\(producerId\)\s*\)\s*\{return;\}/);
    expect(s).toContain('inFlightSet.add(producerId);');
  });
});
