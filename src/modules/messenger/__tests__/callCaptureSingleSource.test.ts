/**
 * BS-CALL-DUPMIC — a live call opens the microphone EXACTLY once.
 *
 * `CallScreen` used to run a second capture next to the WebRTC one: an
 * `expo-av Audio.Recording` (LOW_QUALITY + metering), started for the whole
 * connected leg of every VOICE call and polled at 10 Hz, purely to animate the
 * 11 waveform bars. The code even said so in its own comment — it had been
 * throttled for BATTERY and was never recognised as an audio fault.
 *
 * It is one. A second capture client:
 *   - Android — arrives with a DIFFERENT audio source than the call's
 *     VOICE_COMMUNICATION, so audio policy re-picks the input path. The HAL
 *     binds AEC/NS per input stream (`<preprocess><stream
 *     type="voice_communication">` in /vendor/etc/audio_effects.xml), so the
 *     reshuffle can strip echo cancellation off the call — the far end then
 *     hears itself — and re-tunes mic gain mid-call.
 *   - iOS — `setAudioModeAsync({allowsRecordingIOS: true})` rewrites the
 *     AVAudioSession category underneath CallKit/RTCAudioSession and is never
 *     restored, and starting a recorder on a live VoiceProcessingIO session
 *     tears down the voice-processing (AEC) unit.
 *
 * The level now comes from the capture the call already owns
 * (`useCall`'s 1 Hz getStats → `media-source` audioLevel → `stats.micLevel`).
 *
 * WHY A SOURCE SCAN: the call screens mount RN native views, so the node Jest
 * project cannot import them. Two traps this file must respect, both of which
 * have cost this repo real time before:
 *   1. The replacement code carries a long comment that NAMES every banned
 *      token ("Audio.Recording", "expo-av", "allowsRecordingIOS"). Comments are
 *      stripped before any absence assertion — scanning the raw file would fail
 *      on prose.
 *   2. These files are CRLF, so a `\n`-anchored regex matches nothing and the
 *      assertion passes VACUOUSLY. Everything below is line-based or `\r?\n`.
 *
 * Because comment-stripping can only ever REMOVE text, an absence assertion
 * built on it could in principle pass vacuously. The positive anchors at the
 * bottom exist so that failure mode cannot hide: they assert the replacement
 * path is present, which over-stripping would also break.
 *
 * If a call screen ever legitimately needs its own capture, update this file
 * DELIBERATELY with the reason — do not delete it to make a red run green.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');
const CALL_SCREENS: Array<[string, string]> = [
  ['CallScreen.tsx', join(SCREENS, 'CallScreen.tsx')],
  ['GroupCallScreen.tsx', join(SCREENS, 'GroupCallScreen.tsx')],
];

/**
 * Drop `/* ... *\/` blocks and `//` line tails so prose that merely NAMES a
 * banned token cannot satisfy — or defeat — an assertion. Line-based on
 * purpose: these files are CRLF and the terminators must survive.
 */
function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('BS-CALL-DUPMIC — call screens never open a second microphone', () => {
  it.each(CALL_SCREENS)('%s does not construct an expo-av recorder', (_label, path) => {
    const code = stripComments(readFileSync(path, 'utf8'));
    expect(code).not.toContain('Audio.Recording');
    expect(code).not.toContain('prepareToRecordAsync');
    expect(code).not.toContain('RecordingOptionsPresets');
  });

  it.each(CALL_SCREENS)('%s does not reconfigure the shared audio session via expo-av', (_label, path) => {
    const code = stripComments(readFileSync(path, 'utf8'));
    // setAudioModeAsync is how the AVAudioSession category gets rewritten out
    // from under CallKit on iOS, and how expo-av re-applies
    // setSpeakerphoneOn() over InCallManager's routing on Android. The call
    // screens route audio through InCallManager; only bravoTones (which owns
    // the ring/ringback player) may touch the expo-av audio mode.
    expect(code).not.toContain('setAudioModeAsync');
    expect(code).not.toContain('allowsRecordingIOS');
  });

  it.each(CALL_SCREENS)('%s does not import expo-av at all', (_label, path) => {
    const code = stripComments(readFileSync(path, 'utf8'));
    expect(code).not.toMatch(/from\s*'expo-av'/);
  });
});

describe('BS-CALL-DUPMIC — the waveform reads the capture the call already owns', () => {
  it('useCall publishes a mic level derived from the engine stats it already polls', () => {
    const useCall = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useCall.ts'),
      'utf8',
    );
    const code = stripComments(useCall);
    // The field must exist on the stats shape...
    expect(code).toMatch(/micLevel\s*:/);
    // ...and be fed from the engine's own audio-level stat, not a new capture.
    // (No "does not call getUserMedia" assertion here: useCall is precisely the
    // module that acquires the call's ONE local capture. What matters is that
    // the level is read off a stats report.)
    expect(code).toContain('audioLevel');
    expect(code).toMatch(/type\s*===\s*'media-source'/);
  });

  it('CallScreen drives the bars off that stat', () => {
    const code = stripComments(readFileSync(join(SCREENS, 'CallScreen.tsx'), 'utf8'));
    expect(code).toContain('micLevel');
    // The bars are still animated — this fix must not have silently deleted
    // the feature it was replacing.
    expect(code).toMatch(/bars\.forEach/);
  });
});
