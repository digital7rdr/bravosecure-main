/**
 * Wave 5 (PDF-2) sub-wave 5b — the 6-screen Secure Transfer wizard collapses
 * into ONE consolidated Booking dashboard, built by GROWING CustomizeAddOnsScreen
 * IN PLACE (it already owns confirmBooking + the credit-error call site + the
 * debounced server estimate). The earlier steps fold in as sections that write
 * the SAME bookingStore draft fields:
 *   - Zone     (from ZoneMapScreen)          → zone_code / zone_label / region
 *   - Schedule (from BookingDateTimeScreen)  → mode / passengers / pickup /
 *                                              dropoff / start_time, gated on
 *                                              canAdvanceSchedule; LocationPicker
 *                                              stays a pushed modal
 *   - Baseline (from BaselinePackageScreen)  → static hero, writes nothing
 *   - Team/add-ons/consent/brief/referral    → the CURRENT step-5 body, unchanged
 *   - Sticky CTA                             → the CURRENT confirmBooking() +
 *                                              status routing, verbatim
 *
 * This is a MONEY-FLOW screen the node `booking` project cannot import (RN
 * views), so it is pinned by reading the source — same pattern as
 * creditErrorCallSites / teamCellAlignment. Files are CRLF and carry design
 * prose that names these tokens, so comments are stripped line-wise first (a
 * `\n`-anchored regex would pass VACUOUSLY otherwise).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const SERVICE_SCREEN = join('src', 'screens', 'booking', 'ServiceTypeScreen.tsx');

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

describe('the scan reads real code', () => {
  it('is not vacuous', () => {
    const src = code(SCREEN);
    expect(src.length).toBeGreaterThan(8_000);
    expect(src).toContain('TEAM COMPOSITION');
    expect(src).not.toContain('\r');
  });
});

// ── NEW sections folded in for 5b (RED-first: absent at HEAD) ──────────────────
describe('5b — Zone section (folded from ZoneMapScreen)', () => {
  const src = code(SCREEN);

  it('has an operating-zone section', () => {
    expect(src).toMatch(/OPERATING ZONE/);
  });

  it('writes zone_code / zone_label / region to the SAME draft fields', () => {
    // The ZoneMap continue-logic, inline: updateDraft({zone_code, zone_label, region}).
    expect(src).toMatch(/updateDraft\(\{\s*zone_code:[^}]*zone_label:[^}]*region:/);
  });

  it('reads the live selected zone from the draft (store owns the pickup/dropoff clear)', () => {
    // The store clears pickup/dropoff on a zone change (bookingStore.ts:170); the
    // section must read draft.zone_code so a change visibly re-prompts location.
    expect(src).toMatch(/draft\.zone_code/);
  });
});

describe('5b — Schedule section (folded from BookingDateTimeScreen)', () => {
  const src = code(SCREEN);

  it('gates advancing on canAdvanceSchedule, reused verbatim', () => {
    expect(src).toContain('canAdvanceSchedule');
    expect(src).toContain('MIN_LEAD_HOURS');
  });

  it('the gate actually blocks the CTA AND short-circuits submit (not just present)', () => {
    // Edge review 5b: a presence-only pin would stay green if the guard were
    // deleted, letting a submit with a missing dropoff through. Pin the wiring.
    expect(src).toMatch(/scheduleReady\s*=\s*canAdvanceSchedule\(/);
    expect(src).toMatch(/ctaBlocked[^\n]*!scheduleReady/);
    expect(src).toMatch(/if\s*\(\s*!scheduleReady\s*\)\s*\{?\s*return/);
  });

  it('writes pickup, dropoff and start_time into the draft', () => {
    expect(src).toMatch(/updateDraft\(\{[^}]*pickup:/);
    expect(src).toMatch(/updateDraft\(\{[^}]*dropoff:/);
    expect(src).toMatch(/start_time:/);
  });

  it('writes the Book-Now/Later mode and the passenger count', () => {
    expect(src).toMatch(/updateDraft\(\{[^}]*mode:/);
    expect(src).toMatch(/updateDraft\(\{[^}]*passengers:/);
  });

  it('keeps the passenger-derived vehicle floor (Math.max(draft, minVehicles))', () => {
    expect(src).toMatch(/Math\.max\(draft\.vehicle_count[^,]*,\s*minVehicles\)/);
  });

  it('LocationPicker STAYS a pushed modal, returning to THIS dashboard route', () => {
    expect(src).toMatch(/navigation\.navigate\('LocationPicker'/);
    expect(src).toMatch(/onPickRouteKey:\s*'CustomizeAddOns'/);
  });

  it('merges the picked location back via the route params contract', () => {
    // Same {pickedAddress,pickedLat,pickedLng,pickedKind,pickedAt} merge as
    // BookingDateTimeScreen — the picker navigate({merge:true}) lands here.
    expect(src).toMatch(/route\.params/);
    expect(src).toMatch(/pickedKind/);
    expect(src).toMatch(/pickedLat/);
  });
});

describe('5b — Baseline section (folded from BaselinePackageScreen)', () => {
  const src = code(SCREEN);

  it('renders the static baseline hero (writes nothing to the draft)', () => {
    expect(src).toMatch(/BASELINE PACKAGE/);
    expect(src).toContain('BASE_RATE_BC');
  });
});

// ── PRESERVED from the current step 5 (must stay green — regression pins) ──────
describe('5b — the submit path is the step-5 confirmBooking(), verbatim', () => {
  const src = code(SCREEN);

  it('still calls confirmBooking and keeps the exact status routing', () => {
    expect(src).toContain('confirmBooking()');
    expect(src).toContain("'DISPATCHING'");
    expect(src).toContain("navigation.navigate('FindingDetail'");
    expect(src).toContain("'NO_PROVIDER'");
    expect(src).toContain("navigation.navigate('NoDetail'");
    expect(src).toContain('navigation.popToTop()');
    expect(src).toContain("navigation.navigate('OpsRoomReview'");
  });

  it('still routes a short balance to CreditPaywall via the ONE shared rule', () => {
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
    expect(branch).toContain("source: 'booking-flow'");
    expect(branch).not.toContain('Alert.alert');
  });

  it('the escrow total is still the server estimate (no money math moved)', () => {
    expect(src).toContain('estimatePrice');
    expect(src).toMatch(/estimated_price:\s*totalBc/);
  });
});

describe('5b — routing: Secure Transfer card points at the dashboard', () => {
  it('ServiceTypeScreen navigates to CustomizeAddOns, not BookingDateTime', () => {
    const src = code(SERVICE_SCREEN);
    expect(src).toMatch(/navigation\.navigate\('CustomizeAddOns'\)/);
    expect(src).not.toMatch(/navigation\.navigate\('BookingDateTime'\)/);
    // The Lite-only guard is untouched.
    expect(src).toContain('if (!liteSelected) {return;}');
  });

  it('pins the booking type on Continue (a pre-selected transfer needs a drop-off)', () => {
    // The Secure Transfer card is pre-selected, so a user can proceed WITHOUT
    // tapping it. handleContinue must re-pin type from the service, else `type`
    // stays 'timeslot' and canAdvanceSchedule stops requiring a drop-off.
    const src = code(SERVICE_SCREEN);
    expect(src).toMatch(/updateDraft\(\{\s*service,\s*type:\s*bookingTypeFor\(service\)/);
  });
});
