/**
 * B-455 — founder: "the small video box's corners don't fit inside its own
 * bordered frame — my video overflows the rounded corner and looks square."
 *
 * TWO stacked causes, and only the first is fixable in JS:
 *
 *  1. LAYOUT. The PiP pinned its video plane to `top/left/right/bottom: -2`
 *     — deliberately, to kill a padding band inside the 2dp border — which
 *     made the plane 112x152 inside a 108x148 rounded frame and relied on
 *     the parent's `overflow:'hidden'` to clip it back. That works for
 *     ordinary views. It is a pure RN-layout overflow on BOTH platforms the
 *     moment the clip does not apply.
 *  2. COMPOSITING. On Android an RTCView is a `SurfaceViewRenderer`
 *     (react-native-webrtc WebRTCView.java, `new SurfaceViewRenderer(...)`)
 *     living in its own compositor layer, so an ancestor's rounded-corner
 *     canvas clip never reaches it. The vendored renderer exposes NO
 *     TextureView / clip / corner option — RTCVideoViewManager's props are
 *     mirror, objectFit, streamURL, zOrder and onDimensionsChange, and
 *     `setZOrder` only toggles setZOrderMediaOverlay / setZOrderOnTop
 *     (WebRTCView.java:521-533). Closing this half needs native work.
 *
 * The fix therefore restructures the geometry so the surface can never
 * reach past the frame: the outer view keeps position/size/border/radius/
 * shadow, an INNER container fills the border's content box EXACTLY (zero
 * insets = the padding box) with the concentric radius (outer minus border
 * width) and `overflow:'hidden'`, and the RTCView absolute-fills THAT. The
 * padding band the -2 was fighting cannot come back, because the inner
 * container now owns the padding box precisely.
 *
 * FloatingCallOverlay's video card looks like the same class and is NOT: it
 * never had the -2 bleed, its own `overflow:'hidden'` is the iOS clip, and on
 * Android nothing an ancestor does reaches the surface. A clip wrapper there is
 * inert, so the second describe below pins its ABSENCE.
 *
 * Both screens mount RN views and cannot be imported by the node project —
 * source scan, comments stripped. Both files are CRLF, so nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const call = strip('CallScreen.tsx');
const overlay = strip('FloatingCallOverlay.tsx');

/** The body of a `name: { ... }` StyleSheet entry. */
function styleBlock(src: string, name: string): string {
  const at = src.indexOf(`${name}: {`);
  if (at < 0) {return '';}
  return src.slice(at, src.indexOf('},', at));
}

describe('B-455 — CallScreen PiP: the video plane cannot poke past the frame', () => {
  it('CONTROL: the scan is reading a real, populated screen', () => {
    expect(call.length).toBeGreaterThan(2000);
    expect(call).toContain('styles.pip');
  });

  it('the frame keeps its own border, radius and shadow', () => {
    const pip = styleBlock(call, '  pip');
    expect(pip).toContain('width:108');
    expect(pip).toContain('height:148');
    expect(pip).toContain('borderRadius:18');
    expect(pip).toContain('borderWidth:2');
    expect(pip).toContain("overflow:'hidden'");
  });

  it('an INNER clip container sits between the frame and the video', () => {
    const clip = styleBlock(call, 'pipClip');
    expect(clip).not.toBe('');
    expect(clip).toContain("overflow:'hidden'");
    // Zero insets = the border's content (padding) box, exactly.
    expect(clip).toContain('top:0');
    expect(clip).toContain('left:0');
    expect(clip).toContain('right:0');
    expect(clip).toContain('bottom:0');
    expect(call).toContain('<View style={styles.pipClip}>');
  });

  it('the inner radius is concentric — outer radius minus the border width', () => {
    // Derived, not asserted as a magic number: a future frame restyle that
    // changes one and forgets the other fails here.
    const pip = styleBlock(call, '  pip');
    const clip = styleBlock(call, 'pipClip');
    const outer = Number(/borderRadius:(\d+(?:\.\d+)?)/.exec(pip)?.[1]);
    const border = Number(/borderWidth:(\d+(?:\.\d+)?)/.exec(pip)?.[1]);
    const inner = Number(/borderRadius:(\d+(?:\.\d+)?)/.exec(clip)?.[1]);
    expect(Number.isFinite(outer)).toBe(true);
    expect(Number.isFinite(border)).toBe(true);
    expect(inner).toBeCloseTo(outer - border, 5);
  });

  it('NO negative insets survive on the tile content style', () => {
    // The B-455 shape itself. `top:-2` pushed the plane out to the border
    // box; on Android the surface is not clipped by the parent radius, so
    // that is exactly the square overflow the founder screenshotted.
    const fill = styleBlock(call, 'pipFill');
    expect(fill).not.toBe('');
    expect(fill).not.toMatch(/:\s*-\d/);
    expect(styleBlock(call, 'pipClip')).not.toMatch(/:\s*-\d/);
    // The exact pre-B-455 declaration, anchored on the style name so an
    // unrelated negative offset elsewhere in the sheet cannot satisfy it.
    expect(call).not.toMatch(/pipFill:\s*\{[^}]*-\d/);
  });

  it('the RTCViews absolute-fill their clip box (no bespoke inset style)', () => {
    for (const at of [...call.matchAll(/<RTCView/g)].map(m => m.index ?? 0)) {
      const el = call.slice(at, call.indexOf('/>', at));
      expect(el).toContain('style={StyleSheet.absoluteFill}');
    }
  });

  it('zOrder is untouched — the clip fix must not restack the surfaces', () => {
    expect(call).toContain("zOrder={slot === 'full' ? 0 : 1}");
  });
});

/**
 * FloatingCallOverlay is NOT the same class, and the clip wrapper it briefly
 * grew was INERT. Pinned as an absence so it does not come back:
 *
 *  - the PiP's bug was a LAYOUT bleed (`-2` on every side, out to the border
 *    box). This card never had one — its RTCView absolute-fills the card;
 *  - on iOS the card's own `overflow:'hidden'` already clips it, so a wrapper
 *    clips nothing that was not clipped;
 *  - on Android the RTCView is a SurfaceView composited ABOVE the window, so
 *    NO ancestor's rounded clip reaches it — the card's or a wrapper's alike.
 *
 * Adding structure that changes no pixel is not free: it is a second geometry
 * to keep concentric with the frame, and it reads as a fix, which is how the
 * real (native) remainder stops being tracked.
 */
describe('B-455 — FloatingCallOverlay video card: NOT the same class', () => {
  it('CONTROL: the scan is reading a real, populated component', () => {
    expect(overlay.length).toBeGreaterThan(2000);
    expect(overlay).toContain('styles.videoCard');
  });

  it('no inert clip wrapper — neither the style nor a render site', () => {
    expect(styleBlock(overlay, 'videoCardClip')).toBe('');
    expect(overlay).not.toContain('styles.videoCardClip');
  });

  it('the card itself is what clips, and it still has the frame to clip against', () => {
    const card = styleBlock(overlay, 'videoCard');
    expect(card).toContain("overflow:'hidden'");
    expect(card).toMatch(/borderRadius:\d/);
    expect(card).toMatch(/borderWidth:\d/);
  });

  it('both RTCViews absolute-fill the card directly, with no bespoke inset', () => {
    const sites = [...overlay.matchAll(/<RTCView/g)].map(m => m.index ?? 0);
    expect(sites.length).toBe(2);
    for (const at of sites) {
      const el = overlay.slice(at, overlay.indexOf('/>', at));
      expect(el).toContain('style={StyleSheet.absoluteFill}');
      // A negative inset here IS the PiP's original bug, and unlike the PiP
      // there is no wrapper to catch it.
      expect(el).not.toMatch(/:\s*-\d/);
    }
  });

  /**
   * DOCUMENTS B-461 — this pins the CURRENT, BROKEN behaviour.
   *
   * `zOrder={2}` maps to `setZOrderOnTop(true)` (WebRTCView.java:521-533),
   * which composites the surface above the whole window — so the overlay's own
   * `videoCardFooter` (peer name + timer) and the `videoCardHangup` glyph paint
   * UNDER the video. The hangup control is invisible while still being tappable
   * (it is a sibling rendered AFTER the touchable, so it wins hit-testing),
   * which is a painting defect, not a dead control.
   *
   * WHEN FIXED: this assertion must become the lowered value —
   *   expect(overlay.split('zOrder={2}').length - 1).toBe(0)
   * plus whatever the device-verified replacement is — and this block renamed
   * off DOCUMENTS. NOT changed here: lowering zOrder on a minimized overlay
   * risks the surface disappearing behind the host window entirely, and that
   * needs a device pass. A separate audit is in flight on the founder-reported
   * dead tap; do not pre-empt it.
   */
  it('DOCUMENTS B-461 — the surface still paints above its own footer/controls', () => {
    expect(overlay.split('zOrder={2}').length - 1).toBe(2);
    // The two things it paints over, so the consequence is pinned alongside
    // the cause and a later reshuffle cannot quietly drop them.
    expect(overlay).toContain('styles.videoCardFooter');
    expect(overlay).toContain('styles.videoCardHangup');
  });
});

/**
 * B-460 — the founder's dead minimized-call bar. Tapping it hid the overlay and
 * routed nowhere, leaving a live call with no controls at all.
 *
 * `navigateToMessengerScreen` returns false on three paths (messengerDeepLink
 * :274 no nav object, :275 not ready, :304 a throwing navigate) and BOTH restore
 * handlers discarded that boolean. Worse, it returns TRUE for a navigate React
 * Navigation then drops silently — documented at messengerDeepLink.ts:12-15 and
 * live during the product-gate / product-switch hold windows, which is exactly
 * when productSwitch.ts:48,53 minimizes the call.
 *
 * So the contract is two-part, and both halves are pinned for BOTH handlers:
 * consume the boolean, then VERIFY the resolved route before trusting the
 * optimistic clear.
 */
describe('B-460 — a restore that did not land must put the overlay back', () => {
  /** Each restore handler's body, bounded by the hangup that follows it. */
  const handler = (from: string): string => {
    const at = overlay.indexOf(from);
    expect(at).toBeGreaterThan(-1);
    const start = overlay.indexOf('const restore = (): void => {', at);
    expect(start).toBeGreaterThan(-1);
    const end = overlay.indexOf('const hangup', start);
    expect(end).toBeGreaterThan(start);
    return overlay.slice(start, end);
  };
  const ONE_TO_ONE = handler('const isVideo = active.kind');
  const GROUP      = handler('function GroupOverlay');

  it('CONTROL: the two handlers are found and are distinct', () => {
    expect(ONE_TO_ONE).toContain("'CallScreen'");
    expect(GROUP).toContain("'GroupCallScreen'");
    expect(ONE_TO_ONE).not.toBe(GROUP);
  });

  it.each([
    ['1:1',   ONE_TO_ONE, 'setMinimized'],
    ['group', GROUP,      'setGroupCallMinimized'],
  ])('%s consumes the navigate result before clearing minimized', (_label, body, setter) => {
    expect(body).toMatch(/const ok = navigateToMessengerScreen\(/);
    const okAt  = body.indexOf('if (!ok) {return;}');
    // WI-1.1 — the 1:1 setter takes a CallKey first, so match the CALL rather
    // than a literal argument list.
    const clear = body.search(new RegExp(`${setter}\\([^)]*false\\)`));
    expect(okAt).toBeGreaterThan(-1);
    // The bail must come FIRST — after the clear it is useless.
    expect(clear).toBeGreaterThan(okAt);
  });

  it.each([
    ['1:1',   ONE_TO_ONE, 'CallScreen',      'setMinimized'],
    ['group', GROUP,      'GroupCallScreen', 'setGroupCallMinimized'],
  ])('%s verifies the resolved route and reverts if it never arrived', (_l, body, target, setter) => {
    expect(body).toMatch(new RegExp(`confirmRestored\\('${target}', \\(\\) => ${setter}\\([^)]*true\\)\\);`));
    const clear = body.search(new RegExp(`${setter}\\([^)]*false\\)`));
    expect(body.indexOf('confirmRestored(')).toBeGreaterThan(clear);
  });

  it('WI-1.1 — the 1:1 restore keys the clear AND the deferred re-minimise on the call it acted for', () => {
    // `confirmRestored`'s fallback fires a tick after the tap. Unkeyed, it
    // re-minimised whatever call held the slot by then — not the one the user
    // was restoring. The key is read at PRESS time, not from the rendered
    // `active`: that is React state fed by `onActiveCallChange` and is a commit
    // behind the registry, and a stale key here would make the control no-op.
    expect(ONE_TO_ONE).toMatch(/const live = getActiveCall\(\);/);
    expect(ONE_TO_ONE).toMatch(/const key = \{callId: live\.callId, gen: live\.gen\}/);
    expect(ONE_TO_ONE).toMatch(/setMinimized\(key, false\)/);
    expect(ONE_TO_ONE).toMatch(/confirmRestored\('CallScreen', \(\) => setMinimized\(key, true\)\)/);
  });

  it.each([
    ['1:1',   'const hangup = (): void => {',   /const live = getActiveCall\(\);[\s\S]{0,160}endActiveCall\(\{callId: live\.callId, gen: live\.gen\}/],
    ['group', 'const hangup = (): void => {',   /const liveNow = getActiveGroupCall\(\);[\s\S]{0,120}endActiveGroupCall\(liveNow\.roomId\)/],
  ])('%s overlay End reads the registry at PRESS time, not the rendered snapshot', (_label, _anchor, pattern) => {
    // A stale key on a TEARDOWN does not end the wrong call — it ends NOTHING.
    // The End button silently no-ops while the bubble is still on screen, and
    // for a global overlay that is the only control the user has left.
    expect(overlay).toMatch(pattern as RegExp);
  });

  it('the verification is ONE helper, and it reads the route it was told to', () => {
    // Two copies of a revert is how one of them keeps the next fix.
    expect(overlay.split('function confirmRestored').length - 1).toBe(1);
    const at = overlay.indexOf('function confirmRestored');
    const fn = overlay.slice(at, overlay.indexOf('\n}', at));
    expect(fn).toContain('getCurrentRoute?.()');
    expect(fn).toContain('cur.name !== target');
    // Absence of a readable route is NOT failure (the container can be
    // mid-transition); reverting on it would flap the overlay on every restore.
    expect(fn).toContain('cur?.name &&');
    // Next tick, not synchronously — the route is not resolved yet at dispatch.
    expect(fn).toContain('setTimeout(');
  });
});
