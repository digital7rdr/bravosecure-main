/**
 * FRAUD-2 / P0 — server-verified guard-identity handshake. The assigned LEAD
 * proves presence by entering the CLIENT-bound arrival code; the server
 * re-derives it and stamps missions.identity_verified_at, which the
 * proof-of-completion gate requires before escrow may auto-release. A wrong
 * code stamps nothing; a non-lead is refused. Reverting the fix (dropping the
 * client_id binding or the stamp) turns these red.
 */
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import {deriveVerifyCode} from '../dispatch/verify-code.util';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

const SECRET = 'test-action-secret';
const BOOKING = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const config = {get: jest.fn((k: string) => (k === 'jwt.actionSecret' ? SECRET : undefined))};

function svc(): AgentService {
  return new AgentService(
    db as unknown as DatabaseService,
    new AgentStateMachine(),
    {} as unknown as RedisService,
    {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService,
    {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService,
    config as unknown as ConfigService,
  );
}

function wireCrew(row: Record<string, unknown> | null): void {
  db.qOne.mockImplementation((sql: string) => {
    if (/FROM mission_crew mc[\s\S]*JOIN lite_bookings/.test(sql)) return Promise.resolve(row);
    return Promise.resolve(null);
  });
  db.q.mockResolvedValue([]);
}

describe('AgentService.verifyArrival — FRAUD-2 identity handshake', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // resetAllMocks wipes the impl too — re-establish the secret the service derives with.
    config.get.mockImplementation((k: string) => (k === 'jwt.actionSecret' ? SECRET : undefined));
  });

  it('stamps identity_verified_at when the lead submits the client-bound arrival code', async () => {
    wireCrew({is_lead: true, booking_id: BOOKING, client_id: CLIENT, identity_verified_at: null});
    const {code} = deriveVerifyCode(SECRET, BOOKING, CLIENT, Date.now());
    const res = await svc().verifyArrival('lead-user', 'm1', code);
    expect(res.verified).toBe(true);
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE missions[\s\S]*identity_verified_at = NOW\(\)/),
      ['m1', 'lead-user'],
    );
    // Audit trail — the fact of a match is recorded (never the submitted code).
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO ops_audit[\s\S]*mission\.identity_verified/),
      ['lead-user', 'm1', expect.stringContaining(BOOKING)],
    );
    // The rotating credential must never appear in the audit metadata.
    const auditCall = db.q.mock.calls.find(c => /ops_audit/.test(String(c[0])));
    expect(JSON.stringify(auditCall?.[1] ?? [])).not.toContain(code);
  });

  it('rejects a wrong code and stamps nothing', async () => {
    wireCrew({is_lead: true, booking_id: BOOKING, client_id: CLIENT, identity_verified_at: null});
    const {code} = deriveVerifyCode(SECRET, BOOKING, CLIENT, Date.now());
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(svc().verifyArrival('lead-user', 'm1', wrong)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.q).not.toHaveBeenCalled();
  });

  it('rejects a non-lead crew member (lead_only) even with the right code', async () => {
    wireCrew({is_lead: false, booking_id: BOOKING, client_id: CLIENT, identity_verified_at: null});
    const {code} = deriveVerifyCode(SECRET, BOOKING, CLIENT, Date.now());
    await expect(svc().verifyArrival('crew-user', 'm1', code)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a user not assigned to the mission (not_assigned_to_mission)', async () => {
    wireCrew(null);
    await expect(svc().verifyArrival('rando', 'm1', '123456')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is idempotent once verified — no re-check, no second write', async () => {
    wireCrew({is_lead: true, booking_id: BOOKING, client_id: CLIENT, identity_verified_at: new Date()});
    const res = await svc().verifyArrival('lead-user', 'm1', 'whatever');
    expect(res.verified).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
  });
});
