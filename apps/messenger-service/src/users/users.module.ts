import {Global, Module} from '@nestjs/common';
import {UserPrivacyService} from './user-privacy.service';

/**
 * M-06 / M-07 — privacy flags (last-seen visibility, blocks) read from
 * the shared Postgres via the Supabase service-role client. @Global for
 * the same reason as ConnectionRegistryModule: both the gateway and
 * PresenceService (which lives in a global module) consume it.
 */
@Global()
@Module({
  providers: [UserPrivacyService],
  exports:   [UserPrivacyService],
})
export class UsersModule {}
