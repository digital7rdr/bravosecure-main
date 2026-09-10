/**
 * Static source-scan regression — a PARTIAL group rekey must not be silent.
 *
 * Reported: create a 4-person group, remove one member, and afterwards the
 * group "sound doesn't come" and the key looks corrupted.
 *
 * ROOT CAUSE of the silent half. Both rekey fan-outs collected a
 * `rekeyFailures` list and then NEVER READ IT unless delivery hit exactly zero:
 *
 *     let rekeyDelivered = await fanOutRekey();
 *     if (rekeyDelivered === 0) { …retry… }
 *     if (rekeyDelivered === 0) { setError(…); }      // <- only the 0 case
 *
 * So removing one of four, where the new epoch key reached two of the three
 * remaining members, left the third permanently unable to decrypt — with no
 * signal to anyone. The local rotation immediately after is fail-CLOSED by
 * design (better a missed message than letting the removed member keep
 * reading), so that member cannot be repaired implicitly; the only way out is
 * to tell someone.
 *
 * productionRuntime.ts cannot be imported by any test project (MESSAGE_LOOP.md),
 * so this is a source scan by necessity.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function code(): string {
  const src = readFileSync(RUNTIME, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('a partial group rekey is surfaced, not swallowed', () => {
  it('BOTH fan-out sites branch on rekeyFailures, not only on zero delivery', () => {
    const src = code();
    // remove-and-rekey + add-and-rekey.
    expect((src.match(/else if \(rekeyFailures\.length > 0\)/g) ?? []).length).toBe(2);
  });

  it('the message NAMES who missed the key', () => {
    const src = code();
    // "some members missed it" is unactionable; the admin needs the who.
    expect((src.match(/did not reach every member \(\$\{missed\}\)/g) ?? []).length).toBe(2);
    expect((src.match(/rekeyFailures\.map\(f => f\.split\(':'\)\[0\]\)/g) ?? []).length).toBe(2);
  });

  it('the zero-delivery case still has its own distinct message', () => {
    // Collapsing the two would lose the difference between "nobody got it"
    // (retryable, whole group broken) and "one member got left behind".
    // Matched on the setError form specifically: a bare "reached no members"
    // also appears in the Ops Room bootstrap warn at ~4803, which is a
    // different fan-out with its own `failures` list and is not in scope here.
    const src = code();
    const zeroCase = src.match(
      /store\.setError\('Group key update reached no members/g,
    ) ?? [];
    expect(zeroCase.length).toBe(2);
  });

  it('failures are still collected at every catch site', () => {
    const src = code();
    // Per-peer deliver failures AND a whole-broadcast throw both feed the list;
    // dropping either would make the new branch under-report.
    expect((src.match(/rekeyFailures\.push\(`\$\{peer\.userId\}: /g) ?? []).length).toBe(2);
    expect((src.match(/rekeyFailures\.push\(asErrorMessage\(e\)\)/g) ?? []).length).toBe(2);
  });

  it('the fail-CLOSED local rotation is UNCHANGED', () => {
    // This is a privacy property, not a UX one: we rotate locally even when
    // fan-out failed, so a removed member cannot keep reading. Surfacing the
    // partial failure must not have turned this into an early return.
    const src = code();
    expect((src.match(/const stateAfterRekey = applyAdminAction\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
