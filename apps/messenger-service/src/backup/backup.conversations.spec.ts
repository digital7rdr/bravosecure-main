/**
 * sqa.md bug register — this suite pins: B-178, B-179.
 *
 * Both are SERVER-side halves of the 2026-07-24 backup audit (B-162…B-183) that the
 * client-side suites cannot reach, and neither had a spec: `backup.service.spec.ts`
 * covers only the P0-1 verify protocol.
 *
 * B-178 (P2, data-loss) — `putConversations` wrote
 * `group_state: r.group_state ?? null` into a last-write-wins upsert. The client
 * legitimately mirrors a group conversation with NO group_state — the state is not
 * hydrated yet, or a decrypt-skip during restore dropped it — and that null then
 * ERASED the stored encrypted group master key. The next restore came back with no
 * key for that group: an undecryptable room with intact metadata. The fix splits the
 * upsert so rows without a group_state omit the column entirely, leaving ON CONFLICT
 * to preserve whatever is stored.
 *
 * B-179 (P2, silent truncation) — `getConversations` capped a cursor-less call at
 * 5000 with only a server-side log, and the client never paginated, so an account
 * past the cap silently lost the remainder on restore. The timestamp-only cursor
 * also dropped every row sharing the boundary timestamp (the same class of defect
 * `getMessages` was fixed for); the tuple keyset on
 * (last_message_at, conversation_id) closes it.
 *
 * The Supabase client is a hand-rolled recorder — the same approach
 * `backup.service.spec.ts` takes. We assert the QUERY the service builds, because
 * that is where both bugs live: B-178 is "which columns are in the payload" and
 * B-179 is "which limit and which predicate".
 */
import {ConfigService} from '@nestjs/config';
import {BackupService} from './backup.service';
import type {RedisService} from '../redis/redis.service';

interface UpsertCall {
  table: string;
  payload: Array<Record<string, unknown>>;
  opts: unknown;
}
interface SelectCall {
  table: string;
  columns: string;
  limit: number | null;
  orders: Array<{col: string; opts: unknown}>;
  or: string | null;
  lt: Array<[string, unknown]>;
  eq: Array<[string, unknown]>;
}

function mk(rowsBack: Array<Record<string, unknown>> = []) {
  const upserts: UpsertCall[] = [];
  const selects: SelectCall[] = [];

  const client = {
    from(table: string) {
      return {
        upsert(payload: Array<Record<string, unknown>>, opts: unknown) {
          upserts.push({table, payload, opts});
          return Promise.resolve({error: null});
        },
        select(columns: string) {
          const call: SelectCall = {
            table, columns, limit: null, orders: [], or: null, lt: [], eq: [],
          };
          selects.push(call);
          const q: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) { call.eq.push([col, val]); return chain; },
            order(col: string, opts: unknown) { call.orders.push({col, opts}); return chain; },
            limit(n: number) { call.limit = n; return chain; },
            or(expr: string) { call.or = expr; return chain; },
            lt(col: string, val: unknown) { call.lt.push([col, val]); return chain; },
            // The service awaits the builder itself.
            then(resolve: (v: unknown) => void) {
              resolve({data: rowsBack, error: null});
            },
          };
          Object.assign(q, chain);
          return chain;
        },
      };
    },
  };

  const svc = new BackupService(
    {get: () => undefined} as unknown as ConfigService,
    {client: {}} as unknown as RedisService,
  );
  // Inject the fake client + neutralise the best-effort quota probe, which is
  // a separate concern with its own guard (H-11).
  (svc as unknown as {client: unknown}).client = client;
  (svc as unknown as {isOverRowCap: unknown}).isOverRowCap = async () => false;

  return {svc, upserts, selects};
}

const convo = (id: string, extra: Record<string, unknown> = {}) => ({
  conversation_id: id,
  kind: 'group',
  name: 'Ops Room',
  members: ['a', 'b'],
  last_message_at: '2026-07-24T10:00:00.000Z',
  ...extra,
});

describe('B-178 — a null group_state must PRESERVE the stored encrypted group key', () => {
  it('a row WITHOUT group_state omits the column entirely', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1')] as never);

    expect(upserts).toHaveLength(1);
    const row = upserts[0].payload[0];
    // The regression was `group_state: null` in this payload — ON CONFLICT DO
    // UPDATE would then write NULL over the stored ciphertext.
    expect('group_state' in row).toBe(false);
    // The rest of the row still round-trips.
    expect(row.conversation_id).toBe('c1');
    expect(row.owner_user_id).toBe('owner-1');
  });

  it('a row WITH group_state still updates the column', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1', {group_state: {ct: 'sealed'}})] as never);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload[0].group_state).toEqual({ct: 'sealed'});
  });

  it('a MIXED batch is split into two upserts, never one', async () => {
    // This is the whole shape of the fix: one statement cannot both write and
    // omit a column, so a mixed batch must become two.
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [
      convo('with', {group_state: {ct: 'sealed'}}),
      convo('without'),
    ] as never);

    expect(upserts).toHaveLength(2);
    const stated = upserts.find(u => u.payload.some(r => r.conversation_id === 'with'))!;
    const bare = upserts.find(u => u.payload.some(r => r.conversation_id === 'without'))!;
    expect(stated.payload.every(r => 'group_state' in r)).toBe(true);
    expect(bare.payload.every(r => !('group_state' in r))).toBe(true);
  });

  it('both upserts keep the conflict target (dedupe contract, M-9)', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [
      convo('with', {group_state: {ct: 'x'}}),
      convo('without'),
    ] as never);
    for (const u of upserts) {
      expect(u.opts).toMatchObject({onConflict: 'owner_user_id,conversation_id'});
    }
  });

  it('an undefined group_state is treated as absent, not as a write', async () => {
    // `?? null` used to collapse undefined and null to the same clobbering write.
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1', {group_state: undefined})] as never);
    expect('group_state' in upserts[0].payload[0]).toBe(false);
  });
});

describe('B-594 — the conversation delete flag round-trips, omit-if-absent', () => {
  it('an explicit deleted:true is written (the delete path marks the row)', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1', {deleted: true})] as never);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload[0].deleted).toBe(true);
  });

  it('an explicit deleted:false is written (a live mirror clears the flag on re-add — the lift)', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1', {deleted: false})] as never);
    expect(upserts[0].payload[0].deleted).toBe(false);
  });

  it('a row WITHOUT deleted omits the column (a legacy/partial mirror must not clobber a stored delete)', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [convo('c1')] as never);
    expect('deleted' in upserts[0].payload[0]).toBe(false);
  });

  it('deleted splits the batch by column signature (present vs absent), same as group_state', async () => {
    const {svc, upserts} = mk();
    await svc.putConversations('owner-1', [
      convo('marked', {deleted: true}),
      convo('bare'),
    ] as never);
    expect(upserts).toHaveLength(2);
    const marked = upserts.find(u => u.payload.some(r => r.conversation_id === 'marked'))!;
    const bare = upserts.find(u => u.payload.some(r => r.conversation_id === 'bare'))!;
    expect(marked.payload.every(r => 'deleted' in r)).toBe(true);
    expect(bare.payload.every(r => !('deleted' in r))).toBe(true);
  });

  it('getConversations selects the deleted column and surfaces it', async () => {
    const {svc, selects} = mk([
      {conversation_id: 'c1', kind: 'direct', name: null, members: [], last_message_at: null, deleted: true},
    ]);
    const rows = await svc.getConversations('owner-1');
    expect(selects[0].columns).toContain('deleted');
    expect(rows[0].deleted).toBe(true);
  });

  it('getConversations defaults deleted to false when the column is absent (fail-open, legacy row)', async () => {
    const {svc} = mk([
      {conversation_id: 'c1', kind: 'direct', name: null, members: [], last_message_at: null},
    ]);
    const rows = await svc.getConversations('owner-1');
    expect(rows[0].deleted).toBe(false);
  });
});

describe('B-179 — conversation restore must not silently truncate', () => {
  it('a cursor-less call is capped (bounded response, not unbounded)', async () => {
    const {svc, selects} = mk();
    await svc.getConversations('owner-1');
    expect(selects[0].limit).toBe(5000);
  });

  it('an explicit limit is clamped into a sane page size', async () => {
    const {svc, selects} = mk();
    await svc.getConversations('owner-1', {limit: 999_999});
    expect(selects[0].limit).toBe(1000);

    const b = mk();
    await b.svc.getConversations('owner-1', {limit: 0});
    expect(b.selects[0].limit).toBeGreaterThanOrEqual(1);
  });

  it('paging is a deterministic tuple order, not timestamp alone', async () => {
    // Two conversations sharing last_message_at need a tiebreaker or the
    // keyset cannot make progress.
    const {svc, selects} = mk();
    await svc.getConversations('owner-1');
    expect(selects[0].orders.map(o => o.col)).toEqual(['last_message_at', 'conversation_id']);
  });

  it('a cursor WITH cursorId uses the tuple keyset (boundary rows survive)', async () => {
    const {svc, selects} = mk();
    await svc.getConversations('owner-1', {
      cursor: '2026-07-24T10:00:00.000Z',
      cursorId: 'c-500',
    });
    // (ts < cursor) OR (ts = cursor AND id > cursorId) — the second arm is the
    // fix: a timestamp-only `.lt` dropped every row sharing the boundary stamp.
    expect(selects[0].or).toContain('last_message_at.lt.');
    expect(selects[0].or).toContain('last_message_at.eq.');
    expect(selects[0].or).toContain('conversation_id.gt.');
    expect(selects[0].lt).toHaveLength(0);
  });

  it('a legacy cursor WITHOUT cursorId keeps the old behaviour unchanged', async () => {
    const {svc, selects} = mk();
    await svc.getConversations('owner-1', {cursor: '2026-07-24T10:00:00.000Z'});
    expect(selects[0].or).toBeNull();
    expect(selects[0].lt).toEqual([['last_message_at', '2026-07-24T10:00:00.000Z']]);
  });

  it('the cursor is quote-escaped (PostgREST or() injection)', async () => {
    // An unescaped `"` inside a cursor would close the quoted value early and
    // let the remainder be parsed as further or() syntax. Both operands are
    // attacker-influenced (they come back from the client verbatim).
    const {svc, selects} = mk();
    await svc.getConversations('owner-1', {cursor: 'a"b', cursorId: 'c"d'});

    const or = selects[0].or ?? '';
    // The embedded quote survives as an ESCAPE, not as a delimiter.
    expect(or).toContain('a\\"b');
    expect(or).toContain('c\\"d');
    // …and the value is never terminated at the injected quote.
    expect(or).not.toContain('"a"');
    expect(or).not.toContain('"c"');
  });

  it('every read is scoped to the owner', async () => {
    const {svc, selects} = mk();
    await svc.getConversations('owner-1');
    expect(selects[0].eq).toContainEqual(['owner_user_id', 'owner-1']);
  });
});
