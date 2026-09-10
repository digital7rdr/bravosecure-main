import type { LocalMessage } from '../store/types';

/**
 * Shared transaction-tracking test harness.
 *
 * Extracted VERBATIM out of receiveTransaction.test.ts so the B-130
 * burst-deadlock regression can drive the same stub connection without
 * re-implementing it. A second hand-rolled copy of this stub would be a
 * mirror, and mirrors in this repo drift (B-129).
 *
 * Not a `*.test.ts` file, so the `messenger-crypto` testMatch
 * (`__tests__/**\/*.test.ts`) will not try to run it — same precedent as the
 * existing `__tests__/fixtures.ts` and `__tests__/setup.ts`.
 */

export function makeMsg(id: string, convo = 'c1', over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: convo,
    sender_id:       'peer-1',
    type:            'text',
    content:         'x',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      '2026-07-09T00:00:00.000Z',
    peer:            { userId: 'peer-1', deviceId: 1 },
    ...over,
  } as LocalMessage;
}

/**
 * Stub connection that behaves like op-sqlite/SQLite for transactions:
 * a second BEGIN while one is open throws the exact native error. Every
 * statement yields to the microtask queue first, so two UNSERIALIZED
 * callers genuinely interleave — which is what turns a missing shared
 * mutex into the nested-BEGIN throw the P0 documents.
 */
export function makeTxnTrackingDb(opts?: { failOn?: RegExp; failWith?: Error }) {
  const calls: string[] = [];
  let txnDepth = 0;
  const db = {
    async execute(sql: string): Promise<{ rows: unknown[] }> {
      await Promise.resolve();
      await Promise.resolve();
      calls.push(sql);
      if (/^BEGIN/i.test(sql)) {
        if (txnDepth > 0) {
          throw new Error('cannot start a transaction within a transaction');
        }
        txnDepth += 1;
        return { rows: [] };
      }
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
        txnDepth = Math.max(0, txnDepth - 1);
        return { rows: [] };
      }
      if (opts?.failOn?.test(sql)) {
        throw opts.failWith ?? new Error('database is locked (5) (SQLITE_BUSY)');
      }
      return { rows: [] };
    },
  };
  return { calls, db };
}

/** Walk a statement trace and assert at most ONE txn is ever open. */
export function assertSerializedTrace(calls: string[]): void {
  let depth = 0;
  for (const sql of calls) {
    if (/^BEGIN/i.test(sql)) {
      depth += 1;
      expect(depth).toBe(1); // a nested BEGIN would have thrown anyway
    } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
      depth -= 1;
    }
  }
  expect(depth).toBe(0);
}
