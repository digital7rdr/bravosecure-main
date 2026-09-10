/**
 * B-643 — the Lite "choose date" dialog reset itself under the user's finger.
 *
 * A declarative <DateTimePicker> on Android is a native dialog FRAGMENT. The
 * library re-invokes `open()` from an effect keyed on the `onChange` identity
 * (datetimepicker/src/datetimepicker.android.js, deps `[onChange, valueTimestamp,
 * mode]`), and an inline arrow handler is a NEW identity on every render — so every
 * re-render while the dialog is up calls `open()` again. The native module answers a
 * second `open()` with `oldFragment.update(args); return;` (DatePickerModule.java):
 * the dialog snaps back to `value` and the new promise is NEVER settled. The Secure
 * Transfer dashboard re-renders on its own (the 400 ms debounced price estimate sets
 * state twice per cycle), so the day the user tapped kept reverting; and a fragment
 * left behind by an activity restore carries no listeners, which kills the field for
 * good.
 *
 * The contract: on Android these screens open the dialog IMPERATIVELY from the press
 * gesture, through `androidPicker.ts`. No Android-branch mount, ever.
 *
 * STATIC SOURCE SCAN — these files mount RN screens and cannot be imported by the
 * node `booking` project. Per CLAUDE.md: comments are stripped before every absence
 * assertion (the fix's own comments name both `Platform.OS` and `DateTimePicker`, so
 * an unstripped scan would pass vacuously), and CRLF is normalised first.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
const HELPER = join(R, 'src', 'components', 'booking', 'androidPicker.ts');

/** The LIVE Lite booking date/time doors (a screen nothing navigates to is listed below). */
const LIVE_SCREENS = [
  join(R, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'),
  join(R, 'src', 'screens', 'executive', 'ExecReviewScreen.tsx'),
  join(R, 'src', 'screens', 'executive', 'ExecTransportScreen.tsx'),
];

/** Registered but unreachable — nothing calls navigate() for these. Kept as the
 *  detector's self-check: they still carry the old pattern, so a scan that passes
 *  them is broken, not clean. */
const LEGACY_SCREENS = [
  join(R, 'src', 'screens', 'booking', 'BookingDateTimeScreen.tsx'),
  join(R, 'src', 'screens', 'executive', 'ExecScheduleScreen.tsx'),
];

function read(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** True when a <DateTimePicker ...> is mounted inside an `'android'` branch. */
function hasAndroidMount(rawSrc: string): boolean {
  const src = stripComments(rawSrc);
  let from = 0;
  for (;;) {
    const at = src.indexOf('<DateTimePicker', from);
    if (at < 0) {return false;}
    // The guard sits immediately above the element in every one of these screens.
    const lookback = src.slice(Math.max(0, at - 220), at);
    if (/Platform\.OS === 'android'/.test(lookback)) {return true;}
    from = at + 1;
  }
}

describe('B-643 — the Android picker helper filters on the SET action', () => {
  it('exists', () => {
    expect(existsSync(HELPER)).toBe(true);
  });

  const src = existsSync(HELPER) ? stripComments(read(HELPER)) : '';

  it('opens through the imperative DateTimePickerAndroid API, never a mounted component', () => {
    expect(src).toMatch(/DateTimePickerAndroid\.open\(/);
    expect(src).not.toMatch(/<DateTimePicker/);
  });

  it("commits ONLY on 'set' — the library's dismiss path calls back with the ORIGINAL date", () => {
    // A handler that checks the date argument alone treats Cancel as a pick.
    expect(src).toMatch(/ev\?\.type !== 'set'/);
    expect(src).toMatch(/return;/);
  });

  it('exposes both doors, so the time dialog cannot regress to a declarative mount', () => {
    expect(src).toMatch(/export const openAndroidDatePicker/);
    expect(src).toMatch(/export const openAndroidTimePicker/);
  });
});

describe('B-643 — no LIVE Lite booking screen mounts the Android dialog declaratively', () => {
  it.each(LIVE_SCREENS)('%s opens imperatively', file => {
    const raw = read(file);
    expect(hasAndroidMount(raw)).toBe(false);
    // ...and actually walks through the helper, so this is not just a deleted door.
    expect(stripComments(raw)).toMatch(/openAndroid(Date|Time)Picker\(/);
  });

  it('still renders the iOS spinner — the fix is Android-only', () => {
    for (const file of LIVE_SCREENS) {
      const src = stripComments(read(file));
      expect(src).toMatch(/Platform\.OS === 'ios'/);
      expect(src).toMatch(/<DateTimePicker/);
    }
  });
});

describe('B-643 — the detector is not vacuous', () => {
  // If this ever goes green, `hasAndroidMount` stopped detecting the bug pattern
  // and every assertion above became decoration. These two screens are dead code
  // (no navigate() call site); fix them or delete them, but do not "fix" this test.
  it.each(LEGACY_SCREENS)('%s still shows the pattern the scan looks for', file => {
    expect(hasAndroidMount(read(file))).toBe(true);
  });
});
