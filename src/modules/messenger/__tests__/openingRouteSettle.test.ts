/**
 * B-309 — kill the ~1s loudspeaker blip at call start with a headset attached.
 *
 * Device evidence (Pixel 6a, v1.0.179, realme Buds connected — every call):
 *
 *   15:46:28.709  chooseAudioRoute: SPEAKER_PHONE      ← media default, applied blind
 *   15:46:28.768  Can not select SPEAKER_PHONE from available []
 *   15:46:29.178  chooseAudioRoute: BLUETOOTH → SCO_CONNECTED   ← auto-snap, ~1s later
 *
 * The media-type default was applied against a device list that does not
 * exist yet, so with a headset attached every call audibly opens on the
 * LOUDSPEAKER and then jumps into the headset. Industry behaviour (Android
 * Telecom, WebRTC's AppRTCAudioManager, Agora/BytePlus) decides the opening
 * route from the ENUMERATED device set — no blind default, no blip.
 *
 * The settle rule, pinned here:
 *  - first device event arrives WITH a headset → do nothing (the existing
 *    auto-snap owns it — the settle must never double-apply);
 *  - first device event arrives WITHOUT a headset → apply the media default
 *    NOW (the enumeration answered "nothing attached");
 *  - no event inside the window (fallback, e.g. iOS where the enumerator
 *    does not exist) → apply the media default at timeout;
 *  - exactly-once, cancellable (screen unmount mid-settle must not fire a
 *    route change into the next call's session).
 *
 * Why the deferral is safe with no headset: audio only flows once the call
 * CONNECTS (offer/answer + ICE ≫ 1.2 s in practice); the settle resolves
 * during ringing, so the user never hears the difference — but the headset
 * case stops blipping entirely.
 */
import {createOpeningRouteSettle} from '../runtime/callAudioRoute';

describe('B-309 — the opening route settles from evidence, not a blind default', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('headset in the first device list → the settle stays silent (auto-snap owns it)', () => {
    const applyDefault = jest.fn();
    const s = createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    jest.advanceTimersByTime(5000);
    expect(applyDefault).not.toHaveBeenCalled();
  });

  it('no headset in the first device list → default applies immediately', () => {
    const applyDefault = jest.fn();
    const s = createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(applyDefault).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    expect(applyDefault).toHaveBeenCalledTimes(1);
  });

  it('no device event at all → default applies at the timeout (iOS fallback)', () => {
    const applyDefault = jest.fn();
    createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    expect(applyDefault).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1200);
    expect(applyDefault).toHaveBeenCalledTimes(1);
  });

  it('exactly once — a late second device event cannot re-apply', () => {
    const applyDefault = jest.fn();
    const s = createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    jest.advanceTimersByTime(1200);
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(applyDefault).toHaveBeenCalledTimes(1);
  });

  it('cancel disarms both paths', () => {
    const applyDefault = jest.fn();
    const s = createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    s.cancel();
    jest.advanceTimersByTime(5000);
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(applyDefault).not.toHaveBeenCalled();
  });

  it('wired counts as a headset too', () => {
    const applyDefault = jest.fn();
    const s = createOpeningRouteSettle({applyDefault, timeoutMs: 1200});
    s.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'WIRED_HEADSET']);
    jest.advanceTimersByTime(5000);
    expect(applyDefault).not.toHaveBeenCalled();
  });
});

describe('B-309 — the screens route their opening default through the settle', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const code = (file: string): string =>
    readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\/[^\r\n]*/g, '');

  it.each(['CallScreen.tsx', 'GroupCallScreen.tsx'])('%s uses createOpeningRouteSettle', file => {
    const s = code(file);
    expect(s).toMatch(/createOpeningRouteSettle\(/);
    // The first device event must feed the settle.
    expect(s).toMatch(/onFirstDeviceList\(/);
  });

  it('CallScreen applies the media default ONLY through the settle', () => {
    const s = code('CallScreen.tsx');
    // Exactly one occurrence of the default-apply expression…
    const hits = s.match(/pickAudioRouteNative\(isVideo \? 'SPEAKER_PHONE' : 'EARPIECE'\)/g) ?? [];
    expect(hits).toHaveLength(1);
    // …and it lives inside the settle's applyDefault, not as a bare call at
    // session start (the exact line that shipped the blip).
    const settleAt = s.indexOf('createOpeningRouteSettle({');
    const applyAt  = s.indexOf("pickAudioRouteNative(isVideo ? 'SPEAKER_PHONE' : 'EARPIECE')");
    expect(settleAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(settleAt);
    expect(applyAt - settleAt).toBeLessThan(220);
  });
});
