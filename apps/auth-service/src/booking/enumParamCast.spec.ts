/**
 * ENUM COLUMNS MUST NOT BE COMPARED TO A PARAMETER PINNED TO text.
 *
 * Found on staging 2026-08-05: `GET /bookings` was throwing on EVERY call —
 * 888 occurrences in the container log, roughly one every eight seconds. The
 * client's whole bookings list was dead.
 *
 *     WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
 *
 * `lite_bookings.status` is the enum `lite_booking_status`. The `$2::text`
 * PINS that parameter's type to text for the entire statement, so the bare
 * `status = $2` beside it resolves to `lite_booking_status = text` — an
 * operator Postgres does not have. It fails during planning, so it threw
 * whether or not a status filter was supplied.
 *
 * WHY NO UNIT TEST WOULD HAVE CAUGHT IT. Nothing in this suite executes SQL;
 * `DatabaseService` is mocked everywhere. A query can be syntactically fine,
 * fully covered, and still be rejected by Postgres at plan time. That is the
 * DB-only defect class this project has been bitten by before — six review
 * rounds and 2,100 green tests once missed five live defects of exactly this
 * kind. So the gate is a source scan plus a live probe recorded here:
 *
 *   SELECT count(*) FROM lite_bookings WHERE ('CANCELLED'::text IS NULL
 *                                          OR status::text = 'CANCELLED')  -> 137
 *   pg_operator has no '=' for (lite_booking_status, text)                 -> confirmed
 *
 * WHY CAST THE COLUMN, NOT THE PARAM. `$2::lite_booking_status` also compiles,
 * but then any unexpected string raises "invalid input value for enum" — a
 * filter typo becomes a 500. `status::text` compares like with like, and is the
 * idiom already used at dispatch.service.ts:588 (`b.status::text = $1`).
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * Columns that are Postgres ENUMs, as `table.column`, verified against the live
 * schema via information_schema on 2026-08-05. Bare column names are ambiguous:
 * `lite_bookings.status` is an enum while `booking_disputes.status` is text, and
 * treating them alike would either miss the bug or cry wolf.
 */
const ENUM_COLUMNS = [
  'agents.status', 'agents.type', 'agent_audit.from_status', 'agent_audit.to_status',
  'agent_kyc_checks.state', 'agent_documents.state',
  'admin_users.role', 'admin_invites.role',
  'job_applications.status', 'jobs.status',
  'cpo_pool.availability', 'dispatch_offers.status', 'escrow_holds.status',
  'lite_bookings.status', 'lite_booking_audit.from_status', 'lite_booking_audit.to_status',
  'missions.status', 'system_broadcasts.kind', 'vehicle_pool.status',
  'wallet_transactions.status', 'wallet_transactions.type',
];

/** Every .ts under src, excluding specs. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {sources(p, out);}
    else if (/\.ts$/.test(e) && !/\.spec\.ts$/.test(e)) {out.push(p);}
  }
  return out;
}

/**
 * A parameter is "pinned to text" when the query casts it to a text-ish type
 * anywhere. From that point Postgres treats $N as that type in EVERY clause of
 * the statement, which is what makes the sibling comparison illegal.
 *
 * `varchar` / `character varying` pin exactly as hard as `text` — there is no
 * `lite_booking_status = character varying` operator either. Matching only
 * `::text` let a `::varchar` spelling of the identical bug through.
 */
function pinnedParams(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\$(\d+)\s*::\s*(?:text|varchar|character\s+varying)\b/gi)) {
    out.add(m[1]);
  }
  // `CAST($1 AS text)` is the same pin in SQL-standard spelling. Postgres does
  // not care which you write; a scan that only knows `::` would wave the
  // identical bug through.
  for (const m of sql.matchAll(
    /\bCAST\s*\(\s*\$(\d+)\s+AS\s+(?:text|varchar|character\s+varying)\s*\)/gi,
  )) {
    out.add(m[1]);
  }
  return out;
}

/**
 * alias -> table, from the FROM/JOIN clauses.
 *
 * WITHOUT THIS THE SCAN CRIES WOLF. Its first version flagged
 * `ops-data.service.ts` twice, for `escrow_holds.status` and
 * `lite_bookings.status`, purely because those tables are JOINed in the same
 * query. The actual comparison there is `d.status = $1`, and `d` is
 * `booking_disputes`, whose status is plain text — safe. A scan that reports
 * healthy code is worse than no scan, because the next person turns it off.
 */
function aliasMap(sql: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of sql.matchAll(
    /\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi,
  )) {
    const table = x[1].toLowerCase();
    const alias = x[2].toLowerCase();
    // Skip SQL keywords that can follow a table name (FROM t WHERE …).
    if (['on', 'where', 'set', 'using', 'left', 'right', 'inner', 'outer', 'join',
         'group', 'order', 'limit', 'returning', 'and', 'or'].includes(alias)) {continue;}
    m.set(alias, table);
  }
  // Un-aliased tables resolve to themselves.
  for (const x of sql.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
    const t = x[1].toLowerCase();
    if (!m.has(t)) {m.set(t, t);}
  }
  return m;
}

/**
 * Every comparison of a column to a parameter in one query.
 *
 * OPERATOR COVERAGE. Matching only `=` let five spellings of the same illegal
 * comparison through: `= ANY($N)`, `IN ($N)`, `<>`, `!=`, and the ordering
 * operators. Postgres rejects every one of them for (enum, text) exactly as it
 * rejects `=`.
 *
 * The optional `(::cast)` group is how the SAFE form is recognised: if the
 * column itself carries a cast, this is `text = text` and fine.
 */
const COLUMN_FIRST =
  /(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*(::\s*[a-z_]+(?:\s+varying)?)?\s*(?:(?:=|<>|!=|<=|>=|<|>)\s*(?:ANY\s*\(\s*)?|\s+IN\s*\(\s*)\$(\d+)\b/gi;

/**
 * The same comparison with the operands the other way round. This is not
 * hypothetical spelling: `cpo-assignment.service.ts` already writes
 * `($3::text IS NULL OR $3 = ANY(specialties))`. Postgres resolves an operator
 * from the pair of types, not from which side they sit on, so `$N = enum_col`
 * fails identically to `enum_col = $N` — and the column-first pattern alone
 * cannot see it.
 */
const PARAM_FIRST =
  /\$(\d+)\s*(?:=|<>|!=|<=|>=|<|>)\s*(?:ANY\s*\(\s*)?(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\s*(::\s*[a-z_]+(?:\s+varying)?)?/gi;

/**
 * The detector, as a pure function of ONE SQL block, so the fixtures below can
 * prove it actually fires. Its top-level assertion is `offenders == []`, which
 * a broken regex satisfies just as happily as clean code — the vacuous-pass
 * trap CLAUDE.md names. A source scan is only as good as its anchor, and the
 * only way to anchor a detector is to feed it something it MUST catch.
 */
export function offendersIn(sql: string): string[] {
  if (!/\bSELECT\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b/i.test(sql)) {return [];}
  const pinned = pinnedParams(sql);
  if (pinned.size === 0) {return [];}
  const aliases = aliasMap(sql);
  const out: string[] = [];

  const hits: Array<{qualifier?: string; column: string; cast?: string; param: string}> = [];
  for (const m of sql.matchAll(COLUMN_FIRST)) {
    hits.push({qualifier: m[1], column: m[2], cast: m[3], param: m[4]});
  }
  for (const m of sql.matchAll(PARAM_FIRST)) {
    hits.push({param: m[1], qualifier: m[2], column: m[3], cast: m[4]});
  }

  for (const {qualifier, column, cast, param} of hits) {
    if (!pinned.has(param)) {continue;}
    // The column is cast -> like compared with like -> safe.
    if (cast) {continue;}

    // Resolve which TABLE this column belongs to. A qualified reference
    // resolves through the alias map. An UNQUALIFIED one is checked against
    // every table the query touches: SQL itself rejects an ambiguous
    // unqualified column, so if any table in scope has this column as an enum,
    // that is necessarily the one being compared.
    //
    // The old rule — only resolve unqualified names when the query touches
    // exactly ONE table — made this scan VACUOUS for the very shape of the bug
    // it exists to catch. The query that took staging down wrote `status`
    // unqualified; adding a single JOIN to it (or a CTE, whose name also counts
    // as a table here) would have silently switched the guard off while the
    // suite stayed green.
    const candidates = qualifier
      ? [aliases.get(qualifier.toLowerCase())].filter(Boolean) as string[]
      : [...new Set(aliases.values())];

    const table = candidates.find(t => ENUM_COLUMNS.includes(`${t}.${column}`));
    if (!table) {continue;}
    out.push(`${table}.${column} compared to $${param}, which is pinned to text in the same query`);
  }
  return out;
}

describe('enum columns are never compared to a text-pinned parameter', () => {
  const files = sources(SRC);

  it('finds source files to scan (the scan is not vacuously empty)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  /**
   * The specific query that was down. Pinned by its exact shape so a future
   * edit that drops the cast fails here by name.
   */
  it('the client bookings list casts the COLUMN, not the parameter', () => {
    // STRIP COMMENTS FIRST. The first version of this assertion failed against
    // the FIXED file, because the comment explaining the fix contains the very
    // string it bans. Prose carrying the banned token is this repo's most
    // common false result, in both directions.
    const s = readFileSync(join(SRC, 'booking', 'booking.service.ts'), 'utf8')
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(s).toMatch(/\(\$2::text IS NULL OR status::text = \$2\)/);
    // The exact broken form, which threw on every call.
    expect(s).not.toMatch(/\(\$2::text IS NULL OR status = \$2\)/);
    // Casting the PARAM instead turns a filter typo into a 500.
    expect(s).not.toMatch(/\$2::lite_booking_status/);
  });

  /**
   * The CLASS, not just the one line. Any query that pins a param to text and
   * then compares a known enum column to that same param, uncast, is the same
   * bug in a different file.
   */
  it('no query anywhere pins a param to text then compares an enum column to it', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Template-literal SQL blocks — how every query in this service is written.
      for (const block of text.match(/`[^`]*`/g) ?? []) {
        for (const o of offendersIn(block)) {
          offenders.push(`${file.replace(process.cwd(), '')}: ${o}`);
        }
      }
    }

    // Each entry is a query Postgres will reject at plan time — a guaranteed
    // 500 on every call, invisible to this suite because nothing executes SQL.
    expect(offenders).toEqual([]);
  });
});

/**
 * THE DETECTOR MUST BE ABLE TO FAIL.
 *
 * The scan above asserts `offenders == []` over the real sources. A regex that
 * matches NOTHING satisfies that assertion exactly as well as clean code does,
 * so on its own it is a green light with no bulb behind it — and this repo has
 * shipped that mistake before (CLAUDE.md: "a source scan is only as good as its
 * anchor", "the test passes VACUOUSLY"). These fixtures are the anchor: known-bad
 * SQL the detector MUST flag, and healthy SQL it must leave alone. Break any
 * regex above and this block goes red immediately.
 *
 * Each POSITIVE fixture was verified against the live schema by PREPARE, which
 * is where Postgres does parameter-type resolution:
 *   PREPARE x AS SELECT * FROM lite_bookings
 *     WHERE client_id = $1 AND ($2::text IS NULL OR status = $2) ...
 *   -> ERROR 42883: operator does not exist: lite_booking_status = text
 * and the fixed spelling PREPAREs clean with parameter_types {uuid,text,bigint}.
 */
describe('the detector itself catches what it claims to', () => {
  const flagged = (sql: string) => offendersIn(sql).length > 0;

  // ── MUST FLAG ───────────────────────────────────────────────────────────
  it('flags the exact query that took staging down', () => {
    expect(flagged(
      `SELECT * FROM lite_bookings
        WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT 50 OFFSET $3`,
    )).toBe(true);
  });

  it('flags an unqualified enum column in a MULTI-table query', () => {
    // The pre-widening rule resolved unqualified names only in single-table
    // queries, so one JOIN switched the guard off.
    expect(flagged(
      `SELECT b.* FROM lite_bookings b JOIN missions m ON m.booking_id = b.id
        WHERE ($1::text IS NULL OR status = $1)`,
    )).toBe(true);
  });

  it.each([
    ['<>', `SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR status <> $1)`],
    ['!=', `SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR status != $1)`],
    ['IN', `SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR status IN ($1))`],
    ['ANY', `SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR status = ANY($1))`],
  ])('flags the %s spelling', (_label, sql) => {
    expect(flagged(sql)).toBe(true);
  });

  it('flags a ::varchar pin, which binds exactly as hard as ::text', () => {
    expect(flagged(
      `SELECT * FROM missions WHERE ($1::varchar IS NULL OR status = $1)`,
    )).toBe(true);
  });

  it('flags the SQL-standard CAST($1 AS text) spelling of the pin', () => {
    expect(flagged(
      `SELECT * FROM lite_bookings WHERE CAST($1 AS text) IS NULL OR status = $1`,
    )).toBe(true);
  });

  it('flags the operands written the OTHER way round', () => {
    // `$3 = ANY(specialties)` already ships in cpo-assignment.service.ts, so
    // param-first is a spelling this codebase actually uses. Postgres resolves
    // the operator from the type PAIR, not from operand order.
    expect(flagged(
      `SELECT * FROM dispatch_offers WHERE ($1::text IS NULL OR $1 = status)`,
    )).toBe(true);
  });

  // ── MUST NOT FLAG ───────────────────────────────────────────────────────
  it('leaves the FIXED query alone', () => {
    expect(offendersIn(
      `SELECT * FROM lite_bookings
        WHERE client_id = $1 AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC LIMIT 50 OFFSET $3`,
    )).toEqual([]);
  });

  it('does not flag a TEXT column named status on a table JOINed to an enum table', () => {
    // This is the false positive the alias map exists to prevent:
    // booking_disputes.status is plain text; lite_bookings.status next to it
    // is the enum. Verified against information_schema.
    expect(offendersIn(
      `SELECT d.* FROM booking_disputes d
         JOIN lite_bookings b ON b.id = d.booking_id
        WHERE ($1::text IS NULL OR d.status = $1)
          AND ($2::text IS NULL OR b.region_code = $2)`,
    )).toEqual([]);
  });

  it('does not flag an enum column compared to an UNPINNED param', () => {
    expect(offendersIn(
      `SELECT * FROM lite_bookings
        WHERE ($1::text IS NULL OR region_code = $1) AND status = $2`,
    )).toEqual([]);
  });

  it('does not flag a pinned param compared to a different column entirely', () => {
    expect(offendersIn(
      `SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR region_code = $1)`,
    )).toEqual([]);
  });

  it('does not flag an enum column already cast inside a CTE', () => {
    expect(offendersIn(
      `WITH recent AS (
         SELECT * FROM lite_bookings WHERE ($1::text IS NULL OR status::text = $1)
       )
       SELECT * FROM recent ORDER BY created_at DESC`,
    )).toEqual([]);
  });

  it('does not flag a query with no parameters at all', () => {
    expect(offendersIn(
      `SELECT status, count(*) FROM lite_bookings GROUP BY status`,
    )).toEqual([]);
  });
});

/**
 * WHAT THIS SCAN STILL CANNOT SEE — read before trusting a green run.
 *
 * 1. INTERPOLATED FRAGMENTS. The scan reads each backtick block as written, so
 *    a `${...}` hole is opaque. `dispatch.service.ts` builds `RANKING_SQL` from
 *    `regionScopeClause()`, which returns the SINGLE-QUOTED string
 *    `'AND ($3::text IS NOT NULL OR $3::text IS NULL)'` — a pin the scan cannot
 *    see, in a query that also touches `agents.status` / `agents.type` (both
 *    enums). Safe today only because those two are compared to LITERALS, never
 *    to a parameter. Same shape: `roster.service.ts` BRANCH_SCOPE_PREDICATE.
 * 2. PINS THAT ARE NOT CASTS. `LOWER($1)`, `COALESCE($1, '')` and friends fix
 *    the parameter's type through function resolution with no `::` anywhere.
 *    `org-cpo.service.ts:155` does exactly this (`LOWER(email) = LOWER($1) OR
 *    phone_e164 = $1`) and is safe only because `phone_e164` is text.
 * 3. NON-ENUM TYPES WITH NO text OPERATOR. `uuid = text` fails identically —
 *    see `dispatch.service.ts` `timeline`, where `subject_id = $1::text` sits in
 *    a UNION with five `booking_id = $1` (uuid) branches. It survives ONLY
 *    because parameter types resolve on FIRST use and the uuid branch is
 *    textually first; move the ops_audit branch to the top and it 500s. Proven:
 *      PREPARE p AS SELECT 1 FROM ops_audit WHERE subject_id = $1::text
 *                   UNION ALL SELECT 1 FROM missions WHERE booking_id = $1;
 *      -> ERROR 42883: operator does not exist: uuid = text
 *    (the same two branches in the other order PREPARE clean). Guarding uuid
 *    columns here would therefore CRY WOLF on the currently-correct query, so
 *    this scan deliberately stays enum-only.
 * 4. `citext`. `users.email` is citext, and `citext = text` silently resolves to
 *    a CASE-SENSITIVE text comparison instead of citext's case-insensitive one
 *    (`'a'::citext = 'A'::text` -> false, verified live). That failure mode is a
 *    wrong ANSWER, not a 500, so it would never show up in an error log. No
 *    query pins a param next to `email` today.
 * 5. `apps/messenger-service`. Not scanned — it has zero positional SQL
 *    parameters, so there is nothing there to pin.
 */

/**
 * The status ALLOW-LIST must be the enum, exactly.
 *
 * Found while auditing the cast fix: the allow-list guarding that same `$2`
 * had drifted from the enum in both directions.
 *
 *   - 'LIVE' was MISSING. It is a real, reachable booking state
 *     (state-machine.service.ts: CONFIRMED -> LIVE, by CPO or OPS_HANDLER).
 *     An unlisted value is coerced to null, which DROPS the filter — so
 *     `GET /bookings?status=LIVE` answered with EVERY booking the client has
 *     ever made instead of the live one. A wrong answer that looks like data.
 *   - 'REJECTED' was PRESENT but is not a lite_booking_status at all; it
 *     belongs to dispatch_offers / agents / job_applications. It could never
 *     match a row, and it is a live landmine for the `$2::lite_booking_status`
 *     spelling of this query, which would 500 on it ("invalid input value for
 *     enum lite_booking_status") rather than return nothing.
 *
 * Labels verified against the live schema on 2026-08-05:
 *   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
 *    WHERE t.typname='lite_booking_status' ORDER BY e.enumsortorder;
 *
 * KNOWN, NOT FIXED HERE: an unknown status is silently coerced to null rather
 * than rejected with a 400, so any typo still returns the unfiltered list.
 * Changing that is an API contract change, not part of this fix.
 */
describe('the bookings-list status allow-list matches lite_booking_status', () => {
  const LIVE_ENUM_LABELS = [
    'DRAFT', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED',
    'LIVE', 'COMPLETED', 'CANCELLED', 'DISPATCHING', 'NO_PROVIDER', 'AGENCY_NO_SHOW',
  ];

  it('allow-lists every enum label and nothing else', () => {
    // Read the literal set out of the source: the value is what ships, and
    // nothing in this suite executes list() against a real database.
    const src = readFileSync(join(SRC, 'booking', 'booking.service.ts'), 'utf8');
    const block = /const VALID_STATUS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block).not.toBeNull();

    // Strip comments before reading the literals — prose in the block above
    // this constant names both 'LIVE' and 'REJECTED'.
    const body = block![1]
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    const listed = [...body.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);

    expect([...listed].sort()).toEqual([...LIVE_ENUM_LABELS].sort());
    // Named explicitly so a regression reads plainly in the failure output.
    expect(listed).toContain('LIVE');
    expect(listed).not.toContain('REJECTED');
  });
});
