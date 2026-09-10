import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {AttendanceRollupService} from './attendance-rollup.service';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';

const mockDb = {q: jest.fn()};
const redisClient = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const mockRedis = {client: redisClient};
const mockConfig = {get: jest.fn()};

describe('AttendanceRollupService', () => {
  let svc: AttendanceRollupService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockConfig.get.mockReturnValue(true); // flag on
    redisClient.del.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceRollupService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService, useValue: mockRedis},
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    svc = module.get(AttendanceRollupService);
  });

  it('marks absent under the lock via an idempotent NOT EXISTS insert', async () => {
    redisClient.set.mockResolvedValueOnce('OK');
    mockDb.q.mockResolvedValueOnce([{id: 's1'}, {id: 's2'}]);
    const out = await svc.sweepOnce();
    expect(out).toEqual({marked: 2, skipped_lock: false, skipped_flag: false});
    expect(String(mockDb.q.mock.calls[0][0])).toMatch(/NOT EXISTS/);
    expect(String(mockDb.q.mock.calls[0][0])).toMatch(/'absent'/);
    expect(redisClient.eval).toHaveBeenCalled(); // lock released (fenced compare-and-delete)
  });

  /**
   * Scope v2 A7.2 — THE WORST BUG THIS PHASE COULD HAVE SHIPPED.
   *
   * Hiding draft-roster shifts from members (myTodayShift) also removed the
   * only way to clock in against them — but this sweep did not know that. It
   * would have written a PERMANENT `absent` HR record for every CPO assigned
   * inside a draft month, within minutes of the window closing, for a shift
   * they were never allowed to see. The visibility fix is what armed it.
   *
   * The gate must be the SAME shape as myTodayShift's: an unlinked shift is a
   * pre-v2 ad-hoc one and must keep being swept exactly as before, so this is a
   * LEFT JOIN with a NULL-permitting predicate, never an inner join.
   */
  it('never marks absent for a shift the CPO was not allowed to see', async () => {
    redisClient.set.mockResolvedValueOnce('OK');
    mockDb.q.mockResolvedValueOnce([]);
    await svc.sweepOnce();
    const sql = String(mockDb.q.mock.calls[0][0])
      .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/LEFT JOIN public\.cpo_roster_months rm ON rm\.id = s\.roster_month_id/);
    expect(sql).toMatch(/rm\.id IS NULL OR rm\.status IN \('published', 'amended'\)/);
    // draft and archived are exactly the two that must not appear
    const allowed = sql.match(/rm\.status IN \(([^)]*)\)/)?.[1] ?? '';
    expect(allowed).not.toMatch(/draft|archived/);
  });

  it('skips when another pod holds the lock', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    const out = await svc.sweepOnce();
    expect(out.skipped_lock).toBe(true);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('no-ops when the flag is off (never touches Redis)', async () => {
    mockConfig.get.mockReturnValue(false);
    const out = await svc.sweepOnce();
    expect(out.skipped_flag).toBe(true);
    expect(redisClient.set).not.toHaveBeenCalled();
  });
});
