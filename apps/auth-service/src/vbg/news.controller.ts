import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {NewsFeedService}    from './newsfeed.service';
import {NewsFeedQueryDto}   from './dto/vbg.dto';

/**
 * General news feed for the messenger News screens. Lives in the VBG module
 * because it inherits the VBG intel stack's news sources; guarded the same
 * way as /vbg/* (JWT first so req.user exists, then per-user throttle).
 */
@Controller('news')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class NewsController {
  constructor(private readonly news: NewsFeedService) {}

  // Feed opens + pref saves + pull-to-refresh; upstream is TTL-cached so a
  // generous bucket is safe.
  @Throttle({default: {limit: 20, ttl: 60_000}})
  @Get('feed')
  feed(@Query() q: NewsFeedQueryDto) {
    return this.news.feed(q.countries, q.categories);
  }

  // World sweep for the Bravo Intel map — server-cached per category,
  // shared by everyone.
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @Get('worldmap')
  worldMap(@Query() q: NewsFeedQueryDto) {
    return this.news.worldMap(q.categories);
  }
}
