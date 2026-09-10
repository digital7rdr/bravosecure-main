import {Module} from '@nestjs/common';
import {UsersController} from './users.controller';
import {UsersService}    from './users.service';
import {AuthModule}      from '../auth/auth.module';

/**
 * Directory lookups for contact discovery. Imports AuthModule so the
 * controller can use `JwtAuthGuard` + the `@CurrentUser` decorator
 * (same pattern as KeysModule).
 */
@Module({
  imports:     [AuthModule],
  controllers: [UsersController],
  providers:   [UsersService],
})
export class UsersModule {}
