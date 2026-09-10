import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * FRAUD-2 / P0 — the mission identity handshake. The backend (verify-arrival +
 * arrival_code) shipped dark; this pins the MOBILE half so it can't silently
 * regress: the client must SURFACE the arrival code, and the CPO must be able to
 * ENTER it. Source scans — LiveTrackingScreen and AssignedMissionDetailScreen
 * mount large native-dep trees the node project can't bootstrap.
 */
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('identity handshake — API wiring', () => {
  const api = strip(read('services/api.ts'));

  it('getVerifyCode exposes arrival_code to the client', () => {
    expect(api).toMatch(/getVerifyCode:[\s\S]{0,240}arrival_code:\s*string/);
  });

  it('agentApi.verifyArrival posts the code to the verify-arrival route', () => {
    expect(api).toMatch(/verifyArrival:\s*\(missionId[\s\S]{0,200}\/agents\/me\/missions\/\$\{missionId\}\/verify-arrival/);
  });

  it('getActiveMission carries identity_verified so the badge can persist', () => {
    expect(api).toMatch(/getActiveMission:[\s\S]{0,320}identity_verified:\s*boolean/);
  });
});

describe('identity handshake — client displays the arrival code', () => {
  const screen = strip(read('screens/liveops/LiveTrackingScreen.tsx'));

  it('reads arrival_code from the verify-code response', () => {
    expect(screen).toMatch(/setArrivalCode\(data\.arrival_code/);
  });

  it('renders the arrival code for the principal to read out', () => {
    expect(screen).toMatch(/verifyArrivalCode/);
    expect(screen).toMatch(/\{arrivalCode\}/);
  });
});

describe('identity handshake — CPO enters the arrival code', () => {
  const screen = strip(read('screens/cpo/AssignedMissionDetailScreen.tsx'));

  it('submits the typed code through agentApi.verifyArrival', () => {
    expect(screen).toMatch(/agentApi\.verifyArrival\(missionId,\s*code\)/);
  });

  it('has a synchronous double-tap guard on the mutation (NAV_RAPID_USE_LOOP)', () => {
    expect(screen).toMatch(/verifyGuard\.current/);
  });

  it('handles the mismatch and lead_only failure states', () => {
    expect(screen).toMatch(/verify_code_mismatch/);
    expect(screen).toMatch(/lead_only/);
  });

  it('the verified latch is MISSION-scoped — a new active mission resets it (critic F1)', () => {
    // This screen is a persistent tab. A component-scoped OR-latch carried mission
    // A's verified into mission B, hid B's entry input, and (flag on) blocked B's
    // escrow. The latch must key on the mission id: hold for the SAME mission
    // (lagging poll can't un-verify), reset for a DIFFERENT one.
    expect(screen).toMatch(/verifiedMission !== null && verifiedMission === missionId/);
    expect(screen).toMatch(/setVerifiedMission\(v =>\s*am\.identity_verified \? am\.mission_id\s*:\s*\(v === am\.mission_id \? v : null\)\)/);
    // The buggy global boolean latch must not come back.
    expect(screen).not.toMatch(/setVerified\(v => v \|\|/);
  });
});
