import {ConflictException} from '@nestjs/common';
import {DispatchService} from './dispatch.service';
import type {DatabaseService} from '../database/database.service';
import type {BookingStateMachine} from '../booking/state-machine.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

function mk() {
  const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null), withTransaction: jest.fn()};
  const audit = {record: jest.fn().mockResolvedValue(undefined)};
  const push = {dispatchOffer: jest.fn().mockResolvedValue(undefined)};
  // refundEscrowHold: adminCancel's D4 refund of a (relist-only) HELD hold —
  // idempotent no-op on the uncharged paths these tests model.
  const wallet = {refundEscrowHold: jest.fn().mockResolvedValue({refunded: false, credits: 0})};
  const svc = new DispatchService(
    db as unknown as DatabaseService,
    {assert: jest.fn()} as unknown as BookingStateMachine,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
  );
  return {svc, db, audit, push, wallet};
}

describe('DispatchService — ops-console dispatch monitor', () => {
  it('fireTestDispatch inserts a DRAFT auto booking and runs the matchmaker', async () => {
    const {svc, db, audit} = mk();
    db.qOne.mockResolvedValue({id: 'b-test'});
    const start = jest.spyOn(svc, 'start').mockResolvedValue(undefined);
    const r = await svc.fireTestDispatch('adm-1', {region_code: 'AE', pickup_lat: 25.2, pickup_lng: 55.3, cpo_count: 2});
    expect(r).toEqual({booking_id: 'b-test'});
    expect(db.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO public\.lite_bookings[\s\S]*'DRAFT', 'auto'/),
      expect.arrayContaining(['adm-1', 'AE']),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.test_fire', subject_id: 'b-test'}));
    expect(start).toHaveBeenCalledWith('b-test');
  });

  it('fireTestDispatch clamps cpo_count to 1..4', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue({id: 'b1'});
    jest.spyOn(svc, 'start').mockResolvedValue(undefined);
    await svc.fireTestDispatch('adm-1', {region_code: 'AE', pickup_lat: 0, pickup_lng: 0, cpo_count: 99});
    const params = db.qOne.mock.calls[0][1] as unknown[];
    expect(params).toContain(4); // cpo_count clamped to 4
  });

  it('monitor returns the DISPATCHING bookings + recently-settled auto bookings', async () => {
    const {svc, db} = mk();
    db.q
      .mockResolvedValueOnce([{booking_id: 'b1', region_code: 'AE', offers: []}])
      .mockResolvedValueOnce([{booking_id: 'b2', status: 'CONFIRMED'}]);
    const m = await svc.monitor();
    expect(m.dispatching).toHaveLength(1);
    expect(m.recent).toHaveLength(1);
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/WHERE b\.status = 'DISPATCHING'/));
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/dispatch_mode = 'auto'/));
  });
});

describe('DispatchService — Step 26 admin overrides', () => {
  it('adminCancel cancels a DISPATCHING booking (race-safe) and reports cancelled', async () => {
    const {svc, db, push} = mk();
    const txQ = jest.fn()
      .mockResolvedValueOnce([{provider_user_id: 'agency-A'}]) // supersede RETURNING
      .mockResolvedValueOnce([{id: 'b1'}]);                    // booking flip RETURNING
    const txQOne = jest.fn().mockResolvedValue({status: 'DISPATCHING'});
    db.withTransaction.mockImplementation((fn: (t: unknown) => unknown) => fn({q: txQ, qOne: txQOne}));
    const r = await svc.adminCancel('b1');
    expect(r).toEqual({cancelled: true, superseded: ['agency-A']});
    expect(push.dispatchOffer).toHaveBeenCalledWith('agency-A', 'b1');
  });

  it('adminCancel reports NOT cancelled when the booking already moved on (→ controller 409)', async () => {
    const {svc, db} = mk();
    const txQOne = jest.fn().mockResolvedValue({status: 'CONFIRMED'}); // no longer DISPATCHING
    db.withTransaction.mockImplementation((fn: (t: unknown) => unknown) => fn({q: jest.fn(), qOne: txQOne}));
    const r = await svc.adminCancel('b1');
    expect(r.cancelled).toBe(false);
  });

  it('adminForceAssign binds the live offer via the accept saga', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue({id: 'o1', provider_user_id: 'agency-A'});
    const accept = jest.spyOn(svc, 'accept').mockResolvedValue({offer_id: 'o1', booking_id: 'b1', status: 'CONFIRMED'});
    const r = await svc.adminForceAssign('b1');
    expect(accept).toHaveBeenCalledWith('o1', 'agency-A');
    expect(r).toEqual({offer_id: 'o1', provider_user_id: 'agency-A', booking_id: 'b1'});
  });

  it('adminForceAssign 409s when there is no live offer to bind', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue(null);
    await expect(svc.adminForceAssign('b1')).rejects.toBeInstanceOf(ConflictException);
  });
});
