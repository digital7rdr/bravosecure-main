/**
 * Static source-scan regression for Issue 30 (Testing Issues V2, PDF p.35) —
 * "Client Is Not Shown the Assigned Vehicle and Registration Number".
 *
 * The data was NOT missing: /bookings/:id/team already returned call_sign,
 * make_model and plate. It was rendered only inside LiveTracking's TEAM tab —
 * not on the verify surface, which is where the principal stands on a kerb
 * deciding whether to get into a car. Colour genuinely was missing.
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

const SCREEN = 'src/screens/liveops/LiveTrackingScreen.tsx';
const POOL = 'apps/auth-service/src/booking/assignment/vehicle-pool.service.ts';

describe('Issue 30 — the client can identify the arriving vehicle', () => {
  it('colour exists end to end: migration, row, DTO, mapper, client type', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20260725130000_vehicle_colour.sql'), 'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE vehicle_pool[\s\S]*ADD COLUMN IF NOT EXISTS colour TEXT/);

    const pool = code(POOL);
    expect(pool).toMatch(/interface VehicleRow \{[\s\S]*?colour: string \| null;/);
    expect(pool).toMatch(/interface AssignedVehicle \{[\s\S]*?colour: string \| null;/);
    expect(pool).toMatch(/colour: r\.colour \?\? null/);

    expect(code('src/services/api.ts')).toMatch(/AssignedVehicleDto \{[\s\S]*?colour\?: string \| null;/);
  });

  it('the verify card receives the vehicle', () => {
    // Anchored on the vehicle prop itself rather than the whole prop list, so
    // adding an unrelated prop (the code is now mirrored into the fullscreen
    // map via onCode) cannot fail this — the point is that team.vehicle is
    // threaded into the card and typed.
    const src = code(SCREEN);
    expect(src).toMatch(/<VerifyGuardCard\b[^>]*\bbookingId=\{bookingId\}/);
    expect(src).toMatch(/<VerifyGuardCard\b[^>]*\bvehicle=\{team\.vehicle\}/);
    expect(src).toMatch(/vehicle: AssignedVehicleDto \| null;/);
  });

  it('it shows make/model, colour, call sign and the registration plate', () => {
    const src = code(SCREEN);
    const start = src.indexOf('s.verifyVehicle}');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 900);
    expect(block).toMatch(/vehicle\.colour/);
    expect(block).toMatch(/vehicle\.make_model/);
    expect(block).toMatch(/vehicle\.call_sign/);
    expect(block).toMatch(/vehicle\.plate/);
  });

  it('an unrecorded colour is OMITTED, never rendered as blank or "null"', () => {
    const src = code(SCREEN);
    // filter(Boolean) drops a null colour and leaves just the make/model.
    expect(src).toMatch(/\[vehicle\.colour, vehicle\.make_model\]\.filter\(Boolean\)\.join\(' '\)/);
  });

  it('the block renders only once a vehicle is assigned', () => {
    // Before dispatch there is nothing to identify; an empty plate chip would
    // read as "no vehicle is coming".
    expect(code(SCREEN)).toMatch(/\{vehicle && \(/);
  });

  it('the TEAM tab keeps its vehicle row — this ADDS a surface, not moves one', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/team\.vehicle\.call_sign\} · \$\{team\.vehicle\.make_model\}/);
  });
});
