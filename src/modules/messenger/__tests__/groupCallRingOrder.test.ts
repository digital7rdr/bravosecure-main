/**
 * B-342 — "we started the call and it takes time to ring all the other
 * members" (founder, 2026-07-30; measured: joined 15:58:53 → ring.send
 * 15:59:04 = 10.8 s, on top of a 36 s getUserMedia stall).
 *
 * The relay fans a ring out within the same second it is asked (server logs)
 * — the whole delay was host-side: the boot rang at step 11, AFTER
 * Device.load, both transports, DTLS, producing audio+video, the early-
 * producer drain and an AWAITED presence fan-out. None of those are ring
 * prerequisites. The ring needs exactly: the room exists and we joined
 * (step 3) and the key fan-out ran (step 3a — the pinned key-before-ring
 * contract, so a fast acceptor never waits keyless). Recipients who accept
 * before the host produces pick producers up via sfu.new-producer + the
 * B-06 early buffer — the standard path for any 3rd member already.
 *
 * Rules pinned (comment-stripped source order; the file is CRLF — no \n
 * anchors):
 *   1. ring is sent BEFORE mediasoup Device construction (and hence before
 *      transports/produce/presence);
 *   2. ring stays AFTER the FrameCryptor keying (key-before-ring preserved).
 */
import * as fs from 'fs';
import * as path from 'path';

const HOOK = fs.readFileSync(
  path.join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8');
const src = HOOK
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('B-342 — boot ring ordering', () => {
  const ringAt = src.indexOf("'sfu.ring'");
  const deviceAt = src.indexOf("handlerName: 'ReactNative106'");
  const cryptorReadyAt = src.indexOf('FrameCryptor ready selfTag=');

  test('anchors exist', () => {
    expect(ringAt).toBeGreaterThan(-1);
    expect(deviceAt).toBeGreaterThan(-1);
    expect(cryptorReadyAt).toBeGreaterThan(-1);
  });

  test('ring goes out BEFORE the mediasoup Device / transports / produce', () => {
    expect(ringAt).toBeLessThan(deviceAt);
  });

  test('ring stays AFTER FrameCryptor keying (key-before-ring contract)', () => {
    expect(ringAt).toBeGreaterThan(cryptorReadyAt);
  });
});
