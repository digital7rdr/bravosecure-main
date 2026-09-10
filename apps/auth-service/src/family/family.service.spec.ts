import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {GeocodeService}      from '../vbg/geocode.service';
import {BookingPushBridge}   from '../ops/booking-push-bridge.service';
import {OpsAuditService}     from '../ops/ops-audit.service';
import {FamilyService}       from './family.service';
import {FamilyQuotaService}  from './family-quota.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockGeocode = {
  reverse: jest.fn().mockResolvedValue({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: 0, lng: 0}),
};
// R-3 — invite/accept wakes; fire-and-forget so resolved mocks suffice.
const mockPush = {
  familyInvite: jest.fn().mockResolvedValue(undefined),
  familyInviteAccepted: jest.fn().mockResolvedValue(undefined),
};
// #7 (D2) — the seat-increase request files an ops-feed row via emit().
const mockOpsAudit = {emit: jest.fn().mockResolvedValue(undefined)};
// Quota control plane. `setSpendLimit` now delegates here (spec §19 moved the
// guard + audit write into it), and `revoke` closes any open credit request.
// Its own rules are covered by family-quota.service.spec.ts.
const mockQuota = {
  setQuota: jest.fn().mockResolvedValue({ok: true, previousLimit: null, newLimit: 0, spent: 0, remaining: 0}),
  cancelPendingOnRevoke: jest.fn().mockResolvedValue(undefined),
  notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  notifyUsageThresholdForMember: jest.fn().mockResolvedValue(undefined),
  rearmUsageThreshold: jest.fn().mockResolvedValue(undefined),
};

describe('FamilyService', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockGeocode.reverse.mockResolvedValue({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: 0, lng: 0});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: GeocodeService, useValue: mockGeocode},
        {provide: BookingPushBridge, useValue: mockPush},
        {provide: OpsAuditService, useValue: mockOpsAudit},
        {provide: FamilyQuotaService, useValue: mockQuota},
      ],
    }).compile();
    svc = module.get(FamilyService);
  });

  describe('invite', () => {
    // qOne order: target lookup → resolveAccountKind → active count →
    // in-another-family → dupe check → insert. (The old 4-mock sequences
    // predated the account-kind + dupe checks and were silently misaligned.)
    it('creates a pending invite for a registered phone', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000001'}) // phone → user
        .mockResolvedValueOnce(null)          // account-kind row (null → individual default)
        .mockResolvedValueOnce({n: 0})        // active count
        .mockResolvedValueOnce(null)          // not in another family
        .mockResolvedValueOnce(null)          // no pending/active dupe
        .mockResolvedValueOnce({id: 'fm-1'}); // insert
      const res = await svc.invite('u-holder', '+971500000001', 200);
      expect(res).toEqual({id: 'fm-1', status: 'pending'});
    });

    it('rejects inviting yourself', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'u-holder', phone_e164: '+971500000000'});
      await expect(svc.invite('u-holder', '+971500000000')).rejects.toThrow(BadRequestException);
    });

    it('rejects an unregistered phone (founder rule: must already be a Bravo user)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // phone not registered
      await expect(svc.invite('u-holder', '+971500000009')).rejects.toThrow(/not_a_bravo_user/);
    });

    it('rejects when the family is full (4 active)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000009'})
        .mockResolvedValueOnce(null)       // account-kind → individual
        .mockResolvedValueOnce({n: 4});    // active count
      await expect(svc.invite('u-holder', '+971500000009')).rejects.toThrow(/family_full/);
    });

    it('rejects an invalid phone', async () => {
      await expect(svc.invite('u-holder', 'nope')).rejects.toThrow(/invalid_phone/);
    });
  });

  // #7 (D2) — the 4/4 escape hatch. Self-serve `invite` stays hard-capped (the
  // family_full test above still holds); this only ASKS Ops for more seats.
  describe('requestSeats', () => {
    it('files an ops-feed request stamped with the current active count, and never throws', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 4}); // active count at the cap
      const res = await svc.requestSeats('u-holder');
      expect(res).toEqual({ok: true});
      expect(mockOpsAudit.emit).toHaveBeenCalledTimes(1);
      const ev = mockOpsAudit.emit.mock.calls[0][0];
      expect(ev.kind).toBe('family');
      expect(ev.subject).toBe('u-holder');
      expect(ev.message).toMatch(/4\/4/);
      expect(ev.metadata).toMatchObject({holderId: 'u-holder', activeCount: 4, maxSeats: 4});
    });

    it('still emits (and returns ok) even if the count lookup comes back empty', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.requestSeats('u-holder')).resolves.toEqual({ok: true});
      expect(mockOpsAudit.emit).toHaveBeenCalledTimes(1);
      expect(mockOpsAudit.emit.mock.calls[0][0].metadata.activeCount).toBeNull();
    });
  });

  describe('accept', () => {
    it('binds the member and activates', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)            // not active elsewhere
        .mockResolvedValueOnce({id: 'fm-1'});   // update returns row
      await expect(svc.accept('u-member', 'fm-1')).resolves.toEqual({ok: true});
    });
    it('refuses if already in a family', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-other'});
      await expect(svc.accept('u-member', 'fm-1')).rejects.toThrow(/already_in_a_family/);
    });
  });

  describe('resolvePayer (billing hook)', () => {
    it('returns the holder for an active member', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        id: 'fm-1', holder_id: 'u-holder', spend_limit_credits: 500, spent_credits: 100,
        holder_suspended_at: null,
      });
      const res = await svc.resolvePayer('u-member');
      expect(res).toEqual({
        payerId: 'u-holder', familyRowId: 'fm-1', spendLimit: 500, spent: 100,
        holderSuspended: false,
      });
    });
    it('returns the user themselves when not a member (identity)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await svc.resolvePayer('u-stranger');
      expect(res).toEqual({
        payerId: 'u-stranger', familyRowId: null, spendLimit: null, spent: 0,
        holderSuspended: false,
      });
    });

    // Spec §21 — a suspended ROOT account stops every member draw on it, even
    // though the member's own quota is untouched. Surfaced as a flag here and
    // turned into ROOT_ACCOUNT_SUSPENDED by the charge sites, so the member is
    // told the real reason instead of a limit message (§9's principle).
    it('flags a SUSPENDED holder', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        id: 'fm-1', holder_id: 'u-holder', spend_limit_credits: 5000, spent_credits: 0,
        holder_suspended_at: new Date(),
      });
      const res = await svc.resolvePayer('u-member');
      expect(res).toMatchObject({payerId: 'u-holder', holderSuspended: true, spendLimit: 5000});
    });

    it('reads the holder suspension in the SAME query as the membership', async () => {
      // Two separate reads could straddle a suspension and miss it.
      mockDb.qOne.mockResolvedValueOnce(null);
      await svc.resolvePayer('u-member');
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      // Both tokens, asserted independently — the projection precedes the JOIN
      // in SQL, so an ordered regex would pin the wrong thing (and would have
      // passed only by accident if it matched at all).
      expect(sql).toMatch(/h\.suspended_at AS holder_suspended_at/);
      expect(sql).toMatch(/JOIN public\.users h ON h\.id = fm\.holder_id/);
    });
  });

  describe('reportLocation (member last fix)', () => {
    const fix = {lat: 25.2048, lng: 55.2708, accuracyM: 12};

    it('upserts the fix with a server-side geocode label for an eligible member', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'}); // eligibility hit
      const res = await svc.reportLocation('u-member', fix);
      expect(res).toEqual({ok: true, reported: true});
      expect(mockGeocode.reverse).toHaveBeenCalledWith(25.2048, 55.2708);
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO public\.family_member_locations[\s\S]*ON CONFLICT \(user_id\) DO UPDATE/),
        ['u-member', 25.2048, 55.2708, 12, 'Benoni'],
      );
    });

    it('gates eligibility on ACTIVE + not-held + the permissive location scope in SQL', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', fix);
      const sql = (mockDb.qOne.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain(`fm.status = 'active'`);
      expect(sql).toContain('fm.held_until IS NULL OR fm.held_until <= NOW()');
      // Only the broad default shares; both narrower user choices
      // ('during_mission', 'never') exclude continuous family sharing.
      expect(sql).toContain(`u.location_scope = 'while_on_duty'`);
    });

    it('is a silent no-op for a non-member / held / opted-out caller — nothing stored', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await svc.reportLocation('u-stranger', fix);
      expect(res).toEqual({ok: true, reported: false});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockGeocode.reverse).not.toHaveBeenCalled();
    });

    it.each([
      [{lat: 91, lng: 10}],
      [{lat: 10, lng: 181}],
      [{lat: 0, lng: 0}],          // null island — a failed-fix sentinel, never real
      [{lat: NaN, lng: 10}],
    ])('rejects invalid coordinates %j before touching the db', async bad => {
      await expect(svc.reportLocation('u-member', bad as never)).rejects.toThrow(/invalid_coordinates/);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('stores a null accuracy when the client sends none', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', {lat: 1, lng: 2});
      expect(mockDb.q).toHaveBeenCalledWith(expect.any(String), ['u-member', 1, 2, null, 'Benoni']);
    });

    it('stores a null accuracy on the WIRE shape too (controller coalesces to null — Number(null) is 0)', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', {lat: 1, lng: 2, accuracyM: null});
      expect(mockDb.q).toHaveBeenCalledWith(expect.any(String), ['u-member', 1, 2, null, 'Benoni']);
    });
  });

  describe('listMembers (owner view)', () => {
    it('exposes lastLocation only through the active+non-held SQL gate and maps it', async () => {
      mockDb.q.mockResolvedValueOnce([{
        id: 'fm-1', member_id: 'u-m', invite_phone: null, status: 'active',
        relationship: 'Brother', held_until: null, spend_limit_credits: 1000,
        spent_credits: 0, invited_at: new Date('2026-08-01T00:00:00Z'),
        accepted_at: new Date('2026-08-02T00:00:00Z'), display_name: 'Ranger Danger',
        avatar_url: null, loc_lat: 25.1, loc_lng: 55.2, loc_label: 'Benoni',
        loc_accuracy_m: 15, loc_recorded_at: new Date('2026-08-04T10:00:00Z'),
      }, {
        id: 'fm-2', member_id: 'u-p', invite_phone: null, status: 'pending',
        relationship: 'Father', held_until: null, spend_limit_credits: null,
        spent_credits: 0, invited_at: new Date('2026-08-03T00:00:00Z'),
        accepted_at: null, display_name: 'Leon', avatar_url: null,
        loc_lat: null, loc_lng: null, loc_label: null, loc_accuracy_m: null, loc_recorded_at: null,
      }]);
      const out = await svc.listMembers('u-holder');
      expect(out[0].lastLocation).toEqual({
        lat: 25.1, lng: 55.2, label: 'Benoni', accuracyM: 15,
        recordedAt: '2026-08-04T10:00:00.000Z',
      });
      expect(out[1].lastLocation).toBeNull();
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      // The join itself must refuse pending/held rows — not just the mapper.
      expect(sql).toContain(`AND fm.status = 'active' AND (fm.held_until IS NULL OR fm.held_until <= NOW())`);
    });
  });

  describe('memberSpend (owner itemised view)', () => {
    it('404s for a foreign member row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.memberSpend('u-holder', 'fm-x')).rejects.toThrow(NotFoundException);
    });

    it('returns empty lists for a pending (unbound) invite', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_id: null, spend_limit_credits: null, spent_credits: 0, display_name: null, invite_phone: '+971' });
      const out = await svc.memberSpend('u-holder', 'fm-p');
      expect(out.byFeature).toEqual([]);
      expect(out.transactions).toEqual([]);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('itemises the holder-wallet ledger by actor with feature grouping', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_id: 'u-m', spend_limit_credits: 1000, spent_credits: 344, display_name: 'Ranger Danger', invite_phone: null});
      mockDb.q
        .mockResolvedValueOnce([{ // transactions
          id: 't1', type: 'payment', amount_credits: -344, description: 'Escrow hold b1',
          booking_id: 'b1', feature: 'booking', created_at: new Date('2026-08-04T09:00:00Z'),
        }, {
          id: 't2', type: 'refund', amount_credits: 100, description: 'Refund · booking b0 cancelled',
          booking_id: 'b0', feature: 'booking', created_at: new Date('2026-08-03T09:00:00Z'),
        }])
        .mockResolvedValueOnce([{feature: 'booking', spent: 344, refunded: 100, n: 2}, {feature: null, spent: 5, refunded: 0, n: 1}]);
      const out = await svc.memberSpend('u-holder', 'fm-1');
      expect(out.member).toEqual({id: 'fm-1', name: 'Ranger Danger', spent: 344, spendLimit: 1000});
      expect(out.transactions[0]).toEqual({
        id: 't1', type: 'payment', feature: 'booking', description: 'Escrow hold b1',
        amount: -344, bookingId: 'b1', at: '2026-08-04T09:00:00.000Z',
      });
      expect(out.byFeature).toEqual([
        {feature: 'booking', spent: 344, refunded: 100, count: 2},
        {feature: 'other', spent: 5, refunded: 0, count: 1},
      ]);
      // Scoped: holder wallet rows, keyed on the member as actor.
      const txSql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(txSql).toContain(`WHERE user_id = $1 AND actor_user_id = $2 AND type IN ('payment','refund')`);
      expect(mockDb.q.mock.calls[0][1]).toEqual(['u-holder', 'u-m', 50]);
    });
  });

  describe('usage (holder rollup)', () => {
    it('keys recent rows on the actor stamp — never the description LIKE-match', async () => {
      mockDb.q
        .mockResolvedValueOnce([{id: 'fm-1', member_id: 'u-m', invite_phone: null, spent_credits: 300, spend_limit_credits: 1000, display_name: 'Ranger'}])
        .mockResolvedValueOnce([{amount_credits: -300, created_at: new Date('2026-08-04T00:00:00Z'), booking_id: 'b1', display_name: 'Ranger'}]);
      const out = await svc.usage('u-holder');
      expect(out.recent).toEqual([{name: 'Ranger', credits: 300, at: '2026-08-04T00:00:00.000Z', bookingId: 'b1'}]);
      const sql = (mockDb.q.mock.calls[1][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain('wt.actor_user_id IS NOT NULL');
      expect(sql).not.toContain('LIKE');
    });
  });

  describe('revoke', () => {
    it('also purges the removed member\'s stored location (privacy hygiene)', async () => {
      await svc.revoke('u-holder', 'fm-1');
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM public\.family_member_locations/),
        ['fm-1', 'u-holder'],
      );
    });
  });
});
