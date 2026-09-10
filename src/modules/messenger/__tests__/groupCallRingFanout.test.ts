/**
 * Static source-scan regression — group-call ring fan-out.
 *
 * Reported: an agency starting a group call rang the CLIENT but not the CPOs;
 * a CPO starting one rang the client but not the agency/managers. Each device
 * rang a different subset — the tell that the list was derived from per-device
 * state rather than the roster.
 *
 * ROOT CAUSE. launchCall built `recipientUserIds` from
 * `conversations[id].participants`. That field resolves to CRYPTO membership:
 * resolveRosterOverwrite (pendingRosterIntents.ts) returns `cryptoMembers`
 * whenever it holds any, i.e. "peers I already have a group key for". Ringing
 * is plain SFU signalling and needs no key, so every peer whose key had not yet
 * reached this device was silently never rung.
 *
 * FIX: union the local set with the server's authoritative roster
 * (/conversations/mine) before ringing, falling back to local-only if the fetch
 * fails — a degraded ring beats no call.
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

const LAUNCH = 'src/modules/messenger/webrtc/launchCall.ts';

describe('group call ring reaches the whole roster, not just key-holders', () => {
  it('the ring set is resolved by ringRecipients(), not raw participants', () => {
    const src = code(LAUNCH);
    expect(src).toMatch(/async function ringRecipients\(/);
    expect(src).toMatch(/ringRecipients\(opts\.conversationId, fromStore, opts\.participants\)/);
  });

  /**
   * B-247 part 2 moved the union itself into `ringSet.ts` so it could be tested
   * BEHAVIOURALLY per device shape — see ringSet.test.ts, which asserts the
   * resulting SET rather than the text that computes it, because the text was
   * green while the behaviour was wrong twice. These assertions keep the part
   * launchCall still owns: that each source is COLLECTED and handed over.
   */
  it('it unions the SERVER roster in', () => {
    const src = code(LAUNCH);
    const start = src.indexOf('async function ringRecipients');
    const fn = src.slice(start, src.indexOf('\n}', start));
    expect(fn).toMatch(/conversationApi\.listMine\(\)/);
    expect(fn).toMatch(/\.map\(m => m\.userId\)/);
    expect(fn).toMatch(/computeRingSet\(\{[^}]*server[^}]*\}\)/);
  });

  it('a roster fetch failure degrades to the local set, never to no call', () => {
    const src = code(LAUNCH);
    const start = src.indexOf('async function ringRecipients');
    const fn = src.slice(start, src.indexOf('\n}', start));
    expect(fn).toMatch(/catch \(e\)/);
    expect(fn).toMatch(/ringing local set only/);
    // `server` stays [] on failure and the other sources still reach the union.
    expect(fn).toMatch(/let server: string\[\] = \[\];/);
    expect(fn).toMatch(/computeRingSet\(\{localMembers,/);
  });

  it('self is excluded from every source', () => {
    // One central filter now, applied to every source — proven behaviourally
    // in ringSet.test.ts ('never rings itself', "drops the legacy 'self'").
    const ring = code('src/modules/messenger/webrtc/ringSet.ts');
    expect(ring).toMatch(/p !== 'self' && p !== ownId/);
    expect(code(LAUNCH)).toMatch(/const ownId = useAuthStore\.getState\(\)\.user\?\.id;/);
  });

  it('the explicit participants hint is still honoured', () => {
    // The mission Ops Room can launch a call before the conversation is
    // materialised locally; that path passes members explicitly.
    const src = code(LAUNCH);
    const start = src.indexOf('async function ringRecipients');
    const fn = src.slice(start, src.indexOf('\n}', start));
    expect(fn).toMatch(/computeRingSet\(\{[^}]*hint[^}]*\}\)/);
  });

  it('the ring no longer short-circuits on a non-empty local list', () => {
    // The old shape: `fromStore.length > 0 ? fromStore : hint` — once local
    // held ANY member the hint was discarded and the roster never consulted.
    const src = code(LAUNCH);
    expect(src).not.toMatch(/fromStore\.length > 0\s*\n?\s*\?\s*fromStore/);
  });

  it('CONTEXT: participants really does resolve to crypto membership', () => {
    // If this ever stops being true the fix above is still correct, but the
    // REASON in its comment would be wrong — so pin the premise.
    const src = code('src/modules/messenger/runtime/pendingRosterIntents.ts');
    expect(src).toMatch(/if \(args\.cryptoMembers && args\.cryptoMembers\.length > 0\) \{[\s\S]{0,80}participants: args\.cryptoMembers/);
  });
});
