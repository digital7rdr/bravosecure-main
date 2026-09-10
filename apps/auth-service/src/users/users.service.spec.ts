import {Test} from '@nestjs/testing';
import {UsersService} from './users.service';
import {DatabaseService} from '../database/database.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};

describe('UsersService.lookupByPhones', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        {provide: DatabaseService, useValue: mockDb},
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('returns mapped rows for matching phones, excluding the caller', async () => {
    mockDb.q.mockResolvedValueOnce([
      {id: 'u-bob',   phone_e164: '+14155551000', display_name: 'Bob',   avatar_url: null},
      {id: 'u-carol', phone_e164: '+14155552000', display_name: 'Carol', avatar_url: 'https://cdn.example/c.png'},
    ]);

    const res = await service.lookupByPhones(
      ['+14155551000', '+14155552000', '+14155559999'],
      'u-alice',
    );

    expect(res).toEqual([
      {phone: '+14155551000', userId: 'u-bob',   displayName: 'Bob',   avatarUrl: null},
      {phone: '+14155552000', userId: 'u-carol', displayName: 'Carol', avatarUrl: 'https://cdn.example/c.png'},
    ]);

    const [sql, params] = mockDb.q.mock.calls[0];
    expect(params[0]).toEqual(['+14155551000', '+14155552000', '+14155559999']);
    expect(params[1]).toBe('u-alice');
    // The query must filter blocks in BOTH directions so a block hides
    // both parties from each other's directory. Either alias prefix is
    // acceptable — we only care that both orderings are present.
    expect(sql).toMatch(/blocker_user_id\s*=\s*\$2\s+AND\s+b?\.?blocked_user_id\s*=\s*u\.id/);
    expect(sql).toMatch(/blocker_user_id\s*=\s*u\.id\s+AND\s+b?\.?blocked_user_id\s*=\s*\$2/);
  });

  it('deduplicates phones before querying', async () => {
    mockDb.q.mockResolvedValueOnce([]);
    await service.lookupByPhones(['+11111111111', '+11111111111', '+12222222222'], 'caller');
    const [, params] = mockDb.q.mock.calls[0];
    expect(params[0]).toEqual(['+11111111111', '+12222222222']);
  });

  it('returns [] without hitting the DB when given an empty list', async () => {
    const res = await service.lookupByPhones([], 'caller');
    expect(res).toEqual([]);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('returns [] when DB has no matches', async () => {
    mockDb.q.mockResolvedValueOnce([]);
    const res = await service.lookupByPhones(['+19999999999'], 'caller');
    expect(res).toEqual([]);
  });
});

describe('UsersService.updatePreferences — Step 25', () => {
  let service: UsersService;
  const meRow = {
    id: 'u1', display_name: 'A', email: 'a@x.com', phone_e164: null, bio: null, avatar_url: null,
    last_seen_visible: true, read_receipts_enabled: true,
    language: 'ar', currency: 'AED', notif_prefs: {trip: true, marketing: false, safety: true},
    location_scope: 'while_on_duty', app_lock: false,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.qOne.mockResolvedValue(meRow); // getMe read after the update
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, {provide: DatabaseService, useValue: mockDb}],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('forces notif_prefs.safety = true even when the client tries to disable it', async () => {
    await service.updatePreferences('u1', {notifPrefs: {safety: false, marketing: false}});
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    expect(updateCall?.[0]).toMatch(/notif_prefs = \$\d+::jsonb/);
    const jsonParam = (updateCall?.[1] as unknown[]).find(p => typeof p === 'string' && (p as string).includes('safety'));
    expect(JSON.parse(jsonParam as string)).toEqual({safety: true, marketing: false});
  });

  it('drops non-boolean notif_prefs values (keeps the Record<string,boolean> contract)', async () => {
    await service.updatePreferences('u1', {
      notifPrefs: {trip: true, marketing: 'yes' as never, junk: 5 as never},
    });
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    const jsonParam = (updateCall?.[1] as unknown[]).find(p => typeof p === 'string' && (p as string).includes('safety'));
    expect(JSON.parse(jsonParam as string)).toEqual({trip: true, safety: true});
  });

  it('persists language/currency/location_scope/app_lock and re-forces safety on read', async () => {
    const me = await service.updatePreferences('u1', {language: 'ar', currency: 'AED', appLock: true});
    expect(me.notifPrefs.safety).toBe(true);
    const updateCall = mockDb.q.mock.calls.find(([sql]: [string]) => /UPDATE public\.users/.test(sql));
    expect(updateCall?.[0]).toMatch(/language = \$1/);
  });

  it('no-ops the UPDATE when nothing is supplied (still returns Me)', async () => {
    const me = await service.updatePreferences('u1', {});
    expect(mockDb.q).not.toHaveBeenCalled();
    expect(me.id).toBe('u1');
  });
});

/**
 * B-246 — "search with a number to message someone says no account found".
 *
 * Seven rows in prod predate E.164 normalisation at registration and store the
 * number nationally ("01878547473", "0507356048"). The searcher types the
 * correct "+8801878547473", the client normalises it correctly, and the exact
 * lookup returns nothing — for an account that plainly exists.
 *
 * The rescue is a national-significant-number comparison, and the PRECEDENCE
 * RULE is the entire safety argument. Verified against the live table before
 * writing it: "0507356048" (a legacy row, user "John Deer") shares its national
 * number with "+971507356048", which belongs to a DIFFERENT user. Matching
 * nationals unconditionally would return both and let the client open a chat
 * with the wrong person — strictly worse than the bug being fixed, in an app
 * where the wrong recipient means a leaked message.
 */
describe('UsersService.lookupByPhones — B-246 legacy national-format rescue', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, {provide: DatabaseService, useValue: mockDb}],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('finds a legacy national-format row from a correct E.164 search', async () => {
    mockDb.q
      .mockResolvedValueOnce([])   // exact: misses, because the row has no "+"
      .mockResolvedValueOnce([
        {id: 'u-arif', phone_e164: '01878547473', display_name: 'Arif', avatar_url: null},
      ]);

    const res = await service.lookupByPhones(['+8801878547473'], 'u-caller');

    expect(res).toEqual([
      {phone: '01878547473', userId: 'u-arif', displayName: 'Arif', avatarUrl: null},
    ]);
    // The national significant number: digits, leading zeros stripped.
    const [, params] = mockDb.q.mock.calls[1];
    expect(params[0]).toEqual(['8801878547473']);
  });

  it('does NOT run the fallback when the number matched exactly', async () => {
    // THE COLLISION CASE. "+971507356048" belongs to Ranger Danger; the legacy
    // row "0507356048" (John Deer) has the same national digits. An exact hit
    // must end it — otherwise the caller could be handed John Deer.
    mockDb.q.mockResolvedValueOnce([
      {id: 'u-ranger', phone_e164: '+971507356048', display_name: 'Ranger Danger', avatar_url: null},
    ]);

    const res = await service.lookupByPhones(['+971507356048'], 'u-caller');

    expect(res).toEqual([
      {phone: '+971507356048', userId: 'u-ranger', displayName: 'Ranger Danger', avatarUrl: null},
    ]);
    expect(mockDb.q).toHaveBeenCalledTimes(1);   // no second query at all
  });

  it('applies the fallback PER-CANDIDATE, not per-batch', async () => {
    // The contact sweep sends hundreds of numbers at once. If one exact hit
    // suppressed the fallback for the whole batch, a legacy contact would stay
    // invisible for everyone with at least one normal contact — i.e. everyone.
    mockDb.q
      .mockResolvedValueOnce([
        {id: 'u-bob', phone_e164: '+14155551000', display_name: 'Bob', avatar_url: null},
      ])
      .mockResolvedValueOnce([
        {id: 'u-arif', phone_e164: '01878547473', display_name: 'Arif', avatar_url: null},
      ]);

    const res = await service.lookupByPhones(['+14155551000', '+8801878547473'], 'u-caller');

    expect(res.map(r => r.userId)).toEqual(['u-bob', 'u-arif']);
    const [, params] = mockDb.q.mock.calls[1];
    // Only the UNMATCHED candidate is carried into the fallback.
    expect(params[0]).toEqual(['8801878547473']);
  });

  it('never re-lists a user already returned by the exact query', async () => {
    mockDb.q
      .mockResolvedValueOnce([
        {id: 'u-bob', phone_e164: '+14155551000', display_name: 'Bob', avatar_url: null},
      ])
      .mockResolvedValueOnce([]);

    await service.lookupByPhones(['+14155551000', '+8801878547473'], 'u-caller');

    const [, params] = mockDb.q.mock.calls[1];
    expect(params[2]).toEqual(['u-bob']);   // excluded by id
  });

  it('only ever matches rows that are THEMSELVES malformed', async () => {
    // The blast radius is the point: well-formed rows keep strict exact
    // matching, so a correct number can never resolve to someone else.
    mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.lookupByPhones(['+8801878547473'], 'u-caller');
    const [sql] = mockDb.q.mock.calls[1];
    // Literal, not a regex — the SQL contains a backslash and fighting two
    // layers of escaping is how this assertion silently rots into a no-op.
    // Asserted as fragments WITHOUT the backslash: the SQL escapes it for
    // Postgres and the test file escapes it again for JS, and fighting both
    // layers is exactly how an assertion silently rots into a no-op.
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('u.phone_e164 !~');       // malformed rows ONLY
    expect(flat).toContain("regexp_replace(u.phone_e164, '[^0-9]', '', 'g')");
  });

  it('ignores candidates too short to be a real subscriber number', async () => {
    // Guards the junk rows in the table ("123456789", "00000000000") — a
    // fat-fingered short entry must not reach them.
    mockDb.q.mockResolvedValueOnce([]);
    await service.lookupByPhones(['+123456'], 'u-caller');
    expect(mockDb.q).toHaveBeenCalledTimes(1);
  });

  it('still filters blocks in both directions on the fallback path', async () => {
    // The rescue path is a second query and would otherwise be a way around
    // the block list.
    mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.lookupByPhones(['+8801878547473'], 'u-caller');
    const [sql] = mockDb.q.mock.calls[1];
    expect(sql).toMatch(/blocker_user_id\s*=\s*\$2\s+AND\s+b?\.?blocked_user_id\s*=\s*u\.id/);
    expect(sql).toMatch(/blocker_user_id\s*=\s*u\.id\s+AND\s+b?\.?blocked_user_id\s*=\s*\$2/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it('excludes the caller on the fallback path too', async () => {
    mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.lookupByPhones(['+8801878547473'], 'u-caller');
    const [sql, params] = mockDb.q.mock.calls[1];
    expect(sql).toMatch(/u\.id\s*<>\s*\$2/);
    expect(params[1]).toBe('u-caller');
  });
});
