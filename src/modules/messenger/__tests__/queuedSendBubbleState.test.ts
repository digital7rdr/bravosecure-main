/**
 * XO-5 (+ GF-1/SRV-01) — a 1:1 send whose outbox row is still QUEUED must not
 * paint a red bubble. The split state ("bubble failed, row pending") is what
 * makes users re-type, and a re-type mints a fresh clientMsgId the relay's
 * (recipient, clientMsgId) dedup cannot coalesce.
 *
 * Part A drives the REAL SqlOutboxStore through the exact decision the 1:1
 * httpFallback catch now composes. Part B pins the wiring statically —
 * productionRuntime.ts is too heavy to import under jest (see
 * bootGroupStashDrain.test.ts), same approach as resumeOutboxKick.test.ts.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  SqlOutboxStore,
  classifyOutboxFailure,
  isPermanentRelayRejection,
} from '../store/sqlOutboxStore';
import {RelayHttpError} from '@bravo/messenger-core';

type Row = Record<string, string | number | null>;

/** Mirrors sqlOutboxStore.test.ts's hand-rolled engine (same SQL surface). */
function makeFakeDb() {
  const table: Row[] = [];
  const sameKey = (r: Row, cmid: unknown, uid: unknown, did: unknown): boolean =>
    r.client_msg_id === cmid && r.peer_user_id === uid && r.peer_device_id === did;
  return {
    table,
    async execute(sql: string, params: (string | number)[] = []) {
      const trimmed = sql.trim().replace(/\s+/g, ' ');
      if (trimmed.startsWith('INSERT OR IGNORE INTO outbox')) {
        const [client_msg_id, conversation_id, message_id, peer_user_id,
               peer_device_id, payload, next_retry_at, created_at] = params;
        if (table.some(r => sameKey(r, client_msg_id, peer_user_id, peer_device_id))) {
          return {rows: []};
        }
        table.push({
          client_msg_id, conversation_id, message_id, peer_user_id,
          peer_device_id, payload, attempts: 0, soft_attempts: 0,
          next_retry_at, created_at, status: 'pending',
        });
        return {rows: []};
      }
      if (trimmed.startsWith('SELECT client_msg_id, conversation_id')) {
        const now = params[0] as number;
        const rows = table
          .filter(r => r.status === 'pending' && (r.next_retry_at as number) <= now)
          .sort((a, b) => (a.created_at as number) - (b.created_at as number));
        return {rows};
      }
      if (trimmed.startsWith('SELECT DISTINCT message_id FROM outbox')) {
        const pendingOnly = /status = 'pending'/.test(trimmed);
        const rows = table
          .filter(r => !pendingOnly || r.status === 'pending')
          .map(r => ({message_id: r.message_id}));
        return {rows};
      }
      if (trimmed.startsWith('SELECT attempts, soft_attempts FROM outbox')) {
        const [cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        return {rows: match ? [{attempts: match.attempts, soft_attempts: match.soft_attempts}] : []};
      }
      if (trimmed.startsWith('UPDATE outbox SET status = \'failed\'')) {
        const [cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.status = 'failed'; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, status = \'failed\'')) {
        const [attempts, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.status = 'failed'; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = 0, soft_attempts = 0')) {
        const [next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did) && r.status === 'failed');
        if (match) {
          match.attempts = 0; match.soft_attempts = 0;
          match.next_retry_at = next_retry_at; match.status = 'pending';
        }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, next_retry_at = ?')) {
        const [attempts, next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.next_retry_at = next_retry_at; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET soft_attempts = 0, next_retry_at = ?')) {
        const [next_retry_at] = params;
        for (const r of table) {
          if (r.status === 'pending' && (r.soft_attempts as number) > 0) {
            r.soft_attempts = 0;
            r.next_retry_at = next_retry_at;
          }
        }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET soft_attempts = ?, next_retry_at = ?')) {
        const [soft_attempts, next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.soft_attempts = soft_attempts; match.next_retry_at = next_retry_at; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET next_retry_at = ?')) {
        const [next_retry_at, cutoff] = params;
        for (const r of table) {
          if (r.status === 'pending' && (r.next_retry_at as number) > (cutoff as number)) {
            r.next_retry_at = next_retry_at;
          }
        }
        return {rows: []};
      }
      throw new Error(`unhandled SQL: ${trimmed}`);
    },
  };
}

const KEY = {clientMsgId: 'cmid-1', peerUserId: 'bob', peerDeviceId: 1};

function make(): {store: SqlOutboxStore; table: Row[]} {
  const fake = makeFakeDb();
  return {store: new SqlOutboxStore(fake as never), table: fake.table};
}

async function seed(store: SqlOutboxStore): Promise<void> {
  await store.enqueue({
    clientMsgId:    KEY.clientMsgId,
    conversationId: 'direct:bob',
    messageId:      'mid-1',
    peerUserId:     KEY.peerUserId,
    peerDeviceId:   KEY.peerDeviceId,
    payload:        '{"outerSealed":"AAA"}',
  });
}

/**
 * The composed rule from productionRuntime's 1:1 httpFallback catch: classify,
 * charge the row, and let the OUTBOX decide whether the bubble goes red.
 */
async function sendFailure(
  store: SqlOutboxStore,
  e: unknown,
): Promise<{bubble: 'sending' | 'failed'; attempts: number; failed: boolean; kind: string; retryAfterMs?: number}> {
  const f = classifyOutboxFailure(e);
  const res = await store.recordAttempt(KEY.clientMsgId, KEY.peerUserId, KEY.peerDeviceId, {
    unreachable: f.kind === 'unreachable',
    transient:   f.kind === 'server-transient',
    deferMs:     f.retryAfterMs,
    permanent:   isPermanentRelayRejection(e),
  });
  return {
    bubble:       res.queued ? 'sending' : 'failed',
    attempts:     res.attempts,
    failed:       res.failed,
    kind:         f.kind,
    retryAfterMs: f.retryAfterMs,
  };
}

describe('XO-5 — the outbox owns the terminal decision', () => {
  test('offline send keeps the bubble sending AND the row pending (no split state)', async () => {
    const {store, table} = make();
    await seed(store);
    const out = await sendFailure(store, new TypeError('Network request failed'));
    expect(out.kind).toBe('unreachable');
    // Asserted TOGETHER so a future edit re-introducing the split fails loudly.
    expect({bubble: out.bubble, rowStatus: table[0].status}).toEqual({
      bubble: 'sending', rowStatus: 'pending',
    });
    // The "auto-sends later" half — the row is still drainable.
    const due = await store.dueRows(Date.now() + 10 * 60_000);
    expect(due.map(r => r.clientMsgId)).toEqual([KEY.clientMsgId]);
  });

  test('GF-1/SRV-01 — an HTTP-fallback 429 shows no red bubble and burns no budget', async () => {
    const {store, table} = make();
    await seed(store);
    const err = new RelayHttpError(429, 'ThrottlerException: Too Many Requests', undefined, 3_000);
    const out = await sendFailure(store, err);
    expect(out.kind).toBe('server-transient');
    expect(out.retryAfterMs).toBe(3_000);
    expect(out.bubble).toBe('sending');
    expect(out.attempts).toBe(0);          // budget untouched
    expect(table[0].soft_attempts).toBe(1); // escalating soft counter instead
    expect(table[0].status).toBe('pending');
  });

  test('a semantic 400 rejection terminates the row and the bubble together', async () => {
    const {store, table} = make();
    await seed(store);
    const out = await sendFailure(store, new RelayHttpError(400, 'invalid_outer_sealed'));
    expect(out.kind).toBe('rejected');
    expect({bubble: out.bubble, failed: out.failed}).toEqual({bubble: 'failed', failed: true});
    expect(table[0].status).toBe('failed');
    expect(table[0].attempts).toBe(0);
    expect(await store.dueRows(Date.now() + 10 * 60_000)).toEqual([]);
  });

  test('no durable row at all => pre-fix behaviour (red bubble) is preserved', async () => {
    const {store} = make();
    const res = await store.recordAttempt(KEY.clientMsgId, KEY.peerUserId, KEY.peerDeviceId, {});
    expect(res).toEqual({attempts: 0, failed: false, queued: false});
    const out = await sendFailure(store, new RelayHttpError(404, 'not_found'));
    expect(out.bubble).toBe('failed');
  });

  test('a TERMINAL row still reports queued=true — so the runtime MUST re-open it', async () => {
    // This is the trap the `if (queued) return;` branch walks into: after a
    // terminal failure the retry re-sends under the SAME clientMsgId, enqueue is
    // an INSERT OR IGNORE no-op, and a second transient failure answers
    // queued=true over a row `dueRows` will never return again.
    const {store, table} = make();
    await seed(store);
    await sendFailure(store, new RelayHttpError(400, 'invalid_outer_sealed'));
    await seed(store);                      // the retry's enqueue — no-op
    expect(table).toHaveLength(1);
    expect(table[0].status).toBe('failed');
    const out = await sendFailure(store, new TypeError('Network request failed'));
    expect(out.bubble).toBe('sending');     // store says "queued"...
    expect(await store.dueRows(Date.now() + 10 * 60_000)).toEqual([]); // ...nothing drains
  });

  test('tap-to-retry re-opens the row, so a queued bubble is always drainable', async () => {
    const {store, table} = make();
    await seed(store);
    await sendFailure(store, new RelayHttpError(400, 'invalid_outer_sealed'));
    await seed(store);
    // productionRuntime's opts.existingMsgId branch (pinned statically below).
    await store.resetFailed(KEY.clientMsgId, KEY.peerUserId, KEY.peerDeviceId);
    expect(table[0].status).toBe('pending');
    const out = await sendFailure(store, new TypeError('Network request failed'));
    expect(out.bubble).toBe('sending');
    const due = await store.dueRows(Date.now() + 10 * 60_000);
    expect(due.map(r => r.clientMsgId)).toEqual([KEY.clientMsgId]);
  });

  test('budget exhaustion hands the retry chip back', async () => {
    const {store, table} = make();
    await seed(store);
    let last = await sendFailure(store, new RelayHttpError(404, 'not_found'));
    for (let i = 0; i < 9; i++) {
      last = await sendFailure(store, new RelayHttpError(404, 'not_found'));
    }
    expect({bubble: last.bubble, failed: last.failed}).toEqual({bubble: 'failed', failed: true});
    expect(table[0].status).toBe('failed');
  });
});

const SRC = readFileSync(
  join(__dirname, '..', 'runtime', 'productionRuntime.ts'),
  'utf8',
);

/**
 * Strip comments for ORDERING assertions only.
 *
 * Several `slice()` anchors in this file are deliberately comment text, so SRC
 * itself must stay raw. But an ordering check against a quoted status literal
 * is the repo's classic false result: a B-703 MR-4 comment in the catch
 * explains the 'failed' stamp, and `indexOf("'failed'")` matched the
 * explanation rather than the code, inverting the pin.
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function slice(from: string, to: string): string {
  const start = SRC.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('XO-5 — productionRuntime 1:1 catch wiring', () => {
  const httpFallback = (): string => slice('const httpFallback = async', 'const ackTimer = setTimeout');

  it('classifies the failure instead of the old boolean unreachable check', () => {
    expect(httpFallback()).toContain('classifyOutboxFailure(');
  });

  it('terminates a semantic rejection through the permanent seam', () => {
    const block = httpFallback();
    expect(block).toContain('permanent:');
    expect(block).toContain('isPermanentRelayRejection(');
  });

  it('maps the no-budget classes so a 429 never burns an attempt (GF-1/SRV-01)', () => {
    const block = httpFallback();
    // Part A drives this mapping through the real store; pin it here too, or a
    // one-word edit silently re-reddens the bubble on a throttled submit.
    expect(block).toMatch(/unreachable:\s+f\.kind === 'unreachable',/);
    expect(block).toMatch(/transient:\s+f\.kind === 'server-transient',/);
    expect(block).toMatch(/deferMs:\s+f\.retryAfterMs,/);
    expect(block).toMatch(/scheduleTransientRedrain\(/);
  });

  it('re-opens a TERMINAL row on tap-to-retry so "queued" means drainable', () => {
    // XO-5 regression guard: retry re-sends under the SAME clientMsgId, so the
    // enqueue is an INSERT OR IGNORE no-op. Without resetFailed the row stays
    // 'failed', recordAttempt still answers queued=true, and the bubble spins
    // in 'sending' over a row dueRows will never return.
    const block = slice('peerDeviceId: target.deviceId,', 'const httpFallback = async');
    // B-122 — the row is keyed by the WIRE id (fresh when the relay already
    // accepted the original, identical otherwise).
    expect(block).toMatch(
      /if \(opts\.existingMsgId\)[\s\S]{0,120}?sqlOutbox\.resetFailed\(wireClientMsgId, target\.userId, target\.deviceId\)/,
    );
  });

  it('no longer flips the bubble to failed BEFORE recording the attempt', () => {
    const block = stripComments(httpFallback());
    expect(block.indexOf('recordAttempt(')).toBeLessThan(block.indexOf("'failed'"));
  });

  it('B-703 MR-4 — the accepted-mid-flight guard runs BEFORE recordAttempt', () => {
    // Order is the contract: an accept that landed during this attempt must not
    // burn an outbox attempt on its way to being ignored.
    const block = stripComments(httpFallback());
    const guard  = block.indexOf('acceptedDuringAttempt(');
    const record = block.indexOf('recordAttempt(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(record);
  });

  it('B-703 MR-4 — the acceptance snapshot is taken OUTSIDE the retry closure', () => {
    // Inside it, the snapshot would run when the watchdog fires — and the
    // accept can land between the watchdog's pre-check and that moment, so the
    // snapshot would already see it and conclude nothing changed.
    const block = stripComments(
      slice('const acceptedBefore = snapshotAcceptance(', 'const ackTimer = setTimeout'),
    );
    expect(block.indexOf('snapshotAcceptance('))
      .toBeLessThan(block.indexOf('const httpFallback = async'));
  });

  it('returns without throwing when the row is still queued', () => {
    const block = httpFallback();
    expect(block).toMatch(/if \(queued\)[\s\S]{0,240}?return;/);
    const queuedAt = block.indexOf('if (queued)');
    const failAt = block.indexOf("updateMessageStatus(conversationId, msgId, 'failed')");
    expect(queuedAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeLessThan(failAt);
  });

  it('still pops the pending entry / ack watchdog on every path (Fix #8)', () => {
    expect(httpFallback()).toContain('clearPending(wireClientMsgId);');
  });
});

describe('XO-5/GF-1 — group fan-out catch stays non-terminal', () => {
  const fanoutCatch = (): string =>
    slice('// Why: no `permanent` here', 'throw e;');

  it('classifies and books the early re-drain like the 1:1 lane', () => {
    const block = fanoutCatch();
    expect(block).toContain('classifyOutboxFailure(');
    expect(block).toMatch(/unreachable:\s+f\.kind === 'unreachable',/);
    expect(block).toMatch(/transient:\s+f\.kind === 'server-transient',/);
    expect(block).toMatch(/deferMs:\s+f\.retryAfterMs,/);
    expect(block).toContain('scheduleTransientRedrain(');
  });

  it('never terminates a row here — this site discards recordAttempt\'s verdict', () => {
    // A `permanent:` flag would mark one peer row 'failed' while the aggregate
    // bubble stays 'sending' over a row dueRows never returns: the exact split
    // state XO-5 exists to kill.
    expect(fanoutCatch()).not.toContain('permanent:');
  });
});

describe('B-122 — tap-to-retry actually delivers', () => {
  // The relay dedups on (recipient, clientMsgId) and answers the ORIGINAL
  // accept for a repeat submit (envelope.service.ts P0-N5). A same-id retry
  // of a message the relay accepted once is therefore a silent no-op: 200,
  // bubble 'sent', nothing delivered. These pins hold the fix together.

  it('mints a FRESH wire id when the relay already accepted the original', () => {
    const lane = slice('// B-122 — the relay dedups', 'let outerSealed:');
    expect(lane).toMatch(/if \(prior\?\.envelope_id\)[\s\S]{0,240}?wireClientMsgId = makeId\(\);/);
    // ...and drops the old row so a later drain can't re-ship a no-op.
    expect(lane).toMatch(/deleteByClientMsgId\(clientMsgId\)/);
  });

  it('keeps the SAME wire id when the relay never accepted (dedup stays idempotent)', () => {
    const lane = slice('// B-122 — the relay dedups', 'let outerSealed:');
    expect(lane).toContain('let wireClientMsgId = clientMsgId;');
    expect(lane).toMatch(/if \(opts\.existingMsgId\)/);
  });

  it('ships, queues and acks the 1:1 lane under the WIRE id', () => {
    const lane = slice('// B-122 — the relay dedups', 'CRIT-7 multi-device fan-out');
    expect(lane).toMatch(/relay\.send\(\{\s*recipient:\s+target,\s*outerSealed,\s*clientMsgId:\s+wireClientMsgId,/);
    expect(lane).toMatch(/trackPending\(wireClientMsgId, \{conversationId, messageId: msgId, peer: target, ackTimer\}\)/);
    expect(lane).toMatch(/recordAttempt\(wireClientMsgId, target\.userId, target\.deviceId/);
    expect(lane).toMatch(/markDelivered\(wireClientMsgId, target\.userId, target\.deviceId\)/);
  });

  it("an 'undelivered' retry rebuilds the session from the peer's CURRENT bundle", () => {
    // AUDIT-2026-08-13 #5 — this assertion previously pinned
    // `peerIdentityCache.delete(target.userId)`: a NO-OP (the cache is keyed
    // `${userId}.${deviceId}`), so the retry re-wrapped to the DEAD identity
    // for a full TTL. The bug survived review because this test looked like
    // coverage while pinning the defect. The lane now routes through the
    // shared recovery closure (evict → forceRefresh → re-seed); its key
    // discipline and ordering are pinned by peerIdentityCacheKey.test.ts.
    const lane = slice('// B-122 — an ', 'const sealed = sealPayload(cert, text,');
    expect(lane).toMatch(/if \(opts\.freshSession\)[\s\S]{0,120}?await refreshPeerIdentityAndSession\(target\);/);
  });

  it('the identity-ack gate hands the retry chip back instead of stranding the bubble', () => {
    // M3 — the gate moved BELOW the 1:1 append and now exits through
    // failDirectSend, which flips the bubble unconditionally. That SUBSUMES the
    // old `if (opts.existingMsgId)` special case (a double flip would be dead
    // weight): the chip now comes back for a fresh send too, not just a retry.
    // Assert the routing AND that the helper it routes to does the flip.
    const gate = slice('hasPendingIdentityAck(gatePeerId)', 'B-122 — the relay dedups');
    expect(gate).toMatch(/failDirectSend\(/);
    expect(SRC).toMatch(/failDirectSend\s*=\s*\([\s\S]{0,240}?updateMessageStatus\(conversationId, msgId, 'failed'\)/);
  });

  it('a retried GROUP message re-opens its terminal peer rows (XO-5, group edition)', () => {
    // B-683 re-anchor: the group lane now sends under `wireClientMsgId`
    // (fresh id when the prior attempt was relay-accepted — the same-id
    // reopen below is the never-accepted case, where wireClientMsgId ===
    // clientMsgId; the accepted case purges + re-enqueues fresh rows).
    const fanout = slice('const sendOne = async', 'Group fan-out always uses HTTP');
    expect(fanout).toMatch(/if \(opts\.existingMsgId\)[\s\S]{0,320}?resetFailed\(wireClientMsgId, peer\.userId, peer\.deviceId\)/);
  });

  it('the ChatScreen chip requests a fresh session for undelivered bubbles', () => {
    const chat = readFileSync(
      join(__dirname, '..', '..', '..', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8');
    expect(chat).toMatch(/freshSession:\s+msg\.status === 'undelivered'/);
  });
});

describe('XO-5 — boot sweep + drain-catch invariants', () => {
  it('MSG-07 boot sweep counts only retriable rows', () => {
    expect(SRC).toMatch(/await sqlOutbox\.pendingMessageIds\(\)/);
    expect(SRC).not.toMatch(/allMessageIds\(\)/);
  });

  it('the drain catch classifies and keeps the L17 no-downgrade guard', () => {
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    expect(drain).toContain('classifyOutboxFailure(');
    expect(drain).toContain("cur?.status === 'sending'");
  });

  it('B-703 MR-6 — a markDelivered failure AFTER a successful send is not a send failure', () => {
    // Inside the send's try it was classified by classifyOutboxFailure and
    // charged an attempt against the retry budget; repeated database trouble
    // could then walk an already-delivered message to a terminal red chip.
    // Leaving the row is harmless: the next drain re-ships the SAME
    // clientMsgId and the relay's dedup memo answers with the original accept.
    const drain = stripComments(slice('async function drainOutboxPass', 'async function drainRelay'));
    // EVERY post-send site, not just the first: the function ships from two
    // branches (the key-material row and the message row) and both delete the
    // local row after a successful send. Anchoring on a bare indexOf found only
    // the key-material one and declared victory.
    const sites: number[] = [];
    for (let i = drain.indexOf('shippedThisPass.add(row.clientMsgId);');
         i !== -1;
         i = drain.indexOf('shippedThisPass.add(row.clientMsgId);', i + 1)) {
      sites.push(i);
    }
    expect(sites).toHaveLength(2);
    for (const at of sites) {
      const postSend = drain.slice(Math.max(0, at - 700), at);
      expect(postSend).toMatch(
        /try \{\s*await outbox\.markDelivered\([^)]*\);\s*\} catch \(e\) \{[\s\S]*?console\.warn\(/,
      );
      // ...and the catch BACKS THE ROW OFF. Swallowing alone leaves
      // next_retry_at untouched, so the row stays due and re-ships on every
      // drain pass forever — and past the cert reseal margin each pass costs a
      // cert fetch and a real ratchet advance, invisibly, because the bubble
      // already reads 'sent'. Soft, so it still spends no retry budget.
      expect(postSend).toMatch(/recordAttempt\([^)]*\{transient: true\}\)/);
      // ...and the send's classifier still sits in the OUTER catch, after it.
      expect(drain.indexOf('classifyOutboxFailure(')).toBeGreaterThan(at);
    }
  });

  it('the SN-06 cert-freshness gate survived (routed through planOutboxDrain)', () => {
    // RT-3 moved the parse/stale/deferred branching into the pure router; the
    // drain must route EVERY row through it, and the router must still consult
    // the stored cert expiry.
    const drain = slice('async function drainOutboxPass', 'async function drainRelay');
    expect(drain).toContain('planOutboxDrain(row.payload)');
    const router = readFileSync(
      join(__dirname, '..', 'runtime', 'deferredOutbox.ts'), 'utf8');
    expect(router).toContain('isStoredCertStale(parsed.certExpSec');
    expect(router).toContain("return {mode: 'fail', reason: 'cert_expired_unresealable'};");
  });
});

describe('B-125 — group membership guards can no longer eat the typed text', () => {
  it('the participants + fan-out-cap guards sit BELOW the optimistic append', () => {
    // The throws used to run ~50 lines above appendMessage while ChatScreen
    // had already cleared the composer — text destroyed, no bubble, no chip.
    const group = slice('if (isGroup) {', 'P2-4 — capture the master key');
    const appendAt = group.indexOf('useMessengerStore.getState().appendMessage(conversationId, msg);');
    const emptyGuardAt = group.indexOf('if (participants.length === 0) {');
    const capGuardAt = group.indexOf('participants.length > MAX_GROUP_FANOUT');
    expect(appendAt).toBeGreaterThan(-1);
    expect(emptyGuardAt).toBeGreaterThan(appendAt);
    expect(capGuardAt).toBeGreaterThan(appendAt);
    // ...and both guards hand the retry chip back before throwing. M3 — the two
    // hand-copied inline flips are now ONE named helper (the repo's recurring
    // root cause is N copies of one behaviour, the unwatched copy drifting), so
    // pin the routing of BOTH guards *and* the helper's flip-then-throw. Same
    // assertion strength as the old inline regex, one spelling later.
    expect(group).toMatch(/participants\.length === 0\) \{\s*\n\s*failGroupSend\(/);
    expect(group).toMatch(/participants\.length > MAX_GROUP_FANOUT\) \{\s*\n\s*failGroupSend\(/);
    expect(group).toMatch(/failGroupSend\s*=\s*\([\s\S]{0,240}?updateMessageStatus\(conversationId, msgId, 'failed'\);[\s\S]{0,120}?throw new Error/);
  });

  it('the empty-membership error no longer blames /conversations/mine', () => {
    const group = slice('if (isGroup) {', 'P2-4 — capture the master key');
    expect(group).not.toContain('may not be synced from /conversations/mine');
  });

  it('B-124 — key material never routes an explicit direct row as a group', () => {
    // This used to pin the INLINE expression
    //   `!!groupState && convo?.type !== 'direct' && groupState.name !== 'Call'`
    // which made the assertion fail the moment sendText was fixed to stop
    // holding its own copy of the rule. Two duplicated copies of this predicate
    // IS B-124 — messageTopologyInvariants.test.ts asserts the opposite (that
    // sendText must NOT re-inline it), so pinning the inline spelling here put
    // the suite in direct self-contradiction.
    //
    // Pin the PROPERTY instead: sendText decides topology by delegating to the
    // single shared predicate, and holds no groups-map presence test of its own.
    // The rule's actual behaviour (a `direct` row + stray 'Call' key must never
    // be a group) is covered for real — by import, not by regex — in
    // messagingLogic.test.ts.
    const seam = slice('const isGroup =', 'P2-12 — reuse the bubble');
    expect(seam).toMatch(/isGroupConversation\(/);
    expect(seam).not.toMatch(/groups\[/);
    expect(seam).not.toMatch(/!!\s*groupState/);
  });
});
