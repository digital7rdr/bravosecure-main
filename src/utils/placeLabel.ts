/**
 * Short, human place names for map pins and route timelines.
 *
 * Bookings store a full formatted address — in the UAE typically
 * "شارع العريف, Al Raha, Abu Dhabi, Abu Dhabi, United Arab Emirates". Rendering
 * that verbatim is what put wide black bars across the founder's map and
 * repeated the same line on every row of the route timeline.
 *
 * The rule: keep the most specific part that a person would actually say, drop
 * the administrative tail (emirate, country) and the duplicate levels Mapbox
 * emits, and cap the length. Pure so the real UAE strings can be unit-tested.
 */

/** Administrative tails that never help identify a pickup or drop-off. */
const DROPPABLE = [
  'united arab emirates',
  'uae',
  'saudi arabia',
  'qatar',
  'kuwait',
  'bahrain',
  'oman',
];

/** True when the string has no Latin letters at all (e.g. an Arabic-only street). */
export function isNonLatin(s: string): boolean {
  return s.trim().length > 0 && !/[A-Za-z]/.test(s);
}

/**
 * The display name for an address.
 *
 * @param address the stored formatted address
 * @param maxLen  hard cap; the result is ellipsised beyond it
 */
export function shortPlaceLabel(address: string | null | undefined, maxLen = 24): string {
  const raw = (address ?? '').trim();
  if (!raw) {
    return '';
  }

  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }

  // Drop administrative tails and the repeated levels Mapbox emits
  // ("Abu Dhabi, Abu Dhabi").
  const kept: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (DROPPABLE.includes(lower)) {
      continue;
    }
    if (kept.length > 0 && kept[kept.length - 1].toLowerCase() === lower) {
      continue;
    }
    kept.push(part);
  }
  if (kept.length === 0) {
    return clamp(parts[0], maxLen);
  }

  // Prefer the most specific component the reader can actually use. An
  // Arabic-only street in an otherwise English interface is noise, so fall
  // through to the next component when one exists.
  const first = kept[0];
  const head = isNonLatin(first) && kept.length > 1 ? kept[1] : first;
  return clamp(head, maxLen);
}

/**
 * "Al Raha · Abu Dhabi" — a slightly richer form for a single prominent label
 * (a destination header), still bounded. Falls back to the short label when
 * there is only one usable component.
 */
export function placeWithContext(address: string | null | undefined, maxLen = 34): string {
  const raw = (address ?? '').trim();
  if (!raw) {
    return '';
  }
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean)
    .filter(p => !DROPPABLE.includes(p.toLowerCase()));
  const latin = parts.filter(p => !isNonLatin(p));
  const usable = latin.length > 0 ? latin : parts;
  const deduped = usable.filter((p, i) => i === 0 || p.toLowerCase() !== usable[i - 1].toLowerCase());
  if (deduped.length === 0) {
    return '';
  }
  if (deduped.length === 1) {
    return clamp(deduped[0], maxLen);
  }
  return clamp(`${deduped[0]} · ${deduped[1]}`, maxLen);
}

function clamp(s: string, maxLen: number): string {
  const t = s.trim();
  if (t.length <= maxLen) {
    return t;
  }
  // Cut on a word boundary when one is close to the cap, so we do not end
  // mid-word the way the fixed-width cells used to.
  const cut = t.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
