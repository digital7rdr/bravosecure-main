import {IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength} from 'class-validator';

/** POST /wallet/redeem-promo — apply a promo code that credits BC. */
export class RedeemPromoDto {
  @IsString() @MinLength(1) @MaxLength(40)
  code!: string;
}

/** POST /wallet/topup — mint Stripe PaymentIntent + write pending ledger row. */
export class TopUpDto {
  /**
   * Fiat amount in the currency's MAJOR unit — e.g. `237.50` USD.
   * Must be a finite number (decimals allowed); server rounds to cents.
   * `maxDecimalPlaces: 2` mirrors Stripe's precision for USD / AED / EUR
   * so we can't accept sub-cent amounts that'd round-trip oddly.
   */
  @IsNumber({allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2})
  @Min(1) @Max(100_000)
  amount!: number;

  // Industry-style settlement-currency whitelist: every currency the product
  // regions use (AE/SA/BD/GB + usd/eur base) is accepted — all are Stripe
  // 2-decimal currencies, and under the 1-fiat-unit = 1-BC peg the awarded
  // credits are round(amount) regardless of which one the card is charged in.
  @IsString() @IsIn(['usd', 'aed', 'eur', 'sar', 'gbp', 'bdt'])
  currency!: string;

  /** Optional — display-only hint for the ledger description. */
  @IsOptional() @IsInt() @Min(0)
  credits_hint?: number;
}
