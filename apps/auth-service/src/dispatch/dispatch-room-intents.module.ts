import {Module} from '@nestjs/common';
import {DispatchRoomIntentsService} from './dispatch-room-intents.service';

/**
 * Standalone home for the Ops-Room membership-intent queue (BUILD_RUNBOOK Step 12/13).
 * Imports nothing but the @Global DatabaseService, so BOTH DispatchModule (the agency
 * drain controller) AND OrgModule (Step 13 crew-assign, which enqueues intents) can import
 * it without the Org↔Dispatch cycle — DispatchModule already imports OrgModule for
 * OrgManagerGuard, so OrgModule must NOT import DispatchModule. This tiny module sits below
 * both.
 */
@Module({
  providers: [DispatchRoomIntentsService],
  exports: [DispatchRoomIntentsService],
})
export class DispatchRoomIntentsModule {}
