import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {DispatchService} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

/**
 * Job-Portal marketplace paths (JOB_PORTAL_MARKETPLACE_SPEC §2/§3 + R12):
 * claimOpenBooking (pull-claim), withdrawBooking (relist), and the noProvider
 * refund of a persisted HELD hold. The shared settle tail (settleWonOffer) is
 * exercised through the claim path — escrow charge, single-writer CONFIRMED
 * flip, sibling supersede.
 */
const fsm = new BookingStateMachine(); // real FSM (pure logic)
const audit = {record: jest.fn()};
const push = {
  dispatchOffer: jest.fn(), providerAccepted: jest.fn(), noProvider: jest.fn(),
  paymentFailed: jest.fn(), bookingReDispatching: jest.fn(),
};
const wallet = {holdToEscrow: jest.fn(), refundEscrowHold: jest.fn()};
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};

function service(): DispatchService {
  return new DispatchService(
    db as unknown as DatabaseService, fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
  );
}

interface Wire {
  claimBooking?: {status: string; client_id: string; region_code?: string; cpo_count?: number;
                  requirements?: Record<string, unknown> | null; armed_required?: boolean;
                  dispatch_mode?: string | null} | null;
  agent?: {type: string; status: string; cooldown_until: Date | null} | null;
  eligible?: boolean;
  capacity?: boolean;
  priorSeen?: boolean;                 // R9 exclusion row exists
  winRows?: Array<{id: string}>;       // claim's win-existing-OFFERED UPDATE
  settleBooking?: {status: string; client_id: string; payer_user_id: string | null; total_eur: string} | null;
  existingHold?: boolean;              // escrow idempotency anchor
  confirmRows?: number;                // CONFIRMED flip row count
  withdrawBooking?: {status: string; client_id: string; assigned_provider_user_id: string | null} | null;
  withdrawMission?: {id: string} | null;
  withdrawFlipRows?: number;
  noProviderLock?: {status: string; client_id: string; region_code: string | null} | null;
  noProviderRows?: number;
  abandonLock?: {status: string} | null; // handleChargeFailure's abandonUnstarted lock read
  payerUserId?: string | null;           // B-384 — family holder on the charge-failure read
}

function wire(w: Wire): {q: jest.Mock; qOne: jest.Mock} {
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT status, client_id, region_code, cpo_count, requirements, armed_required/.test(sql)) {
      return Promise.resolve(w.claimBooking ?? null);
    }
    if (/FROM public\.agents WHERE user_id = \$1/.test(sql)) return Promise.resolve(w.agent ?? null);
    if (/is_eligible_for_dispatch\(\$1, \$2, \$3::jsonb\) AS ok/.test(sql)) {
      return Promise.resolve({ok: w.eligible ?? true});
    }
    if (/has_free_cpo_capacity\(\$1, \$2\) AS ok/.test(sql)) return Promise.resolve({ok: w.capacity ?? true});
    if (/SELECT 1 AS x FROM dispatch_offers/.test(sql)) return Promise.resolve(w.priorSeen ? {x: 1} : null);
    if (/INSERT INTO dispatch_offers/.test(sql)) return Promise.resolve({id: 'o-claim'});
    if (/SELECT status, client_id, payer_user_id, total_eur FROM lite_bookings/.test(sql)) {
      return Promise.resolve(w.settleBooking ?? null);
    }
    if (/SELECT booking_id FROM escrow_holds WHERE booking_id = \$1/.test(sql)) {
      return Promise.resolve(w.existingHold ? {booking_id: 'b1'} : null);
    }
    if (/SELECT status, client_id, assigned_provider_user_id/.test(sql)) {
      return Promise.resolve(w.withdrawBooking ?? null);
    }
    if (/SELECT id FROM missions WHERE booking_id = \$1 AND status <> 'ABORTED'/.test(sql)) {
      return Promise.resolve(w.withdrawMission ?? null);
    }
    if (/SELECT status, client_id, region_code FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve(w.noProviderLock ?? null);
    }
    // B-384 — the charge-failure handler also reads payer_user_id so a
    // family-permission block can wake the HOLDER, not just the member.
    if (/SELECT client_id, payer_user_id FROM lite_bookings WHERE id = \$1/.test(sql)) {
      return Promise.resolve({client_id: 'c1', payer_user_id: w.payerUserId ?? null});
    }
    if (/SELECT status FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve(w.abandonLock ?? null);
    }
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string) => {
    if (/UPDATE dispatch_offers SET status = 'ACCEPTED'/.test(sql)) return Promise.resolve(w.winRows ?? []);
    if (/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/.test(sql)) {
      return Promise.resolve(new Array(w.confirmRows ?? 1).fill({id: 'b1'}));
    }
    if (/SET status = 'DISPATCHING',\s+assigned_provider_user_id = NULL/.test(sql)) {
      return Promise.resolve(new Array(w.withdrawFlipRows ?? 1).fill({id: 'b1'}));
    }
    if (/UPDATE lite_bookings SET status = 'NO_PROVIDER'/.test(sql)) {
      return Promise.resolve(new Array(w.noProviderRows ?? 1).fill({id: 'b1'}));
    }
    // OPS_APPROVED→DISPATCHING claim flip / abandon CANCELLED / supersedes / accounting
    return Promise.resolve([{id: 'b1'}]);
  });
  return {q: db.q, qOne: db.qOne};
}

const CLAIM_BOOKING = {
  status: 'DISPATCHING', client_id: 'c1', region_code: 'AE', cpo_count: 1,
  requirements: {} as Record<string, unknown>, armed_required: false,
  dispatch_mode: 'auto' as string | null,
};
const AGENT_OK = {type: 'company', status: 'ACTIVE', cooldown_until: null};
const SETTLE_OK = {status: 'DISPATCHING', client_id: 'c1', payer_user_id: null, total_eur: '100'};

describe('DispatchService.claimOpenBooking (Job Portal pull-claim)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.providerAccepted.mockResolvedValue(undefined);
    push.paymentFailed.mockResolvedValue(undefined);
    wallet.holdToEscrow.mockResolvedValue({currency: 'AED'});
    wallet.refundEscrowHold.mockResolvedValue({refunded: true, credits: 100});
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('DISPATCHING booking → mints a rank-0 ACCEPTED offer, charges escrow, flips CONFIRMED', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK});
    const res = await service().claimOpenBooking('b1', 'agency-A');
    expect(res).toEqual({offer_id: 'o-claim', booking_id: 'b1', status: 'CONFIRMED'});
    // Born ACCEPTED — never OFFERED (spec R7: the expiry sweep can't race a claim).
    expect(db.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO dispatch_offers[\s\S]*'ACCEPTED'/),
      ['b1', 'agency-A'],
    );
    expect(wallet.holdToEscrow).toHaveBeenCalledTimes(1);
    // The single-writer flip (settleWonOffer) ran with this provider.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/SET status = 'CONFIRMED', assigned_provider_user_id = \$2/),
      ['b1', 'agency-A', 15],
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.claim'}));
    expect(push.providerAccepted).toHaveBeenCalledWith('c1', 'b1');
  });

  it('OPS_APPROVED booking → flips into DISPATCHING before settling + audits BOTH hops', async () => {
    wire({claimBooking: {...CLAIM_BOOKING, status: 'OPS_APPROVED'}, agent: AGENT_OK, settleBooking: SETTLE_OK});
    await service().claimOpenBooking('b1', 'agency-A');
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/SET status = 'DISPATCHING', dispatch_started_at = NOW\(\)[\s\S]*status = 'OPS_APPROVED'/),
      ['b1'],
    );
    // LM-V6 — the OPS_APPROVED→DISPATCHING hop gets its own timeline row.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO lite_booking_audit/),
      ['b1', 'OPS_APPROVED', 'DISPATCHING', 'agency-A', 'SYSTEM', expect.stringContaining('portal_claim_start')],
    );
  });

  it('409 job_not_claimable for a LEGACY (non-auto) booking — no un-consented charge (D5)', async () => {
    wire({claimBooking: {...CLAIM_BOOKING, dispatch_mode: null}, agent: AGENT_OK});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'job_not_claimable'});
    expect(wallet.holdToEscrow).not.toHaveBeenCalled();
  });

  it('retires a raced sibling live offer as CANCELLED — never SUPERSEDED (D3, innocent bystander)', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK});
    await service().claimOpenBooking('b1', 'agency-A');
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE dispatch_offers SET status = 'CANCELLED'[\s\S]*id <> \$2/),
      ['b1', 'o-claim'],
    );
  });

  it('reuses an existing live OFFERED row for this agency instead of minting', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK, winRows: [{id: 'o-live'}]});
    const res = await service().claimOpenBooking('b1', 'agency-A');
    expect(res.offer_id).toBe('o-live');
    expect(db.qOne).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO dispatch_offers/), expect.anything());
  });

  it('404 job_not_found for a missing booking', async () => {
    wire({claimBooking: null});
    await expect(service().claimOpenBooking('nope', 'agency-A')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 job_not_approved while PENDING_OPS', async () => {
    wire({claimBooking: {...CLAIM_BOOKING, status: 'PENDING_OPS'}, agent: AGENT_OK});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'job_not_approved'});
  });

  it('409 job_taken once CONFIRMED (another agency won)', async () => {
    wire({claimBooking: {...CLAIM_BOOKING, status: 'CONFIRMED'}, agent: AGENT_OK});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(ConflictException);
  });

  it('403 provider_only for a non-company agent', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: {...AGENT_OK, type: 'individual'}});
    await expect(service().claimOpenBooking('b1', 'cpo-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 agent_not_approved for a non-ACTIVE agency', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: {...AGENT_OK, status: 'PENDING'}});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'agent_not_approved'});
  });

  it('409 provider_on_cooldown for a benched agency', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: {...AGENT_OK, cooldown_until: new Date(Date.now() + 60_000)}});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'provider_on_cooldown'});
  });

  it('403 provider_not_eligible when the region credential gate fails', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, eligible: false});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'provider_not_eligible'});
  });

  it('409 no_free_cpo_capacity when the agency has no free seats', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, capacity: false});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'no_free_cpo_capacity'});
  });

  it('409 provider_excluded when this agency already saw the booking out (R9 — incl. own withdraw)', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, priorSeen: true});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'provider_excluded'});
  });

  it('R1 race: CONFIRMED flip loses (0 rows) → booking_state_changed_concurrently, no partial state', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK, confirmRows: 0});
    await expect(service().claimOpenBooking('b1', 'agency-A'))
      .rejects.toMatchObject({message: 'booking_state_changed_concurrently'});
    expect(push.providerAccepted).not.toHaveBeenCalled();
  });

  it('R10 relist re-claim: an existing HELD hold is re-pointed, never re-charged', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK, existingHold: true});
    await service().claimOpenBooking('b1', 'agency-B');
    expect(wallet.holdToEscrow).not.toHaveBeenCalled();
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE escrow_holds SET offer_id = \$2, provider_user_id = \$3/),
      ['b1', 'o-claim', 'agency-B'],
    );
  });

  it('deadlock (40P01) → the claim txn is retried once and succeeds', async () => {
    wire({claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK});
    db.withTransaction
      .mockImplementationOnce(() => Promise.reject({code: '40P01'}))
      .mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
    const res = await service().claimOpenBooking('b1', 'agency-A');
    expect(res.status).toBe('CONFIRMED');
  });

  it('charge failure → neutral job_unavailable to the agency; search terminated + client woken (LM-B7)', async () => {
    wire({
      claimBooking: CLAIM_BOOKING, agent: AGENT_OK, settleBooking: SETTLE_OK,
      abandonLock: {status: 'DISPATCHING'},
    });
    wallet.holdToEscrow.mockRejectedValue(new Error('insufficient_credits'));
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'job_unavailable'});
    await new Promise(setImmediate); // fire-and-forget failure handler
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.payment_failed'}));
    expect(push.paymentFailed).toHaveBeenCalledWith('c1', 'b1');
  });
});

describe('DispatchService.withdrawBooking (agency relist)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.bookingReDispatching.mockResolvedValue(undefined);
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  const OWNED = {status: 'CONFIRMED', client_id: 'c1', assigned_provider_user_id: 'agency-A'};

  it('CONFIRMED + owner + no mission → relists to DISPATCHING; hold untouched; breach counted', async () => {
    wire({withdrawBooking: OWNED});
    const res = await service().withdrawBooking('b1', 'agency-A', 'no capacity');
    expect(res).toEqual({booking_id: 'b1', status: 'DISPATCHING'});
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/SET status = 'DISPATCHING',\s+assigned_provider_user_id = NULL/),
      ['b1'],
    );
    // Own ACCEPTED offer superseded → the R9 exclusion stops a self re-claim.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE dispatch_offers SET status = 'SUPERSEDED'[\s\S]*provider_user_id = \$2 AND status = 'ACCEPTED'/),
      ['b1', 'agency-A'],
    );
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/reliability_breaches \+ 1/),
      ['agency-A'],
    );
    // Escrow is deliberately untouched — the hold stays HELD for the next claimant.
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/escrow_holds/), expect.anything());
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({action: 'dispatch.withdraw'}));
    expect(push.bookingReDispatching).toHaveBeenCalledWith('c1', 'b1');
  });

  it('403 org_scope_violation for a non-owner — before any status probe (IDOR)', async () => {
    wire({withdrawBooking: {...OWNED, assigned_provider_user_id: 'agency-B'}});
    await expect(service().withdrawBooking('b1', 'agency-A')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('409 booking_not_withdrawable when not CONFIRMED', async () => {
    wire({withdrawBooking: {...OWNED, status: 'LIVE'}});
    await expect(service().withdrawBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'booking_not_withdrawable'});
  });

  it('409 crew_already_assigned once a live mission exists (Phase 1 pre-crew gate)', async () => {
    wire({withdrawBooking: OWNED, withdrawMission: {id: 'm1'}});
    await expect(service().withdrawBooking('b1', 'agency-A')).rejects.toMatchObject({message: 'crew_already_assigned'});
  });

  it('404 for a missing booking', async () => {
    wire({withdrawBooking: null});
    await expect(service().withdrawBooking('nope', 'agency-A')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('R5/R6 race: relist flip loses (0 rows) → booking_state_changed_concurrently', async () => {
    wire({withdrawBooking: OWNED, withdrawFlipRows: 0});
    await expect(service().withdrawBooking('b1', 'agency-A'))
      .rejects.toMatchObject({message: 'booking_state_changed_concurrently'});
    expect(push.bookingReDispatching).not.toHaveBeenCalled();
  });
});

describe('DispatchService.noProvider — R12 refund of a persisted HELD hold', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.noProvider.mockResolvedValue(undefined);
    wallet.refundEscrowHold.mockResolvedValue({refunded: true, credits: 100});
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('refunds a relisted booking\'s hold atomically with the NO_PROVIDER flip', async () => {
    wire({noProviderLock: {status: 'DISPATCHING', client_id: 'c1', region_code: 'AE'}});
    await service().noProvider('b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(
      expect.anything(), 'b1', expect.stringContaining('No provider'),
    );
    expect(push.noProvider).toHaveBeenCalledWith('c1', 'b1');
  });

  it('no refund attempt when the booking already settled (flip 0 rows)', async () => {
    wire({noProviderLock: {status: 'DISPATCHING', client_id: 'c1', region_code: 'AE'}, noProviderRows: 0});
    await service().noProvider('b1');
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
  });

  it('no-op when the booking is no longer DISPATCHING', async () => {
    wire({noProviderLock: {status: 'CONFIRMED', client_id: 'c1', region_code: 'AE'}});
    await service().noProvider('b1');
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
    expect(push.noProvider).not.toHaveBeenCalled();
  });
});

describe('D4 — every DISPATCHING→CANCELLED path refunds a (relist-only) HELD hold', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.dispatchOffer.mockResolvedValue(undefined);
    wallet.refundEscrowHold.mockResolvedValue({refunded: true, credits: 100});
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('DispatchService.cancel refunds inside the same txn', async () => {
    wire({abandonLock: {status: 'DISPATCHING'}});
    await service().cancel('b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringContaining('cancelled'));
  });

  it('adminCancel refunds inside the same txn', async () => {
    wire({abandonLock: {status: 'DISPATCHING'}});
    const r = await service().adminCancel('b1');
    expect(r.cancelled).toBe(true);
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringContaining('ops'));
  });

  it('abandonUnstarted refunds inside the same txn', async () => {
    wire({abandonLock: {status: 'DISPATCHING'}});
    await service().abandonUnstarted('b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringContaining('abandoned'));
  });
});

describe('DispatchService — INFRA-4 runtime kill switch coverage', () => {
  function killedService() {
    const killswitch = {isAutoDispatchEnabled: jest.fn().mockResolvedValue(false)};
    return new DispatchService(
      db as unknown as DatabaseService, fsm,
      audit as unknown as OpsAuditService,
      push as unknown as BookingPushBridge,
      wallet as unknown as WalletService,
      undefined, // metrics
      killswitch as never,
    );
  }

  it('claimOpenBooking refuses a portal claim when the kill switch is off (money path honored)', async () => {
    db.withTransaction.mockClear();
    await expect(killedService().claimOpenBooking('b1', 'agency-A')).rejects.toThrow('auto_dispatch_disabled');
    expect(db.withTransaction).not.toHaveBeenCalled(); // refused before the claim txn
  });

  it('offerNext mints nothing when the kill switch is off', async () => {
    db.qOne.mockClear();
    await killedService().offerNext('b1');
    expect(db.qOne).not.toHaveBeenCalled(); // returned before reading the booking / minting an offer
  });
});
