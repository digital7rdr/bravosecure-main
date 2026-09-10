/**
 * Issue 31 (Testing Issues V2, PDF p.36) — "Post-Mission Rating Does Not Allow
 * Written Remarks".
 *
 * Found while fixing it: `tags` were ALREADY accepted by SubmitRatingDto and
 * ALREADY sent by the screen, but submitRating() only ever wrote `rating`. The
 * preset feedback the client picked was silently discarded, so the same defect
 * existed twice. Both are persisted now.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SCREEN = 'src/screens/booking/RateAgencyScreen.tsx';
const SERVICE = 'apps/auth-service/src/booking/booking.service.ts';
const DTO = 'apps/auth-service/src/booking/dto/rating.dto.ts';

describe('Issue 31 — the client can leave written remarks', () => {
  it('the screen renders a remarks input beneath the preset tags', () => {
    const src = code(SCREEN);
    expect(src).toContain('<TextInput');
    expect(src).toMatch(/value=\{remarks\}/);
    // Order matters: the PDF asks for it BENEATH the tags.
    expect(src.indexOf('TAGS.map')).toBeLessThan(src.indexOf('remarksWrap'));
  });

  it('remarks are sent on submit, and blank means absent (not an empty string)', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/submitRating\(bookingId, \{stars, tags, remarks: remarks\.trim\(\) \|\| undefined\}\)/);
  });

  it('the client-side cap matches the server cap exactly', () => {
    const screen = code(SCREEN);
    const dto = code(DTO);
    expect(screen).toMatch(/REMARKS_MAX = 500/);
    expect(screen).toMatch(/maxLength=\{REMARKS_MAX\}/);
    expect(dto).toMatch(/@MaxLength\(500\)/);
  });

  it('the screen uses the app-wide keyboard rule, not a hand-rolled one', () => {
    const src = code(SCREEN);
    // CLAUDE.md B-184: the bottom-most element owns the inset via bottomPad().
    expect(src).toMatch(/useKeyboardLayout/);
    expect(src).toMatch(/paddingBottom: bottomPad\(12\)/);
    expect(src).not.toMatch(/KeyboardAvoidingView|keyboardVerticalOffset|kbHeight/);
  });

  it('the server PERSISTS remarks and tags, not just the star count', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/UPDATE lite_bookings SET rating = \$2, rating_tags = \$4, rating_remarks = \$5/);
    expect(src).toMatch(/dto\.remarks\?\.trim\(\) \|\| null/);
    // tags were accepted by the DTO but never written — the second half of this bug.
    expect(src).toMatch(/dto\.tags \?\? null/);
  });

  it('the one-rating-per-booking guard is untouched', () => {
    const src = code(SERVICE);
    // Losing this would let a re-submit overwrite and skew the agency average.
    expect(src).toMatch(/AND status = 'COMPLETED' AND rating IS NULL/);
  });

  it('a migration adds the columns with a defence-in-depth length check', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725120000_booking_rating_remarks.sql'), 'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS rating_tags\s+TEXT\[\]/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS rating_remarks TEXT/);
    expect(sql).toMatch(/char_length\(rating_remarks\) <= 500/);
  });

  it('remarks are documented as quality/ops-only, never provider-visible', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725120000_booking_rating_remarks.sql'), 'utf8',
    );
    expect(sql).toMatch(/Authorised quality\/ops roles only/);
    // And nothing reads it back on a client- or provider-facing path yet.
    expect(code(SERVICE)).not.toMatch(/SELECT[^;]*rating_remarks/);
  });
});
