/**
 * B-372 — fullScreenGestureEnabled must be Android-only (static source scan).
 *
 * Round 7 enabled `gestureEnabled` + `fullScreenGestureEnabled` globally so
 * ANDROID gained swipe-back (native-stack ships it off there; iOS "gets it
 * for free"). But on iOS `fullScreenGestureEnabled: true` upgrades the
 * platform-standard EDGE swipe to a swipe-back from ANYWHERE on the screen —
 * which hijacks every horizontal pan surface: the GroupCallScreen tile pager
 * (a JS PanResponder that cannot negotiate with the native recognizer — see
 * the B-242 termination work), the draggable FloatingCallOverlay bubble, and
 * any horizontal carousel. A tile swipe mid-call popping the screen minimizes
 * the call the user was interacting with. Gate the flag to
 * `Platform.OS === 'android'`: Android behaviour is byte-identical, iOS gets
 * the conventional edge-only interactive pop (which beforeRemove still
 * intercepts — B-367/BS-022 are unaffected).
 *
 * Navigators are plain config; a render test cannot see the option object on
 * both platforms, so this is a comment-stripped source scan. Files are CRLF:
 * normalize first.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const NAVIGATORS = [
  'src/navigation/MessengerNavigator.tsx',
  'src/navigation/BookingNavigator.tsx',
  'src/navigation/AgentNavigator.tsx',
  'src/navigation/AuthNavigator.tsx',
  'src/navigation/NewsNavigator.tsx',
];

describe('B-372 — full-screen swipe-back is Android-only; iOS keeps the edge gesture', () => {
  it.each(NAVIGATORS)('%s gates fullScreenGestureEnabled on Platform.OS', file => {
    const src = strip(read(file));
    expect(src).toMatch(/fullScreenGestureEnabled: Platform\.OS === 'android'/);
    expect(src).not.toMatch(/fullScreenGestureEnabled: true/);
  });

  it.each(NAVIGATORS)('%s keeps the swipe gesture itself enabled', file => {
    const src = strip(read(file));
    expect(src).toMatch(/gestureEnabled: true/);
  });
});
