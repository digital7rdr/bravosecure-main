/**
 * B-262a — the red error banner is a single GLOBAL field, and the
 * key-divergence variant was never cleared.
 *
 * `store.error` is one string (`messengerStore.ts`), rendered by every chat
 * screen through `chatStatusLabel({error, …})`. It is NOT scoped to the
 * conversation that raised it. So a banner that is set and never retired
 * follows the user into unrelated chats and stays there after the condition
 * has resolved.
 *
 * That is what happened on 2026-07-26: a group key divergence set
 * "Couldn't decrypt one message — re-syncing" as a bare inline string, no
 * clear site matched it, and the founder then saw it while reading a 1:1 with
 * someone else entirely — and reported it as a problem with THAT chat. The
 * banner was stale and misattributed, and it aimed the investigation at the
 * wrong bug (see sqa.md B-262 for the real one, which was ACK-then-drop).
 *
 * B-213 already fixed exactly this for the sibling `no_key` banner. This suite
 * pins BOTH so the pair cannot drift again.
 *
 * `productionRuntime.ts` cannot be imported by this Jest project, so these are
 * source scans. Two repo traps apply and are handled below:
 *   - the file is CRLF, so `\n`-anchored regexes match nothing and pass
 *     VACUOUSLY. Everything here is line-based or `\r?\n`.
 *   - prose containing a banned string is the classic false result, so
 *     comments are stripped before any absence assertion.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function source(): string {
  return readFileSync(RUNTIME, 'utf8');
}

/** Block and line comments removed — prose must never satisfy a code assertion. */
function code(): string {
  return source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

const DIVERGENCE_CONST = 'GROUP_KEY_DIVERGENCE_RECEIVE_ERROR';
const PENDING_CONST = 'GROUP_KEY_PENDING_RECEIVE_ERROR';

describe('B-262a — the divergence banner is named and retired', () => {
  it('CONTROL: the scan can see both banner constants', () => {
    // If either is renamed or extracted, every assertion below would go
    // vacuous. This fails first and says why.
    const src = code();
    expect(src).toContain(`const ${PENDING_CONST}`);
    expect(src).toContain(`const ${DIVERGENCE_CONST}`);
  });

  it('the divergence text is a CONSTANT, never an inline string at the set site', () => {
    // The whole mechanism of the bug: an inline literal has no name, so no
    // clear site can match it and nobody notices it is unreachable.
    const src = code();
    const inline = src.match(/setError\(\s*["'`]Couldn/g) ?? [];
    expect(inline).toEqual([]);
    expect(src).toContain(`setError(${DIVERGENCE_CONST})`);
  });

  it('BOTH banners are cleared on the same drain-success condition', () => {
    // A `tamper` row is stashed on the same pending queue and drains through
    // the same function as a `no_key` row, so "no longer key-blocked" must
    // retire both or the survivor is the next stale banner.
    const src = code();
    const guard = /if \(!stillKeyBlocked\) \{[\s\S]{0,600}?\r?\n {2}\}/.exec(src);
    expect(guard).not.toBeNull();
    const body = guard![0];
    expect(body).toContain(PENDING_CONST);
    expect(body).toContain(DIVERGENCE_CONST);
    expect(body).toContain('setError(null)');
  });

  it('the clear stays an EQUALITY check per variant, never a prefix or a blanket wipe', () => {
    // The safety property. `setError(null)` unconditionally — or on a prefix
    // match — would silently eat a real, different error that landed in
    // between, which is a worse bug than the stale banner.
    const guard = /if \(!stillKeyBlocked\) \{[\s\S]{0,600}?\r?\n {2}\}/.exec(code());
    const body = guard![0];
    expect(body).toMatch(new RegExp(`store\\.error === ${PENDING_CONST}`));
    expect(body).toMatch(new RegExp(`store\\.error === ${DIVERGENCE_CONST}`));
    expect(body).not.toMatch(/startsWith|includes\(/);
  });
});

describe('B-262 — an ack is the point of no return, so it must survive log stripping', () => {
  // The relay HARD-DELETES the envelope on ack (`ackEnvelope` is the only path
  // that removes an `env:` payload). A message acked and then not rendered is
  // gone from the server for good, and only this line records which branch
  // took it. `console.log` is removed from release bundles by
  // babel-plugin-transform-remove-console (error/warn excluded), which is why
  // the 2026-07-26 QA build carried no record and the last bit of the
  // diagnosis was unobtainable.

  it('the WS receive path logs the ack disposition at warn level', () => {
    const src = code();
    const line = src.split(/\r?\n/).find(l => l.includes('[messenger.deliver] ACK ok'));
    expect(line).toBeDefined();
    expect(line).toContain('console.warn');
    expect(line).toContain('disposition');
  });

  it('the HTTP drain path records a DESTROYED envelope at warn level', () => {
    const src = code();
    const line = src.split(/\r?\n/).find(l => l.includes('[messenger.drain] ACK discarded'));
    expect(line).toBeDefined();
    expect(line).toContain('console.warn');
  });

  it('neither ack site regresses to console.log', () => {
    // The exact regression: a later cleanup "quietens" the ack log and the
    // next data-loss report is undiagnosable again.
    for (const marker of ['[messenger.deliver] ACK ok', '[messenger.drain] ACK discarded']) {
      const line = code().split(/\r?\n/).find(l => l.includes(marker)) ?? '';
      expect(line).not.toContain('console.log');
    }
  });
});
