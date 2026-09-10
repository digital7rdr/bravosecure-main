/**
 * B-251 — "the call plays through the loudspeaker even though a headset is
 * connected".
 *
 * Both call screens discovered audio devices twice: `onAudioDeviceChanged`
 * (a TRANSITION) auto-snapped to a headset, while `getAudioDeviceList()` on
 * mount (the SEED) only populated the picker and decided nothing. A headset
 * already connected when the call started fires no transition, so the seed was
 * the only path that ran — and the media-type default won: SPEAKER_PHONE for
 * video, EARPIECE for voice.
 *
 * These pin the decision. The application of it stays in each screen, because
 * CallScreen's `pickAudioRouteNative` carries the BS-CALL-CHOPPY de-dupe guard
 * that keeps Bluetooth SCO from flapping.
 */
import {
  initialCallRoute,
  isAudioRoute,
  parseAudioDeviceList,
  preferredHeadset,
  type AudioRoute,
} from '../runtime/callAudioRoute';

describe('parseAudioDeviceList', () => {
  it('reads the native JSON array', () => {
    expect(parseAudioDeviceList('["EARPIECE","BLUETOOTH"]')).toEqual(['EARPIECE', 'BLUETOOTH']);
  });

  it('drops entries that are not routes we understand', () => {
    // A future OEM device type must not become an unroutable "route".
    expect(parseAudioDeviceList('["EARPIECE","TELEPATHY",7,null]')).toEqual(['EARPIECE']);
  });

  it('is total — malformed, empty, absent and non-array all mean "nothing known"', () => {
    // iOS has no getAudioDeviceList at all; a throw here would take out the
    // whole audio-setup effect and leave the call on whatever route the OS
    // happened to pick.
    for (const bad of ['', 'not json', '{"a":1}', undefined, null, 42, {}]) {
      expect(parseAudioDeviceList(bad)).toEqual([]);
    }
  });
});

describe('isAudioRoute', () => {
  it('accepts exactly the four real routes', () => {
    for (const r of ['BLUETOOTH', 'SPEAKER_PHONE', 'EARPIECE', 'WIRED_HEADSET']) {
      expect(isAudioRoute(r)).toBe(true);
    }
    for (const r of ['bluetooth', 'SPEAKER', '', null, undefined, 1]) {
      expect(isAudioRoute(r)).toBe(false);
    }
  });
});

describe('preferredHeadset', () => {
  it('WIRED beats BLUETOOTH — a cable is a deliberate act, proximity is not', () => {
    expect(preferredHeadset(['BLUETOOTH', 'WIRED_HEADSET', 'EARPIECE'])).toBe('WIRED_HEADSET');
  });

  it('takes Bluetooth when that is the only headset', () => {
    expect(preferredHeadset(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'])).toBe('BLUETOOTH');
  });

  it('is null with no headset — earpiece and speaker are not headsets', () => {
    expect(preferredHeadset(['EARPIECE', 'SPEAKER_PHONE'])).toBeNull();
    expect(preferredHeadset([])).toBeNull();
  });
});

describe('initialCallRoute — THE BUG', () => {
  it('a Bluetooth headset connected BEFORE a VIDEO call beats the speaker default', () => {
    // The reported symptom, exactly: answering on BT played through the
    // loudspeaker because video defaults to SPEAKER_PHONE.
    expect(initialCallRoute(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'], {isVideo: true}))
      .toBe('BLUETOOTH');
  });

  it('and before a VOICE call beats the earpiece default', () => {
    expect(initialCallRoute(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'], {isVideo: false}))
      .toBe('BLUETOOTH');
  });

  it('wired headphones win too', () => {
    expect(initialCallRoute(['EARPIECE', 'WIRED_HEADSET'], {isVideo: false})).toBe('WIRED_HEADSET');
  });

  it('falls back to the media-type default when nothing is attached', () => {
    expect(initialCallRoute(['EARPIECE', 'SPEAKER_PHONE'], {isVideo: true})).toBe('SPEAKER_PHONE');
    expect(initialCallRoute(['EARPIECE', 'SPEAKER_PHONE'], {isVideo: false})).toBe('EARPIECE');
  });

  it('an EXPLICIT user pick is never overridden', () => {
    // Someone who deliberately chose the speaker with a headset on their neck
    // must keep the speaker.
    expect(initialCallRoute(['BLUETOOTH'], {isVideo: true, hasExplicitPreference: true})).toBeNull();
  });

  it('an empty device list still yields a usable default, never null', () => {
    // iOS returns nothing from getAudioDeviceList; the call must still route.
    const r: AudioRoute | null = initialCallRoute([], {isVideo: false});
    expect(r).toBe('EARPIECE');
  });
});

/**
 * The decision above is worthless if a screen keeps its own copy. These are
 * source scans because neither call screen can be imported by this project —
 * they mount RN views and pull in react-native-webrtc.
 *
 * CRLF trap: these files are CRLF, so a \n-anchored regex matches NOTHING and
 * the assertion passes vacuously. Scan line-wise instead.
 */
describe('both call screens SEED from the shared decision', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  /** Comment-stripped source lines — prose containing a banned token is the
   *  single most common false result in this repo's scan tests. */
  function codeLines(rel: string): string[] {
    const raw = readFileSync(join(process.cwd(), rel), 'utf8');
    const out: string[] = [];
    let inBlock = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
      if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
      if (t.startsWith('*') || t.startsWith('//')) {continue;}
      out.push(line);
    }
    return out;
  }

  const SCREENS = [
    'src/screens/messenger/CallScreen.tsx',
    'src/screens/messenger/GroupCallScreen.tsx',
  ];

  it.each(SCREENS)('%s imports the shared helper', rel => {
    const src = codeLines(rel).join('\n');
    expect(src).toMatch(/import \{[^}]*preferredHeadset[^}]*\} from '@\/modules\/messenger\/runtime\/callAudioRoute'/);
  });

  it.each(SCREENS)('%s snaps to an already-connected headset on the first device event', rel => {
    // B-297 — this used to say "on mount", and asserted a mount-time seed that
    // read `InCallManager.getAudioDeviceList()`. That method does not exist in
    // react-native-incall-manager@4.2.1, so the seed always evaluated to
    // `undefined` through its optional call and decided nothing — this
    // assertion was green against code that never ran. The already-connected
    // case is really covered by the FIRST `onAudioDeviceChanged` event, whose
    // payload carries the full list. See audioRoutePhantomApi.test.ts.
    const src = codeLines(rel).join('\n');
    // The decision must still be the SHARED rule, not a hand-copy.
    expect(src).toMatch(/const snap = preferredHeadset\(list\)/);
    // Only when the user has not already chosen.
    expect(src).toMatch(/if \(preferredRouteRef\.current === null\)/);
    // Pin the choice, or the next device-list change reverts it.
    expect(src).toMatch(/preferredRouteRef\.current = snap;/);
    // And it must be reached from the event subscription, not a dead seed.
    expect(src).toMatch(/onAudioDeviceChanged[\s\S]*const snap = preferredHeadset\(list\)/);
  });

  it.each(SCREENS)('%s does not call the phantom getAudioDeviceList', rel => {
    // Full rationale in audioRoutePhantomApi.test.ts. Duplicated here because
    // this suite is what claimed the feature worked.
    expect(codeLines(rel).join('\n')).not.toContain('getAudioDeviceList');
  });

  it.each(SCREENS)('%s no longer hand-rolls the device-list parse', rel => {
    const src = codeLines(rel).join('\n');
    // The duplicated `JSON.parse(initial)` + inline filter is what drifted.
    expect(src).not.toMatch(/JSON\.parse\(initial\)/);
  });

  it('CallScreen routes through pickAudioRouteNative, keeping the SCO de-dupe guard', () => {
    // Bypassing it re-opens BS-CALL-CHOPPY: a redundant chooseAudioRoute tears
    // down and re-establishes the SCO link, and every renegotiation produces a
    // burst of PCM underruns.
    // B-297 — the call that satisfied this used to be in the DEAD mount seed,
    // while the live auto-snap issued a raw setForceSpeakerphoneOn +
    // chooseAudioRoute pair that bypassed the guard AND left `lastAppliedRoute`
    // stale (the very cache B-278 had to invalidate by hand). Removing the dead
    // seed exposed that; the live branch now routes through the helper.
    const src = codeLines('src/screens/messenger/CallScreen.tsx').join('\n');
    expect(src).toMatch(/const snap = preferredHeadset\(list\)[\s\S]{0,400}pickAudioRouteNative\(snap\)/);
  });
});

describe('B-251 — the DISPLAYED route and the APPLIED route agree', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  it('GroupCallScreen no longer seeds its icon from valid[0]', () => {
    // `valid[0]` is the first entry in NATIVE order — normally EARPIECE — so
    // with a headset connected the icon said one thing while the audio went
    // somewhere else. Two rules for one decision is the whole bug class.
    const raw = readFileSync(join(process.cwd(), 'src/screens/messenger/GroupCallScreen.tsx'), 'utf8');
    expect(raw).not.toMatch(/return valid\[0\]/);
    // B-297 — the icon used to be seeded by `initialCallRoute(parseAudioDeviceList(
    // initial), …)`, where `initial` came from the phantom getAudioDeviceList and
    // was therefore ALWAYS undefined: the seed collapsed to the media-type
    // default on every call. It is now that default explicitly, and the
    // `onAudioDeviceChanged` handler moves icon and route together — which is
    // what "one rule" was actually protecting.
    // B-302 added the escalation handover in front of the default; the default
    // is still what an ordinary (non-escalated) call renders.
    expect(raw).toMatch(/useState<AudioRoute>\(\s*initialAudioRoute \?\? \(isVideo \? 'SPEAKER_PHONE' : 'EARPIECE'\),?\s*\)/);
    expect(raw).toMatch(/onAudioDeviceChanged[\s\S]*setAudioRoute\(/);
  });
});
