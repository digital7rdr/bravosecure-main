import {BadRequestException, Logger} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const cpoAssign = {getCrewForPayout: jest.fn(), getForBooking: jest.fn(), resolvePayeeUserId: jest.fn()};
const wallet = {creditForBooking: jest.fn()};
const proof = {runProofGate: jest.fn()};
const config = {get: jest.fn(() => 259200)};

function svc(): AgentService {
  return new AgentService(
    db as unknown as DatabaseService,
    new AgentStateMachine(),
    {} as unknown as RedisService,
    cpoAssign as unknown as CpoAssignmentService,
    wallet as unknown as WalletService,
    {} as unknown as DepartmentService,
    proof as unknown as ProofOfCompletionService,
    config as unknown as ConfigService,
  );
}

interface Wire {
  isLead?: boolean | null;       // mission_crew lead gate (null = not assigned)
  hold?: boolean;                // an escrow_holds HELD row exists (auto-dispatch)
  gatePass?: boolean;            // proof gate verdict
}

function wire(w: Wire): void {
  db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT is_lead FROM mission_crew/.test(sql)) return Promise.resolve(w.isLead === undefined ? {is_lead: true} : (w.isLead === null ? null : {is_lead: w.isLead}));
    if (/FROM escrow_holds WHERE booking_id = \$1 AND status = 'HELD'/.test(sql)) return Promise.resolve(w.hold ? {booking_id: 'b1'} : null);
    if (/total_eur/.test(sql)) return Promise.resolve({total_eur: '800', short_code: 'BL-1'}); // disburse reads (legacy)
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string) => {
    if (/UPDATE missions SET status/.test(sql)) return Promise.resolve([{id: 'm1', booking_id: 'b1'}]);
    return Promise.resolve([]);
  });
  proof.runProofGate.mockResolvedValue({pass: w.gatePass ?? true, reasons: w.gatePass === false ? ['too_short'] : []});
  cpoAssign.getCrewForPayout.mockResolvedValue([{user_id: 'cpo1', call_sign: 'A1'}]);
  cpoAssign.resolvePayeeUserId.mockResolvedValue('cpo1');
  wallet.creditForBooking.mockResolvedValue({bravo_credits: 800, currency: 'AED', stripe_customer_id: null});
}

describe('AgentService.missionComplete — lead Finish escrow split (Step 10 / LB4)', () => {
  beforeEach(() => jest.resetAllMocks());

  it('AUTO-dispatch + gate PASS: opens PENDING_RELEASE, pays NOTHING inline', async () => {
    wire({hold: true, gatePass: true});
    await svc().missionComplete('u1', 'm1');
    expect(proof.runProofGate).toHaveBeenCalledWith('b1', 'm1');
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds[\s\S]*PENDING_RELEASE/), expect.arrayContaining(['b1', 259200]));
    expect(wallet.creditForBooking).not.toHaveBeenCalled(); // money deferred to the Step 11 release sweep
  });

  it('FSM-2 — completion requires the mission to have gone LIVE (live_at IS NOT NULL)', async () => {
    wire({hold: true, gatePass: true});
    await svc().missionComplete('u1', 'm1');
    const completeUpd = db.q.mock.calls.find(c => /UPDATE missions SET status = 'COMPLETED'/.test(String(c[0])));
    expect(completeUpd).toBeDefined();
    // Blocks the DISPATCHED->SOS->COMPLETED never-live bypass.
    expect(String(completeUpd![0])).toMatch(/live_at IS NOT NULL/);
  });

  it('releases the crew on complete (mission_crew status=off) so the CPO is free for the next mission', async () => {
    wire({hold: true, gatePass: true});
    await svc().missionComplete('u1', 'm1');
    // Without this the crew row stays status='active' and the unique index
    // mission_crew_agent_active_uq keeps rejecting the CPO as 'cpo_busy' forever.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mission_crew SET status = 'off' WHERE mission_id = \$1/),
      ['m1'],
    );
  });

  it('AUTO-dispatch + gate FAIL: flags review_required, pays NOTHING, never PENDING_RELEASE', async () => {
    wire({hold: true, gatePass: false});
    await svc().missionComplete('u1', 'm1');
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds SET review_required = TRUE/), ['b1']);
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/PENDING_RELEASE/), expect.anything());
    expect(wallet.creditForBooking).not.toHaveBeenCalled();
  });

  it('LEGACY booking (no escrow hold): keeps the existing inline even-split payout', async () => {
    wire({hold: false});
    await svc().missionComplete('u1', 'm1');
    expect(proof.runProofGate).not.toHaveBeenCalled();
    expect(wallet.creditForBooking).toHaveBeenCalledWith('cpo1', 'b1', 800, expect.any(String));
    expect(db.q).not.toHaveBeenCalledWith(expect.stringMatching(/escrow_holds/), expect.anything());
  });

  it('rejects a non-lead crew member (lead_only)', async () => {
    wire({isLead: false});
    await expect(svc().missionComplete('u1', 'm1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('B-76 — a settle failure (proof gate / escrow UPDATE) does NOT fail the Finish', async () => {
    // The mission is already COMPLETED before settle runs; a settle throw must not
    // surface to the CPO as a 500 for an action that actually landed. Best-effort +
    // loud error log; the hold stays HELD for operator repair.
    wire({hold: true, gatePass: true});
    proof.runProofGate.mockRejectedValueOnce(new Error('PostGIS timeout'));
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(svc().missionComplete('u1', 'm1')).resolves.toEqual({ok: true});
    // The mission flip still happened (COMPLETED) and the failure was logged loudly.
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions SET status/), expect.anything());
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/settleEscrowOnFinish FAILED[\s\S]*booking=b1/));
    errSpy.mockRestore();
  });
});

describe('AgentService.missionGoLive — auto-dispatch booking follows the mission to LIVE', () => {
  beforeEach(() => jest.resetAllMocks());

  it('advances the booking CONFIRMED→LIVE when the lead takes the mission LIVE', async () => {
    wire({});
    await svc().missionGoLive('u1', 'm1');
    // Without this, the booking stays CONFIRMED forever and the LIVE→COMPLETED flip on
    // Finish (guarded on status='LIVE') is unreachable — the booking never completes.
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE lite_bookings SET status = 'LIVE'[\s\S]*status = 'CONFIRMED'/),
      ['b1'],
    );
  });

  it('does NOT flip the booking to LIVE on a PICKUP transition', async () => {
    wire({});
    await svc().missionPickup('u1', 'm1');
    expect(db.q).not.toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE lite_bookings SET status = 'LIVE'/),
      expect.anything(),
    );
  });
});
