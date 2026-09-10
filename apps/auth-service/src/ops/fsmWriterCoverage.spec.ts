import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * FSM defense-in-depth — every mission-status writer routes through
 * missionFsm.assert, so the MissionStateMachine is the single source of truth and a
 * future table change can't leave a raw writer silently drifted. The crew-forward
 * flips are AGENT-attributed (gated by requireLead); the SYSTEM sweeps are aborts.
 * Source scans — these live across services the node Jest project can't co-mount.
 *
 * NOTE (critic 2026-08-28): the mission-lead flips assert with actor 'AGENT', NOT
 * 'SYSTEM'. Asserting them as SYSTEM would demand adding SYSTEM crew-forward rows to
 * the FSM, which deletes the "SYSTEM cannot fabricate crew progress" invariant
 * (mission-state-machine.service.spec.ts). Keep them AGENT.
 */
const root = join(__dirname, '..');
const strip = (p: string) =>
  readFileSync(join(root, p), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('FSM writer coverage — every mission-status writer asserts the transition', () => {
  it('mission-lead crew-forward flips assert AGENT (DISPATCHED→PICKUP, PICKUP→LIVE)', () => {
    const src = strip('agents/mission-lead.service.ts');
    expect(src).toMatch(/missionFsm\.assert\('DISPATCHED',\s*'PICKUP',\s*'AGENT'\)/);
    expect(src).toMatch(/missionFsm\.assert\('PICKUP',\s*'LIVE',\s*'AGENT'\)/);
    // Must NOT assert these as SYSTEM (that would need a forbidden FSM row).
    expect(src).not.toMatch(/missionFsm\.assert\('(DISPATCHED|PICKUP)',\s*'(PICKUP|LIVE)',\s*'SYSTEM'\)/);
  });

  it('arrival-noshow sweep asserts SYSTEM→ABORTED', () => {
    expect(strip('dispatch/arrival-noshow.service.ts'))
      .toMatch(/missionFsm\.assert\('DISPATCHED',\s*'ABORTED',\s*'SYSTEM'\)/);
  });

  it('org-mission rollback asserts SYSTEM→ABORTED', () => {
    expect(strip('org/org-mission.service.ts'))
      .toMatch(/missionFsm\.assert\('DISPATCHED',\s*'ABORTED',\s*'SYSTEM'\)/);
  });

  it('booking client-cancel asserts SYSTEM→ABORTED for BOTH declared froms', () => {
    const src = strip('booking/booking.service.ts');
    // Loop over ['DISPATCHED','PICKUP'] asserting each as SYSTEM→ABORTED.
    expect(src).toMatch(/for \(const from of \['DISPATCHED',\s*'PICKUP'\][\s\S]{0,120}missionFsm\.assert\(from[\s\S]{0,40}'ABORTED',\s*'SYSTEM'\)/);
  });
});
