/**
 * B-692 S-3 — the one-shot receive tone's guards.
 *
 * The tone must: play through its OWN player (never a bravoTones slot), never
 * touch Audio.setAudioModeAsync (the routing-clobber trap bravoTones pins),
 * throttle a burst to one blip, and stay silent while any call is live.
 */

const mockSetAudioModeAsync = jest.fn(async () => undefined);
const mockUnload = jest.fn(async () => undefined);
const mockCreateAsync = jest.fn(async (..._args: unknown[]) => ({
  sound: {
    unloadAsync: mockUnload,
    setOnPlaybackStatusUpdate: jest.fn(),
  },
}));

jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: (...a: unknown[]) => mockSetAudioModeAsync(...(a as [])),
    Sound: {createAsync: (...a: unknown[]) => mockCreateAsync(...a)},
  },
  InterruptionModeIOS: {MixWithOthers: 0, DoNotMix: 1, DuckOthers: 2},
}));

jest.mock('../../../../assets/message.wav', () => 3, {virtual: true});

const mockGetActiveCall = jest.fn((): unknown => null);
const mockGetActiveGroupCall = jest.fn((): unknown => null);
jest.mock('../runtime/callRegistry', () => ({
  __esModule: true,
  getActiveCall: () => mockGetActiveCall(),
}));
jest.mock('../runtime/groupCallRegistry', () => ({
  __esModule: true,
  getActiveGroupCall: () => mockGetActiveGroupCall(),
}));

import {
  playMessageTone,
  _resetMessageToneForTest,
  _setInAppMessageSoundsForTest,
  inAppMessageSoundsEnabled,
  TONE_MIN_GAP_MS,
} from '../runtime/messageTone';

describe('messageTone guards (B-692)', () => {
  beforeEach(() => {
    // Fake timers so the 3 s unload backstop can't hold the process open —
    // the throttle itself takes an injected `now`, so no timer is awaited.
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetActiveCall.mockReturnValue(null);
    mockGetActiveGroupCall.mockReturnValue(null);
    _resetMessageToneForTest();
    // The guard cases below exercise the AUDIBLE layer; the shipped default
    // is asserted separately.
    _setInAppMessageSoundsForTest(true);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('kill switch ships OFF — founder veto 2026-08-29 (B-698 session)', () => {
    // "sound per message … I don't want that." Re-enabling requires a real
    // in-app-sounds SETTING, not a flag flip — see messageTone.ts header.
    _resetMessageToneForTest();
    expect(inAppMessageSoundsEnabled()).toBe(false);
  });

  it('the shipped default is SILENT end-to-end', async () => {
    _resetMessageToneForTest(); // back to default (off)
    expect(await playMessageTone('banner', 1_000)).toBe(false);
    expect(await playMessageTone('inChat', 1_000 + TONE_MIN_GAP_MS)).toBe(false);
    expect(mockCreateAsync).not.toHaveBeenCalled();
  });

  it('plays a one-shot (non-looping) blip and NEVER touches the audio mode', async () => {
    const played = await playMessageTone('banner', 1_000);
    expect(played).toBe(true);
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateAsync.mock.calls[0][1]).toEqual(
      expect.objectContaining({shouldPlay: true, isLooping: false}),
    );
    // The routing-clobber trap: a blip must not re-route live audio.
    expect(mockSetAudioModeAsync).not.toHaveBeenCalled();
  });

  it('banner tone is louder than the in-chat tone', async () => {
    await playMessageTone('banner', 1_000);
    await playMessageTone('inChat', 1_000 + TONE_MIN_GAP_MS);
    const [bannerOpts, inChatOpts] = mockCreateAsync.mock.calls.map(c => c[1] as {volume: number});
    expect(bannerOpts.volume).toBeGreaterThan(inChatOpts.volume);
  });

  it('throttles a burst — a second play inside TONE_MIN_GAP_MS is dropped', async () => {
    expect(await playMessageTone('banner', 5_000)).toBe(true);
    expect(await playMessageTone('banner', 5_000 + TONE_MIN_GAP_MS - 1)).toBe(false);
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
    expect(await playMessageTone('banner', 5_000 + TONE_MIN_GAP_MS)).toBe(true);
    expect(mockCreateAsync).toHaveBeenCalledTimes(2);
  });

  it('stays silent while a 1:1 call is live', async () => {
    mockGetActiveCall.mockReturnValue({callId: 'c1', gen: 1});
    expect(await playMessageTone('banner', 9_000)).toBe(false);
    expect(mockCreateAsync).not.toHaveBeenCalled();
  });

  it('stays silent while a GROUP call is live', async () => {
    mockGetActiveGroupCall.mockReturnValue({roomId: 'r1', gen: 1});
    expect(await playMessageTone('banner', 9_000)).toBe(false);
    expect(mockCreateAsync).not.toHaveBeenCalled();
  });

  it('a failed load reports false and never throws', async () => {
    mockCreateAsync.mockRejectedValueOnce(new Error('no audio focus'));
    expect(await playMessageTone('banner', 20_000)).toBe(false);
  });
});
