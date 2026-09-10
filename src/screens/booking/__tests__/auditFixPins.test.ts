/**
 * Audit 2026-08-05 (B-377..B-386) — source pins for the fixes whose behavior no
 * node test can execute (RN screens, tx-heavy server paths). Each assertion goes
 * RED if its fix is reverted or refactored away. Comment-stripped + CRLF-safe
 * per the repo scan rules; anchors are code tokens, never prose.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => {const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l;})
    .join('\n');

describe('B-377 — officer respond seam is wired end-to-end', () => {
  it('the client API calls /respond (was: sole writer of accepted_at with no caller)', () => {
    const api = stripped('src/services/api.ts');
    expect(api).toContain('respondToMission');
    expect(api).toContain('/respond');
  });
  it('the mission screen renders the accept/decline card', () => {
    const amd = stripped('src/screens/cpo/AssignedMissionDetailScreen.tsx');
    expect(amd).toContain('respondToMission');
    expect(amd).toContain('responsePending');
  });
  it('the deployment payload carries the officer’s own response stamps', () => {
    const svc = stripped('apps/auth-service/src/agents/agent.service.ts');
    expect(svc).toMatch(/crew_role:\s*\{[\s\S]{0,400}accepted_at/);
  });
});

describe('B-378 — crewed client-cancel wakes crew + agency', () => {
  it('cancel() pushes missionAborted to captured crew and mission-cancelled to the provider', () => {
    const svc = stripped('apps/auth-service/src/booking/booking.service.ts');
    expect(svc).toContain('abortCrew');
    expect(svc).toContain('missionCancelledByClient');
  });
  it('the bridge publishes the provider kind', () => {
    const bridge = stripped('apps/auth-service/src/ops/booking-push-bridge.service.ts');
    expect(bridge).toContain("'mission-cancelled'");
  });
});

describe('B-379 — client escrow controls exist', () => {
  it('api.ts exposes escrow read + confirm-complete + dispute', () => {
    const api = stripped('src/services/api.ts');
    expect(api).toContain('confirm-complete');
    expect(api).toContain(`/dispute`);
    expect(api).toContain('openDispute');
    expect(api).toContain('getEscrow');
  });
  it('TripSummary renders the release/dispute card', () => {
    const trip = stripped('src/screens/booking/TripSummaryScreen.tsx');
    expect(trip).toContain('confirmComplete');
    expect(trip).toContain('openDispute');
    expect(trip).toContain('PENDING_RELEASE');
  });
});

describe('B-381/B-383 — Pro activation staleness + exclusive period end', () => {
  it('activate() re-checks proposal expiry and elapsed coverage before the debit', () => {
    const svc = stripped('apps/auth-service/src/pro-applications/pro-applications.service.ts');
    const activate = svc.slice(svc.indexOf('async activate('));
    const beforeDebit = activate.slice(0, activate.indexOf('debitForFeature'));
    expect(beforeDebit).toContain('proposal_expired');
    expect(beforeDebit).toContain('coverage_elapsed');
  });
  it('current_period_end is the EXCLUSIVE end of the final day', () => {
    const svc = stripped('apps/auth-service/src/pro-applications/pro-applications.service.ts');
    expect(svc).toContain('($3::date + 1)::timestamptz');
  });
});

describe('B-384 — family relationship re-checked at charge time', () => {
  it('settleWonOffer re-reads hold/cap and fails the charge neutrally', () => {
    const svc = stripped('apps/auth-service/src/dispatch/dispatch.service.ts');
    // RE-POINTED, not relaxed. The quota work added `JOIN public.users h` to the
    // same locked statement (spec §21 — a suspended ROOT must stop the charge
    // too), which aliased the columns to `fm.`. The invariant is untouched: the
    // cap is re-read at CHARGE time and a permission failure raises the DISTINCT
    // family marker, never the top-up copy the member can do nothing about.
    const idx = svc.indexOf('fm.spend_limit_credits, fm.spent_credits');
    expect(idx).toBeGreaterThan(-1);
    expect(svc.slice(idx, idx + 1400)).toContain('charge_failed_family');
  });

  it('§21 — a SUSPENDED root account blocks the charge on the same path', () => {
    // Read under the same lock as the cap, so a suspension landing between two
    // separate reads cannot be missed, and folded into the same neutral marker.
    const svc = stripped('apps/auth-service/src/dispatch/dispatch.service.ts');
    const idx = svc.indexOf('fm.spend_limit_credits, fm.spent_credits');
    const block = svc.slice(idx, idx + 1400);
    expect(block).toContain('holder_suspended_at');
    expect(block).toMatch(/rootSuspended/);
    expect(block).toMatch(/if \(!fam \|\| onHold \|\| overCap \|\| rootSuspended\)/);
  });
});

describe('B-385 — Lite add-ons: reject unknown, persist the RESOLVED set', () => {
  it('create() rejects unresolved ids and persists resolved ids only', () => {
    const svc = stripped('apps/auth-service/src/booking/booking.service.ts');
    expect(svc).toContain("code: 'unknown_add_on'");
    expect(svc).toContain('addOns.map(a => a.id)');
    expect(svc).not.toContain('JSON.stringify(dto.add_ons ?? [])');
  });
});

describe('B-386 — legacy cancel window anchored to confirmation', () => {
  it('the anchor prefers confirmed_at and the CONFIRMED flip stamps it', () => {
    const svc = stripped('apps/auth-service/src/booking/booking.service.ts');
    expect(svc).toContain('row.confirmed_at ?? row.created_at');
    expect(svc).toContain('confirmed_at = COALESCE(confirmed_at, NOW())');
  });
});

describe('E-13 — one lead-time constant', () => {
  it('scheduleGate owns MIN_LEAD_HOURS; no screen re-declares it', () => {
    expect(stripped('src/screens/booking/scheduleGate.ts')).toContain('export const MIN_LEAD_HOURS');
    expect(stripped('src/screens/executive/ExecScheduleScreen.tsx')).not.toContain('const MIN_LEAD_HOURS =');
    expect(stripped('src/screens/booking/BookingDateTimeScreen.tsx')).not.toContain('const MIN_LEAD_HOURS =');
  });
});

describe('B-385 client — add-on catalogue reads the ops-editable server list', () => {
  it('the add-ons screen loads and merges live prices', () => {
    const scr = stripped('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(scr).toContain('loadAddOns');
    expect(scr).toContain('liveAddOns');
  });
  // Review finding: merging prices WITHOUT filtering left a de-listed add-on
  // selectable, and the new server reject then made the wizard a dead end.
  it('de-listed add-ons are FILTERED OUT, not just re-priced', () => {
    const scr = stripped('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(scr).toMatch(/ADDONS\.filter\(a => byId\.has\(a\.key\)\)/);
  });
  // The catalogue is region-scoped server-side; fetching on a different key than
  // create() validates against would 400 on the first region-scoped row.
  it('fetches the catalogue with the same region create() validates against', () => {
    const scr = stripped('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(scr).toContain('draft.region || draft.zone_code');
  });
  // The offline fallback must mirror the LITE seed, not the executive table
  // (120/100/90/75 over-stated every Lite add-on ~4x).
  it('the compiled fallback carries LITE prices', () => {
    const scr = stripped('src/screens/booking/CustomizeAddOnsScreen.tsx');
    expect(scr).toMatch(/female_cpo[\s\S]{0,120}priceHourly: 30/);
    expect(scr).not.toMatch(/female_cpo[\s\S]{0,120}priceHourly: 120/);
  });
});

describe('B-383 follow-up — "covered until" must not render the exclusive period end', () => {
  it('the server derives covered_until', () => {
    const svc = stripped('apps/auth-service/src/pro-applications/pro-applications.service.ts');
    expect(svc).toContain('AS covered_until');
  });
  it('every display site prefers it', () => {
    for (const f of [
      'src/screens/securepro/SecureProPaymentScreen.tsx',
      'src/screens/pro/ProDashboardScreen.tsx',
      'apps/ops-console/src/app/pro-applications/[id]/page.tsx',
    ]) {
      expect(stripped(f)).toContain('covered_until');
    }
  });
});

describe('E-10 — subscribe idempotency must not swallow a deliberate re-subscribe', () => {
  it('the key is per-attempt, not a date bucket', () => {
    const api = stripped('src/services/api.ts');
    expect(api).toContain('function subscribeKey');
    // A date-bucketed key replayed the first response for 24h.
    expect(api).not.toMatch(/subtier-\$\{tier\}-\$\{new Date\(\)/);
  });
});

describe('Review round 2 — routing + guards', () => {
  it('dispute-opened routes to the AGENCY shell (it wakes the provider)', () => {
    const boot = stripped('src/modules/messenger/push/fcmBootstrap.ts');
    expect(boot).toMatch(/kind === 'dispute-opened'[\s\S]{0,400}OrgMissions/);
  });
  it('respond is DISPATCHED-only server-side', () => {
    const svc = stripped('apps/auth-service/src/agents/agent.service.ts');
    expect(svc).toContain('respond_window_closed');
  });
  it('a declined officer can still accept while the mission waits', () => {
    const amd = stripped('src/screens/cpo/AssignedMissionDetailScreen.tsx');
    expect(amd).toContain('canUndoDecline');
  });
  it('the cancelled-booking wake reaches an agency that had not crewed yet', () => {
    const svc = stripped('apps/auth-service/src/booking/booking.service.ts');
    expect(svc).toMatch(/if \(escrow\.providerId\) \{[\s\S]{0,200}missionCancelledByClient/);
  });
  it('the job-feed CONFIRMED flip stamps the cancel-window anchor too', () => {
    const feed = stripped('apps/auth-service/src/ops/job-feed.service.ts');
    expect(feed).toMatch(/status = 'CONFIRMED', confirmed_at = COALESCE/);
  });
});
