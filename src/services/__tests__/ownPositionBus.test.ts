/**
 * ownPositionBus — the driver's own fixes at navigation cadence.
 *
 * What this pins:
 *   - exactly ONE underlying GPS watch no matter how many subscribers (a
 *     second 1 Hz high-accuracy watch is a battery bug, and this repo has
 *     already shipped a duplicate-watcher regression once);
 *   - the watch STOPS when the last subscriber leaves, so a screen that
 *     unmounts cannot leave GPS running for the rest of the session;
 *   - driving cadence, not the 10 s / 25 m telemetry cadence — the whole
 *     reason this module exists;
 *   - iOS' -1 sentinel for course/speed is normalised to null rather than
 *     being rendered as a real bearing of -1 degrees.
 */
import {NativeModules, Platform} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {
  subscribeOwnPosition,
  getLastOwnFix,
  __resetOwnPositionForTest,
} from '../ownPositionBus';

jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {
    watchPosition: jest.fn(() => 42),
    clearWatch: jest.fn(),
    requestAuthorization: jest.fn(async () => 'granted'),
  },
}));

jest.mock('@utils/locationPermission', () => ({
  ensureLiveLocationAccess: jest.fn(async () => 'granted'),
}));

const geo = Geolocation as unknown as {
  watchPosition: jest.Mock;
  clearWatch: jest.Mock;
  requestAuthorization: jest.Mock;
};

/** Let the bus's async permission step settle. */
const settle = () => new Promise<void>(r => setImmediate(r));

const fix = (over: Record<string, unknown> = {}) => ({
  coords: {
    latitude: 25.2,
    longitude: 55.27,
    heading: 90,
    speed: 12,
    accuracy: 5,
    ...over,
  },
  timestamp: 1_700_000_000_000,
});

const startObserving = jest.fn();

beforeEach(() => {
  __resetOwnPositionForTest();
  jest.clearAllMocks();
  Platform.OS = 'android';
  (NativeModules as Record<string, unknown>).RNFusedLocation = {startObserving};
});

describe('ownPositionBus · one shared watch', () => {
  it('starts a single watch for many subscribers', async () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = subscribeOwnPosition(a);
    const offB = subscribeOwnPosition(b);
    await settle();

    expect(geo.watchPosition).toHaveBeenCalledTimes(1);

    // One OS fix fans out to every subscriber.
    geo.watchPosition.mock.calls[0][0](fix());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    offB();
  });

  it('a subscriber arriving AFTER the watch is live does not open a second one', async () => {
    // The `starting` flag only covers arrivals during the permission prompt.
    // A later subscriber reaches start() with starting=false, and without the
    // watchId guard it opens a second 1 Hz watch and overwrites watchId —
    // leaking the first for the rest of the session.
    const offA = subscribeOwnPosition(jest.fn());
    await settle();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);

    const offB = subscribeOwnPosition(jest.fn());
    await settle();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);

    offA();
    offB();
    // Exactly the one watch was cleared, and it is the one we opened.
    expect(geo.clearWatch).toHaveBeenCalledTimes(1);
    expect(geo.clearWatch).toHaveBeenCalledWith(42);
  });

  it('stops the watch only when the LAST subscriber leaves', async () => {
    const offA = subscribeOwnPosition(jest.fn());
    const offB = subscribeOwnPosition(jest.fn());
    await settle();

    offA();
    expect(geo.clearWatch).not.toHaveBeenCalled();
    offB();
    expect(geo.clearWatch).toHaveBeenCalledWith(42);
  });

  it('replays the last known fix to a late subscriber immediately', async () => {
    const off = subscribeOwnPosition(jest.fn());
    await settle();
    geo.watchPosition.mock.calls[0][0](fix());

    const late = jest.fn();
    const offLate = subscribeOwnPosition(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0]).toMatchObject({lat: 25.2, lng: 55.27});

    off();
    offLate();
  });
});

describe('ownPositionBus · cadence', () => {
  it('watches at driving cadence, not the telemetry cadence', async () => {
    const off = subscribeOwnPosition(jest.fn());
    await settle();
    const opts = geo.watchPosition.mock.calls[0][2];
    expect(opts.enableHighAccuracy).toBe(true);
    // 1 Hz. The telemetry streamer uses 10_000 / 25 m; reusing that here is
    // what made the map describe where the vehicle WAS.
    expect(opts.interval).toBe(1000);
    expect(opts.fastestInterval).toBe(1000);
    // A distance filter makes the track-up camera lurch between updates.
    expect(opts.distanceFilter).toBe(0);
    off();
  });
});

describe('ownPositionBus · it OWNS the shared stream cadence', () => {
  it('re-issues its options directly, because watchPosition options are ignored for a second watcher', () => {
    // react-native-geolocation-service calls startObserving(options) ONLY for
    // the first watcher; every later watchPosition inherits that cadence. The
    // agent dashboard runs a 15-30 s watcher during exactly this window, so
    // without the re-issue the driver would navigate on 30-second fixes.
    const off = subscribeOwnPosition(jest.fn());
    return settle().then(() => {
      expect(startObserving).toHaveBeenCalledWith(
        expect.objectContaining({interval: 1000, fastestInterval: 1000, distanceFilter: 0}),
      );
      off();
    });
  });

  it('hands the stream back to ambient cadence when navigation stops', async () => {
    const off = subscribeOwnPosition(jest.fn());
    await settle();
    startObserving.mockClear();

    off();

    expect(startObserving).toHaveBeenCalledWith(
      expect.objectContaining({interval: 5000}),
    );
    // …and the downgrade must be issued BEFORE our listener goes, or there may
    // be no live provider left to retune.
    const retuneOrder = startObserving.mock.invocationCallOrder[0];
    const clearOrder = geo.clearWatch.mock.invocationCallOrder[0];
    expect(retuneOrder).toBeLessThan(clearOrder);
  });

  it('degrades quietly when the native module is absent', async () => {
    delete (NativeModules as Record<string, unknown>).RNFusedLocation;
    const off = subscribeOwnPosition(jest.fn());
    await settle();
    // Still watching — just at whatever cadence the first watcher set.
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(() => off()).not.toThrow();
  });
});

describe('ownPositionBus · fix normalisation', () => {
  it('normalises the iOS -1 sentinel for course and speed to null', async () => {
    const cb = jest.fn();
    const off = subscribeOwnPosition(cb);
    await settle();
    geo.watchPosition.mock.calls[0][0](fix({heading: -1, speed: -1}));

    expect(cb.mock.calls[0][0].headingDeg).toBeNull();
    expect(cb.mock.calls[0][0].speedMps).toBeNull();
    off();
  });

  it('keeps a real course and exposes it as the last fix', async () => {
    const off = subscribeOwnPosition(jest.fn());
    await settle();
    geo.watchPosition.mock.calls[0][0](fix({heading: 271.5}));

    expect(getLastOwnFix()).toMatchObject({headingDeg: 271.5, lat: 25.2, lng: 55.27});
    off();
  });
});

describe('ownPositionBus · permission', () => {
  it('does not start a watch when Android access is refused', async () => {
    const perm = jest.requireMock('@utils/locationPermission') as {
      ensureLiveLocationAccess: jest.Mock;
    };
    perm.ensureLiveLocationAccess.mockResolvedValueOnce('blocked');

    const off = subscribeOwnPosition(jest.fn());
    await settle();

    expect(geo.watchPosition).not.toHaveBeenCalled();
    off();
  });

  it('does not start a watch if everyone unsubscribed during the permission prompt', async () => {
    const off = subscribeOwnPosition(jest.fn());
    off(); // user left the screen while the sheet was up
    await settle();

    expect(geo.watchPosition).not.toHaveBeenCalled();
  });
});
