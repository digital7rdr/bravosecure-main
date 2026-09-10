import 'reflect-metadata';
import {DispatchController} from './dispatch.controller';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {OrgManagerGuard} from '../org/org-manager.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {DispatchService} from './dispatch.service';
import type {OpsAuditService} from '../ops/ops-audit.service';

// Nest core metadata keys (stable across v10) — used to prove the security
// decorators are actually wired on the controller, not just intended.
const GUARDS_METADATA = '__guards__';
const INTERCEPTORS_METADATA = '__interceptors__';

const dispatch = {
  getCurrentOfferForOrg: jest.fn(),
  getFullOffer: jest.fn(),
  accept: jest.fn(),
  reject: jest.fn(),
};
const audit = {record: jest.fn()};

function controller(): DispatchController {
  return new DispatchController(dispatch as unknown as DispatchService, audit as unknown as OpsAuditService);
}

// req.orgManager is populated by OrgManagerGuard (verified in its own spec).
const req = {orgManager: {user_id: 'mgr-1', org_user_id: 'agency-A', department: null}};

describe('DispatchController', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
  });

  describe('current', () => {
    it('scopes the read to the resolved org', async () => {
      dispatch.getCurrentOfferForOrg.mockResolvedValue(null);
      await controller().current(req);
      expect(dispatch.getCurrentOfferForOrg).toHaveBeenCalledWith('agency-A');
    });
  });

  describe('full', () => {
    it('audits dispatch.full_read with the booking id AFTER fetching, then returns the dto', async () => {
      dispatch.getFullOffer.mockResolvedValue({booking_id: 'b1', pickup_lat: '25.2'});
      const dto = await controller().full(req, 'o1');
      expect(dispatch.getFullOffer).toHaveBeenCalledWith('agency-A', 'o1');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'dispatch.full_read', actor_id: 'mgr-1', subject_type: 'booking', subject_id: 'b1',
        metadata: {offer_id: 'o1', org_user_id: 'agency-A'},
      }));
      expect(dto).toEqual({booking_id: 'b1', pickup_lat: '25.2'});
    });

    it('is FAIL-CLOSED: if the audit cannot be written, the coords are NOT returned (LB1)', async () => {
      dispatch.getFullOffer.mockResolvedValue({booking_id: 'b1', pickup_lat: '25.2'});
      audit.record.mockRejectedValue(new Error('audit_insert_failed:dispatch.full_read'));
      await expect(controller().full(req, 'o1')).rejects.toThrow(/audit_insert_failed/);
    });
  });

  describe('accept', () => {
    it('passes the offer id + resolved org to the service', async () => {
      dispatch.accept.mockResolvedValue({offer_id: 'o1', booking_id: 'b1', status: 'CONFIRMED'});
      const res = await controller().accept(req, 'o1');
      expect(dispatch.accept).toHaveBeenCalledWith('o1', 'agency-A');
      expect(res).toEqual({offer_id: 'o1', booking_id: 'b1', status: 'CONFIRMED'});
    });
  });

  describe('reject', () => {
    it('passes the offer id + resolved org + reason, returns ok', async () => {
      dispatch.reject.mockResolvedValue(undefined);
      const res = await controller().reject(req, 'o1', {reason: 'too far'});
      expect(dispatch.reject).toHaveBeenCalledWith('o1', 'agency-A', 'too far');
      expect(res).toEqual({ok: true});
    });
  });

  describe('security wiring (decorator metadata)', () => {
    it('guards the controller with Jwt → OrgManager → Throttler, in that order', () => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, DispatchController) ?? []) as Array<new (...a: never[]) => unknown>;
      const names = guards.map(g => g.name);
      expect(names).toEqual([JwtAuthGuard.name, OrgManagerGuard.name, UserThrottlerGuard.name]);
    });

    it('wraps accept in the IdempotencyInterceptor (tap-safety)', () => {
      const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, DispatchController.prototype.accept) ?? []) as Array<new (...a: never[]) => unknown>;
      expect(interceptors.map(i => i.name)).toContain(IdempotencyInterceptor.name);
    });

    it('does NOT wrap the read/reject routes in the IdempotencyInterceptor', () => {
      for (const fn of [DispatchController.prototype.current, DispatchController.prototype.full, DispatchController.prototype.reject]) {
        const interceptors = (Reflect.getMetadata(INTERCEPTORS_METADATA, fn) ?? []) as Array<new (...a: never[]) => unknown>;
        expect(interceptors.map(i => i.name)).not.toContain(IdempotencyInterceptor.name);
      }
    });
  });
});
