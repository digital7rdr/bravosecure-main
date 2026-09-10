/**
 * B-283 — founder: "in group call video and 1:1 video call remove the blur option,
 * we don't need that one."
 *
 * Worth recording what was actually there, because the request named two screens
 * and only one had the feature:
 *
 *   - `CallScreen.tsx` (1:1) had a "Blur" toggle in the tier-1 control row plus two
 *     `<BlurView>` overlays. It only ever blurred the LOCAL self-view PiP — the
 *     peer's frame was untouched and the peer saw no difference — so it cost a
 *     native Gaussian blur over live video to obscure the one tile the user does
 *     not need obscured.
 *   - `GroupCallScreen.tsx` never had it. Its only `blur` match is `blurOnSubmit`
 *     on the in-call chat TextInput, which is keyboard submit behaviour and must
 *     NOT be swept up by a careless "remove blur" grep.
 *
 * These screens mount RN views so the node project cannot import them — source
 * scan, comments stripped. Both files are CRLF: nothing here is `\n`-anchored,
 * which would match nothing and pass VACUOUSLY.
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
const group = strip('GroupCallScreen.tsx');

describe('B-283 — the 1:1 call has no blur affordance', () => {
  it('CONTROL: the scan is reading a real, populated screen', () => {
    // Without this, a renamed file would make every absence assertion below
    // pass against an empty string.
    expect(call.length).toBeGreaterThan(2000);
    expect(call).toContain('ctrlToggle');
  });

  it('the BlurView import and every render of it are gone', () => {
    expect(call).not.toContain('@react-native-community/blur');
    expect(call).not.toContain('BlurView');
  });

  it('the isBlurred state is gone', () => {
    expect(call).not.toContain('isBlurred');
    expect(call).not.toContain('setIsBlurred');
  });

  it('the Blur button is gone from the control row', () => {
    expect(call).not.toMatch(/label\s*:\s*'Blur'/);
    expect(call).not.toContain("'blur-off'");
  });

  it('the dead blurOverlay style went with it', () => {
    expect(call).not.toContain('blurOverlay');
  });

  it('the OTHER tier-1 toggles survive — this was a removal, not a purge', () => {
    // Guards the over-correction: ripping out the control row entirely would
    // also take Mute, Video and the audio-route button.
    expect(call).toMatch(/label\s*:\s*'Mute'/);
    expect(call).toContain('routePickerOpen');
  });
});

describe('B-283 — the group call never had one, and keeps its text-input behaviour', () => {
  it('has no blur toggle', () => {
    expect(group).not.toContain('BlurView');
    expect(group).not.toMatch(/label\s*:\s*'Blur'/);
  });

  it('KEEPS blurOnSubmit — that is keyboard behaviour, not video blur', () => {
    // A grep-driven "remove blur" would delete this and make the in-call chat
    // input dismiss the keyboard on every submit.
    expect(group).toContain('blurOnSubmit={false}');
  });
});
