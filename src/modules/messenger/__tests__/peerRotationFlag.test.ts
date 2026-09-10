/**
 * B-701 — send-side peer-rotation detection: the flag contract plus the
 * seal-lane detector, plus the source-scanned wiring in productionRuntime
 * (which no test can import — the MESSAGE_LOOP rule; scans are the pin).
 *
 * sqa.md bug register — this suite pins: B-701 (sender half).
 *
 * The live failure (founder, 2026-08-29): a reinstall regenerated the
 * device identity, and a peer's device kept sealing into the dead ratchet —
 * outer unwrap fine (the seal identity is server-first, ≤8 min fresh),
 * inner decrypt dead, redelivery churn, 110-141 s sends. The receive-side
 * heal only runs when the ROTATED device's messages arrive; a sender-only
 * relationship never converged. These pins hold the three legs of the fix:
 * the seal lane NOTES an identity mismatch (zero extra network — it rides
 * the fetch the seal already made), ensureOutgoingSession CONSUMES it
 * one-shot and rebuilds through the B-46 core, and no caller may bypass
 * ensureOutgoingSession behind its own hasSession guard again.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  notePeerRotationSuspected,
  takePeerRotationSuspected,
  hasPeerRotationSuspected,
  _resetPeerRotationFlagsForTests,
} from '../crypto/peerRotationFlag';
import {recipientIdentityKeyB64Cached, type PeerIdentityCache} from '../crypto/peerIdentityCache';
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

beforeEach(() => {
  _resetPeerRotationFlagsForTests();
});

describe('the flag contract', () => {
  it('is one-shot: note once, take once, then empty', () => {
    notePeerRotationSuspected('u1.1');
    expect(hasPeerRotationSuspected('u1.1')).toBe(true);
    expect(takePeerRotationSuspected('u1.1')).toBe(true);
    expect(takePeerRotationSuspected('u1.1')).toBe(false);
  });

  it('re-noting after a failed rebuild re-arms it', () => {
    notePeerRotationSuspected('u1.1');
    expect(takePeerRotationSuspected('u1.1')).toBe(true);
    notePeerRotationSuspected('u1.1');      // the catch-path re-arm
    expect(takePeerRotationSuspected('u1.1')).toBe(true);
  });

  it('keys are independent and empty ids are ignored', () => {
    notePeerRotationSuspected('u1.1');
    expect(takePeerRotationSuspected('u2.1')).toBe(false);
    notePeerRotationSuspected('');
    expect(hasPeerRotationSuspected('')).toBe(false);
  });
});

describe('the seal-lane detector (recipientIdentityKeyB64Cached)', () => {
  const PEER = {userId: 'peer-1', deviceId: 1};
  const KEY = 'peer-1.1';
  const OLD_ID = new Uint8Array(33).fill(7);
  const NEW_ID_B64 = b64(new Uint8Array(33).fill(9));

  const keysWith = (identityKey: string) => ({
    fetchPeerBundleWithPoolSize: async () => ({bundle: {identityKey}, poolSize: 50}),
  }) as never;

  const storeWith = (row: Uint8Array | null) => ({
    loadIdentityKey: async () => row,
  }) as never;

  it('NOTES a suspicion when the server identity differs from the trust row', async () => {
    const cache: PeerIdentityCache = new Map();
    await recipientIdentityKeyB64Cached(storeWith(OLD_ID), keysWith(NEW_ID_B64), PEER, cache);
    expect(hasPeerRotationSuspected(KEY)).toBe(true);
  });

  it('does NOT note when they match', async () => {
    const cache: PeerIdentityCache = new Map();
    await recipientIdentityKeyB64Cached(storeWith(OLD_ID), keysWith(b64(OLD_ID)), PEER, cache);
    expect(hasPeerRotationSuspected(KEY)).toBe(false);
  });

  it('does NOT note on first contact (no trust row yet)', async () => {
    const cache: PeerIdentityCache = new Map();
    await recipientIdentityKeyB64Cached(storeWith(null), keysWith(NEW_ID_B64), PEER, cache);
    expect(hasPeerRotationSuspected(KEY)).toBe(false);
  });

  it('does NOT note off the offline fallback lane (only a SERVER identity may accuse)', async () => {
    const cache: PeerIdentityCache = new Map();
    const deadKeys = {fetchPeerBundleWithPoolSize: async () => { throw new Error('offline'); }} as never;
    await recipientIdentityKeyB64Cached(storeWith(OLD_ID), deadKeys, PEER, cache);
    expect(hasPeerRotationSuspected(KEY)).toBe(false);
  });
});

// ── Source-scanned wiring (productionRuntime cannot be imported) ──────────

const ROOT = process.cwd();

/** House stripper: line comments FIRST, then block comments, CRLF-safe. */
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

describe('B-701 wiring in productionRuntime (source scan)', () => {
  const src = () => code('src/modules/messenger/runtime/productionRuntime.ts');

  it('ensureOutgoingSession CONSUMES the flag inside its hasSession fast path and rebuilds', () => {
    const s = src();
    const fn = s.slice(s.indexOf('async function ensureOutgoingSession'), s.indexOf('async function forceRefreshOutgoingSession'));
    // The consume + rebuild live INSIDE the "session already exists" branch.
    const fastPath = fn.slice(fn.indexOf('await own.hasSession(peer)'));
    expect(fastPath).toMatch(/takePeerRotationSuspected\(peerIdentityCacheKey\(peer\)\)/);
    expect(fastPath).toMatch(/rebuildOutgoingSessionWithBundle\(own, ownStore, peer, bundle\)/);
    // A failed rebuild must RE-ARM, not eat, the suspicion.
    expect(fastPath).toMatch(/notePeerRotationSuspected\(peerIdentityCacheKey\(peer\)\)/);
  });

  it('the B-46 rebuild core keeps its M14 shape: ONE chain acquisition, fetch outside, save→remove→init inside', () => {
    const s = src();
    const core = s.slice(s.indexOf('async function rebuildOutgoingSessionWithBundle'));
    const chain = core.slice(core.indexOf('runOnTxnChain'), core.indexOf("'send:forceRefreshOutgoingSession'"));
    const iSave = chain.indexOf('saveIdentity');
    const iRemove = chain.indexOf('removeSession');
    const iInit = chain.indexOf('initOutgoingSession');
    expect(iSave).toBeGreaterThan(-1);
    expect(iRemove).toBeGreaterThan(iSave);
    expect(iInit).toBeGreaterThan(iRemove);
    // No network fetch inside the chained closure (W18/B-140).
    expect(chain).not.toMatch(/fetchPeerBundle/);
  });

  it('NO caller bypasses ensureOutgoingSession behind its own hasSession guard (the flag would never be consumed)', () => {
    const s = src();
    expect(s).not.toMatch(/if \(!had\) \{ ?await ensureOutgoingSession/);
    expect(s).not.toMatch(/if \(!\(await own\.hasSession\(peer\)\)\) \{\s*await ensureOutgoingSession/);
  });

  it('the seal lane raises the flag ONLY on the fromServer branch (source scan of peerIdentityCache)', () => {
    const s = code('src/modules/messenger/crypto/peerIdentityCache.ts');
    const fromServer = s.slice(s.indexOf('if (got.fromServer)'), s.indexOf('} else {', s.indexOf('if (got.fromServer)')));
    expect(fromServer).toMatch(/notePeerRotationSuspected\(key\)/);
    // …and nowhere else in the module.
    const rest = s.replace(fromServer, '');
    expect(rest).not.toMatch(/notePeerRotationSuspected\(/);
  });
});
