import {CanActivate, ExecutionContext, ForbiddenException, Injectable} from '@nestjs/common';
import {DatabaseService} from '../../database/database.service';
import {resolveAccountKind} from '../../auth/account-kind';
import type {AccessClaims} from '../../auth/jwt.service';

/**
 * CpoSessionGuard — mid-session revocation for managed CPOs (§35A §B).
 *
 * Modeled on OrgManagerGuard: it RE-READS the DB every request (the discriminator
 * is never a JWT claim — auth-token security stop-condition), and ONLY callers
 * that resolve to account_kind='cpo' are gated. A CPO whose org_members.status
 * is no longer 'active' (suspended / removed) is ejected with
 * `agency_access_ended`; agency and individual callers pass through untouched.
 *
 * Apply AFTER JwtAuthGuard (so req.user is populated) on CPO-scoped routes. Do
 * NOT apply it to /auth/me — the app must still be able to read membership_status
 * there to route a revoked CPO to the "Your agency access has ended" screen.
 * No "skip in dev" branch.
 */
@Injectable()
export class CpoSessionGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{user?: AccessClaims}>();
    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    const {account_kind, membership_status} = await resolveAccountKind(this.db, claims.sub);
    if (account_kind === 'cpo' && membership_status !== 'active') {
      throw new ForbiddenException('agency_access_ended');
    }
    return true;
  }
}
