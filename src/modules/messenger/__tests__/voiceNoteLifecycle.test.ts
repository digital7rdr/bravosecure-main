/**
 * B-148 / B-149 — voice-note recorder lifecycle + plaintext cleanup.
 *
 * `VoiceNoteRecorder.tsx` imports react-native AND expo-av at module
 * scope, and `ChatScreen.tsx` is a 3k-line RN screen — neither can be
 * loaded by the node `messenger-crypto` project, and stubbing expo-av's
 * `Audio.Recording` well enough to exercise a stop/stop race would be a
 * test of the stub, not the component. So these rules are pinned the way
 * this repo already pins everything inside `productionRuntime.ts`: by
 * reading the source (see messageTopologyInvariants.test.ts).
 *
 * That makes them REGRESSION tests, not proofs of behaviour — they fail
 * the moment a refactor drops a guard, which is exactly the failure mode
 * these four defects represent. The behavioural half needs a device pass
 * (record → send → play; record → navigate away; Send+Delete double-tap).
 *
 * DO NOT relax these. Each corresponds to a specific reported defect:
 *   (a) iOS audio session left in playAndRecord ⇒ later playback quiet
 *   (b) stop() re-entrancy ⇒ one clip both SENT and CANCELLED
 *   (c) no unmount teardown ⇒ hot mic + retained temp file
 *   (d) wall-clock duration ⇒ wrong length shipped to the recipient
 *   B-149 the plaintext capture was never deleted after encryption
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SRC = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

/**
 * Prose is not code. Every ordering assertion below MUST run on stripped
 * source: the guard comment literally contains the word "await", so an
 * unstripped scan finds it at the top of the function and reports the
 * guard as too late. This trap is documented in MESSAGE_LOOP.md §11 and
 * has cost this repo a session before.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const RECORDER = () => SRC('src', 'modules', 'messenger', 'ui', 'VoiceNoteRecorder.tsx');
const CHAT     = () => SRC('src', 'screens', 'messenger', 'ChatScreen.tsx');
const FILES    = () => SRC('src', 'modules', 'messenger', 'media', 'mediaFiles.ts');
const PICKED   = () => SRC('src', 'modules', 'messenger', 'ui', 'pickedAssets.ts');

describe('B-148(a) — the recording audio mode is released', () => {
  it('start() still opens the recording session', () => {
    expect(RECORDER()).toMatch(/allowsRecordingIOS:\s*true/);
  });

  it('a release path sets allowsRecordingIOS back to false', () => {
    expect(RECORDER()).toMatch(/allowsRecordingIOS:\s*false/);
  });

  it('the release runs on the success path, the throw path AND unmount', () => {
    const src = RECORDER();
    // Three call sites: after stopAndUnloadAsync, in stop()'s catch, and
    // in the unmount teardown. Fewer means one exit leaks the session.
    const calls = src.match(/releaseRecordingMode\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('B-148(b) — stop() is not re-entrant', () => {
  it('a stopping guard exists alongside the starting guard', () => {
    const src = RECORDER();
    expect(src).toContain('startingRef');
    expect(src).toContain('stoppingRef');
  });

  it('the guard is claimed BEFORE the first await, and released in a finally', () => {
    const src = stripComments(RECORDER());
    const start = src.indexOf('const stop = async');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('stopRef.current = stop', start));
    const guardAt   = body.indexOf('stoppingRef.current = true');
    const firstAwait = body.indexOf('await');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    // Claiming after an await is the bug: both callers pass the check.
    expect(guardAt).toBeLessThan(firstAwait);
    // A throw between claim and release would wedge the recorder shut.
    expect(body).toMatch(/finally\s*\{[\s\S]*?stoppingRef\.current = false/);
  });
});

describe('B-148(c) — the recorder is torn down on unmount', () => {
  it('an unmount effect stops a live recording', () => {
    const src = RECORDER();
    expect(src).toContain('recordingRef');
    // The teardown must be keyed on [] (real unmount), not on `recording`
    // — otherwise it tears down the recorder it just created.
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]*?stopAndUnloadAsync[\s\S]*?\},\s*\[\]\)/);
  });
});

describe('B-148(d) — duration comes from the recorder, not the wall clock', () => {
  it('getStatusAsync().durationMillis is preferred over Date.now()', () => {
    const src = RECORDER();
    expect(src).toContain('getStatusAsync');
    expect(src).toContain('durationMillis');
    // Wall-clock survives only as the fallback.
    expect(src).toMatch(/statusMs\s*\?\?\s*Date\.now\(\)\s*-\s*started/);
  });

  it('the 400ms accidental-tap floor still applies to the resolved duration', () => {
    expect(RECORDER()).toMatch(/durationMs\s*<\s*400/);
  });
});

describe('B-149 — the plaintext capture is deleted after encryption', () => {
  it('mediaFiles exposes a narrow app-owned-source deleter', () => {
    expect(FILES()).toContain('export async function deleteEphemeralSource');
  });

  it('the deleter refuses anything outside the app\'s own directories', () => {
    const src = FILES();
    const start = src.indexOf('export async function deleteEphemeralSource');
    const body = src.slice(start, src.indexOf('\n}', start));
    // Without BOTH guards this would happily unlink a library pick —
    // i.e. delete the user's photo out of their gallery.
    expect(body).toContain('file://');
    expect(body).toContain('CachesDirectoryPath');
    expect(body).toMatch(/startsWith\(root\)/);
  });

  it('PickedAsset carries the app-owned-source flag', () => {
    expect(PICKED()).toContain('ephemeralSource');
  });

  it('ONLY the voice-note site sets the flag (library picks must not)', () => {
    const chat = CHAT();
    const sites = chat.match(/ephemeralSource:\s*true/g) ?? [];
    expect(sites).toHaveLength(1);
    // …and it is still the recorder's completion path.
    //
    // B-159 moved the handler: the composer was extracted into <ChatComposer>,
    // so the flag no longer sits inside a literal `onComplete={…}` prop 400
    // chars away — it lives in the screen's `onVoiceComplete` callback, which
    // is handed to the composer and wired to the recorder there. The textual
    // adjacency check was an ANCHOR, not the invariant; following the code
    // keeps the real rule (only the voice note marks its source deletable)
    // alive across the extraction. Deleting the assertion would have silently
    // retired B-149. The chain is now asserted end to end, which is stronger
    // than the proximity check it replaces.
    const at = chat.indexOf('ephemeralSource: true');
    const declStart = chat.lastIndexOf('const onVoiceComplete', at);
    expect(declStart).toBeGreaterThan(-1);
    expect(declStart).toBeLessThan(at);
    // screen → composer → recorder
    expect(chat).toMatch(/onVoiceComplete=\{onVoiceComplete\}/);
    expect(chat).toMatch(/onComplete=\{onVoiceComplete\}/);
  });

  it('the flag is forwarded through the media queue and acted on after the read', () => {
    const chat = CHAT();
    // B-707 appended a `caption` argument after this one, so the anchor can no
    // longer require the closing paren — `[,)]` keeps the real invariant (the
    // flag IS forwarded through the queue) while tolerating later arguments.
    // Re-pointed, not relaxed: a call that drops `next.ephemeralSource` still
    // fails, which is the B-149 defect.
    expect(chat).toMatch(/sendPickedMediaRef\.current\([\s\S]{0,160}?next\.ephemeralSource[,)]/);
    // Deletion must follow readUriBytes (we need the bytes) and precede
    // the size bail-out (which would otherwise strand the plaintext).
    const readAt   = chat.indexOf('const bytes = await readUriBytes(uri);');
    const deleteAt = chat.indexOf('deleteEphemeralSource(uri)');
    const capAt    = chat.indexOf('V2_CIPHERTEXT_OVERHEAD =');
    expect(readAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(readAt);
    expect(deleteAt).toBeLessThan(capAt);
  });
});
