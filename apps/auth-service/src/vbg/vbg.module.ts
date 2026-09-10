import {Module} from '@nestjs/common';
import {AuthModule}      from '../auth/auth.module';
import {SosModule}       from '../sos/sos.module';
import {OpsModule}       from '../ops/ops.module';
import {VbgController}   from './vbg.controller';
import {NewsController}  from './news.controller';
import {VbgService}      from './vbg.service';
import {GeocodeService}  from './geocode.service';
import {GdeltService}      from './gdelt.service';
import {NewsDataService}   from './newsdata.service';
import {GoogleNewsService} from './googlenews.service';
import {NewsFeedService}   from './newsfeed.service';
import {GeofenceService}   from './geofence.service';
import {SmsService}        from '../common/services/sms.service';

@Module({
  // AuthModule = JWT guards. SosModule = SosService (escalation reuse).
  // OpsModule exports OpsAuditService + MissionEventsService for the
  // live-feed + WS fan-out. AuditService (Kafka) + RedisService are
  // @Global. GeocodeService/GdeltService power region SRA/threats/keypoints;
  // GeofenceService does PostGIS breach eval; SmsService sends Twilio alerts.
  imports:     [AuthModule, SosModule, OpsModule],
  controllers: [VbgController, NewsController],
  providers:   [VbgService, GeocodeService, GdeltService, NewsDataService, GoogleNewsService, NewsFeedService, GeofenceService, SmsService],
  exports:     [VbgService],
})
export class VbgModule {}
