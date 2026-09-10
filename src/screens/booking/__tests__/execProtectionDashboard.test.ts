/**
 * Wave 5 (PDF-2) sub-wave 5c — the 7-screen Executive Protection wizard
 * collapses into ONE consolidated Booking dashboard, built by GROWING
 * ExecReviewScreen IN PLACE (it already owns confirmBooking + the consent gate +
 * the credit-error call site + the status routing). The earlier six steps fold
 * in as sections that write the SAME bookingStore draft fields:
 *   - Duration  (from ExecDurationScreen)   → duration_hours (grid over EXEC_DURATIONS)
 *   - Schedule  (from ExecScheduleScreen)   → mode / start_time, rebases
 *                                             transport_pickup_time (B-382)
 *   - Task      (from ExecTaskScreen)        → pickup (service location, pushed
 *                                             LocationPicker) / task_type / notes
 *   - Transport (from ExecTransportScreen)   → transport_mode + legs, with the
 *                                             progressive disclosure preserved
 *   - Team      (from ExecTeamScreen)        → cpo_count / vehicle_count /
 *                                             driver_only / addon_switches /
 *                                             selected_add_ons / estimated_price
 *   - Consent + Calculation + Submit         → the CURRENT ExecReview body +
 *                                             confirmBooking(), status routing and
 *                                             the CreditPaywall branch, verbatim
 *
 * This is a MONEY-FLOW screen the node `booking` project cannot import (RN
 * views), so it is pinned by reading the source — same pattern as
 * secureTransferDashboard / creditErrorCallSites. Files are CRLF and carry
 * design prose that names these tokens, so comments are stripped line-wise
 * first (a `\n`-anchored regex would pass VACUOUSLY otherwise).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');
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
    expect(src).toContain('confirmBooking');
    expect(src).not.toContain('\r');
  });
});

// ── NEW sections folded in for 5c (RED-first: absent at HEAD) ──────────────────
describe('5c — seeds the executive draft on mount', () => {
  const src = code(SCREEN);

  it('calls startExecutiveDraft() from an effect (deep-link / direct-entry backstop)', () => {
    // The one place the executive draft is seeded once ExecDuration is skipped —
    // idempotent while an executive draft is in progress (execDraftSeed pins it).
    expect(src).toMatch(/st\.startExecutiveDraft/);
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{\s*startExecutiveDraft\(\);?\s*\}/);
  });
});

describe('5c — Duration section (folded from ExecDurationScreen)', () => {
  const src = code(SCREEN);

  it('renders a grid over EXEC_DURATIONS that writes duration_hours', () => {
    expect(src).toContain('EXEC_DURATIONS');
    expect(src).toMatch(/EXEC_DURATIONS\.map\(/);
    expect(src).toMatch(/updateDraft\(\{duration_hours:/);
  });
});

describe('5c — Schedule section (folded from ExecScheduleScreen)', () => {
  const src = code(SCREEN);

  it('writes the Book-Now/Later mode and start_time together', () => {
    expect(src).toMatch(/updateDraft\(\{\s*mode,\s*start_time:\s*start\.toISOString\(\)/);
  });

  it('rebases transport_pickup_time through the shared window resolver (B-382)', () => {
    // A hand-rolled same-day setHours collapsed a next-day transfer; the rebase
    // MUST go through resolveTransferTime + transferTimeOutOfWindow.
    expect(src).toContain('resolveTransferTime');
    expect(src).toContain('transferTimeOutOfWindow');
    expect(src).toMatch(/transport_pickup_time:\s*ok\s*\?/);
  });

  it('keeps the 3-hour lead constant from scheduleGate (no re-declare)', () => {
    expect(src).toContain('MIN_LEAD_HOURS');
    expect(src).not.toMatch(/const MIN_LEAD_HOURS =/);
  });
});

describe('5c — Task section (folded from ExecTaskScreen)', () => {
  const src = code(SCREEN);

  it('opens the service-location LocationPicker as a pushed modal returning to THIS route', () => {
    expect(src).toMatch(/navigation\.navigate\('LocationPicker'/);
    expect(src).toMatch(/onPickRouteKey:\s*'ExecReview'/);
  });

  it('merges the picked location back via the route-params contract', () => {
    expect(src).toContain('route.params');
    expect(src).toContain('pickedKind');
    expect(src).toContain('pickedLat');
  });

  it('writes the service pickup and the task_type / notes', () => {
    expect(src).toMatch(/updateDraft\(\{\s*pickup:/);
    expect(src).toMatch(/updateDraft\(\{task_type:/);
    expect(src).toMatch(/updateDraft\(\{notes:/);
    expect(src).toContain('EXEC_TASK_TYPES');
  });

  it('routes each picked location to its OWN slot — no service<->transfer swap', () => {
    // Three location slots share one picker `kind`; a pendingSlot ref names the
    // target. Anchor the branch→field mapping + the opener assignments so a future
    // edit can't send the principal's service pickup to a transfer slot (a
    // wrong-real-world-address regression the presence-only pins missed — edge 5c).
    expect(src).toMatch(/pendingSlot\.current = 'service'/);
    expect(src).toMatch(/pendingSlot\.current = kind === 'pickup' \? 'transfer_pickup' : 'transfer_dropoff'/);
    // service branch writes draft.pickup and NOT the transfer field:
    const svc = src.slice(src.indexOf("slot === 'service'"), src.indexOf("slot === 'transfer_pickup'"));
    expect(svc).toMatch(/updateDraft\(\{\s*pickup:/);
    expect(svc).not.toMatch(/transport_pickup:/);
    // transfer_pickup branch writes transport_pickup:
    const tp = src.slice(src.indexOf("slot === 'transfer_pickup'"), src.indexOf('transport_dropoff:'));
    expect(tp).toMatch(/updateDraft\(\{\s*transport_pickup:/);
  });
});

describe('5c — Transport section (folded from ExecTransportScreen)', () => {
  const src = code(SCREEN);

  it('keeps the progressive disclosure — legs live behind the transport_mode gate', () => {
    // enabled === (transport_mode !== 'none'); the legs render only when enabled,
    // so a presence-only pin of transport_pickup is not enough — the gate hides them.
    expect(src).toMatch(/draft\.transport_mode !== 'none'/);
    expect(src).toMatch(/const enabled\s*=/);
  });

  it('writes every transport draft field', () => {
    expect(src).toMatch(/transport_mode:/);
    expect(src).toMatch(/transport_pickup:/);
    expect(src).toMatch(/transport_dropoff:/);
    expect(src).toMatch(/transport_pickup_time:/);
    expect(src).toMatch(/updateDraft\(\{\s*passengers,/);
  });

  it('toggling the leg OFF zeroes vehicles + driver_only (they exist only with a leg)', () => {
    expect(src).toMatch(/transport_mode: 'none',\s*\n?\s*vehicle_count: 0,\s*\n?\s*driver_only: false/);
  });
});

describe('5c — Team section (folded from ExecTeamScreen)', () => {
  const src = code(SCREEN);

  it('writes cpo_count / vehicle_count / driver_only', () => {
    expect(src).toMatch(/updateDraft\(\{cpo_count:/);
    expect(src).toMatch(/updateDraft\(\{vehicle_count:/);
    expect(src).toMatch(/driver_only: true/);
  });

  it('writes addon_switches + selected_add_ons together on a toggle', () => {
    expect(src).toMatch(/addon_switches: switches,/);
    expect(src).toMatch(/selected_add_ons: EXEC_ADDONS\.filter/);
  });

  it('keeps the debounced server estimate (money math unchanged)', () => {
    expect(src).toContain('estimatePrice');
    expect(src).toMatch(/service: 'executive_protection'/);
  });
});

// ── PRESERVED from the current step 7 (must stay green — regression pins) ──────
describe('5c — the submit path is the step-7 confirmBooking(), verbatim', () => {
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

  it('writes the escrow total (estimated_price) from the live server/local estimate', () => {
    expect(src).toMatch(/estimated_price:\s*totalBc/);
  });
});

describe('5c — the section gates actually block the CTA (wiring, not presence)', () => {
  const src = code(SCREEN);

  it('ctaBlocked folds in the pickup, schedule and transport gates', () => {
    // A presence-only pin stays green if a guard is deleted, letting a submit with
    // a missing service location or an out-of-window transfer through. Pin the wiring.
    expect(src).toMatch(/const ctaBlocked\s*=/);
    expect(src).toMatch(/ctaBlocked[\s\S]{0,240}!pickupReady/);
    expect(src).toMatch(/ctaBlocked[\s\S]{0,240}legsMissing/);
    expect(src).toMatch(/ctaBlocked[\s\S]{0,240}transferOutOfWindow/);
    expect(src).toMatch(/ctaBlocked[\s\S]{0,240}!scheduleValid/);
  });

  it('the consent gate stays part of the block', () => {
    expect(src).toMatch(/ctaBlocked[\s\S]{0,240}consentRequired && !consentGiven/);
  });

  it('handleSubmit short-circuits on the same block', () => {
    expect(src).toMatch(/if \(ctaBlocked\) \{return;\}/);
  });
});

describe('5c — routing: Executive Protection card points at the dashboard', () => {
  it('ServiceTypeScreen navigates to ExecReview, not ExecDuration', () => {
    const src = code(SERVICE_SCREEN);
    expect(src).toMatch(/navigation\.navigate\('ExecReview'\)/);
    expect(src).not.toMatch(/navigation\.navigate\('ExecDuration'\)/);
    // The dirty-guard + seed-before-navigate are untouched.
    expect(src).toContain('startExecutiveDraft()');
    expect(src).toContain('isBookingDraftDirty()');
  });
});
