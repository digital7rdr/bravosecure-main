/**
 * Issue 29 (Testing Issues V2, PDF p.34) — "Executive Protection Hourly Booking
 * Service Is Unavailable".
 *
 * It turned out to be far smaller than "a new booking shape" implied, because
 * most of the shape ALREADY existed and was simply never reachable:
 *   - the DTO already accepts `executive_protection` and an optional dropoff;
 *   - booking.service already inserts `dto.dropoff?.address ?? null`;
 *   - scheduleGate.canAdvanceSchedule already requires a drop-off only for
 *     `type === 'transfer'`;
 *   - pricing already multiplies by duration_hours.
 *
 * What was missing: the service was flagged comingSoon, and ServiceTypeScreen
 * set only `service`, never `type` — so nothing ever selected the timeslot
 * shape. That second half was ALSO a latent bug in the opposite direction: a
 * Secure TRANSFER never required a drop-off either.
 *
 * 2026-08-04 — Executive Protection: the hourly executive product became its own wizard
 * (service 'executive_protection', fixed 3–24 h blocks). The ServiceType card now ROUTES to
 * ExecDuration instead of selecting in place; the Lite-selection pin below
 * moved with the code and gained the executive-residual restore (an abandoned executive
 * seed must not leak duration_hours:3 / vehicle_count:0 into a Lite quote).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {bookingTypeFor, canAdvanceSchedule} from '../scheduleGate';

const ROOT = process.cwd();

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

describe('Issue 29 — Executive Protection is bookable', () => {
  it('is no longer flagged coming soon', () => {
    const src = code('src/screens/booking/ServiceTypeScreen.tsx');
    const start = src.indexOf("key: 'executive_protection'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('},', start));
    expect(block).not.toMatch(/comingSoon/);
  });

  it('Wave 5a A3 — the Recon Team card is removed; Emergency Extraction stays locked', () => {
    const src = code('src/screens/booking/ServiceTypeScreen.tsx');
    // A3 (founder 2026-08-21): ONLY the Recon Team service CARD is removed from
    // ServiceTypeScreen. The `recon_team` ServiceKey union, bookingTypeFor and the
    // server DTO allowlists stay for back-compat (the card was never bookable).
    expect(src).not.toMatch(/key: 'recon_team'/);
    // KEEP decision — Emergency Extraction remains a locked COMING SOON card.
    const ee = src.indexOf("key: 'emergency_extraction'");
    expect(ee).toBeGreaterThan(-1);
    expect(src.slice(ee, src.indexOf('},', ee))).toMatch(/comingSoon: true/);
    // The union key survives: a (legacy) booked recon_team still resolves to a shape.
    expect(bookingTypeFor('recon_team')).toBe('timeslot');
  });
});

describe('Issue 29 — hourly bookings need no destination', () => {
  it('maps each service to the right booking SHAPE', () => {
    expect(bookingTypeFor('secure_transfer')).toBe('transfer');
    expect(bookingTypeFor('executive_protection')).toBe('timeslot');
    expect(bookingTypeFor('recon_team')).toBe('timeslot');
    expect(bookingTypeFor('emergency_extraction')).toBe('timeslot');
  });

  it('a transfer still REQUIRES a drop-off; an hourly detail does not', () => {
    const pickup = {lat: 1, lng: 1};
    expect(canAdvanceSchedule('transfer', pickup, null)).toBe(false);
    expect(canAdvanceSchedule('transfer', pickup, {lat: 2, lng: 2})).toBe(true);
    expect(canAdvanceSchedule('timeslot', pickup, null)).toBe(true);
  });

  it('neither shape can advance without a pickup', () => {
    expect(canAdvanceSchedule('transfer', null, null)).toBe(false);
    expect(canAdvanceSchedule('timeslot', null, null)).toBe(false);
  });

  it('selecting a service now sets the type as well as the service', () => {
    // This is the fix for BOTH halves: EP becomes hourly, and a transfer finally
    // requires a drop-off (it never did, because type stayed at its default).
    expect(code('src/screens/booking/ServiceTypeScreen.tsx'))
      .toMatch(/updateDraft\(\{\s*service: svc\.key, type: bookingTypeFor\(svc\.key\),/);
  });

  it('a Lite re-selection restores the defaults an abandoned executive seed changed', () => {
    // Executive Protection seeds duration_hours:3 / vehicle_count:0 into the SHARED
    // draft; tapping a Lite card afterwards must restore the Lite defaults or
    // the next Secure Transfer is quoted (and escrowed) at 3 h instead of 4 —
    // and must drop the executive brief/transfer legs so they don't ride along.
    const src = code('src/screens/booking/ServiceTypeScreen.tsx');
    expect(src).toMatch(/service === 'executive_protection' \? \{\s*duration_hours: 4, vehicle_count: 1, notes: '',/);
    expect(src).toMatch(/transport_mode: 'none' as const,/);
  });

  it('the executive card routes to the Executive Protection dashboard, dirty-guarded', () => {
    // Wave 5c (PDF-2) — the 7-screen executive wizard collapsed into ONE dashboard
    // grown on ExecReview; the card now routes there (ExecDuration stays registered
    // but is skipped via the happy path). Seed-before-navigate + dirty-guard hold.
    const src = code('src/screens/booking/ServiceTypeScreen.tsx');
    expect(src).toMatch(/navigation\.navigate\('ExecReview'\)/);
    expect(src).not.toMatch(/navigation\.navigate\('ExecDuration'\)/);
    expect(src).toMatch(/isBookingDraftDirty\(\)/);
    // The CTA must not carry a non-Lite draft into the Lite schedule.
    expect(src).toMatch(/if \(!liteSelected\) \{return;\}/);
  });
});

describe('Issue 29 — the brief reaches the Bravo Control System', () => {
  it('a free-text instructions field exists on the review step', () => {
    const src = code('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(src).toMatch(/value=\{notes\}/);
    expect(src).toMatch(/updateDraft\(\{notes: t\.slice\(0, NOTES_MAX\)\}\)/);
  });

  it('its label and placeholder adapt to an hourly detail', () => {
    // An hourly booking has no route to infer intent from, so the brief IS the
    // requirement — the PDF names event support and meeting attendance.
    const src = code('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(src).toMatch(/isHourly \? 'Brief for the team \(optional\)'/);
    expect(src).toMatch(/Event support at the Hilton/);
  });

  it('notes ride the existing booking payload — no new API surface', () => {
    expect(code('src/store/bookingStore.ts')).toMatch(/notes: draft\.notes,/);
    expect(code('apps/auth-service/src/booking/booking.service.ts')).toMatch(/dto\.notes \?\? null/);
  });

  it('the server already accepts the service and a missing dropoff', () => {
    const dto = code('apps/auth-service/src/booking/dto/create-booking.dto.ts');
    expect(dto).toMatch(/'executive_protection'/);
    expect(dto).toMatch(/@IsOptional\(\) dropoff\?: LocationDto;/);
    // Still null when absent; now length-bounded (E-12 — geocoder strings are
    // truncated at persist rather than rejected, which would 400 a paid booking).
    expect(code('apps/auth-service/src/booking/booking.service.ts'))
      .toMatch(/dto\.dropoff\?\.address \? dto\.dropoff\.address\.slice\(0, ADDRESS_MAX\) : null/);
  });
});
