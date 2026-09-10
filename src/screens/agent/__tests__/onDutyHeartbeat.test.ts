/**
 * On-duty location heartbeat (BUILD_RUNBOOK Step 5). Pure controller logic:
 * timer-driven location push gated on DUTY (not mission), idempotent start/stop,
 * and the `isLocatable` staleness helper. Native deps are mocked.
 */
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: jest.fn()},
}));
jest.mock('../../../services/api', () => ({
  agentApi: {updateLocation: jest.fn()},
}));

import Geolocation from 'react-native-geolocation-service';
import {agentApi} from '../../../services/api';
import {
  startOnDutyHeartbeat, stopOnDutyHeartbeat, isHeartbeatRunning,
  getLastPushAt, isLocatable, LOCATION_FRESH_MINUTES,
} from '../../../services/onDutyHeartbeat';

const mockGetPos = (Geolocation as unknown as {getCurrentPosition: jest.Mock}).getCurrentPosition;
const mockUpdate = agentApi.updateLocation as jest.Mock;

// Let the pushOnce() await-chain (getFix -> updateLocation) settle.
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); } };

function grantFix(lat = 25.2, lng = 55.3) {
  // Step 23 — the fix carries quality (accuracy m, speed m/s, Android mocked flag) which
  // the heartbeat forwards to the server for plausibility/mock gating.
  mockGetPos.mockImplementation((success: (p: {coords: {latitude: number; longitude: number; accuracy?: number; speed?: number}; mocked?: boolean}) => void) =>
    success({coords: {latitude: lat, longitude: lng, accuracy: 12, speed: 5}, mocked: false}));
}

describe('onDutyHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
    grantFix();
  });
  afterEach(() => {
    stopOnDutyHeartbeat();
    jest.useRealTimers();
  });

  describe('isLocatable', () => {
    it('false off-duty / no-fix / stale; true when fresh', () => {
      const now = 1_700_000_000_000;
      expect(isLocatable(false, now, now)).toBe(false);
      expect(isLocatable(true, null, now)).toBe(false);
      expect(isLocatable(true, now - (LOCATION_FRESH_MINUTES * 60_000 + 1), now)).toBe(false);
      expect(isLocatable(true, now - 60_000, now)).toBe(true);
    });
  });

  it('pushes an immediate fix on start, then once per interval', async () => {
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // speed 5 m/s → 18 km/h; mocked:false → is_mocked undefined (only forwarded when true).
    expect(mockUpdate).toHaveBeenCalledWith(25.2, 55.3, {accuracy_m: 12, speed_kph: 18, is_mocked: undefined});

    jest.advanceTimersByTime(45_000);
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(45_000);
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });

  it('stop() halts further pushes', async () => {
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    stopOnDutyHeartbeat();
    expect(isHeartbeatRunning()).toBe(false);
    jest.advanceTimersByTime(45_000 * 3);
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a double start does not spawn a second timer', async () => {
    startOnDutyHeartbeat();
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(45_000);
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('reports on duty with NO active mission (the LB16 fix)', async () => {
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).toHaveBeenCalled();
    expect(isHeartbeatRunning()).toBe(true);
  });

  it('records lastPushAt and invokes onPush on a successful push', async () => {
    const onPush = jest.fn();
    startOnDutyHeartbeat({onPush});
    await flush();
    expect(getLastPushAt()).not.toBeNull();
    expect(onPush).toHaveBeenCalledWith(getLastPushAt());
  });

  it('does not push (and keeps running) when no fix is available', async () => {
    mockGetPos.mockImplementation((_s: unknown, error: () => void) => error());
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(isHeartbeatRunning()).toBe(true);
  });

  it('keeps running with no phantom fix when updateLocation rejects, then recovers next tick', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('net'));
    startOnDutyHeartbeat();
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(isHeartbeatRunning()).toBe(true);
    expect(getLastPushAt()).toBeNull();          // a failed push must record no fix

    jest.advanceTimersByTime(45_000);            // next tick — updateLocation resolves (beforeEach default)
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(getLastPushAt()).not.toBeNull();
  });
});
