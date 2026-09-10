import {CpoAssignmentService} from './cpo-assignment.service';
import type {DatabaseService} from '../../database/database.service';

function mockDb() {
  return {q: jest.fn(), qOne: jest.fn()} as unknown as DatabaseService & {
    q: jest.Mock; qOne: jest.Mock;
  };
}

function cpo(id: string, female = false, specialties: string[] = ['armed']) {
  return {
    id, call_sign: `CPO ${id.slice(-2)}`, display_name: 'X. Test',
    role: 'CPO', region_code: 'AE', armed: true, female, specialties,
    availability: 'on_mission', active: true,
  };
}

describe('CpoAssignmentService', () => {
  describe('assign', () => {
    it('claims N CPOs sequentially and writes one booking_cpo_assignments row per slot', async () => {
      const db = mockDb();
      // getForBooking (existing assignments) → empty
      db.q.mockResolvedValueOnce([]);
      // claimOne(): fallback attempt returns a CPO, twice.
      db.qOne.mockResolvedValueOnce(cpo('cpo-a'));   // slot 0
      db.qOne.mockResolvedValueOnce(cpo('cpo-b'));   // slot 1

      const svc = new CpoAssignmentService(db);
      const out = await svc.assign('b1', {region: 'AE', cpoCount: 2, addOns: []});
      expect(out).toHaveLength(2);
      expect(out.map(c => c.id)).toEqual(['cpo-a', 'cpo-b']);

      // Two slot inserts + a lead-CPO FK write onto the booking.
      const inserts = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('INSERT INTO booking_cpo_assignments'),
      );
      expect(inserts).toHaveLength(2);
      const leadWrite = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE lite_bookings SET cpo_id'),
      );
      expect(leadWrite?.[1]).toEqual(['cpo-a', 'b1']);
    });

    it('prefers a female CPO when the female_cpo add-on is selected', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]);
      // First attempt MUST be female=true. Return a female CPO on the first call.
      db.qOne.mockResolvedValueOnce(cpo('cpo-f', true, ['female_team']));

      const svc = new CpoAssignmentService(db);
      await svc.assign('b1', {region: 'AE', cpoCount: 1, addOns: ['female_cpo']});

      const firstClaim = db.qOne.mock.calls[0];
      // Binds: region, excludeIds, specialty, female
      expect(firstClaim[1][3]).toBe(true);
    });

    it('falls through specialty → fallback when preferred is unavailable', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]);
      // recon-preferred first attempt returns null, fallback returns a CPO.
      db.qOne
        .mockResolvedValueOnce(null)                      // recon attempt
        .mockResolvedValueOnce(cpo('cpo-gen'));           // fallback attempt

      const svc = new CpoAssignmentService(db);
      const out = await svc.assign('b1', {region: 'AE', cpoCount: 1, addOns: ['recon']});
      expect(out[0].id).toBe('cpo-gen');
    });

    it('is idempotent when the booking is already fully assigned', async () => {
      const db = mockDb();
      // Existing assignments with slot already = count.
      db.q.mockResolvedValueOnce([
        {...cpo('cpo-a'), slot: 0},
        {...cpo('cpo-b'), slot: 1},
      ]);
      const svc = new CpoAssignmentService(db);
      const out = await svc.assign('b1', {region: 'AE', cpoCount: 2, addOns: []});
      expect(out).toHaveLength(2);
      // Nothing should have been claimed or written.
      expect(db.qOne).not.toHaveBeenCalled();
      const writes = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].startsWith('INSERT'),
      );
      expect(writes).toHaveLength(0);
    });

    it('fails fast when the pool is entirely exhausted', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]);
      db.qOne.mockResolvedValue(null);
      const svc = new CpoAssignmentService(db);
      await expect(
        svc.assign('b1', {region: 'AE', cpoCount: 1, addOns: []}),
      ).rejects.toMatchObject({message: 'no_cpo_available'});
    });

    it('excludes already-claimed CPOs from subsequent slot claims', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]);
      db.qOne.mockResolvedValueOnce(cpo('cpo-a'));
      db.qOne.mockResolvedValueOnce(cpo('cpo-b'));

      const svc = new CpoAssignmentService(db);
      await svc.assign('b1', {region: 'AE', cpoCount: 2, addOns: []});

      const secondClaim = db.qOne.mock.calls[1];
      expect(secondClaim[1][1]).toEqual(['cpo-a']);
    });
  });

  describe('release', () => {
    it('no-ops when there are no assignments', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]);  // booking_cpo_assignments query
      const svc = new CpoAssignmentService(db);
      await svc.release('b1');
      expect(db.q).toHaveBeenCalledTimes(1); // only the SELECT
    });

    it('frees the CPOs and deletes the join rows', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([{cpo_id: 'cpo-a'}, {cpo_id: 'cpo-b'}]);
      db.q.mockResolvedValue(undefined);
      const svc = new CpoAssignmentService(db);
      await svc.release('b1');
      const statusUpdate = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes("SET availability = 'available'"),
      );
      expect(statusUpdate?.[1]).toEqual([['cpo-a', 'cpo-b']]);
      const deleteCall = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].startsWith('DELETE FROM booking_cpo_assignments'),
      );
      expect(deleteCall?.[1]).toEqual(['b1']);
    });
  });

  // ─── Phase 2 — org-as-payee payout sourcing ──────────────────────────
  describe('getCrewForPayout', () => {
    it('reads real officers from mission_crew joined via the booking mission', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([
        {user_id: 'officer-1', call_sign: 'CPO 01'},
        {user_id: 'officer-2', call_sign: 'CPO 02'},
      ]);
      const svc = new CpoAssignmentService(db);
      const crew = await svc.getCrewForPayout('b1');
      expect(crew.map(c => c.user_id)).toEqual(['officer-1', 'officer-2']);
      const [sql, params] = db.q.mock.calls[0];
      expect(String(sql)).toMatch(/mission_crew/);
      expect(String(sql)).toMatch(/JOIN missions/);
      expect(params).toEqual(['b1']);
    });
  });

  describe('resolvePayeeUserId', () => {
    it('returns the applicant org from the winning application (org-as-payee)', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({applicant_org_id: 'org-9'}); // winning app
      const svc = new CpoAssignmentService(db);
      await expect(svc.resolvePayeeUserId('b1', 'officer-1')).resolves.toBe('org-9');
      // Should not even consult org_members when the app already names the org.
      expect(db.qOne).toHaveBeenCalledTimes(1);
    });

    it('falls back to the owning org from org_members when no app names the officer', async () => {
      const db = mockDb();
      db.qOne
        .mockResolvedValueOnce(null)                       // no winning app
        .mockResolvedValueOnce({org_user_id: 'org-5'});    // org_members owner
      const svc = new CpoAssignmentService(db);
      await expect(svc.resolvePayeeUserId('b1', 'officer-1')).resolves.toBe('org-5');
    });

    it('falls back to the officer themselves (legacy self-registered CPO)', async () => {
      const db = mockDb();
      db.qOne
        .mockResolvedValueOnce(null)   // no app
        .mockResolvedValueOnce(null);  // not a managed member
      const svc = new CpoAssignmentService(db);
      await expect(svc.resolvePayeeUserId('b1', 'self-cpo')).resolves.toBe('self-cpo');
    });
  });
});
