import {DispatchRoomIntentsService} from './dispatch-room-intents.service';
import type {DatabaseService} from '../database/database.service';

function mk() {
  const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null)};
  const svc = new DispatchRoomIntentsService(db as unknown as DatabaseService);
  return {svc, db};
}

describe('DispatchRoomIntentsService', () => {
  it('enqueueRoomIntent inserts the full row scoped to the agency org', async () => {
    const {svc, db} = mk();
    await svc.enqueueRoomIntent('org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1');
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO public\.dispatch_room_intents/),
      ['org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1'],
    );
  });

  /**
   * B-416 follow-up — a removed-then-RE-ADDED CPO must get a fresh add-intent.
   *
   * THE BUG: the dedup suppressed on `state IN ('pending','done')` alone, so
   * the (add, done) row from the FIRST assignment blocked the second one
   * forever. The member ends up SEATED (the mission service writes the
   * `conversations` membership, not this queue) but KEYLESS — rung, accepted,
   * then failing the 25s in-call key wait. "The CPO can't join the Ops Room
   * call", with a completely green server.
   *
   * ⚠️ WHAT THIS TEST CAN AND CANNOT DO. `db.q` is a mock: NO SQL EXECUTES
   * here, so this pins the SHAPE of the predicate, not its behaviour. It will
   * catch a revert or a deletion; it cannot catch a subtly wrong expression.
   * This repo has already lost five live defects to exactly that blind spot
   * (nothing in the suite runs Postgres), so the real verification is the SQL
   * probe recorded in sqa.md, on a booking whose crew was removed and re-added.
   */
  describe('re-add after remove is NOT deduped away', () => {
    const sqlOf = (db: {q: jest.Mock}) => String(db.q.mock.calls[0][0]);

    it('suppresses only a same-action intent NEWER than the last opposing one', async () => {
      const {svc, db} = mk();
      await svc.enqueueRoomIntent('org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1');
      const sql = sqlOf(db);
      // The opposing-action subquery is what makes "done" non-terminal.
      expect(sql).toMatch(/o\.action\s*<>\s*\$5/);
      expect(sql).toMatch(/MAX\(o\.created_at\)/);
      // …and the same-action row only counts when it POSTDATES that.
      expect(sql).toMatch(/s\.created_at\s*>\s*COALESCE\(/);
      // No opposing intent at all must still suppress a duplicate — otherwise
      // the resume/retry dedup this predicate exists for stops working and the
      // agency device loops on an `addGroupMember` that throws and never acks.
      expect(sql).toMatch(/'-infinity'::timestamptz/);
    });

    it('still scopes the dedup to (booking, member) — not org-wide', async () => {
      // Widening it would suppress a legitimate add for the same person on a
      // DIFFERENT booking's room.
      const {svc, db} = mk();
      await svc.enqueueRoomIntent('org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1');
      const sql = sqlOf(db);
      expect(sql).toMatch(/s\.booking_id = \$2 AND s\.member_user_id = \$4/);
      expect(sql).toMatch(/o\.booking_id = \$2 AND o\.member_user_id = \$4/);
    });

    it('a FAILED intent never blocks a retry', async () => {
      // Both arms list only pending/done, so a failed attempt leaves the member
      // enqueueable — the drain's own error path depends on it.
      const {svc, db} = mk();
      await svc.enqueueRoomIntent('org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1');
      expect(sqlOf(db)).not.toMatch(/'failed'/);
    });
  });

  it('listRoomIntents returns only the caller-org pending intents (scope fused into SQL)', async () => {
    const {svc, db} = mk();
    db.q.mockResolvedValue([{id: 'i1', booking_id: 'b1', conversation_id: 'conv-1', member_user_id: 'cpo-1', action: 'add', created_at: 't'}]);
    const rows = await svc.listRoomIntents('org-A');
    expect(rows).toHaveLength(1);
    expect(db.q).toHaveBeenCalledWith(
      // The service SQL aliases the intents table (i.*) since the booking join landed.
      expect.stringMatching(/WHERE i\.org_user_id = \$1 AND i\.state = 'pending'[\s\S]*ORDER BY i\.created_at ASC/),
      ['org-A'],
    );
  });

  it('ackRoomIntent acks via the conditional UPDATE (exactly-once + org-scope fused)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue({id: 'i1'});
    const r = await svc.ackRoomIntent('org-A', 'i1');
    expect(r).toEqual({ok: true});
    expect(db.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/SET state = 'done'[\s\S]*WHERE id = \$1 AND state = 'pending' AND org_user_id = \$2[\s\S]*RETURNING id/),
      ['i1', 'org-A'],
    );
  });

  it('ackRoomIntent 404s when 0 rows match — second ack OR cross-org IDOR (ambiguous)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue(null); // already done, unknown id, or wrong org
    await expect(svc.ackRoomIntent('org-OTHER', 'i1')).rejects.toThrow('intent_not_found_or_not_org');
  });

  // ─── B-416 — claimRoomCrypto: PK-arbitrated single key authority per room ───

  it('B-416 claimRoomCrypto — first caller WINS via INSERT ON CONFLICT DO NOTHING and is returned as claimant', async () => {
    const {svc, db} = mk();
    db.qOne
      .mockResolvedValueOnce({ok: 1})                    // org-scope probe
      .mockResolvedValueOnce({claimed_by: 'mgr-1'});     // insert RETURNING
    const r = await svc.claimRoomCrypto('org-A', 'mgr-1', 'conv-1');
    expect(r).toEqual({claimed_by: 'mgr-1'});
    expect(db.qOne).toHaveBeenNthCalledWith(2,
      expect.stringMatching(/INSERT INTO public\.dispatch_room_crypto_claims[\s\S]*ON CONFLICT \(conversation_id\) DO NOTHING[\s\S]*RETURNING claimed_by/),
      ['conv-1', 'mgr-1'],
    );
  });

  it('B-416 claimRoomCrypto — a LOSING caller reads the existing claimant back (never overwrites)', async () => {
    const {svc, db} = mk();
    db.qOne
      .mockResolvedValueOnce({ok: 1})                    // org-scope probe
      .mockResolvedValueOnce(null)                       // conflict: insert returned nothing
      .mockResolvedValueOnce({claimed_by: 'owner-1'});   // existing claimant
    const r = await svc.claimRoomCrypto('org-A', 'mgr-2', 'conv-1');
    expect(r).toEqual({claimed_by: 'owner-1'});
    // No UPDATE/DELETE ever touches the claims table — the PK row is permanent.
    for (const call of db.qOne.mock.calls) {
      expect(String(call[0])).not.toMatch(/(UPDATE|DELETE)[\s\S]*dispatch_room_crypto_claims/);
    }
  });

  it('B-416 claimRoomCrypto — cross-org / workspace-tenant caller gets the same ambiguous 404 as ack (no insert attempted)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce(null);                 // org-scope probe finds no intent row
    await expect(svc.claimRoomCrypto('org-OTHER', 'mgr-1', 'conv-1')).rejects.toThrow('room_not_found_or_not_org');
    expect(db.qOne).toHaveBeenCalledTimes(1);            // never reached the INSERT
  });

  it('B-416 claimRoomCrypto — room hard-deleted between conflict and read (FK cascade) → same ambiguous 404', async () => {
    const {svc, db} = mk();
    db.qOne
      .mockResolvedValueOnce({ok: 1})                    // org-scope probe
      .mockResolvedValueOnce(null)                       // insert: conflict
      .mockResolvedValueOnce(null);                      // row gone (cascade)
    await expect(svc.claimRoomCrypto('org-A', 'mgr-1', 'conv-1')).rejects.toThrow('room_not_found_or_not_org');
  });
});
