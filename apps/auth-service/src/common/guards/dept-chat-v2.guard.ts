import {CanActivate, ExecutionContext, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

/**
 * DeptChatV2Guard — gates the Department Chat v2 ADDITIONS (attendance
 * verification + incident reporting) behind the `featureFlags.deptChatV2` flag.
 *
 * Apply it PER-METHOD on the new v2 routes only — never on the controller class,
 * so the legacy /attendance/* surface (clock-in/out, /me, /org/sessions, edit)
 * stays byte-for-byte unchanged while the module ships dark.
 *
 * Throws 404 (not 403) when the flag is off so the v2 surface is invisible, not
 * merely forbidden. This gates the FEATURE only — it is layered AFTER the real
 * auth guards (JwtAuthGuard / OrgManagerGuard), never a substitute for them.
 */
@Injectable()
export class DeptChatV2Guard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(_ctx: ExecutionContext): boolean {
    if (!this.config.get<boolean>('featureFlags.deptChatV2')) {
      throw new NotFoundException();
    }
    return true;
  }
}
