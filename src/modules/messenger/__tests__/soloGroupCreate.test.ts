/**
 * Q2 (founder QA, 2026-08-08) — solo dept-channel groups (static source scan).
 *
 * A fresh Enterprise workspace seeds channels whose admin is the only member,
 * and `createGroupChat` used to throw `NO_MEMBERS` for exactly that shape —
 * every seeded channel showed "Inactive" and refused to open until the founder
 * enrolled someone from a different screen. The fix is `allowSolo`: the group
 * may exist with only its admin; the master key is generated locally, the
 * fan-out loop runs zero times, and later members are keyed in through the
 * EXISTING add-intent/rekey path — key distribution semantics are unchanged.
 *
 * No test imports productionRuntime.ts (module side effects), so this is a
 * source scan. House rules: parse RAW where a stripper could eat code, use
 * \r?\n-safe matching (these files are CRLF), and anchor the DECISION SITE,
 * not just a token somewhere in the file.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const PROVISION = join(process.cwd(), 'src', 'modules', 'messenger', 'orgWorkspace', 'provisionChannel.ts');

describe('Q2 — allowSolo dept-channel group creation', () => {
  it('the empty-members throw is gated on !allowSolo at the decision site', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    // The guard itself — reverting to the unconditional throw goes red here.
    expect(src).toMatch(/if \(others\.length === 0 && !allowSolo\)/);
    // And the option actually arrives from the call signature, not thin air.
    const sig = src.slice(src.indexOf('createGroupChat: async'), src.indexOf('createGroupChat: async') + 200);
    expect(sig).toContain('allowSolo');
  });

  it('a solo group still gets a placeholder peer (self), never undefined', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    // others[0] is undefined for a solo group; the conversation row must fall
    // back to the caller's own address or every downstream peer read breaks.
    expect(src).toMatch(/peer:\s+\{userId: others\[0\] \?\? ownAddress\.userId, deviceId: 1\}/);
  });

  it('channel provisioning opts in — solo + zero-delivered together', () => {
    const src = readFileSync(PROVISION, 'utf8');
    const call = src.slice(src.indexOf('createGroupChat('));
    expect(call.slice(0, 300)).toMatch(/allowZeroDelivered: true/);
    expect(call.slice(0, 300)).toMatch(/allowSolo: true/);
  });
});
