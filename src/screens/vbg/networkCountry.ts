import {NativeModules} from 'react-native';

/**
 * Physical country from the mobile radio — see BravoNetworkCountryModule.kt.
 *
 *  • `network` — the country of the operator the handset is CAMPED ON (the cell
 *    tower's MCC). Current, correct while roaming, permission-free, and
 *    **immune to a VPN**: no IP geolocation is involved.
 *  • `sim` — the SIM's HOME country. A German SIM roaming in Dubai still reads
 *    DE, so callers must rank it below the serving network and below GPS.
 *
 * iOS resolves both to null on purpose: `CTCarrier.isoCountryCode` is deprecated
 * and returns "--" on iOS 16+, so there is nothing honest to read. iOS therefore
 * relies on the GPS lane, and only degrades to the locale guess when location is
 * unavailable — the same as an Android device with no SIM.
 *
 * Never throws and never rejects: an emergency surface must not depend on this.
 */
export interface RadioCountry {
  /** ISO-3166 alpha-2 of the serving network, or null. */
  network: string | null;
  /** ISO-3166 alpha-2 of the SIM's home country, or null. */
  sim: string | null;
}

const EMPTY: RadioCountry = {network: null, sim: null};

/** Guard against "", "--", lower-case, and any non-alpha-2 the platform returns. */
function normalise(raw: unknown): string | null {
  if (typeof raw !== 'string') {return null;}
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

export async function getRadioCountry(): Promise<RadioCountry> {
  try {
    const mod = NativeModules.BravoNetworkCountry;
    if (!mod?.getCountry) {return EMPTY;}
    const res = (await mod.getCountry()) as Partial<RadioCountry> | null | undefined;
    return {network: normalise(res?.network), sim: normalise(res?.sim)};
  } catch {
    // Module absent (iOS, an older build) or the bridge call failed — the
    // resolver simply moves to the next source.
    return EMPTY;
  }
}
