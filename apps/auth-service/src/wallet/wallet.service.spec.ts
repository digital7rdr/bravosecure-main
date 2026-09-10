import {WalletService} from './wallet.service';
import type {DatabaseService} from '../database/database.service';
import type {StripeClient, StripeEvent} from './stripe.client';

function mockDb() {
  const q = jest.fn();
  const qOne = jest.fn();
  // withTransaction forwards to the same q/qOne so existing assertions on
  // db.q.mock.calls still see the writes that happen inside transactions.
  const withTransaction = jest.fn(async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) =>
    fn({q, qOne}),
  );
  return {
    q,
    qOne,
    withTransaction,
  } as unknown as DatabaseService & {q: jest.Mock; qOne: jest.Mock; withTransaction: jest.Mock};
}

function mockCfg() {
  return {
    get: () => undefined,
  } as never;
}

function mockStripe(overrides: Partial<StripeClient> = {}) {
  const base = {
    enabled: false,
    createPaymentIntent: jest.fn(),
    ensureCustomer: jest.fn(),
    verifyWebhook: jest.fn(),
  } as unknown as StripeClient;
  return Object.assign(base, overrides) as StripeClient & Record<string, jest.Mock>;
}

const NOW = new Date('2026-04-23T12:00:00Z');

describe('WalletService', () => {
  describe('getBalance', () => {
    it('initialises a zero balance row on first read', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      db.qOne.mockResolvedValueOnce({
        user_id: 'u1', bravo_credits: 0, currency: 'AED',
        stripe_customer_id: null, updated_at: NOW,
      });
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const bal = await svc.getBalance('u1');
      expect(bal).toEqual({bravo_credits: 0, currency: 'AED', stripe_customer_id: null});
      expect(db.qOne).toHaveBeenCalledTimes(2); // SELECT, then INSERT RETURNING
    });

    it('returns the existing row without inserting', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        user_id: 'u1', bravo_credits: 250, currency: 'AED',
        stripe_customer_id: 'cus_1', updated_at: NOW,
      });
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const bal = await svc.getBalance('u1');
      expect(bal.bravo_credits).toBe(250);
      expect(db.qOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('topUp (fallback mode)', () => {
    it('credits the wallet locally when Stripe is disabled', async () => {
      const db = mockDb();
      // ensureBalanceRow
      db.qOne.mockResolvedValueOnce({
        user_id: 'u1', bravo_credits: 100, currency: 'AED', stripe_customer_id: null, updated_at: NOW,
      });
      // insertTx
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'succeeded',
        amount_credits: 19, amount_fiat_cents: 1900, fiat_currency: 'usd',
        description: 'Top-up 19 BC (fallback / no stripe)', booking_id: null,
        stripe_intent_id: null, stripe_client_secret: null, metadata: {fallback: true},
        created_at: NOW, settled_at: NOW,
      });
      // getBalance after credit
      db.qOne.mockResolvedValueOnce({
        user_id: 'u1', bravo_credits: 119, currency: 'AED', stripe_customer_id: null, updated_at: NOW,
      });

      const svc = new WalletService(db, mockCfg(), mockStripe({enabled: false}));
      const out = await svc.topUp('u1', {amount: 19, currency: 'usd'});

      expect(out.fallback).toBe(true);
      expect(out.credits_awarded).toBe(19);             // 1 fiat unit = 1 BC peg
      expect(out.balance.bravo_credits).toBe(119);
      // Ledger insert + balance update both run.
      expect(db.q).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE wallet_balances'),
        expect.arrayContaining([19, 'u1']),
      );
    });

    it('rejects zero/negative amounts', async () => {
      const svc = new WalletService(mockDb(), mockCfg(), mockStripe());
      await expect(svc.topUp('u1', {amount: 0, currency: 'usd'})).rejects.toThrow();
    });
  });

  describe('topUp (Stripe enabled)', () => {
    it('mints a PaymentIntent, persists it pending, and does NOT credit until webhook', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        user_id: 'u1', bravo_credits: 100, currency: 'AED',
        stripe_customer_id: null, updated_at: NOW,
      });
      // insertTx
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'pending',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up 100 BC', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: 'pi_1_secret', metadata: {},
        created_at: NOW, settled_at: null,
      });

      const stripe = mockStripe({enabled: true});
      stripe.ensureCustomer = jest.fn().mockResolvedValue('cus_new');
      stripe.createPaymentIntent = jest.fn().mockResolvedValue({
        id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method',
        amount: 1000, currency: 'usd',
      });

      const svc = new WalletService(db, mockCfg(), stripe);
      const out = await svc.topUp('u1', {amount: 10, currency: 'usd'});

      expect(out.client_secret).toBe('pi_1_secret');
      expect(out.intent_id).toBe('pi_1');
      expect(out.customer_id).toBe('cus_new');
      // Balance must NOT have been incremented yet — only the customer_id
      // write + the pending ledger row.
      const balanceUpdates = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE wallet_balances') && c[0].includes('bravo_credits'),
      );
      expect(balanceUpdates).toHaveLength(0);
    });
  });

  describe('handleStripeEvent', () => {
    it('settles the pending ledger row and credits BC on payment_intent.succeeded', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'pending',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: 'pi_1_s', metadata: {},
        created_at: NOW, settled_at: null,
      });

      // Status-guarded flip wins the race → returns the flipped row id.
      db.q.mockImplementation((sql: string) =>
        typeof sql === 'string' && sql.includes("SET status = 'succeeded'")
          ? Promise.resolve([{id: 'tx_1'}])
          : Promise.resolve([]),
      );

      const svc = new WalletService(db, mockCfg(), mockStripe());
      const evt: StripeEvent = {
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: {object: {id: 'pi_1'}},
      };
      await svc.handleStripeEvent(evt);

      const settleCalls = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes("status = 'succeeded'"),
      );
      expect(settleCalls).toHaveLength(1);
      // The flip is race-proof AND recovery-safe: it settles a still-'pending'
      // OR a previously-'failed' row (retry of a declined intent), but never a
      // 'succeeded'/'refunded' one — so no double credit.
      expect(settleCalls[0][0]).toContain("status IN ('pending', 'failed')");
      const creditCalls = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE wallet_balances'),
      );
      expect(creditCalls).toHaveLength(1);
      expect(creditCalls[0][1]).toEqual([100, 'u1']);
    });

    it('does NOT credit when the other settle path already flipped the row (race lost)', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'pending',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: 'pi_1_s', metadata: {},
        created_at: NOW, settled_at: null,
      });
      // Guarded UPDATE returns no rows — client-confirm settled it first.
      db.q.mockResolvedValue([]);

      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: {object: {id: 'pi_1'}},
      });

      const creditCalls = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE wallet_balances'),
      );
      expect(creditCalls).toHaveLength(0); // no double credit
    });

    it('marks the ledger row failed on payment_intent.payment_failed (no credit)', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'pending',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: 'pi_1_s', metadata: {},
        created_at: NOW, settled_at: null,
      });

      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_1',
        type: 'payment_intent.payment_failed',
        data: {object: {id: 'pi_1'}},
      });

      const failed = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes("status = 'failed'"),
      );
      expect(failed).toHaveLength(1);
      const creditCalls = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE wallet_balances'),
      );
      expect(creditCalls).toHaveLength(0);
    });

    it('DOCUMENTS live-money-bug fix — a succeeded retry settles a previously-failed row', async () => {
      const db = mockDb();
      // The row a prior decline marked 'failed'. Before the fix, the SELECT
      // filtered status='pending' only, so this row was never found and the
      // successful retry credited nothing while logging "unknown pending intent".
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'failed',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: null, metadata: {},
        created_at: NOW, settled_at: NOW,
      });
      db.q.mockImplementation((sql: string) =>
        typeof sql === 'string' && sql.includes("SET status = 'succeeded'")
          ? Promise.resolve([{id: 'tx_1'}])
          : Promise.resolve([]),
      );

      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_retry', type: 'payment_intent.succeeded', data: {object: {id: 'pi_1'}},
      });

      const creditCalls = db.q.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE wallet_balances'),
      );
      expect(creditCalls).toHaveLength(1);        // the retry DID credit
      expect(creditCalls[0][1]).toEqual([100, 'u1']);
    });

    it('does NOT re-stamp an already-failed row on a duplicate payment_failed', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce({
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'failed',
        amount_credits: 100, amount_fiat_cents: 1000, fiat_currency: 'usd',
        description: 'Top-up', booking_id: null,
        stripe_intent_id: 'pi_1', stripe_client_secret: null, metadata: {},
        created_at: NOW, settled_at: NOW,
      });
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_dupfail', type: 'payment_intent.payment_failed', data: {object: {id: 'pi_1'}},
      });
      // Already 'failed' → neither a settle nor a re-fail write.
      expect(db.q).not.toHaveBeenCalled();
    });

    it('ignores unrelated event types', async () => {
      const db = mockDb();
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_1',
        type: 'charge.captured',
        data: {object: {id: 'ch_1'}},
      });
      expect(db.qOne).not.toHaveBeenCalled();
      expect(db.q).not.toHaveBeenCalled();
    });

    it('no-ops for an unknown / already-settled intent id', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(null);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: {object: {id: 'pi_not_found'}},
      });
      expect(db.q).not.toHaveBeenCalled();
    });

    // MON-1 — a reversed card charge must claw back the credits it minted.
    it('MON-1: reverses the minted credits on a FULL charge.refunded (negative payment + balance debit)', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 100, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({id: 'evt_r', type: 'charge.refunded', data: {object: {payment_intent: 'pi_1', amount: 1000, amount_refunded: 1000}}});

      const inserts = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO wallet_transactions') && c[0].includes("'payment'"));
      expect(inserts).toHaveLength(1);
      expect(inserts[0][1]).toEqual(expect.arrayContaining([-100])); // negative credits (a debit)
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(1);
      expect(debits[0][1]).toEqual([100, 'u1']);
    });

    it('MON-1: reverses on charge.dispute.funds_withdrawn', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 250, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve(null);
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({id: 'evt_d', type: 'charge.dispute.funds_withdrawn', data: {object: {payment_intent: 'pi_1'}}});
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(1);
      expect(debits[0][1]).toEqual([250, 'u1']);
    });

    it('MON-1: a redelivered FULL reversal is a no-op (target already reached)', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 100, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve({reversed: 100}); // already fully reversed
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({id: 'evt_r2', type: 'charge.refunded', data: {object: {payment_intent: 'pi_1', amount: 1000, amount_refunded: 1000}}});
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(0);
    });

    it('MON-1: a PARTIAL charge.refunded reverses the PROPORTIONAL amount (40% of 100 = 40 BC)', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 100, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve({reversed: 0}); // first partial
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({id: 'evt_p', type: 'charge.refunded', data: {object: {payment_intent: 'pi_1', amount: 1000, amount_refunded: 400}}});
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(1);
      expect(debits[0][1]).toEqual([40, 'u1']); // 100 * 0.4
    });

    it('MON-1: a SECOND partial reverses only the DELTA (cumulative 70% after 40% = +30 BC, never double)', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 100, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve({reversed: 40}); // 40 already reversed
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      // amount_refunded is CUMULATIVE: 700 of 1000 = 70% target = 70; already 40 → reverse 30.
      await svc.handleStripeEvent({id: 'evt_p2', type: 'charge.refunded', data: {object: {payment_intent: 'pi_1', amount: 1000, amount_refunded: 700}}});
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(1);
      expect(debits[0][1]).toEqual([30, 'u1']);
    });

    it('MON-1: a final FULL refund after partials reverses ONLY the remaining (100 target − 70 = 30, no double)', async () => {
      const db = mockDb();
      db.qOne.mockImplementation((sql: string) => {
        if (/type = 'topup' AND status = 'succeeded'/.test(sql)) return Promise.resolve({id: 'tx_1', user_id: 'u1', amount_credits: 100, currency: 'usd'});
        if (/metadata->>'kind' = 'topup_reversal'/.test(sql)) return Promise.resolve({reversed: 70}); // 70 already reversed via partials
        return Promise.resolve(null);
      });
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await svc.handleStripeEvent({id: 'evt_full', type: 'charge.refunded', data: {object: {payment_intent: 'pi_1', amount: 1000, amount_refunded: 1000}}});
      const debits = db.q.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('bravo_credits = bravo_credits - $1'));
      expect(debits).toHaveLength(1);
      expect(debits[0][1]).toEqual([30, 'u1']); // remaining only — never re-reverses the whole 100
    });
  });

  describe('sweepExpiredCredits', () => {
    it('reclaims unconsumed remainder, writes an expire ledger row, and marks the batch swept', async () => {
      const db = mockDb();
      const now = new Date('2027-06-01T00:00:00Z');
      // First call: SELECT due batches — return one with 30 BC unconsumed
      db.q.mockResolvedValueOnce([{
        id: 'batch_1',
        user_id: 'u1',
        amount_credits: 100,
        consumed_credits: 70,
        expires_at: new Date('2027-05-01T00:00:00Z'),
      }]);
      // Subsequent UPDATE/INSERT/UPDATE calls
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const out = await svc.sweepExpiredCredits(now);
      expect(out).toEqual({batches: 1, creditsExpired: 30});
      // Balance debit happened
      const balDecrement = db.q.mock.calls.find(c =>
        typeof c[0] === 'string'
          && c[0].includes('UPDATE wallet_balances')
          && c[0].includes('bravo_credits - $1'),
      );
      expect(balDecrement).toBeTruthy();
      expect(balDecrement?.[1]).toEqual([30, 'u1']);
      // Audit row written
      const expireLedger = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes("'expire'"),
      );
      expect(expireLedger).toBeTruthy();
      // Batch marked swept
      const markSwept = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('SET expired_at'),
      );
      expect(markSwept).toBeTruthy();
    });

    it('no-ops when nothing has expired', async () => {
      const db = mockDb();
      db.q.mockResolvedValueOnce([]); // SELECT returns nothing
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const out = await svc.sweepExpiredCredits();
      expect(out).toEqual({batches: 0, creditsExpired: 0});
      // Only the SELECT ran
      expect(db.q).toHaveBeenCalledTimes(1);
    });

    it('does not double-debit balance for fully-consumed expired batches', async () => {
      const db = mockDb();
      const now = new Date('2027-06-01T00:00:00Z');
      // Batch is fully consumed (100/100) — remainder = 0, only mark swept.
      db.q.mockResolvedValueOnce([{
        id: 'batch_1',
        user_id: 'u1',
        amount_credits: 100,
        consumed_credits: 100,
        expires_at: new Date('2027-05-01T00:00:00Z'),
      }]);
      db.q.mockResolvedValue([]);
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const out = await svc.sweepExpiredCredits(now);
      expect(out).toEqual({batches: 1, creditsExpired: 0});
      const balDecrement = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('bravo_credits - $1'),
      );
      expect(balDecrement).toBeFalsy();
    });
  });

  // Audit F-14 — ops manual grant/deduction.
  describe('adjustCredits', () => {
    const balRow = (credits: number) => ({
      user_id: 'u1', bravo_credits: credits, currency: 'AED',
      stripe_customer_id: null, updated_at: NOW,
    });

    it('grants BC with a topup ledger row + expiry batch', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(balRow(100));  // ensureBalanceRow
      db.qOne.mockResolvedValueOnce(balRow(100));  // FOR UPDATE lock
      db.qOne.mockResolvedValueOnce({              // insertTx
        id: 'tx_1', user_id: 'u1', type: 'topup', status: 'succeeded',
        amount_credits: 500, amount_fiat_cents: 0, fiat_currency: 'AED',
        description: 'Ops adjustment · goodwill', booking_id: null,
        stripe_intent_id: null, stripe_client_secret: null,
        metadata: {kind: 'ops_adjustment'}, created_at: NOW, settled_at: NOW,
      });
      db.qOne.mockResolvedValueOnce(balRow(600));  // getBalance
      const svc = new WalletService(db, mockCfg(), mockStripe());
      const out = await svc.adjustCredits('admin1', 'u1', 500, 'goodwill');
      expect(out.balance.bravo_credits).toBe(600);
      expect(db.q).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE wallet_balances'),
        expect.arrayContaining([500, 'u1']),
      );
      const batchMint = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('INSERT INTO wallet_credit_batches'),
      );
      expect(batchMint).toBeTruthy();
    });

    it('rejects a deduction that exceeds the balance', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(balRow(100));  // ensureBalanceRow
      db.qOne.mockResolvedValueOnce(balRow(100));  // FOR UPDATE lock
      const svc = new WalletService(db, mockCfg(), mockStripe());
      await expect(
        svc.adjustCredits('admin1', 'u1', -500, 'correction'),
      ).rejects.toMatchObject({message: 'insufficient_credits'});
    });

    it('rejects zero credits and empty reasons', async () => {
      const svc = new WalletService(mockDb(), mockCfg(), mockStripe());
      await expect(svc.adjustCredits('a', 'u1', 0, 'x')).rejects.toThrow();
      await expect(svc.adjustCredits('a', 'u1', 10, '  ')).rejects.toThrow();
    });
  });

  // Audit C2 — refund path for cancelled/aborted PAID bookings.
  describe('refundForBooking', () => {
    const balRow = {user_id: 'u1', bravo_credits: 0, currency: 'AED', stripe_customer_id: null, updated_at: NOW};

    it('refunds the captured payment amount, idempotently inserts a refund row, credits the balance', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(balRow);                       // ensureBalanceRow
      db.qOne.mockResolvedValueOnce({debited: '344'});            // SUM of captured payment debits
      db.qOne.mockResolvedValueOnce(null);                         // lite_bookings actor lookup (self-paid)
      db.q.mockResolvedValueOnce([{id: 'rf_1'}]);                  // INSERT refund RETURNING (fresh)
      db.q.mockResolvedValueOnce([]);                              // UPDATE balance
      db.q.mockResolvedValueOnce([]);                              // INSERT credit batch
      db.qOne.mockResolvedValueOnce({...balRow, bravo_credits: 344}); // getBalance

      const svc = new WalletService(db, mockCfg(), mockStripe());
      const res = await svc.refundForBooking('u1', 'bk1', 'Refund · booking bk1 cancelled');

      expect(res.refunded).toBe(true);
      expect(res.credits).toBe(344);
      // The refund row is the idempotency anchor.
      const insertRefund = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && /INSERT INTO wallet_transactions/.test(c[0]) && /'refund'/.test(c[0]));
      expect(insertRefund).toBeTruthy();
      // Idempotency is arbitrated by the partial unique index ux_wallet_tx_booking_refund via index
      // inference (ON CONFLICT (cols) WHERE <predicate>) — a partial index has no constraint to name,
      // so `ON CONFLICT ON CONSTRAINT` would throw 42704 at runtime. See AUTO_DISPATCH_BUGFIX_GUIDE §6.
      expect(insertRefund?.[0]).toMatch(/ON CONFLICT \(user_id, booking_id\)[\s\S]*WHERE type = 'refund'[\s\S]*DO NOTHING/);
      // 6th param = ledger actor; with no lite_bookings row it defaults to the payer.
      expect(insertRefund?.[1]).toEqual(['u1', 344, 'AED', 'Refund · booking bk1 cancelled', 'bk1', 'u1']);
      // Balance credited by the refunded amount.
      const balUpd = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && /bravo_credits = bravo_credits \+ \$1/.test(c[0]));
      expect(balUpd?.[1]).toEqual([344, 'u1']);
    });

    it('is a no-op (no double refund) when the refund row already exists (ON CONFLICT → 0 rows)', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(balRow);                       // ensureBalanceRow
      db.qOne.mockResolvedValueOnce({debited: '344'});            // SUM
      db.qOne.mockResolvedValueOnce(null);                         // lite_bookings actor lookup
      db.q.mockResolvedValueOnce([]);                              // INSERT refund → 0 rows (conflict)
      db.qOne.mockResolvedValueOnce({...balRow, bravo_credits: 344}); // getBalance

      const svc = new WalletService(db, mockCfg(), mockStripe());
      const res = await svc.refundForBooking('u1', 'bk1', 'dup');

      expect(res.refunded).toBe(false);
      expect(res.credits).toBe(0);
      // No balance bump on the duplicate path.
      const balUpd = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && /bravo_credits = bravo_credits \+ \$1/.test(c[0]));
      expect(balUpd).toBeUndefined();
    });

    it('is a no-op when nothing was captured for the booking', async () => {
      const db = mockDb();
      db.qOne.mockResolvedValueOnce(balRow);                       // ensureBalanceRow
      db.qOne.mockResolvedValueOnce({debited: '0'});              // SUM = 0 (free / never paid)
      db.qOne.mockResolvedValueOnce(balRow);                       // getBalance

      const svc = new WalletService(db, mockCfg(), mockStripe());
      const res = await svc.refundForBooking('u1', 'bk1', 'nothing');

      expect(res.refunded).toBe(false);
      expect(res.credits).toBe(0);
      // Never attempted a refund insert.
      const insertRefund = db.q.mock.calls.find(c =>
        typeof c[0] === 'string' && /'refund'/.test(c[0]));
      expect(insertRefund).toBeUndefined();
    });
  });

  describe('holdToEscrow / refundEscrowHold (Step 9 escrow)', () => {
    const ESCROW = '00000000-0000-0000-0000-0000000000e5';
    const FEE = '00000000-0000-0000-0000-0000000000fe';
    function cfgWithEscrow() {
      return {get: (k: string) => (k === 'platformAccounts.escrowId' ? ESCROW : (k === 'platformAccounts.platformFeeId' ? FEE : undefined))} as never;
    }
    // A tx whose batch SELECT returns a covering batch (so FIFO consume is clean).
    function mockTx() {
      const q = jest.fn((sql: string) =>
        /FROM wallet_credit_batches/.test(sql)
          ? Promise.resolve([{id: 'batch1', amount_credits: 10000, consumed_credits: 0}])
          : Promise.resolve([]));
      return {q, qOne: jest.fn()};
    }

    // Sum amount_credits ($2) across EVERY wallet_transactions INSERT (on q + qOne).
    // A balanced paired move must net to ZERO (no money created or destroyed).
    function ledgerNet(tx: {q: jest.Mock; qOne: jest.Mock}): number {
      return [...tx.q.mock.calls, ...tx.qOne.mock.calls]
        .filter(([sql]) => typeof sql === 'string' && /INSERT INTO wallet_transactions/.test(sql))
        .reduce((acc, [, params]) => acc + (Array.isArray(params) ? Number(params[1]) : 0), 0);
    }

    it('holdToEscrow debits the client + credits the escrow account in BALANCED paired rows', async () => {
      const db = mockDb();
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) =>
        /FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)
          ? Promise.resolve({user_id: 'client-1', bravo_credits: 1000, currency: 'AED', stripe_customer_id: null, updated_at: NOW})
          : Promise.resolve(null));
      const svc = new WalletService(db, cfgWithEscrow(), mockStripe());
      const res = await svc.holdToEscrow(tx as never, {clientId: 'client-1', bookingId: 'b1', offerId: 'o1', credits: 800});
      expect(res).toEqual({currency: 'AED'});
      // client debit (payment -800) + balance down
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payment', 'succeeded', \$2/), expect.arrayContaining(['client-1', -800]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/bravo_credits = bravo_credits - \$1/), [800, 'client-1']);
      // escrow credit (escrow_hold +800) + balance up
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'escrow_hold', 'succeeded', \$2/), expect.arrayContaining([ESCROW, 800]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/bravo_credits = bravo_credits \+ \$1/), [800, ESCROW]);
      // MONEY INVARIANT: the paired ledger rows net to zero (no money created/destroyed).
      expect(ledgerNet(tx)).toBe(0);
      // Runs entirely on the caller's tx — never the pool (atomic with accept's flip).
      expect(db.q).not.toHaveBeenCalled();
      expect(db.qOne).not.toHaveBeenCalled();
    });

    it('holdToEscrow throws insufficient_credits and writes NOTHING when the client is short', async () => {
      const tx = mockTx();
      tx.qOne.mockResolvedValue({user_id: 'client-1', bravo_credits: 100, currency: 'AED', stripe_customer_id: null, updated_at: NOW});
      const svc = new WalletService(mockDb(), cfgWithEscrow(), mockStripe());
      await expect(svc.holdToEscrow(tx as never, {clientId: 'client-1', bookingId: 'b1', offerId: 'o1', credits: 800}))
        .rejects.toThrow('insufficient_credits');
      expect(tx.q).not.toHaveBeenCalled(); // no ledger row written
    });

    it('refundEscrowHold reverses a HELD hold in BALANCED paired rows: debit escrow, credit client, flip REFUNDED', async () => {
      const db = mockDb();
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({client_id: 'client-1', gross_credits: 800, currency: 'AED', status: 'HELD'});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        return Promise.resolve(null);
      });
      const svc = new WalletService(db, cfgWithEscrow(), mockStripe());
      const res = await svc.refundEscrowHold(tx as never, 'b1', 'no-show');
      expect(res).toEqual({refunded: true, credits: 800});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'escrow_refund', 'succeeded', \$2/), expect.arrayContaining([ESCROW, -800]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/bravo_credits = bravo_credits - \$1/), [800, ESCROW]);
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/bravo_credits = bravo_credits \+ \$1/), [800, 'client-1']);
      // §43 terminal reconciliation: gross == to_client (+ to_provider 0 + fee 0).
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds[\s\S]*REFUNDED/), expect.arrayContaining(['b1', 800]));
      // MONEY INVARIANT: escrow -800 + client +800 nets to zero; tx-only (no pool).
      expect(ledgerNet(tx)).toBe(0);
      expect(db.q).not.toHaveBeenCalled();
      expect(db.qOne).not.toHaveBeenCalled();
    });

    it('refundEscrowHold is an idempotent no-op when there is no HELD hold', async () => {
      const tx = mockTx();
      tx.qOne.mockResolvedValue(null); // no hold row
      const svc = new WalletService(mockDb(), cfgWithEscrow(), mockStripe());
      const res = await svc.refundEscrowHold(tx as never, 'b1', 'no-show');
      expect(res).toEqual({refunded: false, credits: 0});
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('releaseEscrowHold pays the agency provider out of escrow in BALANCED rows (fee 0)', async () => {
      const db = mockDb();
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({provider_user_id: 'agency-A', gross_credits: 800, currency: 'AED', status: 'PENDING_RELEASE'});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        return Promise.resolve(null);
      });
      const svc = new WalletService(db, cfgWithEscrow(), mockStripe());
      const res = await svc.releaseEscrowHold(tx as never, 'b1', 0);
      expect(res).toEqual({released: true, toProvider: 800, platformFee: 0});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'escrow_release', 'succeeded', \$2/), expect.arrayContaining([ESCROW, -800]));
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'payout', 'succeeded', \$2[\s\S]*ON CONFLICT/), expect.arrayContaining(['agency-A', 800]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds[\s\S]*RELEASED/), expect.arrayContaining(['b1', 800, 0]));
      expect(ledgerNet(tx)).toBe(0); // escrow -800 + provider +800
      expect(db.q).not.toHaveBeenCalled();
    });

    it('releaseEscrowHold splits the platform fee and stays balanced (fee 10%)', async () => {
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({provider_user_id: 'agency-A', gross_credits: 800, currency: 'AED', status: 'PENDING_RELEASE'});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        return Promise.resolve(null);
      });
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe()).releaseEscrowHold(tx as never, 'b1', 10);
      expect(res).toEqual({released: true, toProvider: 720, platformFee: 80});
      expect(ledgerNet(tx)).toBe(0); // escrow -800 + provider +720 + fee +80
    });

    it('releaseEscrowHold is an idempotent no-op when the hold is not PENDING_RELEASE', async () => {
      const tx = mockTx();
      tx.qOne.mockResolvedValue({provider_user_id: 'agency-A', gross_credits: 800, currency: 'AED', status: 'RELEASED'});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe()).releaseEscrowHold(tx as never, 'b1', 0);
      expect(res).toEqual({released: false, toProvider: 0, platformFee: 0});
      expect(tx.q).not.toHaveBeenCalled();
    });
  });

  describe('settleEscrowSplit / clawbackReleasedHold / FX (Step 11)', () => {
    const ESCROW = '00000000-0000-0000-0000-0000000000e5';
    const FEE = '00000000-0000-0000-0000-0000000000fe';
    function cfgWithEscrow() {
      return {get: (k: string) => (k === 'platformAccounts.escrowId' ? ESCROW : (k === 'platformAccounts.platformFeeId' ? FEE : undefined))} as never;
    }
    function mockTx() {
      const q = jest.fn((sql: string) =>
        /FROM wallet_credit_batches/.test(sql)
          ? Promise.resolve([{id: 'batch1', amount_credits: 10000, consumed_credits: 0}])
          : Promise.resolve([]));
      return {q, qOne: jest.fn()};
    }
    function ledgerNet(tx: {q: jest.Mock; qOne: jest.Mock}): number {
      return [...tx.q.mock.calls, ...tx.qOne.mock.calls]
        .filter(([sql]) => typeof sql === 'string' && /INSERT INTO wallet_transactions/.test(sql))
        .reduce((acc, [, params]) => acc + (Array.isArray(params) ? Number(params[1]) : 0), 0);
    }
    function holdTx(over: Record<string, unknown> = {}) {
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({provider_user_id: 'agency-A', client_id: 'client-1', gross_credits: 800, currency: 'AED', status: 'HELD', ...over});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({user_id: 'agency-A', bravo_credits: 10000, currency: 'AED'});
        return Promise.resolve(null);
      });
      return tx;
    }

    it('settleEscrowSplit pro-rata: provider + client + fee == gross, ledger nets to zero, flips PARTIAL', async () => {
      const tx = holdTx();
      const svc = new WalletService(mockDb(), cfgWithEscrow(), mockStripe());
      const res = await svc.settleEscrowSplit(tx as never, 'b1', {
        toProvider: 500, toClient: 300, basis: 'pro_rata', fromStatuses: ['HELD'], finalStatus: 'PARTIAL',
      });
      expect(res).toEqual({settled: true, toProvider: 500, toClient: 300, platformFee: 0});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'escrow_release', 'succeeded', \$2/), expect.arrayContaining([ESCROW, -800]));
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'payout', 'succeeded', \$2[\s\S]*ON CONFLICT/), expect.arrayContaining(['agency-A', 500]));
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'refund', 'succeeded', \$2[\s\S]*RETURNING id/), expect.arrayContaining(['client-1', 300]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds[\s\S]*status = \$2/), expect.arrayContaining(['b1', 'PARTIAL', 'pro_rata', 500, 300, 0]));
      expect(ledgerNet(tx)).toBe(0); // escrow -800 + provider +500 + client +300
    });

    it('settleEscrowSplit puts the remainder into the platform fee (provider 600, client 100 → fee 100)', async () => {
      const tx = holdTx();
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .settleEscrowSplit(tx as never, 'b1', {toProvider: 600, toClient: 100, basis: 'partial', fromStatuses: ['HELD'], finalStatus: 'PARTIAL'});
      expect(res).toEqual({settled: true, toProvider: 600, toClient: 100, platformFee: 100});
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'payout', 'succeeded', \$2[\s\S]*ON CONFLICT/), expect.arrayContaining([FEE, 100]));
      expect(ledgerNet(tx)).toBe(0); // escrow -800 + provider +600 + client +100 + fee +100
    });

    // Family bookings: the hold DEBITED the payer (family holder) — every
    // client-side credit must return there, never to escrow_holds.client_id
    // (the member). These were RED against the pre-fix code, which refunded
    // the member's wallet and never reversed the member's cap.
    function familyHoldTx(over: Record<string, unknown> = {}) {
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({provider_user_id: 'agency-A', client_id: 'member-1', gross_credits: 800, currency: 'AED', status: 'HELD', ...over});
        }
        if (/SELECT client_id, payer_user_id FROM lite_bookings/.test(sql)) {
          return Promise.resolve({client_id: 'member-1', payer_user_id: 'holder-9'});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({user_id: 'agency-A', bravo_credits: 10000, currency: 'AED'});
        return Promise.resolve(null);
      });
      return tx;
    }

    it('refundEscrowHold (family): credits the PAYER, stamps the member as actor, reverses the member cap', async () => {
      const tx = familyHoldTx();
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .refundEscrowHold(tx as never, 'b1', 'agency no-show');
      expect(res).toEqual({refunded: true, credits: 800});
      // Refund row: wallet = holder-9 (the payer), actor = member-1.
      expect(tx.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/'refund', 'succeeded', \$2[\s\S]*RETURNING id/),
        expect.arrayContaining(['holder-9', 800, 'member-1']),
      );
      // Balance + expiry batch also land on the payer's wallet.
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/bravo_credits = bravo_credits \+ \$1/), [800, 'holder-9']);
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO wallet_credit_batches/), expect.arrayContaining(['holder-9', 800]));
      // The member's running family spend is reversed (cap freed).
      expect(tx.q).toHaveBeenCalledWith(
        expect.stringMatching(/GREATEST\(0, spent_credits - \$3\)/),
        ['member-1', 'holder-9', 800],
      );
      expect(ledgerNet(tx)).toBe(0); // escrow -800 + payer +800
    });

    it('refundEscrowHold (family): reverses the CHARGE-TIME membership row when the debit stamped family_row_id', async () => {
      const tx = familyHoldTx();
      const base = tx.qOne.getMockImplementation() as (sql: string) => Promise<unknown>;
      tx.qOne.mockImplementation((sql: string) => {
        if (/family_row_id/.test(sql) && /FROM wallet_transactions/.test(sql)) {
          return Promise.resolve({row_id: 'fm-old'});
        }
        return base(sql);
      });
      await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .refundEscrowHold(tx as never, 'b1', 'agency no-show');
      // Reversal lands on the ORIGINAL row by id — a revoke → re-invite fresh
      // row's legitimate spend is untouched.
      expect(tx.q).toHaveBeenCalledWith(
        expect.stringMatching(/GREATEST\(0, spent_credits - \$2\)[\s\S]*WHERE id = \$1/),
        ['fm-old', 800],
      );
      expect(tx.q).not.toHaveBeenCalledWith(
        expect.stringMatching(/GREATEST\(0, spent_credits - \$3\)/),
        expect.anything(),
      );
    });

    it('settleEscrowSplit (family): the client share goes to the payer and reverses the member cap', async () => {
      const tx = familyHoldTx();
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .settleEscrowSplit(tx as never, 'b1', {toProvider: 500, toClient: 300, basis: 'pro_rata', fromStatuses: ['HELD'], finalStatus: 'PARTIAL'});
      expect(res).toEqual({settled: true, toProvider: 500, toClient: 300, platformFee: 0});
      expect(tx.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/'refund', 'succeeded', \$2[\s\S]*RETURNING id/),
        expect.arrayContaining(['holder-9', 300, 'member-1']),
      );
      expect(tx.q).toHaveBeenCalledWith(
        expect.stringMatching(/GREATEST\(0, spent_credits - \$3\)/),
        ['member-1', 'holder-9', 300],
      );
      expect(ledgerNet(tx)).toBe(0);
    });

    it('clawbackReleasedHold (family): the reclaimed client share goes to the payer', async () => {
      const tx = familyHoldTx({status: 'RELEASED', to_provider_credits: 800, platform_fee_credits: 0, to_client_credits: 0});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .clawbackReleasedHold(tx as never, 'b1', 800, 0, 'dispute upheld');
      expect(res.clawed).toBe(true);
      expect(tx.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/'refund', 'succeeded', \$2[\s\S]*RETURNING id/),
        expect.arrayContaining(['holder-9', 800, 'member-1']),
      );
      expect(tx.q).toHaveBeenCalledWith(
        expect.stringMatching(/GREATEST\(0, spent_credits - \$3\)/),
        ['member-1', 'holder-9', 800],
      );
    });

    it('settleEscrowSplit is an idempotent no-op when the hold is not in fromStatuses', async () => {
      const tx = holdTx({status: 'RELEASED'});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .settleEscrowSplit(tx as never, 'b1', {toProvider: 500, toClient: 300, basis: 'pro_rata', fromStatuses: ['HELD'], finalStatus: 'PARTIAL'});
      expect(res).toEqual({settled: false, toProvider: 0, toClient: 0, platformFee: 0});
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('clawbackReleasedHold refunds the client + debits the agency, ledger nets to zero', async () => {
      const tx = holdTx({status: 'RELEASED', to_provider_credits: 800, platform_fee_credits: 0, to_client_credits: 0});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .clawbackReleasedHold(tx as never, 'b1', 800, 0, 'dispute upheld');
      expect(res).toEqual({clawed: true, toClient: 800, toPlatform: 0, toProvider: 0, shortfall: 0});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payment', 'succeeded', \$2/), expect.arrayContaining(['agency-A', -800]));
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'refund', 'succeeded', \$2[\s\S]*RETURNING id/), expect.arrayContaining(['client-1', 800]));
      // final split is re-stated so the columns still sum to gross (reconciliation-clean).
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/UPDATE escrow_holds[\s\S]*basis = 'clawback'/), ['b1', 800, 0, 0]);
      expect(ledgerNet(tx)).toBe(0); // agency -800 + client +800
    });

    it('clawbackReleasedHold splits the reclaim between client and platform (client 600 + platform 200)', async () => {
      const tx = holdTx({status: 'RELEASED', to_provider_credits: 800, platform_fee_credits: 0, to_client_credits: 0});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .clawbackReleasedHold(tx as never, 'b1', 600, 200, 'partial upheld');
      expect(res).toEqual({clawed: true, toClient: 600, toPlatform: 200, toProvider: 0, shortfall: 0});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payment', 'succeeded', \$2/), expect.arrayContaining(['agency-A', -800])); // pull 800 from agency
      expect(tx.qOne).toHaveBeenCalledWith(expect.stringMatching(/'refund'[\s\S]*RETURNING id/), expect.arrayContaining(['client-1', 600]));
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payout', 'succeeded', \$2/), expect.arrayContaining([FEE, 200]));
      expect(ledgerNet(tx)).toBe(0); // agency -800 + client +600 + platform +200
    });

    it('clawbackReleasedHold is an idempotent no-op when already clawed back (basis=clawback)', async () => {
      const tx = holdTx({status: 'RELEASED', basis: 'clawback', to_provider_credits: 800});
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .clawbackReleasedHold(tx as never, 'b1', 800, 0, 'retry');
      expect(res.clawed).toBe(false);
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('clawbackReleasedHold: platform covers the shortfall when the agency is short', async () => {
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) => {
        if (/FROM escrow_holds WHERE booking_id = \$1 FOR UPDATE/.test(sql)) {
          return Promise.resolve({provider_user_id: 'agency-A', client_id: 'client-1', gross_credits: 800, currency: 'AED', status: 'RELEASED', basis: 'full_release', to_provider_credits: 800, platform_fee_credits: 0, to_client_credits: 0});
        }
        if (/INSERT INTO wallet_transactions[\s\S]*RETURNING id/.test(sql)) return Promise.resolve({id: 'tx1'});
        if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)) return Promise.resolve({user_id: 'agency-A', bravo_credits: 300, currency: 'AED'});
        return Promise.resolve(null);
      });
      const res = await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .clawbackReleasedHold(tx as never, 'b1', 800, 0, 'dispute upheld');
      expect(res).toEqual({clawed: true, toClient: 800, toPlatform: 0, toProvider: 0, shortfall: 500});
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payment', 'succeeded', \$2/), expect.arrayContaining(['agency-A', -300]));
      // shortfall fronted by the platform fee account (negative payout): delta = 0 - 500.
      expect(tx.q).toHaveBeenCalledWith(expect.stringMatching(/'payout', 'succeeded', \$2/), expect.arrayContaining([FEE, -500]));
      expect(ledgerNet(tx)).toBe(0); // agency -300 + platform -500 + client +800
    });

    it('computeCreditsForFiat holds the 1-fiat-unit = 1-BC peg for every currency', () => {
      const svc = new WalletService(mockDb(), cfgWithEscrow(), mockStripe());
      const f = (amt: number, cur: string) => (svc as unknown as {computeCreditsForFiat(a: number, c: string): number}).computeCreditsForFiat(amt, cur);
      expect(f(100, 'usd')).toBe(100);
      expect(f(367, 'aed')).toBe(367);
      expect(f(100, 'eur')).toBe(100);
      expect(f(375, 'sar')).toBe(375);
      expect(f(1100, 'bdt')).toBe(1100);
      expect(f(100, 'gbp')).toBe(100);
      expect(f(237.5, 'usd')).toBe(238);             // rounds to a whole credit
    });

    it('holdToEscrow stamps the fx rate + currency on the ledger metadata', async () => {
      const tx = mockTx();
      tx.qOne.mockImplementation((sql: string) =>
        /FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)
          ? Promise.resolve({user_id: 'client-1', bravo_credits: 1000, currency: 'BDT', stripe_customer_id: null})
          : Promise.resolve(null));
      await new WalletService(mockDb(), cfgWithEscrow(), mockStripe())
        .holdToEscrow(tx as never, {clientId: 'client-1', bookingId: 'b1', offerId: 'o1', credits: 800});
      // Both paired rows carry the fx stamp so a later reversal can show the held rate.
      const metas = (tx.q.mock.calls as unknown as unknown[][])
        .filter(call => /INSERT INTO wallet_transactions/.test(call[0] as string))
        .map(call => (call[1] as unknown[])[5] as string);
      expect(metas.length).toBeGreaterThanOrEqual(2);
      for (const m of metas) expect(m).toMatch(/"fx_currency":"bdt"/);
    });
  });
});
