/**
 * B-251 — which audio device a call should start on.
 *
 * THE BUG. Both call screens discovered devices twice, and only one of the two
 * paths made a decision:
 *
 *   - `onAudioDeviceChanged` (a TRANSITION event) → auto-snapped to a headset
 *     the moment one appeared. This is the "plug in mid-call" path.
 *   - `getAudioDeviceList()` on mount (the SEED) → populated the picker list
 *     and stopped there.
 *
 * A headset that was ALREADY connected when the call started produces no
 * transition, so the seed was the only path that ran — and it decided nothing.
 * The media-type default then won: SPEAKER_PHONE for video, EARPIECE for voice.
 * Answering a call with Bluetooth headphones on played the caller through the
 * LOUDSPEAKER, which is both wrong and, in public, a privacy leak.
 *
 * The decision lives here, once, because it was already duplicated across
 * CallScreen and GroupCallScreen — and a behaviour with two hand-copied
 * implementations is exactly how the unwatched copy drifts (this repo's
 * recurring root cause). Each screen still APPLIES the route through its own
 * primitive: CallScreen's `pickAudioRouteNative` carries a de-dupe guard that
 * exists to stop Bluetooth SCO from flapping (BS-CALL-CHOPPY), and routing
 * around it would resurrect that.
 */

export type AudioRoute = 'BLUETOOTH' | 'SPEAKER_PHONE' | 'EARPIECE' | 'WIRED_HEADSET';

const VALID: readonly AudioRoute[] = ['BLUETOOTH', 'SPEAKER_PHONE', 'EARPIECE', 'WIRED_HEADSET'];

export function isAudioRoute(v: unknown): v is AudioRoute {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v);
}

/**
 * Parse the native `getAudioDeviceList()` payload — a JSON array string on
 * Android, absent on iOS. Never throws: a malformed or missing list is simply
 * "no devices known", which leaves the caller on its media-type default.
 */
export function parseAudioDeviceList(raw: unknown): AudioRoute[] {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAudioRoute) : [];
  } catch {
    return [];
  }
}

/**
 * The headset a call should prefer over its media-type default, or null when
 * none is attached.
 *
 * Wired beats Bluetooth: plugging a cable in is a deliberate act, while a
 * Bluetooth device merely being in range is not. This is the same precedence
 * the mid-call transition path already applies — the point of this function is
 * that mount and mid-call now agree instead of diverging.
 */
export function preferredHeadset(devices: readonly AudioRoute[]): AudioRoute | null {
  if (devices.includes('WIRED_HEADSET')) {
    return 'WIRED_HEADSET';
  }
  if (devices.includes('BLUETOOTH')) {
    return 'BLUETOOTH';
  }
  return null;
}

/**
 * The route a call should OPEN on, given what is attached and what kind of
 * call it is. Returns null when the caller should keep whatever it already
 * decided — used so an explicit user preference is never overridden.
 */
export function initialCallRoute(
  devices: readonly AudioRoute[],
  opts: {isVideo: boolean; hasExplicitPreference?: boolean},
): AudioRoute | null {
  if (opts.hasExplicitPreference === true) {
    return null;
  }
  return preferredHeadset(devices) ?? (opts.isVideo ? 'SPEAKER_PHONE' : 'EARPIECE');
}

/**
 * B-309 — the opening-route settle: decide the call's first route from the
 * ENUMERATED device set instead of applying a blind media-type default.
 *
 * Applying the default against the not-yet-populated device list is what made
 * every call with a headset attached audibly open on the LOUDSPEAKER and jump
 * into the headset ~1 s later (device log 15:46:28.709 → :29.178). Industry
 * routing (Android Telecom, WebRTC's AppRTCAudioManager) picks the opening
 * device once enumeration answers.
 *
 * Contract (pinned in openingRouteSettle.test.ts):
 *  - first device list WITH a headset → stay silent; the screens' existing
 *    auto-snap owns that case (double-applying would flap BT SCO);
 *  - first device list WITHOUT a headset → apply the media default now;
 *  - no event inside `timeoutMs` → apply the default (iOS has no enumerator);
 *  - exactly-once, cancellable.
 *
 * Deferral is safe with no headset because audio only flows at CONNECTED,
 * which is far beyond the settle window in practice — the user hears no
 * difference; the headset case simply stops blipping.
 */
export function createOpeningRouteSettle(opts: {
  applyDefault: () => void;
  timeoutMs?: number;
}): {onFirstDeviceList: (devices: readonly AudioRoute[]) => void; cancel: () => void} {
  let settled = false;
  const settle = (apply: boolean): void => {
    if (settled) {return;}
    settled = true;
    clearTimeout(timer);
    if (apply) {opts.applyDefault();}
  };
  const timer = setTimeout(() => settle(true), opts.timeoutMs ?? 1200);
  return {
    onFirstDeviceList: (devices) => settle(preferredHeadset(devices) === null),
    cancel: () => settle(false),
  };
}

/**
 * B-236u — queue-and-apply for explicit route picks made while the native
 * route manager still reports `available []`.
 *
 * For the first ~11 s of a call the device list can be empty, and the native
 * `selectAudioDevice` neither queues nor retries — every tap in that window
 * was dropped with `Can not select SPEAKER_PHONE from available []` (three
 * on-device repros; taps at 18:24:13.5/.9/:16.6/:19.3 all lost, list only
 * populating at 18:24:24.489).
 *
 * `pick` is the single entry for an explicit user choice: it applies the
 * route now when the last-seen list can honour it, otherwise it REMEMBERS the
 * pick and applies it on the first device-list event that can — a list that
 * contains the route, or, for the built-in routes (SPEAKER_PHONE / EARPIECE),
 * the first non-empty list: a live enumerator is enough for routes every
 * phone has, and parking them until literally listed would be a second dead
 * toggle on devices that omit one.
 *
 * Contract (pinned in routePickQueue.test.ts):
 *  - the queued pick survives until applied or `clear()` at call end;
 *  - a newer explicit pick supersedes it;
 *  - a pick that lands clears it — it never overrides a later success;
 *  - applies exactly once (re-issuing on every event would flap BT SCO —
 *    BS-CALL-CHOPPY);
 *  - it extends the sticky-explicit-pick rule, so callers cancel the B-309
 *    opening settle on pick: an explicit choice beats the default settle.
 */
export function createRoutePickQueue(opts: {apply: (route: AudioRoute) => void}): {
  pick: (route: AudioRoute) => boolean;
  onDeviceList: (devices: readonly AudioRoute[]) => void;
  pending: () => AudioRoute | null;
  clear: () => void;
} {
  let queued: AudioRoute | null = null;
  let lastList: readonly AudioRoute[] = [];
  const canApply = (route: AudioRoute, list: readonly AudioRoute[]): boolean =>
    list.includes(route) ||
    (list.length > 0 && (route === 'SPEAKER_PHONE' || route === 'EARPIECE'));
  return {
    pick: (route) => {
      if (canApply(route, lastList)) {
        queued = null;
        opts.apply(route);
        return true;
      }
      queued = route;
      return false;
    },
    onDeviceList: (devices) => {
      lastList = [...devices];
      if (queued !== null && canApply(queued, devices)) {
        const route = queued;
        // Why: cleared BEFORE apply — chooseAudioRoute can synchronously emit
        // another device event, and a still-set queue would apply twice.
        queued = null;
        opts.apply(route);
      }
    },
    pending: () => queued,
    clear: () => {
      queued = null;
      lastList = [];
    },
  };
}
