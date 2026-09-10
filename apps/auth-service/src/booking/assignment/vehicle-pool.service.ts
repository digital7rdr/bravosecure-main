import {BadRequestException, Injectable, Logger} from '@nestjs/common';
import {DatabaseService, type Tx} from '../../database/database.service';

interface VehicleRow {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  colour: string | null;
  region_code: string;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
  status: 'available' | 'on_mission' | 'maintenance';
  active: boolean;
}

export interface AssignedVehicle {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  /** Issue 30 — kerbside identification. NULL when not recorded. */
  colour: string | null;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}

/**
 * Picks an armored vehicle for a booking and flips its status to
 * `on_mission`. Release happens when the booking completes / cancels.
 *
 * Selection strategy is intentionally simple: first available vehicle in
 * the booking's region that seats ≥ passengers. Once we wire dispatch
 * telemetry in Phase 2 this becomes proximity-weighted.
 */
@Injectable()
export class VehiclePoolService {
  private readonly log = new Logger(VehiclePoolService.name);

  constructor(private readonly db: DatabaseService) {}

  async assign(bookingId: string, opts: {region: string; passengers: number; armored?: boolean}): Promise<AssignedVehicle> {
    // Already assigned? Idempotent — return the existing row.
    const existing = await this.db.qOne<VehicleRow>(
      `SELECT v.*
         FROM lite_bookings b
         JOIN vehicle_pool v ON v.id = b.vehicle_id
        WHERE b.id = $1`,
      [bookingId],
    );
    if (existing) return this.toClient(existing);

    // Pick-and-lock in a single query so two concurrent confirms can't
    // grab the same vehicle.
    const picked = await this.db.qOne<VehicleRow>(
      `UPDATE vehicle_pool
          SET status = 'on_mission'
        WHERE id = (
          SELECT id FROM vehicle_pool
           WHERE active = TRUE
             AND status = 'available'
             AND region_code = $1
             AND capacity   >= $2
             AND ($3::boolean IS NULL OR armored = $3)
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      [opts.region, Math.max(1, opts.passengers), opts.armored ?? null],
    );
    if (!picked) {
      this.log.warn(`No vehicle available in ${opts.region} for ${bookingId}`);
      throw new BadRequestException('no_vehicle_available');
    }

    await this.db.q(
      `UPDATE lite_bookings SET vehicle_id = $1 WHERE id = $2`,
      [picked.id, bookingId],
    );
    this.log.log(`booking ${bookingId} → vehicle ${picked.call_sign}`);
    return this.toClient(picked);
  }

  /** Ops dispatch: claim a specific vehicle by ID. */
  async assignSpecific(bookingId: string, vehicleId: string, tx?: Tx): Promise<AssignedVehicle> {
    const q = tx ?? this.db;
    const picked = await q.qOne<VehicleRow>(
      `UPDATE vehicle_pool
          SET status = 'on_mission'
        WHERE id = $1
          AND active = TRUE
          AND status = 'available'
        RETURNING *`,
      [vehicleId],
    );
    if (!picked) throw new BadRequestException('vehicle_unavailable');
    await q.q(
      `UPDATE lite_bookings SET vehicle_id = $1 WHERE id = $2`,
      [picked.id, bookingId],
    );
    return this.toClient(picked);
  }

  /** List vehicles available in a region for the ops dispatch picker. */
  async listAvailable(region: string): Promise<AssignedVehicle[]> {
    const rows = await this.db.q<VehicleRow>(
      `SELECT * FROM vehicle_pool
        WHERE active = TRUE
          AND status = 'available'
          AND region_code = $1
        ORDER BY call_sign ASC`,
      [region],
    );
    return rows.map(this.toClient);
  }

  async release(bookingId: string): Promise<void> {
    await this.db.q(
      `UPDATE vehicle_pool
          SET status = 'available'
        WHERE id = (SELECT vehicle_id FROM lite_bookings WHERE id = $1)`,
      [bookingId],
    );
  }

  async getForBooking(bookingId: string): Promise<AssignedVehicle | null> {
    const row = await this.db.qOne<VehicleRow>(
      `SELECT v.*
         FROM lite_bookings b
         JOIN vehicle_pool v ON v.id = b.vehicle_id
        WHERE b.id = $1`,
      [bookingId],
    );
    return row ? this.toClient(row) : null;
  }

  private toClient(r: VehicleRow): AssignedVehicle {
    return {
      id: r.id,
      call_sign: r.call_sign,
      make_model: r.make_model,
      plate: r.plate,
      colour: r.colour ?? null,
      armored: r.armored,
      armor_grade: r.armor_grade,
      capacity: r.capacity,
    };
  }
}
