/**
 * B-289 — the one place a group name is cleaned and bounded.
 *
 * Founder: "group name should be changeable."
 *
 * Pure and separate from `productionRuntime.ts` on purpose: NO test can import
 * that file (it pulls the whole native runtime), and CLAUDE.md is explicit that
 * a green suite is therefore not evidence a change there is safe. Everything
 * about a rename that can be checked without a device lives here.
 *
 * The name travels inside the SIGNED admin action (`rename|<epoch>|<name>`), so
 * it is admin-controlled input that every member's device will render. That is
 * why the rules below are about what a receiver can safely display, not just
 * about what looks tidy in the composer.
 */

/**
 * Generous but bounded. The name lands in a signed payload broadcast per member,
 * and it renders in a single-line header and list row where anything past ~50
 * characters is ellipsised anyway.
 */
export const GROUP_NAME_MAX = 64;

/**
 * Code points a group name may not contain.
 *
 * Written as NUMBERS rather than a regex character class on purpose: every one
 * of these is invisible in an editor and in a diff, so a literal class is
 * unreviewable — you cannot tell by reading it whether it still matches what it
 * claims to. Numeric ranges say exactly what they cover.
 */
function isDisallowedCodePoint(cp: number): boolean {
  if (cp <= 0x1f) {return true;}                    // C0 controls, incl. CR/LF/TAB
  if (cp >= 0x7f && cp <= 0x9f) {return true;}      // DEL + C1 controls
  // Bidirectional marks. NOT cosmetic: an RTL override inside a name can
  // reorder the UI text AROUND it, so an admin could make a group header read
  // as something else entirely on every member's device. That is a spoofing
  // primitive, which is why it is stripped rather than trimmed.
  if (cp === 0x200e || cp === 0x200f) {return true;}       // LRM / RLM
  if (cp >= 0x202a && cp <= 0x202e) {return true;}         // embeddings + overrides
  if (cp >= 0x2066 && cp <= 0x2069) {return true;}         // isolates
  return false;
}

/**
 * Clean a user-typed group name, or return null if it is unusable.
 *
 * - Replaces disallowed code points with a space rather than deleting them, so
 *   "A<RLO>B" cannot silently become the single token "AB".
 * - Collapses whitespace runs, which is what a pasted newline becomes. A group
 *   name is a single-line label.
 * - Trims, because a trailing space is invisible and would make two names that
 *   look identical compare unequal and re-broadcast a pointless rename.
 * - Truncates rather than rejecting, so a long paste is not silently lost.
 */
export function normalizeGroupName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {return null;}
  let stripped = '';
  // for..of iterates by code POINT, so an emoji or any astral character is
  // inspected and copied whole instead of as two lone surrogates.
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    stripped += isDisallowedCodePoint(cp) ? ' ' : ch;
  }
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (!collapsed) {return null;}
  // Slice on code points too: cutting mid-surrogate leaves a lone half that
  // renders as a replacement glyph on every member's device.
  const points = Array.from(collapsed);
  if (points.length <= GROUP_NAME_MAX) {return collapsed;}
  return points.slice(0, GROUP_NAME_MAX).join('').trim();
}

/** Whether a rename is worth signing and broadcasting at all. */
export function isGroupNameChange(
  current: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const clean = normalizeGroupName(next);
  if (!clean) {return false;}
  return clean !== (current ?? '');
}
