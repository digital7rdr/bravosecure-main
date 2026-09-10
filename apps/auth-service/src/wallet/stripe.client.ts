import {HttpException, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHmac, timingSafeEqual} from 'crypto';

export interface StripePaymentIntent {
  id: string;
  client_secret: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'succeeded' | 'canceled' | string;
  amount: number;
  currency: string;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: {object: Record<string, unknown>};
}

export interface StripeCard {
  id: string;
  card: {brand: string; last4: string; exp_month: number; exp_year: number};
}

/**
 * Thin HTTPS shim over the Stripe REST API. We avoid the official SDK so
 * auth-service keeps its dependency surface narrow — PaymentIntents and
 * the webhook signature verifier are the only surfaces we need.
 *
 * When `STRIPE_SECRET_KEY` is empty (local dev with no Stripe account), the
 * client reports `enabled = false` and every method throws a structured
 * error. Callers treat that as "fall back to credit-only mode" rather than
 * a 500.
 */
@Injectable()
export class StripeClient {
  private readonly log = new Logger(StripeClient.name);

  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return !!this.cfg.get<string>('stripe.secretKey');
  }

  async createPaymentIntent(opts: {
    amountCents: number;
    currency: string;
    customerId?: string;
    metadata?: Record<string, string>;
    description?: string;
  }): Promise<StripePaymentIntent> {
    if (!this.enabled) {
      throw new HttpException('stripe_disabled', 503);
    }
    const body = new URLSearchParams();
    body.set('amount', String(opts.amountCents));
    body.set('currency', opts.currency.toLowerCase());
    body.set('automatic_payment_methods[enabled]', 'true');
    if (opts.customerId) body.set('customer', opts.customerId);
    if (opts.description) body.set('description', opts.description);
    for (const [k, v] of Object.entries(opts.metadata ?? {})) {
      body.set(`metadata[${k}]`, v);
    }
    return this.post<StripePaymentIntent>('/v1/payment_intents', body);
  }

  /**
   * Fetch a PaymentIntent's current state. Used by the client-confirm flow
   * so the server can independently verify a charge succeeded without
   * relying on the webhook (handy in environments where Stripe can't reach
   * us — e.g. local dev without `stripe listen` running).
   */
  async getPaymentIntent(id: string): Promise<StripePaymentIntent> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const base = this.cfg.get<string>('stripe.apiBase') ?? 'https://api.stripe.com';
    const version = this.cfg.get<string>('stripe.apiVersion') ?? '2024-06-20';
    const key = this.cfg.get<string>('stripe.secretKey')!;
    const res = await fetch(`${base}/v1/payment_intents/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': version},
      signal: AbortSignal.timeout(10_000), // Audit Rev2 API-05
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const err = (json as {error?: {message?: string; code?: string}}).error;
      this.log.warn(`Stripe GET /v1/payment_intents/${id} ${res.status}: ${err?.code ?? ''} ${err?.message ?? ''}`);
      throw new HttpException(err?.message ?? 'stripe_error', res.status);
    }
    return json as StripePaymentIntent;
  }

  /**
   * Create an auto-renewing Stripe subscription for `customerId` on the
   * configured Pro price. Stripe charges the customer's default payment
   * method each period and fires `invoice.paid` / `invoice.payment_failed`
   * webhooks we settle against. Returns the subscription id + status.
   *
   * Requires a configured `stripe.proPriceId` (a Price object in the Stripe
   * dashboard) and the customer to have a default payment method.
   */
  async createSubscription(opts: {
    customerId: string;
    metadata?: Record<string, string>;
    /** Which paid tier's Price id to bill (default 'pro'). An unconfigured
     *  tier price throws 503 — callers degrade to BC-only, no auto-renew. */
    tier?: 'pro' | 'enterprise';
  }, idempotencyKey?: string): Promise<{id: string; status: string; current_period_end: number}> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const priceId = opts.tier === 'enterprise'
      ? this.cfg.get<string>('stripe.enterprisePriceId')
      : this.cfg.get<string>('stripe.proPriceId');
    if (!priceId) throw new HttpException(`stripe_${opts.tier ?? 'pro'}_price_not_configured`, 503);
    const body = new URLSearchParams();
    body.set('customer', opts.customerId);
    body.set('items[0][price]', priceId);
    // Fail fast if the card can't be charged at creation, so the caller
    // can fall back rather than create a half-live subscription.
    body.set('payment_behavior', 'error_if_incomplete');
    for (const [k, v] of Object.entries(opts.metadata ?? {})) {
      body.set(`metadata[${k}]`, v);
    }
    return this.post<{id: string; status: string; current_period_end: number}>(
      '/v1/subscriptions', body,
    );
  }

  /** Cancel a subscription immediately (used on user-initiated cancel). */
  async cancelSubscription(subscriptionId: string): Promise<{id: string; status: string}> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const base = this.cfg.get<string>('stripe.apiBase') ?? 'https://api.stripe.com';
    const version = this.cfg.get<string>('stripe.apiVersion') ?? '2024-06-20';
    const key = this.cfg.get<string>('stripe.secretKey')!;
    const res = await fetch(`${base}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': version},
      signal: AbortSignal.timeout(10_000), // Audit Rev2 API-05 — on the orphan-fix hot path
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const err = (json as {error?: {message?: string; code?: string}}).error;
      this.log.warn(`Stripe DELETE /v1/subscriptions/${subscriptionId} ${res.status}: ${err?.code ?? ''} ${err?.message ?? ''}`);
      throw new HttpException(err?.message ?? 'stripe_error', res.status);
    }
    return json as {id: string; status: string};
  }

  async ensureCustomer(userId: string, existingId: string | null): Promise<string> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    if (existingId) return existingId;
    const body = new URLSearchParams();
    body.set('metadata[user_id]', userId);
    const c = await this.post<{id: string}>('/v1/customers', body);
    return c.id;
  }

  // ── Saved cards (Payment Methods) ─────────────────────────────────────────

  /** SetupIntent the client confirms via PaymentSheet to save a card off-session. */
  async createSetupIntent(customerId: string): Promise<{id: string; client_secret: string}> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const body = new URLSearchParams();
    body.set('customer', customerId);
    body.set('usage', 'off_session');
    body.set('automatic_payment_methods[enabled]', 'true');
    return this.post<{id: string; client_secret: string}>('/v1/setup_intents', body);
  }

  /** The customer's saved card payment methods. */
  async listCards(customerId: string): Promise<StripeCard[]> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const res = await this.get<{data: StripeCard[]}>(
      `/v1/payment_methods?customer=${encodeURIComponent(customerId)}&type=card`,
    );
    return res.data ?? [];
  }

  /** Detach (remove) a saved card from its customer. */
  async detachCard(paymentMethodId: string): Promise<StripeCard> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    return this.post<StripeCard>(
      `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`,
      new URLSearchParams(),
    );
  }

  /** Set the customer's default payment method (used for off-session charges). */
  async setDefaultCard(customerId: string, paymentMethodId: string): Promise<void> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const body = new URLSearchParams();
    body.set('invoice_settings[default_payment_method]', paymentMethodId);
    await this.post(`/v1/customers/${encodeURIComponent(customerId)}`, body);
  }

  /** The customer's current default payment method id, if any. */
  async getDefaultCardId(customerId: string): Promise<string | null> {
    if (!this.enabled) throw new HttpException('stripe_disabled', 503);
    const c = await this.get<{invoice_settings?: {default_payment_method?: string | null}}>(
      `/v1/customers/${encodeURIComponent(customerId)}`,
    );
    return c.invoice_settings?.default_payment_method ?? null;
  }

  private async get<T>(path: string): Promise<T> {
    const base = this.cfg.get<string>('stripe.apiBase') ?? 'https://api.stripe.com';
    const version = this.cfg.get<string>('stripe.apiVersion') ?? '2024-06-20';
    const key = this.cfg.get<string>('stripe.secretKey')!;
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': version},
      signal: AbortSignal.timeout(10_000), // Audit Rev2 API-05
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const err = (json as {error?: {message?: string; code?: string}}).error;
      this.log.warn(`Stripe GET ${path} ${res.status}: ${err?.code ?? ''} ${err?.message ?? ''}`);
      throw new HttpException(err?.message ?? 'stripe_error', res.status);
    }
    return json as T;
  }

  /**
   * Verify a `Stripe-Signature` header against the raw request body. Based on
   * Stripe's documented v1 scheme. Throws if signature / timestamp don't
   * match. Returns the parsed event on success.
   */
  verifyWebhook(rawBody: Buffer | string, signatureHeader: string | undefined, toleranceSec = 300): StripeEvent {
    const secret = this.cfg.get<string>('stripe.webhookSecret');
    if (!secret) throw new HttpException('webhook_secret_missing', 500);
    if (!signatureHeader) throw new HttpException('missing_signature', 400);

    const parts = Object.fromEntries(
      signatureHeader.split(',').map(kv => {
        const [k, ...rest] = kv.split('=');
        return [k, rest.join('=')];
      }),
    );
    const ts = parts['t'];
    const v1 = parts['v1'];
    if (!ts || !v1) throw new HttpException('bad_signature', 400);

    if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) {
      throw new HttpException('signature_too_old', 400);
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpException('signature_mismatch', 400);
    }

    return JSON.parse(payload) as StripeEvent;
  }

  private async post<T>(path: string, body: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const base = this.cfg.get<string>('stripe.apiBase') ?? 'https://api.stripe.com';
    const version = this.cfg.get<string>('stripe.apiVersion') ?? '2024-06-20';
    const key = this.cfg.get<string>('stripe.secretKey')!;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': version,
    };
    // Audit Rev2 API-04 — an Idempotency-Key makes a RETRY of the SAME write
    // (network drop, internal re-call) reuse Stripe's first result instead of
    // creating a second intent/subscription. Only set when the caller derives a
    // key tied to the business operation.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    // Audit Rev2 API-05 — Node fetch has NO default timeout; a stalled Stripe
    // socket held the request ~5 min and saturated the pool. 10s deadline.
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const err = (json as {error?: {message?: string; code?: string}}).error;
      this.log.warn(`Stripe ${path} ${res.status}: ${err?.code ?? ''} ${err?.message ?? ''}`);
      throw new HttpException(err?.message ?? 'stripe_error', res.status);
    }
    return json as T;
  }
}
