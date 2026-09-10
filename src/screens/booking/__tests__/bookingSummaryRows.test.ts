/**
 * Secure Services Streamlined (client UX spec, 2026-08) — after Confirm
 * Booking the summary dashboard must "reproduce EVERY selected value". The
 * post-confirm surface is OpsRoomReviewScreen (PENDING_OPS / OPS_APPROVED /
 * PAYMENT_PENDING); BookingConfirmationScreen is the post-approval one. Both
 * used to show five rows (Service + N add-ons, Date, Pick-up, Duration, Total)
 * and fell back to the DEFAULT draft (cleared at submit) — i.e. "4 hrs est." /
 * "—" / "0 BC" presented as the booking's values.
 *
 * The rows are built by a PURE helper (`buildBookingSummaryRows`) so they are
 * testable without mounting either screen. Honesty contract pinned here:
 *   - only fields the server ECHOES (ClientBooking — booking.service
 *     toClientBooking) or a server INVARIANT implies (consent on the auto path)
 *     are rendered; the referral code and the price split are persisted but
 *     not returned, so they are OMITTED rather than shown as "—";
 *   - an empty booking yields NO rows (never a fabricated default);
 *   - add-on ids resolve to human labels: live catalogue first, then the
 *     executive catalogue, then a minimal Lite fallback, then the humanised id.
 *
 * The screen wiring is pinned by source scan (the screens mount RN views the
 * node `booking` project cannot import). CRLF + comment-strip traps apply.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildBookingSummaryRows, formatBookingTime, type SummaryBooking} from '../bookingSummaryRows';

const ROOT = process.cwd();
const OPS_SCREEN = join('src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx');
const CONFIRM_SCREEN = join('src', 'screens', 'booking', 'BookingConfirmationScreen.tsx');

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

const valueOf = (rows: Array<{label: string; value: string}>, label: string): string | undefined =>
  rows.find(r => r.label === label)?.value;
const labels = (rows: Array<{label: string}>): string[] => rows.map(r => r.label);

describe('formatBookingTime — the SELECTED clock, not the wire clock (review round 1)', () => {
  it('renders the local 12-hour time the dashboards pick in (TZ-independent: built from a LOCAL Date)', () => {
    // 2:30 PM local, whatever the host TZ is — so the expectation is exact.
    const local = new Date(2026, 7, 28, 14, 30);
    expect(formatBookingTime(local.toISOString())).toMatch(/^[A-Za-z]{3},? 28 Aug · 2:30 PM$/);
    const morning = new Date(2026, 7, 29, 8, 5);
    expect(formatBookingTime(morning.toISOString())).toMatch(/ · 8:05 AM$/);
    // Never the UTC "HH:MMZ" form the screen used to show.
    expect(formatBookingTime(local.toISOString())).not.toMatch(/Z$/);
  });

  it('is null for a missing or unparsable time (no fabricated value)', () => {
    expect(formatBookingTime(null)).toBeNull();
    expect(formatBookingTime(undefined)).toBeNull();
    expect(formatBookingTime('not-a-date')).toBeNull();
  });
});

// Wire-true fixtures — the shape toClientBooking returns (src/types Booking).
const secureTransfer: SummaryBooking = {
  service: 'secure_transfer',
  booking_mode: 'now',
  start_time: '2026-08-28T14:30:00.000Z',
  pickup: {latitude: 25.25, longitude: 55.36, address: 'DXB Terminal 3'},
  dropoff: {latitude: 25.14, longitude: 55.18, address: 'Burj Al Arab'},
  duration_hours: 4,
  passengers: 2,
  cpo_count: 1,
  vehicle_count: 1,
  driver_only: false,
  add_ons: ['female_cpo', 'medical'],
  notes: '',
  total_eur: 512,
  dispatch_mode: 'auto',
  task_type: null,
  exec_transport: null,
};

const execBase: SummaryBooking = {
  service: 'executive_protection',
  booking_mode: 'later',
  start_time: '2026-08-29T08:00:00.000Z',
  pickup: {latitude: 25.21, longitude: 55.28, address: 'Four Seasons DIFC', label: 'Service location'},
  dropoff: null,
  duration_hours: 6,
  passengers: 2,
  cpo_count: 2,
  vehicle_count: 0,
  driver_only: false,
  add_ons: ['female_cpo'],
  notes: 'Gala dinner, discreet presence',
  total_eur: 1500,
  dispatch_mode: 'auto',
  task_type: 'event_security',
  exec_transport: null,
};

describe('buildBookingSummaryRows — Secure Transfer', () => {
  const rows = buildBookingSummaryRows(secureTransfer);

  it('reproduces every selected value, in the spec order', () => {
    expect(labels(rows)).toEqual([
      'Service', 'Schedule', 'Pick-up', 'Drop-off', 'Duration', 'Passengers',
      'Team', 'Driver Only', 'Add-ons', 'Notes', 'Consent', 'Estimated Total',
    ]);
    expect(valueOf(rows, 'Service')).toBe('Secure Transfer');
    // Book Now/Later + the booked time (UTC, matching the backend/ops value).
    // Local 12-hour clock (the dashboards pick in 12h local; the summary must
    // echo the SELECTED value, not the wire's UTC form). TZ-independent shape.
    expect(valueOf(rows, 'Schedule')).toMatch(/^Book Now · [A-Za-z]{3},? \d{2} [A-Za-z]{3} · \d{1,2}:\d{2} (AM|PM)$/);
    expect(valueOf(rows, 'Schedule')).toBe(`Book Now · ${formatBookingTime(secureTransfer.start_time)}`);
    expect(valueOf(rows, 'Pick-up')).toBe('DXB Terminal 3');
    expect(valueOf(rows, 'Drop-off')).toBe('Burj Al Arab');
    expect(valueOf(rows, 'Duration')).toBe('4 hrs est.');
    expect(valueOf(rows, 'Passengers')).toBe('2');
    expect(valueOf(rows, 'Team')).toBe('1 CPO · 1 Vehicle + Driver');
    expect(valueOf(rows, 'Driver Only')).toBe('No');
    expect(valueOf(rows, 'Add-ons')).toBe('Female CPO Team · Medical Support');
    expect(valueOf(rows, 'Notes')).toBe('—');
    expect(valueOf(rows, 'Consent')).toBe('Accepted');
    expect(valueOf(rows, 'Estimated Total')).toBe('512 BC');
  });

  it('highlights ONLY the total', () => {
    const highlighted = rows.filter(r => r.highlight).map(r => r.label);
    expect(highlighted).toEqual(['Estimated Total']);
  });

  it('never renders the referral code — it is persisted but not echoed by the server', () => {
    // toClientBooking omits referral_code and the draft is cleared at submit, so
    // the client cannot know it; showing "—" would claim "none was entered".
    expect(labels(rows)).not.toContain('Referral code');
  });

  it('driver-only team reads as the client vehicle + Bravo driver, add-ons None, legacy path has no consent row', () => {
    const r = buildBookingSummaryRows({
      ...secureTransfer, cpo_count: 2, vehicle_count: 0, driver_only: true,
      add_ons: [], notes: 'VIP arriving on EK412', dispatch_mode: null, dropoff: null,
    });
    expect(valueOf(r, 'Team')).toBe('2 CPOs · Client vehicle + Bravo driver');
    expect(valueOf(r, 'Driver Only')).toBe('Yes');
    expect(valueOf(r, 'Add-ons')).toBe('None');
    expect(valueOf(r, 'Notes')).toBe('VIP arriving on EK412');
    expect(labels(r)).not.toContain('Consent');
    expect(labels(r)).not.toContain('Drop-off');
  });

  it('Book Later schedules say so', () => {
    const r = buildBookingSummaryRows({...secureTransfer, booking_mode: 'later'});
    expect(valueOf(r, 'Schedule')).toMatch(/^Book Later · /);
  });

  it('prefers the live catalogue label, then the Lite fallback, then a humanised id', () => {
    const r = buildBookingSummaryRows(
      {...secureTransfer, add_ons: ['female_cpo', 'comms', 'armed_escort']},
      {addOnLabels: {female_cpo: 'Female CPO (live)'}},
    );
    expect(valueOf(r, 'Add-ons')).toBe('Female CPO (live) · Comms / SIGINT · Armed escort');
  });
});

describe('buildBookingSummaryRows — Executive Protection', () => {
  it('without a transfer: protection-only rows, in the spec order', () => {
    const rows = buildBookingSummaryRows(execBase);
    expect(labels(rows)).toEqual([
      'Service', 'Schedule', 'Duration', 'Service location', 'Event / Task type',
      'Description', 'CPOs required', 'Female CPO', 'Secure Transfer',
      'Location consent', 'Estimated Total',
    ]);
    expect(valueOf(rows, 'Service')).toBe('Executive Protection');
    expect(valueOf(rows, 'Schedule')).toMatch(/^Book Later · [A-Za-z]{3},? \d{2} [A-Za-z]{3} · \d{1,2}:\d{2} (AM|PM)$/);
    expect(valueOf(rows, 'Duration')).toBe('6 hrs');
    expect(valueOf(rows, 'Service location')).toBe('Four Seasons DIFC');
    expect(valueOf(rows, 'Event / Task type')).toBe('Event Security');
    expect(valueOf(rows, 'Description')).toBe('Gala dinner, discreet presence');
    expect(valueOf(rows, 'CPOs required')).toBe('2');
    expect(valueOf(rows, 'Female CPO')).toBe('Selected');
    expect(valueOf(rows, 'Secure Transfer')).toBe('Not added');
    expect(valueOf(rows, 'Location consent')).toBe('Accepted');
    const total = valueOf(rows, 'Estimated Total') ?? '';
    expect(total.endsWith(' BC')).toBe(true);
    expect(total.replace(/\D/g, '')).toBe('1500');
    // No transfer → none of the transfer-leg rows, and no Lite-only rows.
    for (const l of ['Transfer type', 'Pick-up', 'Drop-off', 'Pick-up time', 'Passengers', 'Team', 'Driver Only']) {
      expect(labels(rows)).not.toContain(l);
    }
  });

  it('with a transfer: the leg is reproduced (type, legs, time, passengers) plus the vehicle choice', () => {
    const rows = buildBookingSummaryRows({
      ...execBase,
      add_ons: ['female_cpo', 'recon'],
      vehicle_count: 1,
      exec_transport: {
        mode: 'both_ways',
        pickup: {latitude: 25.25, longitude: 55.36, address: 'DXB Terminal 1'},
        dropoff: {latitude: 25.11, longitude: 55.14, address: 'Palm Jumeirah'},
        pickup_time: '2026-08-29T07:15:00.000Z',
        passengers: 3,
      },
    });
    expect(labels(rows)).toEqual([
      'Service', 'Schedule', 'Duration', 'Service location', 'Event / Task type',
      'Description', 'CPOs required', 'Female CPO', 'Secure Transfer',
      'Transfer type', 'Pick-up', 'Drop-off', 'Pick-up time', 'Passengers',
      'Vehicles', 'Driver Only', 'Add-ons', 'Location consent', 'Estimated Total',
    ]);
    expect(valueOf(rows, 'Secure Transfer')).toBe('Added');
    expect(valueOf(rows, 'Transfer type')).toBe('Both Ways');
    expect(valueOf(rows, 'Pick-up')).toBe('DXB Terminal 1');
    expect(valueOf(rows, 'Drop-off')).toBe('Palm Jumeirah');
    expect(valueOf(rows, 'Pick-up time')).toMatch(/^[A-Za-z]{3},? \d{2} [A-Za-z]{3} · \d{1,2}:\d{2} (AM|PM)$/);
    expect(valueOf(rows, 'Passengers')).toBe('3');
    expect(valueOf(rows, 'Vehicles')).toBe('1');
    expect(valueOf(rows, 'Driver Only')).toBe('No');
    // Female CPO has its own row; the remaining add-ons use the EXECUTIVE labels.
    expect(valueOf(rows, 'Add-ons')).toBe('Advance Assessment Team');
  });

  it('a transfer without its own pickup time rides the booking start', () => {
    const rows = buildBookingSummaryRows({
      ...execBase,
      exec_transport: {
        mode: 'one_way',
        pickup: {latitude: 0, longitude: 0, address: 'A'},
        dropoff: {latitude: 0, longitude: 0, address: 'B'},
        pickup_time: null,
        passengers: 1,
      },
    });
    expect(valueOf(rows, 'Transfer type')).toBe('One Way');
    expect(valueOf(rows, 'Pick-up time')).toBe('Same as start time');
  });

  it('Female CPO reads "Not selected" when the add-on is absent; description falls back to a dash', () => {
    const rows = buildBookingSummaryRows({...execBase, add_ons: [], notes: null});
    expect(valueOf(rows, 'Female CPO')).toBe('Not selected');
    expect(valueOf(rows, 'Description')).toBe('—');
    expect(labels(rows)).not.toContain('Add-ons');
  });
});

describe('buildBookingSummaryRows — honesty', () => {
  it('an empty booking yields NO rows (no default duration, no "0 BC", no dashes)', () => {
    expect(buildBookingSummaryRows({})).toEqual([]);
    expect(buildBookingSummaryRows(null)).toEqual([]);
    expect(buildBookingSummaryRows(undefined)).toEqual([]);
  });

  it('a partially loaded booking renders only what it carries', () => {
    const rows = buildBookingSummaryRows({service: 'secure_transfer', total_eur: 300});
    expect(labels(rows)).toEqual(['Service', 'Estimated Total']);
  });

  it('does not invent a service label for an unknown key', () => {
    const rows = buildBookingSummaryRows({service: 'recon_team', total_eur: 1});
    expect(valueOf(rows, 'Service')).toBe('Recon Team');
    const r2 = buildBookingSummaryRows({service: 'mystery_service', total_eur: 1});
    expect(valueOf(r2, 'Service')).toBe('Mystery service');
  });
});

describe('screen wiring (source scan)', () => {
  it('OpsRoomReviewScreen builds its BOOKING SUMMARY from the helper and no longer fabricates defaults from the cleared draft', () => {
    const src = code(OPS_SCREEN);
    expect(src.length).toBeGreaterThan(8_000);
    expect(src).toContain('buildBookingSummaryRows(');
    // The old fixed rows read the DEFAULT draft after submit ("4 hrs est.", "—", 0 BC).
    expect(src).not.toMatch(/draft\.duration_hours \?\? 4/);
    expect(src).not.toMatch(/draft\.pickup\?\.address \?\? '—'/);
    expect(src).not.toContain('add-ons` : \'\')');
    // Pending / Approved / Rejected pill + Cancel Request are untouched.
    expect(src).toContain("'Approved' : state === 'rejected' ? 'Rejected' : 'Pending'");
    expect(src).toContain('CANCEL REQUEST');
  });

  it('BookingConfirmationScreen carries the same summary block', () => {
    const src = code(CONFIRM_SCREEN);
    expect(src.length).toBeGreaterThan(8_000);
    expect(src).toContain('buildBookingSummaryRows(');
    expect(src).toContain('BOOKING SUMMARY');
  });
});
