import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';

export interface InvoiceLine {
  label: string;
  per_hour: number | null;
  hours: number | null;
  amount_credits: number;
}

export interface InvoiceDto {
  id: string;
  invoice_number: string;
  booking_id: string;
  kind: 'client_receipt' | 'credit_note';
  issued_at: string;
  currency: string;
  line_items: InvoiceLine[];
  subtotal_credits: number;
  tax_rate_pct: number;
  tax_credits: number;
  total_credits: number;
  // Display context (joined, not stored): what/when/where the client bought.
  booking: {
    service: string; region_label: string; pickup_time: string;
    pickup_address: string; dropoff_address: string | null;
    cpo_count: number; duration_hours: number;
  };
}

/**
 * F1 — invoice / receipt issuance. `lite_bookings.invoice_pdf_url` existed for
 * months with a dead INVOICE button in front of it and nothing ever writing it.
 * V1 issues a NUMBERED, line-itemised invoice ROW (rendered natively by the
 * apps); a PDF export can later fill `pdf_url` without changing this model.
 *
 * Idempotent by construction: UNIQUE (booking_id, kind) — a re-request returns
 * the existing invoice; the number sequence only advances on a real insert.
 * Money truth: the total binds to the ESCROW split (what actually moved), not a
 * recomputation; the quote-time pricing_breakdown supplies the line items with a
 * rounding-adjustment line when the two disagree by a credit.
 *
 * Tax: `region_tax` ships 0% for every region until finance signs real VAT
 * rates (AE 5% / GB 20% are the expected first entries) — the columns exist so
 * enabling them is config, not schema.
 */
@Injectable()
export class InvoiceService {
  private readonly log = new Logger(InvoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /** Client receipt (COMPLETED booking) or credit note (refunded terminal). */
  async getOrCreateForClient(clientId: string, bookingId: string): Promise<InvoiceDto> {
    const b = await this.db.qOne<{
      id: string; client_id: string; status: string; region_code: string;
      region_label: string; service: string; pickup_time: Date;
      pickup_address: string; dropoff_address: string | null;
      cpo_count: number; duration_hours: number; total_eur: string;
      pricing_breakdown: InvoiceLine[] | Array<{label: string; amount_eur: number}> | null;
    }>(
      `SELECT id, client_id, status, region_code, region_label, service, pickup_time,
              pickup_address, dropoff_address, cpo_count, duration_hours, total_eur,
              pricing_breakdown
         FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    if (!b || b.client_id !== clientId) throw new NotFoundException('Booking not found');

    const kind: 'client_receipt' | 'credit_note' =
      b.status === 'COMPLETED' ? 'client_receipt'
      : (b.status === 'CANCELLED' || b.status === 'AGENCY_NO_SHOW') ? 'credit_note'
      : (() => { throw new BadRequestException('invoice_not_available_yet'); })();

    const existing = await this.readInvoice(bookingId, kind);
    if (existing) {return this.withBookingContext(existing, b);}

    // Amounts bind to what the escrow ACTUALLY settled (fall back to the quote
    // total for legacy bookings with no hold).
    const hold = await this.db.qOne<{
      gross_credits: number; to_client_credits: number | null; status: string;
    }>(
      `SELECT gross_credits, to_client_credits, status FROM escrow_holds WHERE booking_id = $1`,
      [bookingId],
    );
    const gross = hold?.gross_credits ?? Math.round(Number(b.total_eur));
    const total = kind === 'credit_note'
      ? (hold?.to_client_credits ?? gross)
      : gross;
    if (kind === 'credit_note' && total <= 0) {
      throw new BadRequestException('no_refund_to_credit');
    }

    const hours = Math.max(1, b.duration_hours ?? 1);
    const lines: InvoiceLine[] = [];
    if (kind === 'client_receipt' && Array.isArray(b.pricing_breakdown) && b.pricing_breakdown.length > 0) {
      for (const raw of b.pricing_breakdown as Array<{label: string; amount_eur: number}>) {
        const perHour = Number(raw.amount_eur ?? 0);
        lines.push({
          label: raw.label,
          per_hour: +perHour.toFixed(2),
          hours,
          amount_credits: Math.round(perHour * hours),
        });
      }
      const sum = lines.reduce((a, l) => a + l.amount_credits, 0);
      if (sum !== total) {
        lines.push({label: 'Rounding adjustment', per_hour: null, hours: null, amount_credits: total - sum});
      }
    } else {
      lines.push({
        label: kind === 'credit_note' ? 'Refund — booking cancelled' : `Protection detail · ${hours}h`,
        per_hour: null, hours: kind === 'credit_note' ? null : hours,
        amount_credits: kind === 'credit_note' ? -total : total,
      });
    }

    const taxRates = this.config.get<Record<string, number>>('regionTaxPct') ?? {};
    const taxRate = taxRates[b.region_code] ?? 0;
    // Credits are tax-INCLUSIVE: tax is broken out of the total, never added on
    // top (the client was charged exactly `total`).
    const tax = taxRate > 0 ? Math.round((total * taxRate) / (100 + taxRate)) : 0;
    const subtotal = kind === 'credit_note' ? -total : total - tax;
    const signedTotal = kind === 'credit_note' ? -total : total;

    const created = await this.db.withTransaction(async tx => {
      // Re-check under the txn — a concurrent request may have won the insert.
      const race = await tx.qOne<Record<string, unknown>>(
        `SELECT * FROM invoices WHERE booking_id = $1 AND kind = $2`,
        [bookingId, kind],
      );
      if (race) {return race;}
      const seq = await tx.qOne<{no: string}>(
        `INSERT INTO invoice_sequences (region_code, next_no) VALUES ($1, 2)
         ON CONFLICT (region_code) DO UPDATE SET next_no = invoice_sequences.next_no + 1
         RETURNING (next_no - 1)::text AS no`,
        [b.region_code],
      );
      const number = `${b.region_code}-${new Date().getUTCFullYear()}-${String(seq?.no ?? '1').padStart(6, '0')}`;
      const row = await tx.qOne<Record<string, unknown>>(
        `INSERT INTO invoices
           (invoice_number, booking_id, kind, currency, line_items,
            subtotal_credits, tax_rate_pct, tax_credits, total_credits)
         VALUES ($1, $2, $3, 'BC', $4::jsonb, $5, $6, $7, $8)
         ON CONFLICT (booking_id, kind) DO NOTHING
         RETURNING *`,
        [number, bookingId, kind, JSON.stringify(lines), subtotal, taxRate, tax, signedTotal],
      );
      // ON CONFLICT loser: read the winner (its number was minted first).
      return row ?? await tx.qOne<Record<string, unknown>>(
        `SELECT * FROM invoices WHERE booking_id = $1 AND kind = $2`,
        [bookingId, kind],
      );
    });
    if (!created) throw new BadRequestException('invoice_create_failed');
    this.log.log(`invoice ${(created as {invoice_number?: string}).invoice_number} issued booking=${bookingId} kind=${kind}`);
    return this.withBookingContext(created, b);
  }

  private async readInvoice(bookingId: string, kind: string): Promise<Record<string, unknown> | null> {
    return this.db.qOne<Record<string, unknown>>(
      `SELECT * FROM invoices WHERE booking_id = $1 AND kind = $2`,
      [bookingId, kind],
    );
  }

  private withBookingContext(
    row: Record<string, unknown>,
    b: {
      service: string; region_label: string; pickup_time: Date;
      pickup_address: string; dropoff_address: string | null;
      cpo_count: number; duration_hours: number;
    },
  ): InvoiceDto {
    return {
      id: String(row.id),
      invoice_number: String(row.invoice_number),
      booking_id: String(row.booking_id),
      kind: row.kind as InvoiceDto['kind'],
      issued_at: new Date(row.issued_at as string | Date).toISOString(),
      currency: String(row.currency ?? 'BC'),
      line_items: (row.line_items ?? []) as InvoiceLine[],
      subtotal_credits: Number(row.subtotal_credits),
      tax_rate_pct: Number(row.tax_rate_pct),
      tax_credits: Number(row.tax_credits),
      total_credits: Number(row.total_credits),
      booking: {
        service: b.service, region_label: b.region_label,
        pickup_time: new Date(b.pickup_time).toISOString(),
        pickup_address: b.pickup_address, dropoff_address: b.dropoff_address,
        cpo_count: b.cpo_count, duration_hours: b.duration_hours,
      },
    };
  }
}
