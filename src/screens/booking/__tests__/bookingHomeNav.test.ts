/**
 * Wave 5a A2 — Book Now routes straight to service selection.
 *
 * The founder streamlining (PDF-2) drops the zone-first step from the Book Now
 * flow: the hero CTA and the FAB now navigate directly to `ServiceType` instead
 * of `ZoneMap`. This is safe because `bookingStore.defaultDraft` already seeds a
 * valid zone (`zone_code`/`region` = 'AE', a non-empty `zone_label`), so skipping
 * ZoneMap never leaves the draft with a null zone — estimatePrice/confirmBooking
 * gate only on `pickup`, and every downstream zone consumer has an `|| 'AE'`
 * fallback. ZoneMap stays REACHABLE via the header region chip / Zone Map
 * quick-action (it becomes a dashboard section in 5b).
 *
 * Source scan (no test can import BookingHomeScreen in the node project): strip
 * comments + normalise CRLF, then count the literal navigate() call sites.
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

describe('Wave 5a A2 — Book Now skips the zone-first step', () => {
  const src = code('src/screens/booking/BookingHomeScreen.tsx');

  // NAV-10 (2026-08-26) — press sites now dispatch through navigateOnce (same
  // destination, guarded against a tap mash). The destinations are the pin.
  it('the hero CTA and the FAB navigate straight to ServiceType', () => {
    const hits = src.match(/navigateOnce\(navigation, 'ServiceType'\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('ZoneMap stays reachable as the region-detail picker (region chip / quick action)', () => {
    const hits = src.match(/navigateOnce\(navigation, 'ZoneMap'\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
