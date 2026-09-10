/**
 * "Secure Services Streamlined" (client UX spec, Wave 5) — the four client-
 * visible gaps a read-only audit found after the one-dashboard consolidation:
 *
 *   GAP 1  a compact 12-HOUR time dropdown in FIVE-MINUTE steps on BOTH
 *          dashboards (Secure Transfer Book Now + Book Later; Executive start
 *          time + transfer pickup time), every displayed time 12-hour, Book
 *          Later snapped UP to 5 min and never under the 3-hour lead.
 *   GAP 2  the ">24 h → Bravo Secure Pro" nudge lost when ExecDurationScreen
 *          was folded into the Executive dashboard.
 *   GAP 3  "Base Protection" + "Secure Transfer" subtotals above the Executive
 *          Estimated Total (the arithmetic is pinned in execPriceSummary.test).
 *   GAP 4  the Lite card left the plan chooser (founder D3) — BookingHome's
 *          plan-card copy + a11y label must not still say "Lite".
 *
 * Both dashboards are MONEY-FLOW screens the node `booking` project cannot
 * import (RN views), so — same as secureTransferDashboard /
 * execProtectionDashboard — they are pinned by reading the source. Files are
 * CRLF and carry design prose naming these tokens, so comments are stripped
 * line-wise first (a `\n`-anchored regex would pass VACUOUSLY otherwise).
 *
 * The money paths (draft shape, confirmBooking payload, 3-hour lead, pricing)
 * are re-pinned here as ABSENCE-OF-CHANGE checks: the picker UI and the display
 * format were the only things allowed to move.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const TRANSFER = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const EXEC = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');
const HOME = join('src', 'screens', 'booking', 'BookingHomeScreen.tsx');
const WHEEL = join('src', 'components', 'booking', 'WheelTimePicker.tsx');
const FIELD = join('src', 'components', 'booking', 'TimeDropdownField.tsx');
const NAVIGATOR = join('src', 'navigation', 'BookingNavigator.tsx');
const OLD_DURATION_STEP = join('src', 'screens', 'executive', 'ExecDurationScreen.tsx');

/** CODE only — CRLF-normalised, block + line comments stripped. */
function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const count = (src: string, needle: string): number => src.split(needle).length - 1;

// The 24-hour display formula both dashboards used: `${pad(d.getHours())}:${pad(d.getMinutes())}`.
const HOUR24_DISPLAY = /pad\([^)]*getHours\(\)\)\s*\}?\s*:/;

describe('the scans read real code', () => {
  it('are not vacuous', () => {
    for (const rel of [TRANSFER, EXEC, HOME, WHEEL]) {
      const src = code(rel);
      expect(src.length).toBeGreaterThan(2_000);
      expect(src).not.toContain('\r');
    }
    expect(code(TRANSFER)).toContain('TEAM COMPOSITION');
    expect(code(EXEC)).toContain('confirmBooking');
  });
});

// ── GAP 1 — the 12-hour / 5-minute time dropdown ──────────────────────────────
describe('GAP 1 — WheelTimePicker grows a 12-hour cycle (AM/PM column)', () => {
  const src = code(WHEEL);

  it('exposes hourCycle and renders an AM/PM column in 12-hour mode', () => {
    expect(src).toMatch(/hourCycle/);
    expect(src).toMatch(/'AM'/);
    expect(src).toMatch(/'PM'/);
    // 1..12, not 0..23, for the hour column in 12-hour mode.
    expect(src).toMatch(/length:\s*12/);
  });

  it('converts through the shared 12h helpers (no second copy of the arithmetic)', () => {
    expect(src).toMatch(/from '\.\/time12h'/);
    expect(src).toMatch(/\bto12h\(/);
    expect(src).toMatch(/\bto24h\(/);
  });

  it('keeps the 24-hour default so BookingDateTimeScreen (the other caller) is unchanged', () => {
    expect(src).toMatch(/hourCycle\s*=\s*24/);
  });
});

describe('GAP 1 — TimeDropdownField: a dropdown FIELD that opens the 12-hour wheel', () => {
  it('exists', () => {
    expect(existsSync(join(ROOT, FIELD))).toBe(true);
  });

  const src = existsSync(join(ROOT, FIELD)) ? code(FIELD) : '';

  // B-646 r3 — the hand-rolled wheel is GONE; the field opens the PLATFORM picker.
  // Founder call after the wheel cost three separate bugs (rail swallowing drags,
  // disabled interval momentum killing flicks, an unmemoised prop re-scrolling it).
  // The 12-hour rule from B-615 survives — it is now the OS clock's own AM/PM UI.
  it('reads as a dropdown (chevron) and opens the NATIVE picker, not a hand-rolled wheel', () => {
    expect(src).toMatch(/chevron-down/);
    expect(src).not.toMatch(/<WheelTimePicker/);
    // Android: imperative, never a mounted component (see androidPicker.ts).
    expect(src).toMatch(/openAndroidTimePicker\(\{/);
    expect(src).toMatch(/is24Hour: false/);
    // iOS has no modal time dialog, so it keeps the native spinner in a sheet.
    expect(src).toMatch(/<Modal/);
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="time"/);
    expect(src).toMatch(/display="spinner"/);
  });

  it('enforces the minute step itself, since the native clock has no interval on Android', () => {
    expect(src).toMatch(/export function snapToStep/);
    // Rounds TOTAL minutes and wraps the day, so 11:58 at step 5 is 12:00 — never
    // 11:60, and never hour 24.
    expect(src).toMatch(/\(hour \* 60 \+ minute\)/);
    expect(src).toMatch(/% 1440/);
    expect(src).toMatch(/const snapped = snapToStep\(h, m, minuteStep\);/);
  });

  it('labels the field with the shared 12-hour formatter', () => {
    expect(src).toMatch(/formatTime12h\(/);
  });

  it('commits on Done and still hands the caller a 24-hour hour (the draft shape is untouched)', () => {
    expect(src).toMatch(/Done/);
    expect(src).toMatch(/onChange\(/);
    // The field never formats its own value into the callback — it passes the wheel's 24h hour.
    expect(src).not.toMatch(/onChange\(\s*formatTime12h/);
  });
});

describe('GAP 1 — Secure Transfer dashboard (CustomizeAddOnsScreen)', () => {
  const src = code(TRANSFER);

  it('Book Now and Book Later BOTH use the dropdown field (not the inline 24-hour wheel, not a native time picker)', () => {
    expect(src).toMatch(/from '@components\/booking\/TimeDropdownField'/);
    expect(count(src, '<TimeDropdownField')).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/<WheelTimePicker/);
    expect(src).not.toMatch(/is24Hour/);
    expect(src).not.toMatch(/mode="time"/);
    expect(src).not.toMatch(/mode=\{pickerMode\}/);
  });

  it('the native DATE picker for Book Later stays, with its lead-time floor', () => {
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="date"/);
    expect(src).toMatch(/minimumDate=\{new Date\(Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000\)\}/);
  });

  it('every displayed time is 12-hour — the 24-hour formula is gone', () => {
    expect(src).toMatch(/formatTime12h\(/);
    expect(src).not.toMatch(HOUR24_DISPLAY);
    // The "Earliest …" sub-label under Book Now and the lead-time alert both use it.
    expect(src).toMatch(/Earliest \{formatTime12h\(/);
    expect(src).toMatch(/earliest\{' '\}\s*\n?\s*\{formatTime12h\(/);
  });

  it('Book Later snaps UP to 5 minutes and never lands under the 3-hour lead', () => {
    expect(src).toMatch(/roundUpToMinuteStep\(/);
    const commit = src.slice(src.indexOf('const commitLater'), src.indexOf('const onLaterDateChange'));
    expect(commit.length).toBeGreaterThan(50);
    expect(commit).toMatch(/roundUpToMinuteStep\(/);
    expect(commit).toMatch(/Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    // Both entry points (date pick, time pick) funnel through the one commit.
    expect(src).toMatch(/onLaterDateChange[\s\S]{0,400}commitLater\(/);
    expect(src).toMatch(/const onLaterTimeChange[\s\S]{0,200}commitLater\(/);
    expect(src).toMatch(/<TimeDropdownField[\s\S]{0,400}onChange=\{onLaterTimeChange\}/);
  });

  it('MONEY PATH UNCHANGED — start_time, draft writes and the submit payload are byte-verbatim', () => {
    expect(src).toMatch(/start\.setHours\(hour, minute, 0, 0\);/);
    expect(src).toMatch(/if \(start\.getTime\(\) < Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000\) \{/);
    expect(src).toMatch(/start_time: computeStartTime\(\)\.toISOString\(\),/);
    expect(src).toMatch(/updateDraft\(\{selected_add_ons: selectedList, estimated_price: totalBc\}\);/);
    expect(src).toContain('const booking = await confirmBooking();');
    expect(src).toMatch(/vehicle_count: Math\.max\(draft\.vehicle_count \?\? 1, minVehicles\),/);
  });
});

describe('GAP 1 — Executive dashboard (ExecReviewScreen)', () => {
  const src = code(EXEC);

  it('start time AND transfer pickup time use the dropdown field; the native TIME pickers are gone', () => {
    expect(src).toMatch(/from '@components\/booking\/TimeDropdownField'/);
    expect(count(src, '<TimeDropdownField')).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/is24Hour/);
    expect(src).not.toMatch(/mode="time"/);
    expect(src).not.toMatch(/mode=\{pickerMode\}/);
  });

  it('the native DATE picker for Book Later stays, with its lead-time floor', () => {
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="date"/);
    expect(src).toMatch(/minimumDate=\{new Date\(Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000\)\}/);
  });

  it('every displayed time is 12-hour — the 24-hour formula is gone', () => {
    expect(src).toMatch(/formatTime12h\(/);
    expect(src).not.toMatch(HOUR24_DISPLAY);
    // startLabel feeds "Same as start time (…)"; the lead alert names the earliest time.
    expect(src).toMatch(/const startLabel = formatTime12h\(/);
    expect(src).toMatch(/Same as start time \(\$\{startLabel\}\)/);
    expect(src).toMatch(/is\{' '\}\s*\n?\s*\{formatTime12h\(live/);
  });

  it('Book Later snaps UP to 5 minutes and keeps the reject-and-correct lead rule', () => {
    const commit = src.slice(src.indexOf('const commitLater'), src.indexOf('const onLaterDateChange'));
    expect(commit.length).toBeGreaterThan(50);
    expect(commit).toMatch(/roundUpToMinuteStep\(/);
    expect(commit).toMatch(/Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    expect(commit).toMatch(/earliestLater\(\)/);
    expect(commit).toMatch(/setLeadError\(/);
    expect(src).toMatch(/onLaterDateChange[\s\S]{0,400}commitLater\(/);
    expect(src).toMatch(/const onLaterTimeChange[\s\S]{0,200}commitLater\(/);
    expect(src).toMatch(/<TimeDropdownField[\s\S]{0,400}onChange=\{onLaterTimeChange\}/);
  });

  it('the transfer pickup time still resolves through the B-382 window resolver', () => {
    expect(src).toMatch(/resolveTransferTime\(startDate, durationH, h, m\)\.toISOString\(\)/);
    expect(src).toContain('transferTimeOutOfWindow');
    // And the "reset to start time" door survives the field swap.
    expect(src).toMatch(/accessibilityLabel="Reset to same as start time"/);
    expect(src).toMatch(/updateDraft\(\{transport_pickup_time: ''\}\)/);
  });

  it('MONEY PATH UNCHANGED — mode/start_time write, estimate, escrow total and submit are byte-verbatim', () => {
    expect(src).toMatch(/updateDraft\(\{mode, start_time: start\.toISOString\(\), \.\.\.transferRebase\}\);/);
    expect(src).toMatch(/const totalBc = serverTotal \?\? execTotalBc\(localRate, hours\);/);
    expect(src).toMatch(/updateDraft\(\{selected_add_ons: selectedAddOnIds, estimated_price: totalBc\}\);/);
    expect(src).toContain('const booking = await confirmBooking();');
    expect(src).toMatch(/service: 'executive_protection'/);
  });
});

// ── GAP 2 — the ">24 h → Bravo Secure Pro" nudge ──────────────────────────────
describe('GAP 2 — the Pro nudge lives under the DURATION grid on the Executive dashboard', () => {
  const src = code(EXEC);

  it('mirrors the old ExecDurationScreen copy + target', () => {
    expect(src).toContain('Need cover for longer than 24 hours?');
    expect(src).toMatch(/Explore Bravo Secure Pro for Long-Term Bookings\./);
    expect(src).toMatch(/navigation\.navigate\('SecureServices'\)/);
    // Same copy as the skipped wizard step (kept as the single source of wording).
    const old = code(OLD_DURATION_STEP);
    expect(old).toContain('Need cover for longer than 24 hours?');
    expect(old).toMatch(/navigation\.navigate\('SecureServices'\)/);
  });

  it('sits directly under the DURATION grid, before the SCHEDULE section', () => {
    const grid = src.indexOf('EXEC_DURATIONS.map(');
    const nudge = src.indexOf('Need cover for longer than 24 hours?');
    const schedule = src.indexOf('SCHEDULE · START TIME');
    expect(grid).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(grid);
    expect(schedule).toBeGreaterThan(nudge);
  });

  it('is a real button (role + label), and the route exists in the booking stack', () => {
    expect(src).toMatch(/accessibilityLabel="Need cover for longer than 24 hours\? Explore Bravo Secure Pro"/);
    expect(code(NAVIGATOR)).toMatch(/name="SecureServices"/);
  });
});

// ── GAP 3 — Base Protection / Secure Transfer subtotals ───────────────────────
describe('GAP 3 — the Executive price summary shows both subtotals above the total', () => {
  const src = code(EXEC);

  it('derives the lines + subtotals from the ONE pure helper (no second pricing copy)', () => {
    expect(src).toMatch(/from '\.\/execPriceSummary'/);
    expect(src).toMatch(/execPriceLines\(/);
    expect(src).toMatch(/execPriceSummary\(lines, hours\)/);
  });

  it('renders "Base Protection" always and "Secure Transfer" only with transport on, both above the total', () => {
    const card = src.slice(src.indexOf('<Text style={s.fieldLabel}>CALCULATION</Text>'), src.indexOf('ESTIMATED TOTAL'));
    expect(card.length).toBeGreaterThan(100);
    expect(card).toMatch(/>Base Protection</);
    expect(card).toMatch(/\{hasTransport && \([\s\S]{0,400}>Secure Transfer</);
    expect(card).toMatch(/Math\.round\(baseBc\)/);
    expect(card).toMatch(/Math\.round\(transferBc\)/);
  });

  it('the total row is untouched (server estimate first, local mirror second)', () => {
    expect(src).toMatch(/\{Math\.round\(totalBc\)\} BC/);
    expect(src).toMatch(/ESTIMATED TOTAL\{serverTotal === null \? ' \(EST\.\)' : ''\}/);
  });
});

// ── GAP 4 — "Lite" left the plan chooser ──────────────────────────────────────
describe('GAP 4 — BookingHome plan card no longer advertises Lite', () => {
  const src = code(HOME);

  it('copy and a11y label name Pro + Bravo Secure Lux only', () => {
    expect(src).toContain('Secure plans: Pro & Bravo Secure Lux.');
    expect(src).toContain('secure plans Pro and Bravo Secure Lux');
    expect(src).not.toMatch(/secure plans[^"'\n]*Lite/i);
    expect(src).not.toMatch(/Secure plans:[^<\n]*Lite/);
  });
});
