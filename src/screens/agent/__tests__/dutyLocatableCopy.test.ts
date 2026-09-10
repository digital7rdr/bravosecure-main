import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * MOB-5 (honest-UI half) — when an on-duty agency is NOT locatable, the on-duty
 * heartbeat has gone stale. Its most common cause is the app being BACKGROUNDED
 * (the setInterval is suspended; background survival needs a native foreground
 * service that isn't wired yet — see onDutyHeartbeat.ts). The old copy blamed
 * "keep location on", which is actively misleading when location IS on and the
 * app is merely closed. The honest copy must name keeping the app open.
 *
 * Source scan — AgentDashboardScreen mounts a large native-dep tree.
 */
const src = readFileSync(
  join(__dirname, '..', 'AgentDashboardScreen.tsx'), 'utf8',
).replace(/\r\n/g, '\n');

describe('MOB-5 — the not-locatable duty copy is honest about backgrounding', () => {
  it('tells the agency to keep the app open, not only location on', () => {
    // The stale-heartbeat branch names keeping Bravo open.
    expect(src).toMatch(/keep Bravo open/i);
    expect(src).toMatch(/pauses when the app is closed/i);
  });

  it('no longer ships the misleading "keep location on to receive jobs" line', () => {
    // That phrasing is a no-op instruction when the real cause is a closed app.
    expect(src).not.toMatch(/keep location on to receive jobs/);
  });
});
