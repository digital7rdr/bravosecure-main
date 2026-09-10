/**
 * Channels vs2 item 4 — WHICH organisation is this request about?
 *
 * Once a person can belong to several organisations, every server site that
 * used to answer "their org" has to answer "the one they are looking at". The
 * client says which via a header; this module is the only place that reads it.
 *
 * ⚠️ THE HEADER IS A REQUEST, NEVER A GRANT.
 *
 * It NARROWS the caller's real memberships. It can never add one. Every caller
 * of `pickOrgContext` passes the rows it already fetched for that user, and an
 * id that is not among them is refused. Treating the header as authoritative —
 * even once, even on a route that "only reads" — would turn one line of client
 * code into cross-tenant access.
 *
 * Absent or unparseable header = the previous behaviour, unchanged: the first
 * candidate wins. That keeps every existing caller and every older app build
 * working, and means this feature cannot break a client that has not learned
 * about it.
 */
export const ORG_CONTEXT_HEADER = 'x-org-context';

/** The raw asked-for org id, or null. Never trusted on its own. */
export function readOrgContextHeader(req: {headers?: Record<string, unknown>}): string | null {
  const raw = req?.headers?.[ORG_CONTEXT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {return null;}
  const trimmed = value.trim();
  // A REAL uuid pattern. `[0-9a-f-]{36}` also matched 36 dashes and any
  // arrangement of hyphens. It does not reach SQL today — it is only
  // JS-compared against rows we fetched — but a loose check plus a comment
  // claiming it is SQL-safe is the licence the next caller takes, and on a
  // uuid column a malformed value is a 22P02 → uncaught 500 that anyone who
  // can set a header could trigger.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {return null;}
  return trimmed;
}

/**
 * Choose which of the caller's OWN memberships the request is about.
 *
 * @param candidates the caller's real rows, already fetched and already
 *                   filtered to what they are allowed to use on this route
 * @param requested  the header value, or null
 *
 * Returns the requested candidate when it is genuinely theirs; otherwise the
 * first — which is exactly what the code did before multi-org existed.
 *
 * DELIBERATELY SILENT on a mismatch rather than throwing. A stale header is
 * ordinary: the app switches workspace, an in-flight request carries the old
 * id, a push tap arrives with none. Failing those would turn a race into an
 * error the user cannot act on, while falling back to their own default org is
 * both safe (it is still their data) and what they saw a moment ago.
 */
export function pickOrgContext<T extends {org_user_id: string}>(
  candidates: readonly T[],
  requested: string | null,
): T | null {
  if (candidates.length === 0) {return null;}
  if (!requested) {return candidates[0];}
  return candidates.find(c => c.org_user_id === requested) ?? candidates[0];
}

/**
 * The same choice, for a WRITE — where the silent fallback above is wrong.
 *
 * "No header" still falls back: that is every request from a cold start, every
 * route the client does not stamp, and every older build, and refusing those
 * was the mistake that 403'd Accept Offer.
 *
 * "Header present, names nothing I hold" is a different fact and the fallback
 * is unsafe there. Dana is inside Borealis and taps Save; between the GET and
 * the PATCH the Borealis admin removes her. Borealis leaves her candidate list,
 * the fallback picks ACME, and Acme's settings are overwritten with Borealis's
 * — 200, and an audit row naming Acme as her intent. The client cannot catch it
 * either: the reconcile has usually unmounted the sheet before the response
 * lands.
 *
 * Nothing that fails to send a header can reach this, so it costs the dispatch
 * lanes nothing.
 */
export function pickOrgContextForWrite<T extends {org_user_id: string}>(
  candidates: readonly T[],
  requested: string | null,
): {row: T | null; refused: boolean} {
  if (requested && candidates.length > 0 && !candidates.some(c => c.org_user_id === requested)) {
    return {row: null, refused: true};
  }
  return {row: pickOrgContext(candidates, requested), refused: false};
}

/**
 * THE org display-name rule, as SQL — one copy, because this repo's most common
 * bug is one behaviour with N drifted copies, and this particular rule has
 * already regressed once.
 *
 * `org_workspaces.name` FIRST. `users.display_name` for an org id is the OWNER'S
 * PERSONAL NAME — "QA Owner", a human being — so selecting it directly showed
 * every employee their founder's name in place of their company's, and leaked a
 * personal name to the whole staff. Agencies have no `org_workspaces` row, so
 * they legitimately fall through to the display name, which for a company agent
 * IS the company.
 *
 * @param orgIdExpr the SQL expression holding the org's user id (e.g. `ses.org_user_id`)
 * @param p         alias prefix, so a query can join this twice without collision
 */
export function orgNameJoin(orgIdExpr: string, p = 'onm'): string {
  return `LEFT JOIN public.users ${p}_u ON ${p}_u.id = ${orgIdExpr}
          LEFT JOIN public.org_workspaces ${p}_w ON ${p}_w.owner_user_id = ${orgIdExpr}`;
}

/** The matching SELECT expression. Use the same prefix as the join. */
export function orgNameExpr(p = 'onm'): string {
  return `COALESCE(${p}_w.name, ${p}_u.display_name)`;
}
