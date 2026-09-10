# GCV-1 - Camera re-acquisition drops the 640x480 capture constraint (fork silently defaults to 1280x720)

## Verdict

**CONFIRMED** (line numbers in the audit are exact; no drift).

Evidence from the current tree:

1. Boot capture pins 4:3 — `src/modules/messenger/webrtc/peerConnectionFactory.ts:79-84`:
   ```ts
   video: opts.video ? {
     facingMode: 'user',
     width:      {ideal: 640,  max: 1280},
     height:     {ideal: 480,  max: 720},
     frameRate:  {ideal: 30,   max: 30},
   } : false,
   ```
2. All four re-acquisition sites pass facingMode ONLY (verified by
   `grep -n facingMode src/`, which returns exactly these):
   - `peerConnectionFactory.ts:115` (`flipCamera`, the audit's "switchCameraForCall"):
     `const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: next}});`
   - `peerConnectionFactory.ts:169` (`recoverCamera`, the audit's "recoverCameraTrack"):
     `const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});`
   - `peerConnectionFactory.ts:211` (`recoverGroupCamera`): identical line.
   - `useGroupCall.ts:3694` (`toggleVideo` ON / voice->video upgrade):
     `const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: facing}});`
3. The fork normalizes missing dims to 720p — `node_modules/react-native-webrtc`
   (`@livekit/react-native-webrtc@125.0.12`) `src/RTCUtil.ts`:
   ```js
   const DEFAULT_VIDEO_CONSTRAINTS = { facingMode: 'user', frameRate: 30, height: 720, width: 1280 };
   ...
   if (!c.height && !c.width) {
       c.height = DEFAULT_VIDEO_CONSTRAINTS.height;
       c.width  = DEFAULT_VIDEO_CONSTRAINTS.width;
   }
   ```
   `normalizeMediaConstraints` runs on every `getUserMedia` call (`src/getUserMedia.ts:32`
   `constraints = RTCUtil.normalizeConstraints(constraints);`), so the omission is not
   "let the platform decide" — it is an explicit 1280x720 request.
4. Render side is fixed-rect + cover, so the source-aspect change lands as a crop change:
   `src/components/FlexibleVideoTile.tsx:105` `objectFit="cover"`,
   `src/screens/messenger/CallScreen.tsx:2207` `objectFit="cover"`.
5. Second-order confirmation (group): the simulcast ladder is tuned against a 640x480 source —
   `useGroupCall.ts:2084-2087` / `:2730-2733` / `:3777-3780`
   `{rid:'r0', maxBitrate:150_000, scaleResolutionDownBy:4, ...}`. A 1280x720 source pushes
   r2 to 720p under a 1.2 Mbps cap (r0 becomes 320x180), i.e. the re-acquired camera is
   _both_ wrongly-cropped and worse-encoded than the booted one.

## Mechanism

1. Call boots video via `getLocalMedia({video:true})` (`useCall.ts:452`, `useGroupCall.ts:1315`).
   Native capture = 640x480, source aspect 0.75.
2. Any of these four events fires:
   - user taps flip camera (`useCall.ts:1453` -> `flipCamera`),
   - app resumes after another app stole the camera (`useCall.ts:254` -> `recoverCamera`;
     `useGroupCall.ts:589` -> `recoverGroupCamera`),
   - user toggles the camera back ON in a 1:1 call (`useCall.ts:1212` -> `recoverCamera`),
   - user toggles the camera ON / upgrades voice->video in a group call (`useGroupCall.ts:3694`).
3. Each of those calls `getUserMedia({audio:false, video:{facingMode}})` with no width/height.
4. `RTCUtil.normalizeMediaConstraints` sees `!c.height && !c.width` and substitutes
   1280x720. The camera re-opens at 720p, source aspect 0.5625.
5. `replaceTrack` swaps the new 720p source onto the SAME `RTCRtpSender` / mediasoup producer.
   Because there is no renegotiation and no `setParameters` re-application, the encoder keeps
   the encodings that were chosen for a 480p source.
6. `RTCView` (`objectFit:'cover'`) now has to fill a slot rect sized for the old aspect from a
   16:9 source: it scales-to-fill and crops the long axis. Self-tile crop goes from ~0-5% to
   ~21-25%; in a hero slot up to ~39%. Users read this as "my self tile suddenly zoomed in".
7. Because the four sites are hit by _different_ user actions, the same call can show different
   self-view zoom on two devices depending on how video was started — matching the device-log
   640x480 <-> 1280x720 flip-flop in the audit's evidence section.

Important honesty note: fixing GCV-1 restores the **boot-time baseline** everywhere; it does not
make crop zero. The residual structural crop (fixed-rect + cover, hero slots) is GCV-2 and needs
its own product decision. GCV-1 is what makes the zoom _change mid-call_, which is the complaint.

## Fix

Single shared constraint builder in `peerConnectionFactory.ts`, used at all five capture sites
(boot + four re-acquisitions). No wire format, no persisted schema, no migration, no server
change, no security surface touched (SFrame/FrameCryptor attachment is unaffected — every site
keeps its existing `replaceTrack`-onto-the-same-sender behavior).

### File 1 — `src/modules/messenger/webrtc/peerConnectionFactory.ts`

**Edit 1a — add the shared builder above `getLocalMedia`.**

Anchor (verbatim, unique):

```ts
export const rtcPeerConnectionFactory: PeerConnectionFactory = cfg =>
  new RTCPeerConnection(cfg) as unknown as PeerConnectionLike;
```

Insert immediately AFTER that anchor:

```ts
/**
 * GCV-1 — the single source of truth for LOCAL capture geometry.
 *
 * Why: `@livekit/react-native-webrtc` normalizes a video constraint with no
 * width AND no height to its own 1280x720 default (RTCUtil DEFAULT_VIDEO_CONSTRAINTS),
 * so every re-acquisition that passed `{facingMode}` alone silently re-opened the
 * camera at 16:9 while boot captured 4:3. With objectFit 'cover' that flips the
 * self-tile crop mid-call ("zoomed" self view) and de-tunes the group simulcast ladder.
 */
export function localVideoConstraints(facing: 'user' | 'environment'): {
  facingMode: 'user' | 'environment';
  width: {ideal: number; max: number};
  height: {ideal: number; max: number};
  frameRate: {ideal: number; max: number};
} {
  return {
    facingMode: facing,
    width: {ideal: 640, max: 1280},
    height: {ideal: 480, max: 720},
    frameRate: {ideal: 30, max: 30},
  };
}
```

**Edit 1b — make boot use the builder (so the constant cannot drift).**

Anchor (verbatim, unique):

```ts
    video: opts.video ? {
      facingMode: 'user',
      width:      {ideal: 640,  max: 1280},
      height:     {ideal: 480,  max: 720},
      frameRate:  {ideal: 30,   max: 30},
    } : false,
```

Replacement:

```ts
    video: opts.video ? localVideoConstraints('user') : false,
```

(The long `// Bias the camera toward 480p@30 ...` comment block directly above stays —
do not delete it; it documents the 480p rationale.)

**Edit 1c — `flipCamera`.**

Anchor (verbatim, unique — `next` appears only here):

```ts
const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: next}});
```

Replacement:

```ts
const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(next)});
```

**Edit 1d — `recoverCamera`.** NOTE: the anchor line
`const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});`
is **not unique** — it appears at :169 (`recoverCamera`) and :211 (`recoverGroupCamera`).
Use the multi-line anchors below so the two edits are unambiguous.

Anchor (verbatim, unique — preceded by the `videoSender` guard):

```ts
if (!videoSender) {
  return null;
}

const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});
```

Replacement:

```ts
if (!videoSender) {
  return null;
}

const fresh = await mediaDevices.getUserMedia({
  audio: false,
  video: localVideoConstraints(args.facing),
});
```

**Edit 1e — `recoverGroupCamera`.**

Anchor (verbatim, unique — preceded by the producer guard):

```ts
if (!args.producer) {
  return null;
}
const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});
```

Replacement:

```ts
if (!args.producer) {
  return null;
}
const fresh = await mediaDevices.getUserMedia({
  audio: false,
  video: localVideoConstraints(args.facing),
});
```

### File 2 — `src/modules/messenger/webrtc/useGroupCall.ts`

**Edit 2a — import the builder.**

Anchor (verbatim, unique, line 118):

```ts
import {getLocalMedia, recoverGroupCamera} from './peerConnectionFactory';
```

Replacement:

```ts
import {getLocalMedia, localVideoConstraints, recoverGroupCamera} from './peerConnectionFactory';
```

**Edit 2b — `toggleVideo` ON / voice->video upgrade (line 3694).**

Anchor (verbatim, unique):

```ts
const facing = isFrontCameraRef.current ? 'user' : 'environment';
const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: facing}});
```

Replacement:

```ts
const facing = isFrontCameraRef.current ? 'user' : 'environment';
const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(facing)});
```

That is the whole production diff: 2 files, 6 hunks, ~20 net lines.

### Not in this fix (state explicitly, do not silently expand scope)

- No `patches/react-native-webrtc+125.0.12.patch` change (that is GCV-3's territory).
- No `objectFit` / tile-geometry change (GCV-2 — needs the cover-vs-contain product decision).
- No `setParameters` re-application after `replaceTrack`. Once capture is pinned back to 480p
  the existing encodings are correct again, so re-applying is unnecessary; adding it here would
  be a drive-by and would touch the group simulcast ladder.

## Blast radius

**Files edited**

- `src/modules/messenger/webrtc/peerConnectionFactory.ts` — `getLocalMedia`, `flipCamera`,
  `recoverCamera`, `recoverGroupCamera` + new exported `localVideoConstraints`.
- `src/modules/messenger/webrtc/useGroupCall.ts` — import line + one `getUserMedia` call.

**Callers of the changed functions (behavior changes for all of them, all in the intended direction)**

- `getLocalMedia` <- `useCall.ts:452` (call boot), `useCall.ts:1291` (1:1 voice->video upgrade),
  `useGroupCall.ts:1315` (group boot). _Behaviorally identical_ — Edit 1b is a pure refactor to
  the same literal.
- `flipCamera` <- `useCall.ts:1453` (`doFlip`) <- `CallScreen.tsx:676` `setCameraFacing`.
- `recoverCamera` <- `useCall.ts:254` (resume handler) and `useCall.ts:1212` (1:1 toggleVideo ON).
- `recoverGroupCamera` <- `useGroupCall.ts:589` (group resume handler).
- Group `toggleVideo` ON feeds both the `replaceTrack` re-enable path (`useGroupCall.ts:3707+`)
  and the fresh-produce path (`:3777` ladder) — both now receive a 480p source, which is what
  the ladder's `scaleResolutionDownBy: 4/2/1` was designed for.

**Persisted schema / wire format**: none. No SQLCipher schema version bump, no outbox row shape
change, no relay DTO change, no SDP/ICE change (all four sites already used `replaceTrack` with
no renegotiation). Old peers are unaffected — this is a purely local capture-side constraint;
a patched client talking to an unpatched client just sends a 4:3 source instead of 16:9, which
is exactly what boot already did.

**Existing tests that WILL FAIL and must be updated in the same commit** (they assert the buggy
argument verbatim):

- `src/modules/messenger/__tests__/recoverCamera.test.ts:61`
  `expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: {facingMode: 'environment'}});`
- `src/modules/messenger/__tests__/recoverGroupCamera.test.ts:53` (same assertion).

**Overlapping findings**

- **GCV-2** (FlexibleVideoTile / cover policy) — different files (`FlexibleVideoTile.tsx`,
  `GroupCallScreen.tsx`) so no textual conflict, but GCV-2's decision _depends_ on GCV-1
  landing first: option (a) in the audit ("keep cover + pin capture portrait-matching") is only
  coherent once capture is actually pinned. Land GCV-1 first.
- **GCV-4** (`GroupCallScreen.tsx:1620` mirror) and **GCV-5** (`GroupCallScreen.tsx` dimensions)
  — no overlap.
- **GCV-3** (fork patch for unrotated `onFrameResolutionChanged` dims) — no overlap, but note it
  changes the _reported_ aspect, not the _captured_ one; the two fixes are independent.
- No other finding in `docs/audits/messenger_audit_2026-07-19.md` cites
  `peerConnectionFactory.ts` or `useGroupCall.ts` (verified by grep), so no merge conflicts
  with the rest of the batch beyond the shared `useGroupCall.ts` file surface.

**What could regress**

- A device whose rear camera does not enumerate a 640x480 mode: the fork passes the requested
  dims to the native camera enumerator, which picks the closest supported format, so this
  degrades to "nearest mode" rather than failing. 640x480 is a mandatory Camera2 output size on
  Android and available on all iOS lenses, so the practical risk is ~zero — but if a
  `flipCamera` failure surfaces on an exotic lens it will surface here first.
- Rear-camera video quality drops from 720p to 480p after a flip. That is the _intended_
  correction (it matches boot and the 600 kbps cap at `useCall.ts:752` / the group ladder), but
  it is a user-visible change and should be called out in the release note.

## Tests

Jest project: **`messenger-crypto`** (`testMatch: <rootDir>/src/modules/messenger/__tests__/**/*.test.ts`).
Run with `npm run test:crypto`.

**1. Update `src/modules/messenger/__tests__/recoverCamera.test.ts`**
Replace the existing assertion at :61:

```ts
// GCV-1 — same facing (not flipped), audio off, AND the pinned 480p geometry.
expect(mockGetUserMedia).toHaveBeenCalledWith({
  audio: false,
  video: {
    facingMode: 'environment',
    width: {ideal: 640, max: 1280},
    height: {ideal: 480, max: 720},
    frameRate: {ideal: 30, max: 30},
  },
});
```

**2. Update `src/modules/messenger/__tests__/recoverGroupCamera.test.ts`** — same replacement at
:53 with `facingMode: 'environment'`.

**3. New `src/modules/messenger/__tests__/localVideoConstraints.test.ts`** (project
`messenger-crypto`; copy the `jest.mock('react-native', ...)` + `jest.mock('react-native-webrtc', ...)`
preamble from `recoverCamera.test.ts` verbatim — `peerConnectionFactory` imports both).

Assertions:

- `localVideoConstraints('user')` and `localVideoConstraints('environment')` each return
  width/height/frameRate objects (this is the regression guard against re-omitting dims).
- **The fork-default guard** — replicate `RTCUtil.normalizeMediaConstraints`'s decisive branch
  and prove our constraint never hits it:
  ```ts
  // Mirrors @livekit/react-native-webrtc RTCUtil.normalizeMediaConstraints:
  //   if (!c.height && !c.width) { c.height = 720; c.width = 1280; }
  const extractNumber = (c: Record<string, unknown>, prop: string): number | undefined => {
    const v = c[prop] as number | Record<string, number> | undefined;
    if (typeof v === 'number') {
      return v;
    }
    if (v && typeof v === 'object') {
      for (const k of ['exact', 'ideal', 'max', 'min']) {
        if (v[k]) {
          return v[k];
        }
      }
    }
    return undefined;
  };
  const c = localVideoConstraints('user') as unknown as Record<string, unknown>;
  expect(extractNumber(c, 'width')).toBe(640);
  expect(extractNumber(c, 'height')).toBe(480);
  ```
- Aspect ratio is 4:3 (`640 / 480 === 1.3333...`), pinning the property the tile crop depends on.
- `flipCamera`, `recoverCamera` and `recoverGroupCamera` each call `getUserMedia` with
  `video: localVideoConstraints(<expected facing>)` — assert with
  `expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: localVideoConstraints('user')})`
  so the three helpers are pinned to the shared builder by identity of value, not by a copied literal.
- `getLocalMedia({video: true})` calls `getUserMedia` with
  `expect.objectContaining({video: localVideoConstraints('user')})` — guards Edit 1b against drift.
- `getLocalMedia({video: false})` still passes `video: false` (no camera opened).

**4. New static guard in `src/modules/messenger/__tests__/groupCallVideoBoot.test.ts`**
(existing file, already about group video boot; add a `describe` block). Follow the
`readFileSync` precedent at `src/modules/messenger/__tests__/groupCallConsumeOrder.test.ts:21-30`
— `useGroupCall` is a hook whose full mediasoup/WS/FrameCryptor surface is not mockable, so pin
the one line that regressed:

```ts
import {readFileSync} from 'fs';
import {join} from 'path';

const GROUP_SRC = readFileSync(join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8');

describe('useGroupCall — GCV-1 capture geometry', () => {
  it('never re-acquires the camera with facingMode alone (fork defaults to 1280x720)', () => {
    expect(GROUP_SRC).not.toMatch(/getUserMedia\(\{\s*audio:\s*false,\s*video:\s*\{\s*facingMode/);
  });

  it('toggleVideo ON acquires through the shared localVideoConstraints builder', () => {
    expect(GROUP_SRC).toMatch(
      /getUserMedia\(\{audio: false, video: localVideoConstraints\(facing\)\}\)/,
    );
  });
});
```

Add the mirror-image guard for `peerConnectionFactory.ts` in the new
`localVideoConstraints.test.ts` (`expect(FACTORY_SRC).not.toMatch(/video: \{facingMode/)`) so all
five sites are covered by one invariant.

**Gates to run**

- `npm run test:crypto` (direct + regression — covers `recoverCamera`, `recoverGroupCamera`,
  `groupCallVideoBoot`, `groupCallCameraToggle`).
- `npm test` (full) before declaring done.
- `npm run typecheck` — must not exceed `.tsc-baseline.json` (47).
- **Device smoke (cannot be done in CI — say so if not run):** with
  `adb logcat | grep -i "bravo.callquality\|CameraCapture\|Selected capture format"`, confirm the
  capture format stays `640x480` across: (a) 1:1 flip camera, (b) 1:1 camera off->on,
  (c) group camera off->on, (d) group voice->video upgrade, (e) steal the camera with the stock
  Camera app and return. The self tile must not visibly change zoom at any of the five moments.

## Risk

- **The fork ignores `max`.** `RTCUtil.extractNumber` returns the FIRST truthy of
  `['exact','ideal','max','min']`, so `{ideal:640, max:1280}` resolves to 640 and the `max` key
  is inert. Keeping `max` matches the boot literal and documents intent, but a reviewer should
  not believe it caps anything.
- **Two identical anchor lines.** `peerConnectionFactory.ts:169` and `:211` are byte-identical.
  A careless `replace_all` or a single-line anchor will edit the wrong function or fail. The
  multi-line anchors in Edit 1d/1e exist for this reason — verify both functions changed.
- **This does not zero the crop.** If a reviewer expects "self tile no longer zoomed at all",
  they will be disappointed: GCV-1 only removes the mid-call _change_ and restores the boot
  baseline (~0-5% self tile). The residual hero-slot crop is GCV-2 and is a separate decision.
- **Group ladder interaction.** The `replaceTrack` re-enable path does not re-run
  `setParameters`; it inherits encodings computed at produce time. Before this fix the mismatch
  was 720p-source-into-480p-ladder; after, source and ladder agree. A reviewer should confirm no
  one "helpfully" adds a `setParameters` call here — that would touch the simulcast ladder and
  the SFrame-bearing sender, which is out of scope.
- **Security surface is untouched, and must stay untouched.** None of the five edits changes
  which `RTCRtpSender`/mediasoup producer is used, so the FrameCryptor/SFrame transform stays
  attached (see the explicit warning at `peerConnectionFactory.ts:187-204`: do NOT close +
  recreate the producer — that risks a plaintext-video window). Reject any variant of this fix
  that re-produces instead of `replaceTrack`.
- **Log audit.** The only logging touched is the pre-existing
  `console.log('[bravo.callquality] getLocalMedia video=...')`; no new logs, so
  `packages/messenger-core/__tests__/logAudit.test.ts` is unaffected. Do not add a log that
  prints capture dimensions alongside any conversation/user identifier.
