/**
 * BS-GC-CRASH regression — group call boot crashed on every JOINER with
 * "Cannot read property 'has' of undefined" at step 9 (the existing-
 * producer consume loop).
 *
 * Root cause was a source-ORDERING / temporal-dead-zone hazard: the boot
 * IIFE captured `const consumedProducerIds = consumedProducerIdsRef.current`
 * AFTER the step-9 loop that calls `consumeProducer`. On a host the loop is
 * empty (room just created) so it never fired; on a joiner the host's
 * producer already exists, so consumeProducer ran during step 9 and touched
 * the not-yet-initialised const → crash. The host never saw it.
 *
 * The fix reads `consumedProducerIdsRef.current` DIRECTLY at each use site
 * (no captured const), removing the ordering hazard. This test is a cheap
 * static guard: it reads the source and fails if the crashing pattern — a
 * `const consumedProducerIds = ...` alias used inside consumeProducer —
 * comes back. A full hook render test would need the entire mediasoup /
 * FrameCryptor / WS surface mocked, which is far more brittle than pinning
 * the one-line invariant that actually regressed.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  createEarlyProducerBuffer,
  type BufferedProducer,
} from '../webrtc/groupCallProducerBuffer';

const SRC = readFileSync(
  join(__dirname, '..', 'webrtc', 'useGroupCall.ts'),
  'utf8',
);

describe('useGroupCall — consume ordering (BS-GC-CRASH)', () => {
  it('does not capture consumedProducerIds into a const alias (TDZ hazard)', () => {
    // The crashing form. If this reappears, a joiner can touch the const
    // before its initialiser runs (step 9 precedes the declaration).
    expect(SRC).not.toMatch(/const\s+consumedProducerIds\s*=/);
  });

  it('reads consumedProducerIdsRef.current directly in the consume guard', () => {
    // The guard that runs first inside consumeProducer must hit the
    // always-initialised ref, not a possibly-uninitialised local.
    expect(SRC).toMatch(/if\s*\(\s*consumedProducerIdsRef\.current\.has\(producerId\)\s*\)\s*\{return;\}/);
  });

  it('still records a consumed producer via the ref after success', () => {
    expect(SRC).toMatch(/consumedProducerIdsRef\.current\.add\(producerId\)/);
  });
});

describe('B-06 — early new-producer buffer/drain', () => {
  const mk = (id: string): BufferedProducer => ({
    producerId:     id,
    participantTag: `tag-${id}`,
    kind:           'audio',
  });

  it('buffers events that arrive before recvTransport is ready', () => {
    let ready = false;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));
    buf.accept(mk('b'));

    // Nothing consumed while not ready — held in the queue instead.
    expect(consumed).toEqual([]);
    expect(buf.size()).toBe(2);
  });

  it('drains buffered events exactly once when ready, with no duplicate consume', () => {
    let ready = false;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));
    buf.accept(mk('b'));

    ready = true;
    buf.drain();

    expect(consumed).toEqual(['a', 'b']);
    expect(buf.size()).toBe(0);

    // A second drain replays nothing — each buffered descriptor forwards once.
    buf.drain();
    expect(consumed).toEqual(['a', 'b']);
  });

  it('consumes immediately once ready (no buffering on the steady-state path)', () => {
    let ready = true;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));

    expect(consumed).toEqual(['a']);
    expect(buf.size()).toBe(0);
  });
});

describe('B-06 — early handler registration (static guard)', () => {
  it('registers the boot SFU frame handler before sfu.join', () => {
    /**
     * The boot handler used to be registered inline as
     * `registerSfuHandler(rid, (frame) => {`. It is now created through a
     * one-argument factory so the step-3 `room_not_found` retry can
     * RE-POINT it at the room it actually joined — the handler keys strictly
     * on roomId, and one left pointed at a reaped room receives nothing.
     * The invariant under test is unchanged: registration happens before
     * `sfu.join`, so a peer producing in the join→recvTx window is not lost.
     */
    const earlyReg = SRC.indexOf('registerSfuHandler(roomForFrames, (frame)');
    const bootCall = SRC.indexOf('cleanupSubRef.current = registerFramesFor(rid)');
    const joinIdx  = SRC.indexOf("'sfu.join'");
    expect(earlyReg).toBeGreaterThan(-1);
    expect(bootCall).toBeGreaterThan(-1);
    expect(joinIdx).toBeGreaterThan(-1);
    // Both the factory and the boot's use of it must precede sfu.join.
    expect(earlyReg).toBeLessThan(joinIdx);
    expect(bootCall).toBeLessThan(joinIdx);
  });

  it('defines the boot SFU frame handler exactly once', () => {
    // One factory only. The separate resume re-register path (Fix #7) is
    // keyed by `opts.roomId`, so this counts the boot handler alone.
    const matches = SRC.match(/registerSfuHandler\(roomForFrames, \(frame\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('never STACKS boot handlers — the retry releases the previous one first', () => {
    /**
     * `registerSfuHandler` appends; it does not replace. The retry adds a
     * second `registerFramesFor` call site, so without an explicit release
     * the reaped room's handler would stay registered alongside the live
     * one — the F6 handler-leak shape, where frames are also delivered into
     * a dead subscription. Every use after the first must be preceded by a
     * cleanup of the current one.
     */
    const uses = [...SRC.matchAll(/registerFramesFor\(rid\)/g)].map(m => m.index ?? -1);
    expect(uses.length).toBeGreaterThanOrEqual(1);
    for (const at of uses.slice(1)) {
      const preceding = SRC.slice(Math.max(0, at - 400), at);
      expect(preceding).toMatch(/cleanupSubRef\.current\?\.\(\)/);
    }
  });

  it('routes new-producer events through the early buffer', () => {
    expect(SRC).toMatch(/createEarlyProducerBuffer/);
    expect(SRC).toMatch(/earlyProducerBufferRef\.current\?\.accept\(/);
  });

  it('drains the early buffer after the consume pipeline is ready', () => {
    expect(SRC).toMatch(/earlyProducerBuffer\.drain\(\)/);
  });
});
