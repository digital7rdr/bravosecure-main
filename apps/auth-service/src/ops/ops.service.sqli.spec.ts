/**
 * Audit fix 0.2 — regression test that the `region` filter in
 * `OpsService.dashboard()` is bound-parameterized, NOT interpolated.
 *
 * The original implementation built `AND region_code = '<input>'` by
 * concatenating the param after a naive `replace(/'/g, '')` strip; any
 * payload that survives the single-quote scrub (hex escapes, comment
 * markers, unicode tricks) would land inside the SQL text. The fix
 * pushes `region` onto the params array and references it via $N.
 *
 * This spec asserts that an attempted injection payload:
 *   1. NEVER appears inside the SQL string passed to `db.qOne`,
 *   2. ALWAYS shows up as a literal bind parameter, and
 *   3. exits cleanly (no thrown ParseError) with an empty-ish KPI shape.
 */
import {OpsService} from './ops.service';

const PAYLOAD = `AE'; DROP TABLE users;--`;

function makeStubs() {
  const qOne = jest.fn().mockResolvedValue(null);
  const q    = jest.fn().mockResolvedValue([]);
  const db = {q, qOne} as never;
  const audit = {
    recentFeed: jest.fn().mockResolvedValue([]),
    emit:       jest.fn().mockResolvedValue(undefined),
  } as never;
  return {db, audit, qOne};
}

describe('OpsService.dashboard — SQLi regression', () => {
  it('binds the region payload as $N and never inlines it into the SQL string', async () => {
    const {db, audit, qOne} = makeStubs();
    const svc = new OpsService(
      db,
      {} as never,  {} as never,  {} as never, {} as never,
      audit, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      // BookingPushBridge stub — dispatch fan-outs are fire-and-forget.
      {bookingApproved: async () => {}, agentDecided: async () => {},
       missionDispatched: async () => {}, missionAborted: async () => {},
       payoutSettled: async () => {}, sosAlert: async () => {}} as never,
    );

    await svc.dashboard(PAYLOAD);

    expect(qOne).toHaveBeenCalledTimes(1);
    const [sql, params] = qOne.mock.calls[0];

    // The injection payload must NOT be in the SQL text — neither raw nor
    // single-quote-stripped — because that would mean it reached the
    // parser as code instead of a bound value.
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain(`'AE`);
    expect(sql).not.toContain(PAYLOAD);
    expect(sql).not.toContain(PAYLOAD.replace(/'/g, ''));

    // It MUST appear verbatim in the params array, bound as $1.
    expect(params).toEqual([PAYLOAD]);
    expect(sql).toMatch(/AND region_code = \$1/);
  });

  it('omits the region clause entirely when no region is provided', async () => {
    const {db, audit, qOne} = makeStubs();
    const svc = new OpsService(
      db,
      {} as never,  {} as never,  {} as never, {} as never,
      audit, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      // BookingPushBridge stub — dispatch fan-outs are fire-and-forget.
      {bookingApproved: async () => {}, agentDecided: async () => {},
       missionDispatched: async () => {}, missionAborted: async () => {},
       payoutSettled: async () => {}, sosAlert: async () => {}} as never,
    );

    await svc.dashboard();

    const [sql, params] = qOne.mock.calls[0];
    expect(params).toEqual([]);
    expect(sql).not.toContain('region_code = $');
  });
});
