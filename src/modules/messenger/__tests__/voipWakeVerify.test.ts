/**
 * Round 5 / Security S3 — sealed VoIP wake verification.
 *
 * Server signs every wake with HMAC-SHA256 using a per-device wake
 * key. Client verifies sig + nonce window before showing the ring.
 * Without this, anyone who captures a single VoIP push (network sniff
 * / log scrape) can replay it indefinitely to ring the user.
 *
 * Tests cover:
 *   • valid wake → accepted
 *   • bad sig    → rejected
 *   • stale exp  → rejected
 *   • replayed nonce → second one rejected (LRU)
 *   • missing fields under LEGACY_FALLBACK → accepted (rollout window)
 *   • computeVoipSig matches the server-side voipSign byte-for-byte
 */
import {randomBytes, createHmac} from 'node:crypto';
import {
  computeVoipSig,
  verifyVoipWake,
  _resetNonceLruForTests,
  _setVoipWakeKeyLoaderForTests,
  _setVoipNoncePersistenceForTests,
} from '../push/voipWakeVerify';

function genWakeKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Mirror of `apps/messenger-service/src/push/push.service.ts::voipSign`.
 * We reproduce the canonical form here so the test verifies the
 * client + server agree on the bytes — a divergence in either side's
 * canonicalisation would make every wake fail in production.
 */
function serverSideVoipSign(wakeKeyB64: string, fields: {
  kind: 'voip-wake'; callId: string; nonce: string; exp: number;
}): string {
  const key = Buffer.from(wakeKeyB64, 'base64');
  const msg = `${fields.kind}|${fields.callId}|${fields.nonce}|${fields.exp}`;
  return createHmac('sha256', key).update(msg).digest('base64');
}

describe('VoIP wake verifier (Round 5 / S3)', () => {
  beforeEach(() => {
    _resetNonceLruForTests();
    // Default: empty cold-start persistence. Each test that exercises
    // the persisted path overrides this with its own load/save pair.
    _setVoipNoncePersistenceForTests({
      load: async () => null,
      save: async () => {},
    });
  });

  afterAll(() => {
    _setVoipNoncePersistenceForTests(null);
  });

  it('client-side sig is byte-for-byte equal to server-side sig', () => {
    const wakeKey = genWakeKey();
    const fields = {
      kind:     'voip-wake' as const,
      callId:   '11111111-2222-3333-4444-555555555555',
      nonce:    'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
      exp:      1_700_000_000,
    };
    const clientSig = computeVoipSig(wakeKey, fields);
    const serverSig = serverSideVoipSign(wakeKey, fields);
    expect(clientSig).toBe(serverSig);
  });

  it('accepts a wake with a valid sig + fresh exp + unseen nonce', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'unique-nonce-1';
    const fields = {kind: 'voip-wake' as const, callId: 'cid-1', nonce, exp};
    const sig = computeVoipSig(wakeKey, fields);
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.reason).toBe('verified');}
  });

  it('rejects a wake whose sig was forged with the wrong key', async () => {
    const realKey = genWakeKey();
    const attackerKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => realKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    const fields = {kind: 'voip-wake' as const, callId: 'cid-2', nonce: 'n2', exp};
    const forgedSig = computeVoipSig(attackerKey, fields);
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig: forgedSig}});
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('bad_sig');}
  });

  it('rejects a wake whose exp is well beyond the clock-skew window', async () => {
    // N-03 — the exp check now tolerates a bounded clock skew (device clock
    // fast / Doze deferral). A wake far past its exp (beyond the ~90s skew
    // allowance) is still rejected as stale so the caller degrades to a
    // Missed-call notification.
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) - 200;      // >3 min ago, past skew
    const fields = {kind: 'voip-wake' as const, callId: 'cid-3', nonce: 'n3', exp};
    const sig = computeVoipSig(wakeKey, fields);
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('stale');}
  });

  it('accepts a barely-past-exp wake within the clock-skew window', async () => {
    // N-03 — a device clock a few-to-90 seconds fast made a genuinely-fresh
    // wake look expired, silently dropping EVERY killed-app ring on that
    // device. Within the skew allowance the wake still rings (HMAC sig + nonce
    // LRU remain the real anti-replay gate).
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) - 30;       // 30s past — within skew
    const fields = {kind: 'voip-wake' as const, callId: 'cid-3b', nonce: 'n3b', exp};
    const sig = computeVoipSig(wakeKey, fields);
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    expect(r.ok).toBe(true);
  });

  it('rejects a replayed wake (same nonce twice)', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'shared-nonce';
    const fields = {kind: 'voip-wake' as const, callId: 'cid-4', nonce, exp};
    const sig = computeVoipSig(wakeKey, fields);
    const first  = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    const second = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {expect(second.reason).toBe('replay');}
  });

  it('per-user nonce LRU keeps two users from interfering with each other', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'shared-nonce-cross-user';
    const fields = {kind: 'voip-wake' as const, callId: 'cid-5', nonce, exp};
    const sig = computeVoipSig(wakeKey, fields);
    const aliceFirst = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    const bobFirst   = await verifyVoipWake({selfUserId: 'bob',   fields: {...fields, sig}});
    expect(aliceFirst.ok).toBe(true);
    // Bob should still see this as a fresh wake even though alice just saw it.
    expect(bobFirst.ok).toBe(true);
    // But alice replaying again rejects.
    const aliceReplay = await verifyVoipWake({selfUserId: 'alice', fields: {...fields, sig}});
    expect(aliceReplay.ok).toBe(false);
  });

  // Why: audit S9 — LEGACY_FALLBACK now defaults to false. An unsigned
  // wake or a wake against an unregistered device must be REJECTED, not
  // silently accepted. The rollout-window escape hatch lives behind
  // EXPO_PUBLIC_VOIP_WAKE_LEGACY=true which is unset in production.
  it('rejects an unsigned wake when the device has no wake key (audit S9)', async () => {
    _setVoipWakeKeyLoaderForTests(async () => null);
    const r = await verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 'cid-6'},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
  });

  it('rejects a wake missing sig/nonce/exp fields (audit S9)', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const r = await verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 'legacy-1'},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
  });

  it('rejects a wake with invalid (non-numeric) exp', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const r = await verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 'mal-1',
               nonce: 'n', exp: 'not-a-number' as unknown as number, sig: 'whatever'},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
  });

  // Audit P1-N2 — verify the wake no longer needs/accepts callKind. The
  // server's voipSign canonical form was `kind|callId|callKind|nonce|exp`
  // — dropping callKind closes the FCM/APNs PII leak. A backstop test
  // that exercises BOTH the new client-only canonical form AND the
  // verifier rejecting the old form via bad_sig.
  it('audit P1-N2 — accepts a wake without callKind in the canonical form', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    const sig = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'p1n2-a', nonce: 'p1n2-na', exp});
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'p1n2-a', nonce: 'p1n2-na', exp, sig}});
    expect(r.ok).toBe(true);
  });

  it('audit P1-N2 — rejects an OLD-FORMAT wake whose sig still embeds callKind (bad_sig)', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp = Math.floor(Date.now() / 1000) + 30;
    // Sig made with the deprecated 5-field canonical form.
    const legacyMsg = `voip-wake|p1n2-b|voice|p1n2-nb|${exp}`;
    const legacySig = createHmac('sha256', Buffer.from(wakeKey, 'base64')).update(legacyMsg).digest('base64');
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'p1n2-b', nonce: 'p1n2-nb', exp, sig: legacySig}});
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('bad_sig');}
  });

  // ── Rank 10 — cross-cold-start replay protection ─────────────────
  // The previous implementation kept the seen-nonce set in a process-
  // local Map. A wake captured before the user force-quit the app could
  // be replayed on the next launch (Map starts empty after process
  // bootstrap). With the AsyncStorage-backed LRU, the persisted set
  // hydrates on the first verify call and a captured wake inside the
  // 5-minute retain window is now rejected as a replay.

  it('Rank 10 — rejects a wake whose nonce was persisted in a prior process lifetime', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp   = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'rank10-replay';
    const sig   = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'r10-1', nonce, exp});
    // Simulate a prior process having written this nonce to disk 1 min ago.
    const oneMinAgo = Date.now() - 60_000;
    _setVoipNoncePersistenceForTests({
      load: async () => [[`alice:${nonce}`, oneMinAgo]],
      save: async () => {},
    });
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'r10-1', nonce, exp, sig}});
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('replay');}
  });

  it('Rank 10 — ignores a persisted nonce that has already aged out of NONCE_RETAIN_MS', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp   = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'rank10-aged';
    const sig   = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'r10-2', nonce, exp});
    // 10 min ago — past the 5-min retain window.
    const tenMinAgo = Date.now() - 10 * 60_000;
    _setVoipNoncePersistenceForTests({
      load: async () => [[`alice:${nonce}`, tenMinAgo]],
      save: async () => {},
    });
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'r10-2', nonce, exp, sig}});
    expect(r.ok).toBe(true);
  });

  it('Rank 10 — successful verify persists the nonce for future cold-start checks', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    const exp   = Math.floor(Date.now() / 1000) + 30;
    const nonce = 'rank10-persist';
    const sig   = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'r10-3', nonce, exp});
    const saved: Array<Array<[string, number]>> = [];
    _setVoipNoncePersistenceForTests({
      load: async () => null,
      save: async (entries) => { saved.push(entries); },
    });
    const r = await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'r10-3', nonce, exp, sig}});
    expect(r.ok).toBe(true);
    // Persistence fires async — yield once to let the microtask drain.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved.length).toBeGreaterThan(0);
    const last = saved[saved.length - 1];
    expect(last.some(([k]) => k === `alice:${nonce}`)).toBe(true);
  });

  it('Rank 10 — hydration is one-shot per process; subsequent calls do not re-load', async () => {
    const wakeKey = genWakeKey();
    _setVoipWakeKeyLoaderForTests(async () => wakeKey);
    let loadCalls = 0;
    _setVoipNoncePersistenceForTests({
      load: async () => { loadCalls++; return null; },
      save: async () => {},
    });
    const exp   = Math.floor(Date.now() / 1000) + 30;
    const sig1  = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'r10-4a', nonce: 'na', exp});
    const sig2  = computeVoipSig(wakeKey, {kind: 'voip-wake', callId: 'r10-4b', nonce: 'nb', exp});
    await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'r10-4a', nonce: 'na', exp, sig: sig1}});
    await verifyVoipWake({selfUserId: 'alice', fields: {kind: 'voip-wake', callId: 'r10-4b', nonce: 'nb', exp, sig: sig2}});
    expect(loadCalls).toBe(1);
  });
});
