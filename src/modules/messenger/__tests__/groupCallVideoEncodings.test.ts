/**
 * Regression — B-121: an iPhone's video tile showed "Video unavailable" on
 * Android (its audio decoded fine, and Android -> iOS video worked).
 *
 * Verified on device 2026-07-19 as a single-variable change: the same build
 * with 3-layer simulcast failed, with one encoding it works. The MECHANISM is
 * still unproven (see the VIDEO_ENCODINGS doc comment) — so this test pins the
 * empirical contract, not a theory:
 *
 *   iOS     -> exactly ONE encoding, no simulcast rids
 *   Android -> 3-layer simulcast preserved (a slow viewer gets a cheap layer
 *              instead of freezing the call for everyone)
 *
 * If someone restores simulcast on iOS to win back per-viewer adaptation, this
 * fails and points them at the trace-file counters before they ship it blind.
 */

type Mod = typeof import('../webrtc/videoEncodings');

function loadMod(os: 'ios' | 'android'): Mod {
  let mod!: Mod;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({Platform: {OS: os}}), {virtual: true});
    mod = require('../webrtc/videoEncodings');
  });
  return mod;
}

function loadEncodings(os: 'ios' | 'android'): ReadonlyArray<Record<string, unknown>> {
  return loadMod(os).VIDEO_ENCODINGS;
}

describe('B-121 — video send encodings per platform', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
  });

  it('iOS sends exactly one encoding', () => {
    expect(loadEncodings('ios')).toHaveLength(1);
  });

  it('iOS declares no simulcast rids', () => {
    // A stray rid is what re-enables simulcast in mediasoup, so assert on the
    // rid rather than only on the array length.
    for (const enc of loadEncodings('ios')) {
      expect(enc.rid).toBeUndefined();
    }
  });

  it('Android keeps 3-layer simulcast', () => {
    const android = loadEncodings('android');
    expect(android).toHaveLength(3);
    expect(android.map(e => e.rid)).toEqual(['r0', 'r1', 'r2']);
  });

  it('Android layers ascend in bitrate so the SFU can step down', () => {
    const bitrates = loadEncodings('android').map(e => Number(e.maxBitrate));
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b));
  });
});

describe('B-121 — videoEncodings() hands out an isolated copy', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
  });

  it.each(['ios', 'android'] as const)('%s: successive calls are not the same object', os => {
    const {videoEncodings} = loadMod(os);
    const a = videoEncodings();
    const b = videoEncodings();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a).toEqual(b);
  });

  it.each(['ios', 'android'] as const)('%s: mutating one producer\'s copy cannot reach the next', os => {
    const {videoEncodings} = loadMod(os);
    const first = videoEncodings();
    first[0].maxBitrate = 1;
    (first[0] as {rid?: string}).rid = 'CLOBBERED';
    expect(videoEncodings()[0].maxBitrate).not.toBe(1);
    expect((videoEncodings()[0] as {rid?: string}).rid).not.toBe('CLOBBERED');
  });

  it('replaying mediasoup\'s in-place rid write leaves the source intact', () => {
    // Mirrors mediasoup-client ReactNative106 send(): when length > 1 it does
    // encodings.forEach((e, i) => { e.rid = `r${i}` }) on the array we passed,
    // which lands on a live producer. Prove the module const is unreachable.
    const {videoEncodings, VIDEO_ENCODINGS} = loadMod('android');
    const handed = videoEncodings();
    handed.forEach((e, i) => { (e as {rid?: string}).rid = `MUTATED${i}`; });
    // Cast: the module const is a union of the iOS/Android shapes, and only
    // the Android arm declares rid.
    expect(VIDEO_ENCODINGS.map(e => (e as {rid?: string}).rid)).toEqual(['r0', 'r1', 'r2']);
    expect(videoEncodings().map(e => e.rid)).toEqual(['r0', 'r1', 'r2']);
  });

  it('is NOT frozen — Android requires that rid write to succeed', () => {
    // Freezing would look safer but throws in strict mode on the Android path,
    // turning a harmless idempotent write into a failed produce().
    const {videoEncodings} = loadMod('android');
    const handed = videoEncodings();
    expect(() => { (handed[0] as {rid?: string}).rid = 'r0'; }).not.toThrow();
    expect(Object.isFrozen(handed[0])).toBe(false);
  });
});

describe('B-121 — every video producer routes through videoEncodings()', () => {
  // Static source audit (same approach as logAudit.test.ts). The first fix
  // changed ONLY the boot producer and looked verified on device, while the
  // transport-recovery path and toggleVideo still hardcoded 3-layer simulcast
  // — so an iOS camera off->on, or any reconnect, silently restored the bug.
  // A device test cannot catch that; it only exercises the path it walks.
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../webrtc/useGroupCall.ts'),
    'utf8',
  ) as string;

  it('declares no inline simulcast rid ladder', () => {
    const inlineRids = SRC.match(/rid:\s*'r[0-9]'/g) ?? [];
    expect(inlineRids).toEqual([]);
  });

  it('passes videoEncodings() to every produce() that sets encodings', () => {
    const encodingsArgs = SRC.match(/encodings:\s*[^,\n]+/g) ?? [];
    expect(encodingsArgs.length).toBeGreaterThan(0);
    for (const arg of encodingsArgs) {
      expect(arg).toContain('videoEncodings()');
    }
  });
});

describe('B-121 — encoding shapes are valid for mediasoup', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
  });

  it.each(['ios', 'android'] as const)('%s: every layer has a positive finite bitrate', os => {
    for (const enc of loadEncodings(os)) {
      const b = Number(enc.maxBitrate);
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThan(0);
    }
  });

  it.each(['ios', 'android'] as const)('%s: framerates are sane (0 < fps <= 60)', os => {
    for (const enc of loadEncodings(os)) {
      const f = Number(enc.maxFramerate);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(60);
    }
  });

  it('Android rids are unique — duplicates collapse layers at the SFU', () => {
    const rids = loadEncodings('android').map(e => e.rid);
    expect(new Set(rids).size).toBe(rids.length);
  });

  it('iOS single layer is not sent at full-simulcast top bitrate', () => {
    // Without simulcast every viewer shares one stream, so the ceiling should
    // sit below the Android top layer rather than blasting the highest rate at
    // a link that previously would have been served r0.
    const ios = Number(loadEncodings('ios')[0].maxBitrate);
    const androidTop = Math.max(...loadEncodings('android').map(e => Number(e.maxBitrate)));
    expect(ios).toBeLessThan(androidTop);
  });
});
