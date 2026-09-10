/**
 * ProAssignedTeamScreen — Vehicles + Resources tabs (PDF-1 #5 / client Issue 30).
 *
 * Issue 30 ("Client Is Not Shown the Assigned Vehicle and Registration Number")
 * asks the assigned-team screen to surface the real vehicle + plate. The
 * INVESTIGATION verdict is PATH B: no Pro-side assignment model exists yet —
 * pro_cpo_assignments / protection_sessions carry no vehicle/registration link,
 * and vehicle_pool is bound to the Lite booking product (lite_bookings.vehicle_id)
 * only. So the honest fix is an accurate, actionable empty state that sets the
 * client's expectation — and NEVER a hardcoded/fake vehicle standing in for real
 * dispatch data. This test pins that: the copy names the registration plate and
 * the moment it appears, and the old dead VEHICLES stub / any fake vehicle literal
 * may not creep back in.
 *
 * Source scan (not a render) because the screen imports expo vector icons,
 * safe-area-context, the secure-pro store and a live WS hook that the Jest
 * transform / node project cannot mount. Comments are stripped and CRLF is
 * normalised first (repo source-scan traps).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const raw = readFileSync(
  join(process.cwd(), 'src', 'screens', 'pro', 'ProAssignedTeamScreen.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

// Strip comment lines so the explanatory header (which mentions vehicle_pool,
// "registration", "hardcoded vehicle" etc.) can never satisfy or defeat an
// assertion about the actual rendered code.
const code = raw
  .split('\n')
  .filter(l => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('{/*');
  })
  .join('\n');

describe('Vehicles tab — honest, Issue-30-accurate empty state', () => {
  it('names the registration plate the client is waiting to see', () => {
    // Issue 30 is specifically about the PLATE — the copy must promise it.
    expect(code).toMatch(/registration plate/i);
  });

  it('sets an honest expectation without a false trigger (allocation, not mission-confirm)', () => {
    // Must NOT tie appearance to "mission confirmed": that trigger already fires
    // for the CPOs tab, so a client with a confirmed mission would see an empty
    // vehicle card contradicting the promise — the very bug Issue 30 is about.
    expect(code).toMatch(/will appear here once it's allocated to your protection detail/i);
    expect(code).not.toMatch(/appears here once Ops confirms/i);
  });

  it('no longer ships the old dead placeholder copy', () => {
    expect(code).not.toContain('Vehicles are allocated by Ops at mission dispatch.');
  });
});

describe('Resources tab — accurate, actionable empty state', () => {
  it('describes the resources and when they appear', () => {
    expect(code).toMatch(/comms equipment/i);
    expect(code).toMatch(/will appear here once they're allocated to your protection detail/i);
  });
});

describe('no fake / hardcoded vehicle data was introduced (PATH B — no fake data)', () => {
  it('has no VEHICLES stub array or Vehicle type', () => {
    expect(code).not.toMatch(/const VEHICLES/);
    expect(code).not.toMatch(/type Vehicle\b/);
    expect(code).not.toMatch(/VEHICLES\.map/);
  });

  it('has no hardcoded make/model brand literals', () => {
    expect(code).not.toMatch(/Toyota|Lexus|Land Cruiser|Mercedes|BMW|Range Rover/i);
  });

  it('has no hardcoded registration-plate literal', () => {
    // e.g. the vehicle_pool seed plates 'A 4439' / 'A 5512'.
    expect(code).not.toMatch(/\bA\s?\d{4}\b/);
  });

  it('has no vehicle object-literal keys (make_model: / plate: / call_sign:)', () => {
    // Real fleet data now comes from the team payload, so property ACCESS
    // (v.make_model, v.plate, v.call_sign) is EXPECTED. What must never return is
    // a hardcoded vehicle OBJECT LITERAL — so assert the object-literal KEY form
    // (`make_model:`), consistent with the plate/call_sign checks below, rather
    // than the raw substring which now legitimately appears as a field read.
    expect(code).not.toMatch(/\bmake_model\s*:/);
    expect(code).not.toMatch(/\bplate\s*:/);
    expect(code).not.toMatch(/\bcall_sign\s*:/);
  });
});

describe('Vehicles tab — renders the real assigned vehicle (Issue 30 headline)', () => {
  it('stores the vehicles array from the team payload, defaulting to [] for an older server', () => {
    // `?? []` keeps an old server (which returns only {team}) from crashing the
    // three-state render on `undefined.length`.
    // B-681 re-anchor: the team fetch moved to Promise.allSettled (a missions
    // failure must not blank the team), so the payload reads r.value.data.*.
    expect(code).toMatch(/setVehicles\(r\.value\.data\.vehicles \?\? \[\]\)/);
  });

  it('maps the vehicles array to real cards', () => {
    expect(code).toMatch(/\(vehicles \?\? \[\]\)\.map/);
  });

  it('renders the registration PLATE as a real field — the Issue-30 hero', () => {
    // The plate is the headline the client is owed; it must be read from the
    // payload row, not promised in copy only.
    expect(code).toMatch(/\{v\.plate\}/);
  });

  it('renders the make/model from the payload', () => {
    expect(code).toMatch(/v\.make_model/);
  });

  it('is three-state (loading / empty / rows) so it never flashes the empty card mid-load', () => {
    // Three-state like the CPOs tab: null → "Checking…", non-null [] → the empty
    // copy, rows → cards. Gating the empty card on `!== null` is what stops the
    // "not allocated yet" flash during the first fetch (the Issue-30 complaint in
    // miniature). The old single `(vehicles ?? []).length === 0` gate must be gone.
    expect(code).toMatch(/activeTab === 'Vehicles' && vehicles === null/);
    expect(code).toMatch(/activeTab === 'Vehicles' && vehicles !== null && vehicles\.length === 0/);
    expect(code).not.toMatch(/activeTab === 'Vehicles' && \(vehicles \?\? \[\]\)\.length === 0/);
  });
});

describe('Resources tab — renders the real assigned resources grouped by kind', () => {
  it('stores the resources array from the team payload', () => {
    expect(code).toMatch(/setResources\(r\.value\.data\.resources \?\? \[\]\)/);
  });

  it('maps the resources array', () => {
    expect(code).toMatch(/\(resources \?\? \[\]\)\.(?:filter|map)/);
  });

  it('groups rows by kind', () => {
    expect(code).toMatch(/r\.kind/);
  });

  it('renders each resource label from the payload', () => {
    expect(code).toMatch(/\{r\.label\}/);
  });

  it('is three-state so it never flashes the empty card mid-load', () => {
    expect(code).toMatch(/activeTab === 'Resources' && resources === null/);
    expect(code).toMatch(/activeTab === 'Resources' && resources !== null && resources\.length === 0/);
  });
});

describe('resource serial (identifier) stays WITHHELD from the client (decision 6)', () => {
  it('never reads or renders an identifier/serial field', () => {
    expect(code).not.toMatch(/\bidentifier\b/);
    expect(code).not.toMatch(/\.serial\b/);
  });
});

describe('the live CPOs tab is untouched', () => {
  it('still reads the real ops-assigned team source', () => {
    expect(code).toMatch(/secureProApi\.team\(/);
    expect(code).toMatch(/setTeam\(r\.value\.data\.team\)/);
  });
});
