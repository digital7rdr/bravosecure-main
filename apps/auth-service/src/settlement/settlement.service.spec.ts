import {SettlementService} from './settlement.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';
import type {WalletService} from '../wallet/wallet.service';

function mk(holdRow: unknown, releaseRes: {released: boolean; toProvider: number; platformFee: number}) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockImplementation((sql: string) => {
    if (/SELECT status, provider_user_id FROM escrow_holds/.test(sql)) return Promise.resolve(holdRow);
    if (/m\.short_code\s+AS call_sign/.test(sql)) return Promise.resolve({provider_user_id: 'agency-A', conversation_id: 'conv-1', mission_id: 'm1', call_sign: 'BL-1'});
    return Promise.resolve(null);
  });
  const tx = {q: txQ, qOne: txQOne};
  const db = {} as unknown as DatabaseService;
  const config = {get: (k: string) => (k === 'dispatch.platformFeePct' ? 0 : undefined)} as unknown as ConfigService;
  const wallet = {releaseEscrowHold: jest.fn().mockResolvedValue(releaseRes)} as unknown as WalletService;
  const svc = new SettlementService(db, config, wallet);
  return {svc, tx, txQ, txQOne, wallet};
}

describe('SettlementService.settleEscrowRelease', () => {
  it('returns escrow:false and does NOTHING for a legacy booking (no hold)', async () => {
    const {svc, tx, wallet} = mk(null, {released: false, toProvider: 0, platformFee: 0});
    const res = await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'system'});
    expect(res).toEqual({escrow: false, released: false, toProvider: 0, platformFee: 0, providerUserId: null});
    expect(wallet.releaseEscrowHold).not.toHaveBeenCalled();
    expect(tx.q).not.toHaveBeenCalled();
  });

  it('releases a PENDING_RELEASE hold: pays via wallet + writes mission_payouts + bumps jobs_total + dissolves group', async () => {
    const {svc, tx, txQ, wallet} = mk({status: 'PENDING_RELEASE', provider_user_id: 'agency-A'}, {released: true, toProvider: 800, platformFee: 0});
    const res = await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'system'});
    expect(res).toEqual({escrow: true, released: true, toProvider: 800, platformFee: 0, providerUserId: 'agency-A'});
    expect(wallet.releaseEscrowHold).toHaveBeenCalledWith(tx, 'b1', 0);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_payouts/), expect.arrayContaining(['m1', 'b1', 'agency-A']));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE agents SET jobs_total = jobs_total \+ 1/), ['agency-A']);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM public\.conversation_members/), ['conv-1']);
  });

  it('bumps jobs_total for each crewed CPO too, excluding the provider to avoid double-count', async () => {
    const {svc, tx, txQ} = mk({status: 'PENDING_RELEASE', provider_user_id: 'agency-A'}, {released: true, toProvider: 800, platformFee: 0});
    txQ.mockImplementation((sql: string) => {
      if (/SELECT agent_id FROM mission_crew/.test(sql)) {
        return Promise.resolve([{agent_id: 'cpo-1'}, {agent_id: 'cpo-2'}, {agent_id: 'agency-A'}]);
      }
      return Promise.resolve([]);
    });
    await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'system'});
    expect(txQ).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE agents SET jobs_total = jobs_total \+ 1 WHERE user_id = ANY/),
      [['cpo-1', 'cpo-2']],
    );
  });

  it('does NO side-effects when the release no-ops (raced to DISPUTED)', async () => {
    const {svc, tx, txQ, wallet} = mk({status: 'PENDING_RELEASE', provider_user_id: 'agency-A'}, {released: false, toProvider: 0, platformFee: 0});
    const res = await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'system'});
    expect(res).toEqual({escrow: true, released: false, toProvider: 0, platformFee: 0, providerUserId: 'agency-A'});
    expect(wallet.releaseEscrowHold).toHaveBeenCalled();
    expect(txQ).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_payouts/), expect.anything());
  });

  it('admin force-promotes a still-HELD hold to PENDING_RELEASE before releasing', async () => {
    const {svc, tx, txQ} = mk({status: 'HELD', provider_user_id: 'agency-A'}, {released: true, toProvider: 800, platformFee: 0});
    await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'admin', userId: 'adm-1'}, {force: true});
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/SET status = 'PENDING_RELEASE'[\s\S]*WHERE booking_id = \$1 AND status = 'HELD'/), ['b1']);
  });

  it('a system caller does NOT force a HELD hold (no promote)', async () => {
    const {svc, tx, txQ} = mk({status: 'HELD', provider_user_id: 'agency-A'}, {released: false, toProvider: 0, platformFee: 0});
    await svc.settleEscrowRelease(tx as never, 'b1', {kind: 'system'}, {force: true});
    expect(txQ).not.toHaveBeenCalledWith(expect.stringMatching(/SET status = 'PENDING_RELEASE'/), expect.anything());
  });
});
