/**
 * Issue 44 (Testing Issues V2, PDF p.49) — "SOS Activation Is Not Reflected in
 * the Bravo Control System". CRITICAL, life-safety.
 *
 * The app said SOS Active / operations team notified; the console still showed
 * "SOS 0". Two structural gaps, not a UI bug:
 *
 *   1. sos.service.raise() inserted a sos_events row carrying only booking_id
 *      and never touched missions.status. The console lists missions by status
 *      (mission.service listActive -> ['DISPATCHED','PICKUP','LIVE','SOS']) and
 *      counts status === 'SOS' (ops-console live/page.tsx), so a CLIENT panic
 *      was invisible by construction. The CPO path (agent.service raiseSos) has
 *      always flipped the status — only the client path did not.
 *   2. ackSos / escalateSos / resolveSos all read sos_events.mission_id, which
 *      the client path left NULL, so even a spotted alert could not be worked.
 *
 * And the app asserted "Notified" from the moment the record was accepted,
 * which the PDF explicitly forbids until server acknowledgement.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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

const SOS_SERVICE = 'apps/auth-service/src/sos/sos.service.ts';

describe('Issue 44 — a client SOS reaches the Bravo Control System', () => {
  it('raise() resolves the booking\'s active mission', () => {
    const src = code(SOS_SERVICE);
    expect(src).toMatch(/FROM missions m[\s\S]{0,300}WHERE m\.booking_id = \$1/);
    // AUTHZ-1 — the mission resolve is bound to a booking the CALLER owns, so a
    // stranger's bookingId can't flip a live mission to SOS and spam its crew.
    expect(src).toMatch(/b\.client_id = \$2/);
    // Never adopt a mission that has already ended.
    expect(src).toMatch(/status NOT IN \('COMPLETED', 'ABORTED'\)/);
  });

  it('raise() flips the mission to SOS so the console\'s live feed sees it', () => {
    const src = code(SOS_SERVICE);
    expect(src).toMatch(/UPDATE missions SET status = 'SOS'/);
  });

  it('the flip is conditional — two panic presses must not double-write', () => {
    const src = code(SOS_SERVICE);
    // Same guard the CPO path uses.
    expect(src).toMatch(/WHERE id = \$1 AND status NOT IN \('SOS', 'COMPLETED', 'ABORTED'\)/);
  });

  it('the sos_events row carries mission_id, or ack/escalate/resolve cannot work', () => {
    const src = code(SOS_SERVICE);
    expect(src).toMatch(/INSERT INTO public\.sos_events[\s\S]{0,200}mission_id/);
  });

  it('the flip and the insert are ONE transaction', () => {
    const src = code(SOS_SERVICE);
    // A mission flipped SOS with no event row (or vice versa) is a worse state
    // than the bug: the console would show an alert nobody can resolve.
    expect(src).toMatch(/withTransaction/);
    const txStart = src.indexOf('withTransaction');
    const tx = src.slice(txStart, src.indexOf('if (!row)', txStart));
    expect(tx).toContain("UPDATE missions SET status = 'SOS'");
    expect(tx).toContain('INSERT INTO public.sos_events');
  });

  it('an off-mission panic still records (mission_id simply stays null)', () => {
    const src = code(SOS_SERVICE);
    expect(src).toMatch(/mission\?\.id \?\? null/);
  });

  it('the console consumes mission status SOS — the contract this relies on', () => {
    const missions = code('apps/auth-service/src/ops/mission.service.ts');
    expect(missions).toMatch(/listByStatus\(\['DISPATCHED','PICKUP','LIVE','SOS'\]/);
    const live = code('apps/ops-console/src/app/live/page.tsx');
    expect(live).toMatch(/r\.status === 'SOS'/);
  });
});

describe('Issue 44 — the app never claims ops have the alert before they do', () => {
  const SCREEN = 'src/screens/liveops/SOSScreen.tsx';

  it('SOSScreen distinguishes waiting from acknowledged', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/sosAcked \? 'Bravo Control System Acknowledged' : 'Waiting for Bravo Control System…'/);
    // The flat claim the tester screenshotted.
    expect(src).not.toMatch(/>Bravo Control System Notified</);
  });

  it('the acked flag comes from the SERVER, not from a successful send', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/sosApi\.status\(sosId\)/);
    expect(src).toMatch(/data\?\.acknowledged_at.*setSosAcked\(true\)/);
  });

  it('the poll is bounded and cleaned up on unmount', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/MAX_POLL_MS/);
    expect(src).toMatch(/sosPollCancelled\.current = true/);
    expect(src).toMatch(/clearTimeout\(sosPollTimer\.current\)/);
  });

  it('the raise still AWAITS the server before showing ACTIVE (audit C3 kept)', () => {
    const src = code(SCREEN);
    const idx = src.indexOf('await sosApi.raise(');
    expect(idx).toBeGreaterThan(-1);
    expect(src.indexOf('setIsActivated(true)')).toBeGreaterThan(idx);
  });
});

/**
 * The console UX half of Issue 44, which the first pass left open. The PDF's
 * clause is "immediate PERSISTENT alert, AUDIBLE notification, acknowledgement
 * workflow, escalation status, audit record" — ack/escalate/audit already
 * existed on /sos; persistent and audible did not.
 */
describe('Issue 44 — the console alert is persistent and audible', () => {
  const BAR = 'apps/ops-console/src/components/SosAlertBar.tsx';

  it('the alert is mounted in the SHELL, so it shows on every page', () => {
    // The old banner lived on /live only: an operator on /bookings saw nothing
    // but a bell badge.
    const shell = code('apps/ops-console/src/components/Shell.tsx');
    expect(shell).toMatch(/<SosAlertBar \/>/);
    expect(shell).toMatch(/import SosAlertBar from '\.\/SosAlertBar'/);
  });

  it('and the page-local duplicate is gone, so two bars cannot compete', () => {
    const live = code('apps/ops-console/src/app/live/page.tsx');
    expect(live).not.toMatch(/EMERGENCY ALERT/);
  });

  it('it reads unresolved sos_events, not missions.status', () => {
    // missions.status cannot represent a mission-less client or VBG panic.
    const src = code(BAR);
    expect(src).toMatch(/useSosEvents\('active'\)/);
    expect(src).toMatch(/filter\(r => !r\.resolved_at\)/);
  });

  it("'active' really does mean unresolved on the server", () => {
    const data = code('apps/auth-service/src/ops/ops-data.service.ts');
    expect(data).toMatch(/WHEN \$1::text = 'active'\s+THEN s\.resolved_at IS NULL/);
  });

  it('it cannot be dismissed — only working the alert clears it', () => {
    const src = code(BAR);
    expect(src).not.toMatch(/dismiss|onClose|setHidden/i);
    // The single exit: no unresolved rows (and, since the OC-06 amber tier,
    // no attention items either). The red SOS bar still renders whenever ANY
    // unresolved row exists — amber never replaces it.
    expect(src).toMatch(/if \(rows\.length === 0 && amberCount === 0\) return null;/);
    expect(src).toMatch(/if \(rows\.length === 0\) return amberBar \|\| null;/);
  });

  it('the chime sounds for UNACKNOWLEDGED alerts and repeats', () => {
    const src = code(BAR);
    expect(src).toMatch(/useSosChime\(unacked\.length > 0\)/);
    expect(src).toMatch(/setInterval\(sound, CHIME_REPEAT_MS\)/);
  });

  it('the alarm goes quiet once acknowledged, but the bar stays', () => {
    // Punishing the operator already working the alert would train them to
    // mute it. The bar remains because the SOS is still open.
    const src = code(BAR);
    expect(src).toMatch(/ACKNOWLEDGED, NOT RESOLVED/);
  });

  it('audio is synthesised, never an asset — no 404, no CSP media-src', () => {
    const src = code(BAR);
    expect(src).toMatch(/createOscillator\(\)/);
    expect(src).not.toMatch(/new Audio\(|\.mp3|\.wav|\.ogg/);
  });

  it('a muted browser is SURFACED, not silently tolerated', () => {
    // Browsers block audio before a user gesture. Failing quietly on a
    // life-safety alarm would be worse than the bug being fixed.
    const src = code(BAR);
    expect(src).toMatch(/SOUND OFF — ENABLE/);
    expect(src).toMatch(/state === 'running'/);
  });

  it('escalation status is shown — the PDF names it explicitly', () => {
    const src = code(BAR);
    expect(src).toMatch(/ESCALATED/);
    expect(src).toMatch(/escalated\[0\]\.escalated_to/);
  });

  it('it is announced to assistive tech as an assertive alert', () => {
    const src = code(BAR);
    expect(src).toMatch(/role="alert"/);
    expect(src).toMatch(/aria-live="assertive"/);
  });

  it('the ack / escalate / resolve workflow it links to still exists', () => {
    const src = code(BAR);
    expect(src).toMatch(/href="\/sos"/);
    const page = code('apps/ops-console/src/app/sos/page.tsx');
    for (const fn of ['ackSos', 'escalateSos', 'resolveSos']) {
      expect(page).toContain(fn);
    }
  });

  it('every one of those three still writes an admin audit row', () => {
    const svc = code('apps/auth-service/src/ops/mission.service.ts');
    for (const action of ['sos.ack', 'sos.escalate', 'sos.resolve']) {
      expect(svc).toContain(`'${action}'`);
    }
  });
});
