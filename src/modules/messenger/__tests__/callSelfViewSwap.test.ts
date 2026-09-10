/**
 * B-454 — founder: "no option to switch the screen to enlarge yourself and
 * switch back to enlarge the other person on video calls."
 *
 * The 1:1 video screen hard-wired the two slots: the peer's stream was the
 * only thing that could reach the full-screen RTCView and the local camera
 * was the only thing that could reach the PiP. There was no swap state
 * anywhere in the screen.
 *
 * The fix is a `swapped` flag that names WHICH STREAM owns the full-screen
 * slot, plus one renderer per STREAM so every coupled prop travels with the
 * stream rather than being left behind on a container:
 *
 *   - streamURL, `mirror`, the native remount key and the fallback
 *     placeholder follow the STREAM;
 *   - `zOrder` follows the CONTAINER (full-screen 0, small tile 1) — it is
 *     an Android layer-order hint about which surface is on top, and the
 *     full-screen surface must stay underneath whatever else lands there;
 *   - the peer branch keeps flowing through `resolveRemoteTile`, so the
 *     audited CALL-N2 gate (camera-off / avatar / none / video) is reached
 *     from BOTH slots and a swap can never bypass it.
 *
 * The affordance is the PiP TAP, which previously duplicated the chrome
 * toggle that the full-screen tap-catcher already owns over the whole
 * surface — so nothing was lost.
 *
 * CallScreen.tsx mounts RN views (WebRTC / InCallManager native surface) and
 * cannot be imported by the node project — source scan, comments stripped
 * (precedent: callMinimizeRestorePins, chromeAutoHideActivity). The file is
 * CRLF, so nothing here is `\n`-anchored: a `\n` anchor matches nothing and
 * passes VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const raw = readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
);
const src = strip(raw);
const count = (needle: string): number => src.split(needle).length - 1;

const remoteAt = src.indexOf('const renderRemoteTile');
const localAt = src.indexOf('const renderLocalTile');
const modalAt = src.indexOf('const addPickerModal');
const remoteBlock = src.slice(remoteAt, localAt);
const localBlock = src.slice(localAt, modalAt);

describe('B-454 — the 1:1 video call can swap the two slots', () => {
  it('CONTROL: the scan is reading a real, populated screen', () => {
    // Without this a renamed/moved file makes every absence assertion below
    // pass against an empty string.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('styles.pip');
    expect(remoteAt).toBeGreaterThan(-1);
    expect(localAt).toBeGreaterThan(remoteAt);
    expect(modalAt).toBeGreaterThan(localAt);
  });

  it('the swap state exists', () => {
    expect(src).toContain('const [swapped, setSwapped] = useState(false);');
  });

  it('the PiP TAP toggles the swap', () => {
    const respAt = src.indexOf('const pipResponder');
    expect(respAt).toBeGreaterThan(-1);
    const resp = src.slice(respAt, src.indexOf(').current;', respAt));
    const release = resp.slice(
      resp.indexOf('onPanResponderRelease'),
      resp.indexOf('onPanResponderTerminate'),
    );
    expect(release).toContain('setSwapped(s => !s);');
    // The responder is built ONCE (useRef), so the gesture must read the
    // predicate through a ref — a captured value is the mount-time one
    // forever, and at mount there is never a remote stream.
    expect(release).toContain('canSwapRef.current');
  });

  /**
   * DELIBERATE FLIP: this used to assert `release` contains NO
   * `setChromeVisible` at all, on the reasoning that the full-screen
   * tap-catcher owns the chrome toggle. It does — but only where it is
   * REACHABLE, and the PiP sits on top of it. So when `canSwap` is false
   * (audio-only, remote camera off, teardown, pre-answer) the tile swallowed
   * the tap and did nothing: a dead zone in exactly the states where the user
   * is hunting for the controls.
   */
  it('...and falls back to the chrome toggle where there is nothing to swap with', () => {
    const respAt = src.indexOf('const pipResponder');
    const resp = src.slice(respAt, src.indexOf(').current;', respAt));
    const release = resp.slice(
      resp.indexOf('onPanResponderRelease'),
      resp.indexOf('onPanResponderTerminate'),
    );
    expect(release).toContain('if (canSwapRef.current) {setSwapped(s => !s);}');
    expect(release).toContain('else {setChromeVisible(v => !v);}');
    // Still exclusive — a tap must not both swap AND toggle.
    expect(release).toContain('else {');
  });

  it('a sub-slop tap re-settles the tile instead of letting it drift', () => {
    // The offset is flattened before the slop test, so a tap that moved the
    // tile 3dp keeps those 3dp. Repeated taps walk it off its corner rail and
    // eventually back under the control sheet (the B-366 bug, by accumulation).
    const respAt = src.indexOf('const pipResponder');
    const resp = src.slice(respAt, src.indexOf(').current;', respAt));
    const release = resp.slice(
      resp.indexOf('onPanResponderRelease'),
      resp.indexOf('onPanResponderTerminate'),
    );
    const tapAt = release.indexOf('TAP_SLOP_SQ');
    const retAt = release.indexOf('return;', tapAt);
    expect(tapAt).toBeGreaterThan(-1);
    expect(retAt).toBeGreaterThan(tapAt);
    // Inside the tap branch, BEFORE its early return — after it is dead code.
    expect(release.slice(tapAt, retAt)).toContain('settlePipIntoBounds();');
  });

  it('the announced button role is actually actionable for a screen reader', () => {
    // The tap lives in a PanResponder, which TalkBack / VoiceOver never drive.
    // `accessible` + `accessibilityRole="button"` therefore announced a control
    // whose activation gesture reached nothing at all.
    const pipAt = src.indexOf('accessibilityLabel={swapped ?');
    expect(pipAt).toBeGreaterThan(-1);
    const tag = src.slice(src.lastIndexOf('<Animated.View', pipAt), src.indexOf('panHandlers}', pipAt));
    expect(tag).toContain('onAccessibilityTap={');
    // Same decision as the gesture, or the two drift into different behaviour
    // for sighted and screen-reader users.
    expect(tag).toContain('if (canSwapRef.current) {setSwapped(s => !s);}');
    expect(tag).toContain('else {setChromeVisible(v => !v);}');
    // …and the hint must stop claiming a swap that cannot happen.
    expect(tag).toContain("'Shows or hides the call controls'");
  });

  it('chrome toggling survives on the full-screen tap-catcher — nothing was lost', () => {
    expect(src).toMatch(/callState === 'connected' && \(\s*<Pressable/);
    expect(src).toContain('onPress={toggleChrome}');
  });

  it('BOTH slots are swap-conditional and cross over', () => {
    // Full-screen: peer by default, local when swapped. Small tile: the
    // mirror image. If either side stops crossing, the swap is a no-op or
    // (worse) shows the same stream twice.
    expect(src).toContain("swapped ? renderLocalTile('full') : renderRemoteTile('full')");
    expect(src).toContain("swapped ? renderRemoteTile('pip') : renderLocalTile('pip')");
  });

  it('the LOCAL stream carries its own mirror, key and URL into either slot', () => {
    expect(localBlock).toContain('const localUrl = isCameraOn ? safeStreamURL(liveCall.localStream) : null;');
    expect(localBlock).toContain('streamURL={localUrl}');
    expect(localBlock).toContain('mirror={shouldMirrorTile(true, cameraFacing === \'front\')}');
    expect(localBlock).toContain('key={`local-${slot}-${isCameraOn ? \'on\' : \'off\'}`}');
  });

  it('the REMOTE stream carries its own mirror, key and URL into either slot', () => {
    expect(remoteBlock).toContain('streamURL={gate.streamURL}');
    expect(remoteBlock).toContain('mirror={shouldMirrorTile(false, cameraFacing === \'front\')}');
    expect(remoteBlock).toContain('key={`remote-${slot}-${gate.remountKey}`}');
  });

  it('the remount key changes with the slot — Android must rebind a moved stream', () => {
    // Same class as the O-F track-id key: without a key change the native
    // SurfaceView keeps the old track bound and the moved tile stays black.
    expect(remoteBlock).toContain('${slot}');
    expect(localBlock).toContain('${slot}');
    // The pre-B-454 slot-less keys must be gone.
    expect(src).not.toContain('key={`remote-${gate.remountKey}`}');
    expect(src).not.toContain('key={`local-${isCameraOn ? \'on\' : \'off\'}`}');
  });

  it('mirror goes through the ONE shared rule, not a hand-rolled copy', () => {
    expect(raw).toContain("import {shouldMirrorTile} from '@/modules/messenger/webrtc/groupCallLayout';");
    // The hard-wired forms this replaced: a bare selfie flip and a bare
    // `false`. Either one re-introduces "mirror follows the container".
    expect(src).not.toContain('mirror={cameraFacing === \'front\'}');
    expect(src).not.toContain('mirror={false}');
  });

  it('zOrder follows the CONTAINER, not the stream', () => {
    // Full-screen surface underneath (0), small tile on top (1) — whichever
    // stream is in them. A stream-bound zOrder would put the peer's video
    // over the self-view the moment they swapped.
    expect(remoteBlock).toContain("zOrder={slot === 'full' ? 0 : 1}");
    expect(localBlock).toContain("zOrder={slot === 'full' ? 0 : 1}");
  });

  it('the placeholders swap sides with their stream', () => {
    // The peer's identity renders wherever the peer's stream is, and the
    // self disc wherever the local camera is. Crossing these is the B-105
    // bug ("my friend's screen with MY initial") re-lit by the swap.
    expect(remoteBlock).toContain('peerInitials');
    expect(remoteBlock).not.toContain('ownInitials');
    expect(localBlock).toContain('ownInitials');
    expect(localBlock).not.toContain('peerInitials');
    // Both renderers cover both slot sizes — a swap while the camera is off
    // must not drop a placeholder or crash on a null stream.
    expect(remoteBlock).toContain("if (slot === 'pip')");
    expect(localBlock).toContain("if (slot === 'pip')");
  });

  it('the remote decision still flows through resolveRemoteTile — one gate, no bypass', () => {
    expect(count('resolveRemoteTile({')).toBe(1);
    expect(remoteBlock).toContain('resolveRemoteTile({');
    expect(remoteBlock).toContain("if (gate.kind === 'none') {return null;}");
    expect(remoteBlock).toContain("if (gate.kind !== 'video')");
    // The CALL-N2 liveness gate that keeps a black SurfaceView off the
    // screen must run before either slot mounts anything.
    expect(remoteBlock).toContain('if (!liveMode || !isVideoUI) {return null;}');
  });

  it('ONE predicate gates the gesture and resets the flag', () => {
    // Two separate conditions here is how a swap survives the thing it was
    // swapping. The gesture gate and the reset must read the same truth.
    expect(src).toContain(
      'const canSwap = isVideoUI && !tearingDown && callState !== \'ended\' && !!liveCall.remoteStream;',
    );
    expect(src).toContain('canSwapRef.current = canSwap;');
    const at = src.indexOf('if (!canSwap) {setSwapped(false);}');
    expect(at).toBeGreaterThan(-1);
    const effect = src.slice(at, src.indexOf(']);', at) + 3);
    expect(effect).toContain('[canSwap]);');
  });

  it('the swap cannot start while the ringing identity overlay owns the screen', () => {
    // That overlay is not part of either slot: it renders on `!remoteStream`
    // and would paint the peer's pulse-ring avatar straight over the local
    // video the moment someone swapped during a ring.
    expect(src).toContain('{!liveCall.remoteStream && (');
    expect(src).toContain('!!liveCall.remoteStream');
  });

  it('the affordance glyph only shows while the tap does something', () => {
    expect(src).toContain('{canSwap && (');
    expect(src).toContain('styles.pipSwapHint');
  });

  it('the teardown freeze is keyed on the SLOT, so a swap cannot re-key it', () => {
    // CALLS-1to1 (#2): the constant-keyed placeholder is what keeps the
    // native tree from crashing as the screen pops. Keying it on the stream
    // would make a swap mid-teardown remount exactly what was frozen.
    expect(src).toContain('<View key="remote-teardown" style={StyleSheet.absoluteFill} />');
    expect(src).toContain('<View key="local-teardown" style={styles.pipFill} />');
    expect(remoteBlock).not.toContain('teardown');
    expect(localBlock).not.toContain('teardown');
  });
});
