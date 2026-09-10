import {StripeClient} from './stripe.client';
import {createHmac} from 'crypto';

function mkCfg(overrides: Record<string, unknown> = {}) {
  const cfg = {
    'stripe.secretKey': '',
    'stripe.webhookSecret': '',
    'stripe.creditsPerUsd': 10,
    'stripe.apiBase': 'https://stripe.test',
    'stripe.apiVersion': '2024-06-20',
    ...overrides,
  } as Record<string, unknown>;
  return {get: (k: string) => cfg[k]} as never;
}

describe('StripeClient', () => {
  describe('enabled flag', () => {
    it('is false when no secret key', () => {
      const c = new StripeClient(mkCfg() as never);
      expect(c.enabled).toBe(false);
    });

    it('is true when a secret key is set', () => {
      const c = new StripeClient(mkCfg({'stripe.secretKey': 'sk_test_x'}) as never);
      expect(c.enabled).toBe(true);
    });
  });

  describe('createPaymentIntent', () => {
    it('throws stripe_disabled when secret key is empty', async () => {
      const c = new StripeClient(mkCfg() as never);
      await expect(
        c.createPaymentIntent({amountCents: 100, currency: 'usd'}),
      ).rejects.toMatchObject({message: 'stripe_disabled'});
    });

    it('POSTs to /v1/payment_intents with urlencoded body and returns parsed intent', async () => {
      const c = new StripeClient(mkCfg({'stripe.secretKey': 'sk_test_ok'}) as never);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'pi_1',
          client_secret: 'pi_1_secret',
          status: 'requires_payment_method',
          amount: 1900,
          currency: 'usd',
        }),
      });
      (globalThis as unknown as {fetch: typeof fetch}).fetch = fetchMock as unknown as typeof fetch;

      const intent = await c.createPaymentIntent({
        amountCents: 1900,
        currency: 'USD',
        customerId: 'cus_1',
        description: 'Top-up',
        metadata: {user_id: 'u1', credits: '190'},
      });

      expect(intent.id).toBe('pi_1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://stripe.test/v1/payment_intents');
      expect(init.headers.Authorization).toBe('Bearer sk_test_ok');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init.body).toContain('amount=1900');
      expect(init.body).toContain('currency=usd');
      expect(init.body).toContain('customer=cus_1');
      expect(init.body).toContain('metadata%5Bcredits%5D=190');
      expect(init.body).toContain('automatic_payment_methods%5Benabled%5D=true');
    });

    it('surfaces Stripe error messages', async () => {
      const c = new StripeClient(mkCfg({'stripe.secretKey': 'sk'}) as never);
      (globalThis as unknown as {fetch: typeof fetch}).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 402,
        json: async () => ({error: {message: 'Your card was declined.', code: 'card_declined'}}),
      }) as unknown as typeof fetch;

      await expect(
        c.createPaymentIntent({amountCents: 100, currency: 'usd'}),
      ).rejects.toMatchObject({message: 'Your card was declined.', status: 402});
    });
  });

  describe('ensureCustomer', () => {
    it('returns existing customer id without calling Stripe', async () => {
      const c = new StripeClient(mkCfg({'stripe.secretKey': 'sk'}) as never);
      const fetchMock = jest.fn();
      (globalThis as unknown as {fetch: typeof fetch}).fetch = fetchMock as unknown as typeof fetch;
      const id = await c.ensureCustomer('u1', 'cus_existing');
      expect(id).toBe('cus_existing');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates a customer when none exists', async () => {
      const c = new StripeClient(mkCfg({'stripe.secretKey': 'sk'}) as never);
      (globalThis as unknown as {fetch: typeof fetch}).fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({id: 'cus_new'}),
      }) as unknown as typeof fetch;
      const id = await c.ensureCustomer('user-99', null);
      expect(id).toBe('cus_new');
    });
  });

  describe('verifyWebhook', () => {
    const secret = 'whsec_abc';
    const client = new StripeClient(mkCfg({'stripe.webhookSecret': secret}) as never);

    function sign(body: string, ts: number, withSecret = secret): string {
      const sig = createHmac('sha256', withSecret).update(`${ts}.${body}`).digest('hex');
      return `t=${ts},v1=${sig}`;
    }

    it('parses a valid payload', () => {
      const body = JSON.stringify({id: 'evt_1', type: 'payment_intent.succeeded', data: {object: {id: 'pi_1'}}});
      const ts = Math.floor(Date.now() / 1000);
      const evt = client.verifyWebhook(body, sign(body, ts));
      expect(evt.id).toBe('evt_1');
      expect(evt.type).toBe('payment_intent.succeeded');
    });

    it('rejects a stale timestamp', () => {
      const body = '{}';
      const ts = Math.floor(Date.now() / 1000) - 10_000;
      expect(() => client.verifyWebhook(body, sign(body, ts))).toThrow('signature_too_old');
    });

    it('rejects a tampered body', () => {
      const body = '{"a":1}';
      const ts = Math.floor(Date.now() / 1000);
      const header = sign(body, ts);
      expect(() => client.verifyWebhook('{"a":2}', header)).toThrow('signature_mismatch');
    });

    it('rejects a missing signature header', () => {
      expect(() => client.verifyWebhook('{}', undefined)).toThrow('missing_signature');
    });

    it('rejects when webhook secret is unconfigured', () => {
      const bareClient = new StripeClient(mkCfg() as never);
      expect(() => bareClient.verifyWebhook('{}', 't=1,v1=x')).toThrow('webhook_secret_missing');
    });
  });
});
