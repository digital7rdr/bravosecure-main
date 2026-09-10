import 'reflect-metadata';
import {OpsController} from './ops.controller';
import {REQUIRED_ROLES_KEY} from './admin.guard';

/**
 * AUTHZ-5 — every MUTATING mission/SOS ops endpoint must carry a @RequireRoles
 * gate. `sos/:id/ack` and `missions/:id/messages` shipped with none, so any
 * authenticated admin (incl. the lowest OPERATOR tier) could acknowledge a live
 * SOS or inject an "Ops"-authority message to a CPO/principal — while their
 * siblings (escalate/resolve/route-select) already required SUPERVISOR+.
 *
 * The AdminGuard reads REQUIRED_ROLES_KEY off the handler; a missing key means
 * "any admin". This pins the roles at the metadata level so the gate can't be
 * silently dropped again.
 */
function rolesOf(method: keyof OpsController): unknown {
  const fn = (OpsController.prototype as unknown as Record<string, unknown>)[method as string];
  return Reflect.getMetadata(REQUIRED_ROLES_KEY, fn as object);
}

describe('AUTHZ-5 — mutating SOS / mission-message ops endpoints require SUPERVISOR+', () => {
  it.each(['ackSos', 'escalateSos', 'resolveSos', 'sendMissionMessage', 'selectRoute'] as const)(
    '%s is gated to SUPERVISOR/ADMIN',
    (method) => {
      expect(rolesOf(method)).toEqual(['SUPERVISOR', 'ADMIN']);
    },
  );

  it('the read-only mission message list stays open to any admin (not over-gated)', () => {
    // GET is a read — the AdminGuard already authenticates it; no role narrowing.
    expect(rolesOf('listMissionMessages')).toBeUndefined();
  });
});
