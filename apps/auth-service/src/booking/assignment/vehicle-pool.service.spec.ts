import {VehiclePoolService} from './vehicle-pool.service';
import type {DatabaseService} from '../../database/database.service';

function mockDb() {
  return {q: jest.fn(), qOne: jest.fn()} as unknown as DatabaseService & {
    q: jest.Mock; qOne: jest.Mock;
  };
}

const V = {
  id: 'v-1', call_sign: 'VEH 11', make_model: 'Toyota LC300', plate: 'A 4439',
  region_code: 'AE', armored: true, armor_grade: 'B6', capacity: 5,
  status: 'on_mission', active: true,
} as const;

describe('VehiclePoolService', () => {
  describe('assign', () => {
    it('returns the existing vehicle on an already-assigned booking', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(V);
      const svc = new VehiclePoolService(db);
      const v = await svc.assign('b1', {region: 'AE', passengers: 2});
      expect(v.call_sign).toBe('VEH 11');
      // Never ran the claim UPDATE.
      expect(db.qOne).toHaveBeenCalledTimes(1);
    });

    it('claims the first available in-region vehicle with enough capacity', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);     // no existing assignment
      db.qOne.mockResolvedValueOnce(V);        // UPDATE ... RETURNING
      const svc = new VehiclePoolService(db);
      const v = await svc.assign('b2', {region: 'AE', passengers: 4});
      expect(v.id).toBe('v-1');
      // FK write onto lite_bookings happens via `q`.
      expect(db.q).toHaveBeenCalledWith(
        'UPDATE lite_bookings SET vehicle_id = $1 WHERE id = $2',
        ['v-1', 'b2'],
      );
    });

    it('surfaces no_vehicle_available when the pool is empty', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      db.qOne.mockResolvedValueOnce(null);
      const svc = new VehiclePoolService(db);
      await expect(svc.assign('b3', {region: 'AE', passengers: 1})).rejects.toMatchObject({
        message: 'no_vehicle_available',
      });
      // Lite-booking FK write NEVER runs after a failed claim.
      expect(db.q).not.toHaveBeenCalled();
    });

    it('threads the capacity + region filters into the SQL binds', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      db.qOne.mockResolvedValueOnce(V);
      const svc = new VehiclePoolService(db);
      await svc.assign('b4', {region: 'EU', passengers: 7, armored: true});
      const claimCall = db.qOne.mock.calls[1];
      expect(claimCall[1]).toEqual(['EU', 7, true]);
    });
  });

  describe('release', () => {
    it('flips the assigned vehicle back to available', async () => {
      const db = mockDb();
      const svc = new VehiclePoolService(db);
      await svc.release('b1');
      expect(db.q).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'available'"),
        ['b1'],
      );
    });
  });

  describe('getForBooking', () => {
    it('returns null when no vehicle is assigned', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      const svc = new VehiclePoolService(db);
      expect(await svc.getForBooking('b1')).toBeNull();
    });
  });
});
