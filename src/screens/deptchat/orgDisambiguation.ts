/**
 * Channels vs2 edge A7 — TWO ORGANISATIONS WITH THE SAME NAME.
 *
 * The Workspace Hub tiles, the invite picker's stage 1, and Manage Channels'
 * stage 1 all render an organisation as its `name` and nothing else. Names
 * carry no uniqueness constraint anywhere — that fact is load-bearing elsewhere
 * (the Rev-7 security argument hinged on it) — so a person who belongs to two
 * organisations called "Acme" sees two identical rows and picks by coin flip.
 * On the hub that decides which company's data the whole Departmental surface
 * then reads and writes.
 *
 * ── WHY THIS IS A PURE RULE AND NOT A RENDERER ───────────────────────────
 *
 * The review prescribed putting it in "the shared grouping helper so all three
 * surfaces get it at once". They do NOT share one: the hub reads
 * `user.workspaces` from the auth store, while the other two go through
 * `topLevelOf`. A helper in `organisationTree` would have covered two of the
 * three and looked finished.
 *
 * So the DECISION lives here, once, and each surface renders it in its own
 * idiom (the hub already has a role line, Manage Channels already has a channel
 * count). What must never be copied is the rule for WHEN to disambiguate.
 *
 * ── WHY ONLY ON A COLLISION ──────────────────────────────────────────────
 *
 * Appending an id to every row would be noise on the overwhelmingly common
 * single-org case, and noise is how people stop reading a line that matters.
 */

/**
 * The display names that appear MORE THAN ONCE in this list.
 *
 * Trimmed and case-folded, because "Acme" and "acme " are the same name to the
 * person choosing between them — which is the entire failure being fixed.
 * Blank names collapse together too: they are indistinguishable by definition,
 * so they are exactly the case that needs the extra line.
 */
export function collidingOrgNames(names: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    if (seen.has(key)) {twice.add(key);} else {seen.add(key);}
  }
  return twice;
}

/** Does THIS name need a disambiguator, given the collisions in its list? */
export function needsOrgDisambiguator(name: string, colliding: ReadonlySet<string>): boolean {
  return colliding.has(name.trim().toLowerCase());
}

/**
 * A short handle that tells two identically-named rows apart WITHIN ONE LIST.
 *
 * The TAIL of the uuid, not the head: `gen_random_uuid()` is uniform, but the
 * last block is the part people actually scan. Rendered only on a collision, so
 * it is never gratuitous.
 *
 * ⚠️ NOT A CROSS-SURFACE IDENTIFIER, and do not turn it into one. Each caller
 * feeds it a different id space: the hub passes a WORKSPACE org id, while
 * Manage Channels and the invite picker pass a level-0 `department_channels`
 * row id. So one company legitimately reads as a different handle on the hub
 * than it does on the manage dashboard — and their collision DOMAINS differ
 * too, since one workspace can hold several root channels. It disambiguates a
 * list; it does not name a company.
 */
export function shortOrgRef(id: string): string {
  const tail = id.replace(/-/g, '').slice(-4).toUpperCase();
  return tail ? `ID ${tail}` : '';
}

/**
 * The secondary line for one row: the surface's own detail when it has one,
 * then the id handle. Returns null when nothing collides.
 *
 * `detail` is whatever that surface already knows and already shows — the
 * caller's role, a channel count — so the extra line stays informative rather
 * than becoming a bare id.
 */
export function orgDisambiguator(
  name: string,
  id: string,
  colliding: ReadonlySet<string>,
  detail?: string | null,
): string | null {
  if (!needsOrgDisambiguator(name, colliding)) {return null;}
  const ref = shortOrgRef(id);
  const bits = [detail?.trim(), ref].filter((b): b is string => !!b);
  return bits.length ? bits.join(' · ') : null;
}

/** A name the client already holds for an org id — a `user.workspaces` entry,
 *  the primary `org`, the active workspace context. */
export interface OrgNameSource {
  org_id: string;
  name: string;
}

/**
 * B-624 — the header for the `orgId: null` section: rows whose owning
 * organisation the server did not name (it predates `org_id`). Deliberately not
 * "Other organisations" — we do not know that they are other, or that they are
 * more than one.
 */
export const UNATTRIBUTED_ORG_LABEL = 'Other channels';

/**
 * B-624 — a display label per organisation SECTION, given the names this client
 * already holds.
 *
 * `listChannels` answers `org_id` and NOT `org_name` (verified), and widening
 * the wire is a server change this fix does not need: the client is already
 * told the names of every workspace it belongs to. So the label is resolved
 * locally, and the fallback is honest rather than raw — `shortOrgRef`, the same
 * handle the hub and the invite picker already show, instead of a uuid.
 *
 * ⚠️ AN AGENCY-OWNED ORG IS STRUCTURALLY ABSENT from `user.workspaces` (that
 * array is workspace affiliations), so the fallback is a normal state, not an
 * error state. It must never render as a blank header — an unnamed section is
 * indistinguishable from the flat pile this whole change exists to end.
 *
 * Collisions go through `collidingOrgNames`/`orgDisambiguator` — the existing
 * A7 rule, not a second copy of it. The one refinement: a label that IS already
 * `shortOrgRef(id)` is not re-suffixed with its own handle.
 */
export function orgSectionLabels(
  orgIds: ReadonlyArray<string | null>,
  sources: readonly OrgNameSource[],
): Map<string | null, string> {
  const byId = new Map<string, string>();
  for (const s of sources) {
    const n = s.name?.trim();
    // First source wins: the caller orders them by authority.
    if (n && !byId.has(s.org_id)) {byId.set(s.org_id, n);}
  }
  const base = orgIds.map(id => ({
    id,
    name: id === null ? UNATTRIBUTED_ORG_LABEL : (byId.get(id) ?? shortOrgRef(id)),
  }));
  const colliding = collidingOrgNames(base.map(b => b.name));
  const out = new Map<string | null, string>();
  for (const b of base) {
    const ref = b.id === null ? '' : shortOrgRef(b.id);
    const extra = b.id === null || b.name === ref
      ? null
      : orgDisambiguator(b.name, b.id, colliding);
    out.set(b.id, extra ? `${b.name} · ${extra}` : b.name);
  }
  return out;
}
