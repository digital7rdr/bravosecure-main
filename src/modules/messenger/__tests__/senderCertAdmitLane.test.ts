/**
 * EXECUTABLE coverage for `runtime/senderCertAdmit.ts` — the v3 sender-cert
 * ADMISSION DECISION shared by both receive paths (WS `handleDeliverInner`
 * and the HTTP `drainRelay`).
 *
 * `senderCertAdmit.test.ts` (the existing suite) only ever regex-scans this
 * file. Nothing had actually RUN it, which matters more here than almost
 * anywhere else in the module, because this one function decides three
 * mutually-exclusive fates for every inbound envelope:
 *
 *   proceed        — decrypt, using the identity the AUTHORITY attests.
 *   ack-discard    — delete the envelope off the relay. UNRECOVERABLE.
 *   leave-on-relay — do not ack; a later drain retries.
 *
 * Getting the second and third confused is exactly what B-139 (M6) was: a
 * momentary ±120s clock error was acked `discarded`, so the message was
 * destroyed forever. And BS-CERT-MISMATCH was the inverse — an identity
 * rotation `throw e`'d into a sibling try that never caught it, so the
 * refresh never ran and the envelope redelivered forever.
 *
 * MOCKING NOTE: `verifySenderCert` and the peer-identity resolver/refresher
 * are the edges (crypto + network) and are stubbed. `IdentityKeyMismatchError`
 * is the REAL class from messenger-core — the whole rotation branch hangs off
 * an `instanceof`, so a hand-rolled stand-in would prove nothing. So is
 * `isTransientCertError`, which is the M6 classifier itself.
 */

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem:    jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
  },
}));

jest.mock('@bravo/messenger-core', () => ({
  ...jest.requireActual('@bravo/messenger-core'),
  verifySenderCert: jest.fn(),
}));
jest.mock('../crypto/expectedSenderIdentity', () => ({
  resolveExpectedSenderIdentity: jest.fn(),
}));
jest.mock('../crypto/peerIdentityRefresh', () => ({
  refreshPeerIdentityIfRotated: jest.fn(),
}));
jest.mock('../store/peerIdentityAckStore', () => ({
  notePeerIdentityChanged: jest.fn(),
}));

import {IdentityKeyMismatchError, verifySenderCert} from '@bravo/messenger-core';
import type {SenderCertClaims, SessionAddress} from '@bravo/messenger-core';
import {admitSenderCert} from '../runtime/senderCertAdmit';
import type {CertAdmitDeps, CertAdmitEnvelope} from '../runtime/senderCertAdmit';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {refreshPeerIdentityIfRotated} from '../crypto/peerIdentityRefresh';
import {notePeerIdentityChanged} from '../store/peerIdentityAckStore';
import {useMessengerStore} from '../store/messengerStore';

const mockVerify  = verifySenderCert as jest.MockedFunction<typeof verifySenderCert>;
const mockResolve = resolveExpectedSenderIdentity as jest.MockedFunction<typeof resolveExpectedSenderIdentity>;
const mockRefresh = refreshPeerIdentityIfRotated as jest.MockedFunction<typeof refreshPeerIdentityIfRotated>;
const mockNote    = notePeerIdentityChanged as jest.MockedFunction<typeof notePeerIdentityChanged>;

/** The address stamped INSIDE the envelope — forgeable on v3 too. */
const WIRE_SENDER: SessionAddress = {userId: 'wire-claimed-uid', deviceId: 7};
/** What the authority actually attests. Deliberately different from the above. */
const CLAIMED: SenderCertClaims = {
  senderUserId:         'authority-attested-uid',
  senderSignalDeviceId: 3,
  senderIdentityKey:    'cert-identity-b64',
} as SenderCertClaims;

const AUTHORITY = 'authority-pub-key-b64';
const ENV_ID    = 'envelope-abcdef0123456789';

let peerIdentityCache: Map<string, {idKey: string; fetchedAt: number}>;
let keysClient: NonNullable<CertAdmitDeps['keys']>;

function deps(over: Partial<CertAdmitDeps> = {}): CertAdmitDeps {
  return {
    ownStore:           {} as CertAdmitDeps['ownStore'],
    keys:               keysClient,
    peerIdentityCache,
    authorityPubKeyB64: AUTHORITY,
    revokedJtis:        new Set(['revoked-jti-1']),
    envelopeId:         ENV_ID,
    tag:                'ws',
    ...over,
  };
}

function v3(over: Partial<CertAdmitEnvelope> = {}): CertAdmitEnvelope {
  return {wireVersion: 3, senderCert: 'cert.jwt.blob', sender: WIRE_SENDER, ...over};
}

beforeEach(() => {
  jest.clearAllMocks();
  peerIdentityCache = new Map([
    [`${CLAIMED.senderUserId}.${CLAIMED.senderSignalDeviceId}`, {idKey: 'stale', fetchedAt: 1}],
  ]);
  keysClient = {} as NonNullable<CertAdmitDeps['keys']>;
  mockResolve.mockResolvedValue('local-trust-row-identity');
  mockVerify.mockResolvedValue(CLAIMED);
  useMessengerStore.getState().setError(null);
});

describe('back-compat decode path — v2 / certless envelopes', () => {
  it.each([
    ['no wireVersion at all',   {wireVersion: undefined, senderCert: 'cert'}],
    ['wireVersion 2 with cert', {wireVersion: 2,         senderCert: 'cert'}],
    ['v3 with NO cert',         {wireVersion: 3,         senderCert: undefined}],
  ])('%s proceeds on the inner sender without verifying', async (_label, over) => {
    const verdict = await admitSenderCert(v3(over as Partial<CertAdmitEnvelope>), deps());

    expect(verdict).toEqual({kind: 'proceed', trustedPeer: WIRE_SENDER});
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('a verified v3 cert', () => {
  it('trusts the AUTHORITY-ATTESTED claims, never the forgeable inner sender', async () => {
    // The whole point of v3. If this ever returns `unwrapped.sender`, a peer
    // can attribute their message to anybody by editing one field.
    const verdict = await admitSenderCert(v3(), deps());

    expect(verdict).toEqual({
      kind: 'proceed',
      trustedPeer: {userId: CLAIMED.senderUserId, deviceId: CLAIMED.senderSignalDeviceId},
    });
    expect(verdict).not.toEqual(
      expect.objectContaining({trustedPeer: expect.objectContaining({userId: WIRE_SENDER.userId})}),
    );
  });

  it('forwards the trust anchor, the resolved expected identity, and the revocation set', async () => {
    const revoked = new Set(['jti-a', 'jti-b']);

    await admitSenderCert(v3(), deps({revokedJtis: revoked}));

    expect(mockResolve).toHaveBeenCalledWith(
      WIRE_SENDER, expect.anything(), keysClient, peerIdentityCache,
    );
    expect(mockVerify).toHaveBeenCalledWith({
      cert:               'cert.jwt.blob',
      authorityPubKeyB64: AUTHORITY,
      expectedIdentityKey: 'local-trust-row-identity',
      revokedJtis:        revoked,
    });
  });

  it('still verifies the cert when the expected identity is unresolvable (P0-8 dual failure)', async () => {
    // Continuity is skipped, signature + expiry + revocation are NOT — that is
    // the deliberate availability posture, not a bypass.
    mockResolve.mockResolvedValue(undefined);

    const verdict = await admitSenderCert(v3(), deps());

    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({expectedIdentityKey: undefined, authorityPubKeyB64: AUTHORITY}),
    );
    expect(verdict).toEqual({
      kind: 'proceed',
      trustedPeer: {userId: CLAIMED.senderUserId, deviceId: CLAIMED.senderSignalDeviceId},
    });
  });
});

describe('BS-CERT-MISMATCH — identity rotation runs INLINE and actually executes', () => {
  const mismatch = () => new IdentityKeyMismatchError(CLAIMED, 'expected-old-identity');
  const cacheKey = `${CLAIMED.senderUserId}.${CLAIMED.senderSignalDeviceId}`;

  it('a refreshed identity with a session reset proceeds, records the TOFU change and warns the user', async () => {
    mockVerify.mockRejectedValue(mismatch());
    mockRefresh.mockResolvedValue({result: 'refreshed', sessionReset: true} as never);

    const verdict = await admitSenderCert(v3(), deps());

    expect(verdict).toEqual({
      kind: 'proceed',
      trustedPeer: {userId: CLAIMED.senderUserId, deviceId: CLAIMED.senderSignalDeviceId},
    });
    expect(mockRefresh).toHaveBeenCalledWith(
      CLAIMED.senderUserId, CLAIMED.senderSignalDeviceId, CLAIMED.senderIdentityKey,
      keysClient, expect.anything(),
    );
    expect(mockNote).toHaveBeenCalledWith(CLAIMED.senderUserId);
    // The stale cached identity MUST be evicted or the next envelope from this
    // peer re-derives the pre-rotation key and mismatches all over again.
    expect(peerIdentityCache.has(cacheKey)).toBe(false);
    expect(useMessengerStore.getState().error).toMatch(/security code changed/i);
  });

  it('a refresh with NO session reset proceeds silently — no TOFU note, no user-facing error', async () => {
    mockVerify.mockRejectedValue(mismatch());
    mockRefresh.mockResolvedValue({result: 'refreshed', sessionReset: false} as never);

    const verdict = await admitSenderCert(v3(), deps());

    expect(verdict).toEqual({
      kind: 'proceed',
      trustedPeer: {userId: CLAIMED.senderUserId, deviceId: CLAIMED.senderSignalDeviceId},
    });
    expect(mockNote).not.toHaveBeenCalled();
    expect(useMessengerStore.getState().error).toBeNull();
    expect(peerIdentityCache.has(cacheKey)).toBe(false);
  });

  it('an UNAVAILABLE keys-service leaves the envelope on the relay (never acks it away)', async () => {
    mockVerify.mockRejectedValue(mismatch());
    mockRefresh.mockResolvedValue({result: 'unavailable', reason: 'fetch failed'} as never);

    await expect(admitSenderCert(v3(), deps())).resolves.toEqual({kind: 'leave-on-relay'});
    expect(mockNote).not.toHaveBeenCalled();
  });

  it.each(['stale-cert', 'no-change'])(
    'a %s outcome is unrecoverable and acks discard',
    async (result) => {
      mockVerify.mockRejectedValue(mismatch());
      mockRefresh.mockResolvedValue({result, reason: 'r'} as never);

      await expect(admitSenderCert(v3(), deps())).resolves.toEqual({kind: 'ack-discard'});
      // A non-refreshed outcome must not evict the cache entry or claim a
      // TOFU change happened.
      expect(peerIdentityCache.has(cacheKey)).toBe(true);
      expect(mockNote).not.toHaveBeenCalled();
    },
  );

  it('with NO keys client the rotation branch is skipped entirely and the mismatch stays terminal', async () => {
    mockVerify.mockRejectedValue(mismatch());

    const verdict = await admitSenderCert(v3(), deps({keys: undefined}));

    expect(mockRefresh).not.toHaveBeenCalled();
    // `sender identity key mismatch` is a verdict about the sender, not the
    // clock — it must NOT be classified transient.
    expect(verdict).toEqual({kind: 'ack-discard'});
  });
});

describe('M6 / B-139 — a clock-window failure must never destroy the message', () => {
  it.each(['sender cert expired', 'sender cert not yet valid'])(
    '%s leaves the envelope on the relay',
    async (msg) => {
      mockVerify.mockRejectedValue(new Error(msg));
      await expect(admitSenderCert(v3(), deps())).resolves.toEqual({kind: 'leave-on-relay'});
    },
  );

  it.each([
    'sender cert malformed',
    'sender cert signature invalid',
    'sender cert revoked',
    'sender cert wrong issuer: evil',
    'sender cert expired yesterday',
  ])('%s stays terminal (a forgery must not squat the relay for 30 days)', async (msg) => {
    mockVerify.mockRejectedValue(new Error(msg));
    await expect(admitSenderCert(v3(), deps())).resolves.toEqual({kind: 'ack-discard'});
  });

  it('a resolver failure is treated as a cert failure, not as a clock blip', async () => {
    mockResolve.mockRejectedValue(new Error('keys blew up'));
    await expect(admitSenderCert(v3(), deps())).resolves.toEqual({kind: 'ack-discard'});
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('`tag` is log-prefix ONLY and can never change the verdict', () => {
  // The doc comment promises this. Two copies of a security decision that
  // differ by caller is precisely the drift M5 was extracted to end.
  const scenarios: Array<[string, () => void]> = [
    ['verified',       () => { /* defaults */ }],
    ['clock skew',     () => mockVerify.mockRejectedValue(new Error('sender cert expired'))],
    ['forged',         () => mockVerify.mockRejectedValue(new Error('sender cert signature invalid'))],
    ['rotation heal',  () => {
      mockVerify.mockRejectedValue(new IdentityKeyMismatchError(CLAIMED, 'old'));
      mockRefresh.mockResolvedValue({result: 'refreshed', sessionReset: false} as never);
    }],
    ['rotation blip',  () => {
      mockVerify.mockRejectedValue(new IdentityKeyMismatchError(CLAIMED, 'old'));
      mockRefresh.mockResolvedValue({result: 'unavailable', reason: 'x'} as never);
    }],
  ];

  it.each(scenarios)('%s produces the same verdict on ws and on drain', async (_label, arrange) => {
    arrange();
    const ws = await admitSenderCert(v3(), deps({tag: 'ws'}));

    jest.clearAllMocks();
    peerIdentityCache = new Map();
    mockResolve.mockResolvedValue('local-trust-row-identity');
    mockVerify.mockResolvedValue(CLAIMED);
    arrange();
    const drain = await admitSenderCert(v3(), deps({tag: 'drain'}));

    expect(drain).toEqual(ws);
  });
});

describe('a short envelope id never breaks the log slice', () => {
  it('handles an id shorter than the 8-char prefix without throwing', async () => {
    mockVerify.mockRejectedValue(new Error('sender cert malformed'));
    await expect(admitSenderCert(v3(), deps({envelopeId: 'ab'})))
      .resolves.toEqual({kind: 'ack-discard'});
  });
});
