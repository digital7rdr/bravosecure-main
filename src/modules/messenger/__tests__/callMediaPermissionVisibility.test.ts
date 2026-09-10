/**
 * B-340 — the founder's "he got the call but never joined the room" (2026-07-30,
 * rooms 953a899a / 9a268052) was `getLocalMedia` sitting on Android's camera-
 * permission dialog: `requestMultiple` correctly blocks until the user answers,
 * but every log around it is console.log — stripped in release — so four accept
 * attempts across two rooms were TOTALLY silent between "transport acquired"
 * and the (never-reached) sfu.join. appops showed the prompt was only answered
 * at 14:55, a minute after the last room was cancelled.
 *
 * Two rules pinned here:
 *  1. A PENDING prompt must announce itself at WARN level (release keeps warn),
 *     and the outcome (granted / denied) must be warned too — so this state can
 *     never be invisible again.
 *  2. Already-granted permissions must NOT warn — no per-call spam.
 *
 * Companion (same bug number): the purged-member key-resync fallback, pinned by
 * groupCallKeyResyncFallback.test.ts.
 */

const mockCheck = jest.fn(async () => true);
const mockRequestMultiple = jest.fn(async () => ({a: 'granted', c: 'granted'}));

jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 31},
  PermissionsAndroid: {
    PERMISSIONS: {RECORD_AUDIO: 'a', CAMERA: 'c'},
    RESULTS: {GRANTED: 'granted'},
    check: (...args: unknown[]) => mockCheck(...(args as [])),
    requestMultiple: (...args: unknown[]) => mockRequestMultiple(...(args as [])),
  },
}));

const mockGetUserMedia = jest.fn(async () => ({getTracks: () => []}));
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class {},
  mediaDevices: {getUserMedia: (...a: unknown[]) => mockGetUserMedia(...(a as []))},
  RTCView: () => null,
}));

import {getLocalMedia} from '../webrtc/peerConnectionFactory';

describe('B-340 — permission prompt around getLocalMedia is never silent', () => {
  let warns: string[];
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warns = [];
    warnSpy = jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '));
    });
    mockCheck.mockReset();
    mockRequestMultiple.mockReset();
    mockGetUserMedia.mockClear();
  });
  afterEach(() => { warnSpy.mockRestore(); });

  test('pending prompt → warns BEFORE blocking, and warns the granted outcome', async () => {
    mockCheck.mockResolvedValue(false); // nothing granted yet → dialog will show
    mockRequestMultiple.mockResolvedValue({a: 'granted', c: 'granted'});
    await getLocalMedia({video: true});
    const pending = warns.find(w => /permission/i.test(w) && /CALLDIAG/.test(w));
    expect(pending).toBeDefined();
    const outcome = warns.find(w => /granted/i.test(w) && /CALLDIAG/.test(w));
    expect(outcome).toBeDefined();
  });

  test('denied prompt → the outcome warn names the denial', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({a: 'granted', c: 'denied'});
    await getLocalMedia({video: true});
    expect(warns.some(w => /denied/i.test(w) && /CALLDIAG/.test(w))).toBe(true);
  });

  test('already granted → no permission warns (no per-call spam)', async () => {
    mockCheck.mockResolvedValue(true);
    mockRequestMultiple.mockResolvedValue({a: 'granted', c: 'granted'});
    await getLocalMedia({video: true});
    expect(warns.filter(w => /permission/i.test(w))).toHaveLength(0);
  });
});
