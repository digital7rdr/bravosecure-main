import {NotificationsService} from './notifications.service';
import type {DatabaseService} from '../database/database.service';

/**
 * B-706 (NOTIFICATION_ACTIVITY_AUDIT_2026-08-30) — the server half of "I delete the
 * notification, again it came back."
 *
 * A-3  There was NO delete surface at all. The app's "Clear" was a local zustand wipe, so
 *      the server never learned of it and the next sync handed the whole inbox back.
 * A-2  `created_at` is a microsecond column, but node-postgres parses it into a JS `Date`
 *      (milliseconds only) and the controller emits `.toISOString()` — 3 fractional
 *      digits. The client echoes that back as `since`, so `created_at > $since` matched
 *      the newest row against its own truncated cursor and re-delivered it on EVERY sync.
 *      Measured live: 500 of 500 rows. The column is now ms-truncated (migration
 *      20260830120000) and the comparison is `>=`, which over-returns the boundary row —
 *      absorbed for free by the client's id dedupe — rather than SKIPPING a row that
 *      shares the boundary millisecond, which a strict `>` on a truncated column does.
 */
function mk() {
  const q = jest.fn().mockResolvedValue([]);
  const svc = new NotificationsService({q} as unknown as DatabaseService);
  return {svc, q};
}
const sql = (q: jest.Mock, i = 0) => String((q.mock.calls[i] as unknown[])[0]).replace(/\s+/g, ' ');
const args = (q: jest.Mock, i = 0) => (q.mock.calls[i] as unknown[])[1] as unknown[];

describe('B-706 A-3 — dismissal is durable and recipient-scoped', () => {
  it('list() hides dismissed rows — this is what makes Clear stick', async () => {
    const {svc, q} = mk();
    await svc.list('u1');
    expect(sql(q)).toMatch(/WHERE user_id = \$1 AND dismissed_at IS NULL/);
  });

  it('dismiss() stamps only THIS user\'s rows, and is idempotent', async () => {
    const {svc, q} = mk();
    const id = '11111111-2222-3333-4444-555555555555';
    await svc.dismiss('u1', [id]);
    const s = sql(q);
    expect(s).toMatch(/UPDATE public\.notifications SET dismissed_at = now\(\)/);
    expect(s).toMatch(/WHERE user_id = \$1/);          // never an unscoped id lookup
    expect(s).toMatch(/dismissed_at IS NULL/);          // re-dismiss is a no-op
    expect(args(q)).toEqual(['u1', [id]]);
  });

  it('dismissAll() is scoped to the caller', async () => {
    const {svc, q} = mk();
    await svc.dismissAll('u1');
    expect(sql(q)).toMatch(/WHERE user_id = \$1 AND dismissed_at IS NULL/);
    expect(args(q)).toEqual(['u1']);
  });

  it('rejects ids that are not uuids rather than passing them to ::uuid[]', async () => {
    const {svc, q} = mk();
    await svc.dismiss('u1', ['not-a-uuid', '../../etc/passwd']);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('B-706 A-2 — the watermark comparison cannot skip or loop', () => {
  it('uses >= so a row sharing the boundary millisecond is not skipped', async () => {
    const {svc, q} = mk();
    await svc.list('u1', {sinceIso: '2026-08-25T11:16:02.090Z'});
    const s = sql(q);
    expect(s).toMatch(/created_at >= \$2/);
    // A strict `>` on the now-truncated column loses same-ms siblings permanently.
    expect(s).not.toMatch(/created_at > \$/);
  });

  it('still scopes and orders correctly with a cursor', async () => {
    const {svc, q} = mk();
    await svc.list('u1', {sinceIso: '2026-08-25T11:16:02.090Z', limit: 100});
    expect(sql(q)).toMatch(/ORDER BY created_at DESC LIMIT \$3/);
    expect(args(q)).toEqual(['u1', '2026-08-25T11:16:02.090Z', 100]);
  });
});

describe('B-706 A-12 — a malformed limit must not blank the feed', () => {
  it('coerces a NaN limit to the default instead of emitting LIMIT NaN', async () => {
    const {svc, q} = mk();
    // `?limit=abc` → Number('abc') → NaN reached `LIMIT $n`, raised 22P02, and the
    // service's catch turned that into an empty feed behind a 200 — indistinguishable
    // from "nothing new".
    await svc.list('u1', {limit: Number('abc')});
    const bound = args(q).at(-1);
    expect(Number.isFinite(bound as number)).toBe(true);
    expect(bound).toBe(50);
  });

  it('clamps an out-of-range limit', async () => {
    const {svc, q} = mk();
    await svc.list('u1', {limit: 99999});
    expect(args(q).at(-1)).toBe(200);
  });
});
