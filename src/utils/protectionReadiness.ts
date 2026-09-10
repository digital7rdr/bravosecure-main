/**
 * Mission-start readiness — the pure half (founder 2026-08-11).
 *
 * A protection session may only go live when BOTH the protected customer and
 * the assigned CPO hold real device capability. This module holds the platform
 * -agnostic logic — what the OS answers mean, and how to say it to a human — so
 * it can be unit-tested without mounting React Native.
 *
 * The rule that keeps this honest: a rendered map is NOT evidence. Readiness
 * requires a position we actually obtained.
 */

/** The five things a device must have. Mirrors the server's readiness columns. */
export interface ReadinessFlags {
  location_permission: boolean;
  location_services: boolean;
  precise_location: boolean;
  connectivity: boolean;
  location_available: boolean;
}

export type ReadinessRequirement = keyof ReadinessFlags;

export const ALL_REQUIREMENTS: ReadinessRequirement[] = [
  'location_permission', 'location_services', 'precise_location',
  'connectivity', 'location_available',
];

export const NOT_READY: ReadinessFlags = {
  location_permission: false, location_services: false, precise_location: false,
  connectivity: false, location_available: false,
};

/** What the user is told is missing, in the order they should fix it. */
const LABELS: Record<ReadinessRequirement, string> = {
  location_permission: 'Location permission',
  location_services: 'Location Services',
  precise_location: 'Precise Location',
  connectivity: 'Internet connection',
  location_available: 'Current location',
};

const HINTS: Record<ReadinessRequirement, string> = {
  location_permission: 'Allow location access for Bravo Secure.',
  location_services: 'Turn on Location Services on this device.',
  precise_location: 'Switch location accuracy from approximate to precise.',
  connectivity: 'Reconnect to mobile data or Wi-Fi.',
  location_available: 'We could not get a position yet — move somewhere with a clearer signal.',
};

export function requirementLabel(r: ReadinessRequirement): string {
  return LABELS[r] ?? r;
}

export function requirementHint(r: ReadinessRequirement): string {
  return HINTS[r] ?? '';
}

/** Everything that is still false, in fix order. */
export function missingRequirements(f: ReadinessFlags): ReadinessRequirement[] {
  return ALL_REQUIREMENTS.filter(r => !f[r]);
}

export function isReady(f: ReadinessFlags): boolean {
  return missingRequirements(f).length === 0;
}

/**
 * Geolocation error codes, mapped to what they prove. `react-native-geolocation
 * -service` reports 1=denied, 2=position unavailable (no provider — i.e. the OS
 * location switch is off), 3=timeout, 5=Android settings not satisfied.
 *
 * A timeout means services are on and permitted but we have no fix YET: that
 * blocks `location_available` WITHOUT falsely claiming the switch is off.
 */
export function applyLocationError(
  base: ReadinessFlags, code: number | undefined,
): ReadinessFlags {
  switch (code) {
    case 1:
      return {...base, location_permission: false, precise_location: false, location_available: false};
    case 2:
    case 5:
      return {...base, location_services: false, location_available: false};
    default:
      // 3 (timeout) and anything unrecognised: no fix, nothing else disproven.
      return {...base, location_available: false};
  }
}

/**
 * Which side is blocking, phrased for the OTHER participant. Ops and both apps
 * show this so nobody is left guessing why a mission has not started.
 */
export function blockedByText(blockedBy: string[]): string {
  const cpo = blockedBy.includes('cpo');
  const customer = blockedBy.includes('customer');
  if (cpo && customer) {return 'Both you and your officer still need to finish setup.';}
  if (cpo) {return 'Waiting for your officer to enable location access.';}
  if (customer) {return 'Waiting for the member to enable location access.';}
  return '';
}
