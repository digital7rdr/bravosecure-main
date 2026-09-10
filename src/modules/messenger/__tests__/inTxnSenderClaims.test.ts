import {toBase64, CryptoError} from '@bravo/messenger-core';
import {verifyInTxnSenderClaims} from '../runtime/inTxnSenderClaims';

/**
 * Seam S1 — the in-transaction sender-claims check.
 *
 * These are two SECURITY rules (the cert must name the same peer the outer wrap
 * named, and must pin the same deviceId), and until this extraction nothing
 * could call them: they sat inside an 8k-line module jest cannot import, so
 * they were covered only by hand-written mirrors.
 *
 * The behaviour under test that is easiest to break by "tidying": both rules
 * THROW rather than returning a verdict. Inside doHandleIncoming a bare return
 * COMMITs the transaction — keeping the libsignal session UPSERT from the
 * decrypt that just happened — and the next redelivery then hits a burned
 * per-message key and wedges the conversation permanently. Throwing rolls the
 * ratchet back.
 */

const PEER = {userId: 'alice', deviceId: 1};

function makeStore(idKeyByAddr: Record<string, number>) {
  return {
    async loadIdentityKey(addr: string): Promise<Uint8Array | null> {
      const seed = idKeyByAddr[addr];
      return seed === undefined ? null : new Uint8Array(32).fill(seed);
    },
  } as never;
}

/** verifySenderCert is mocked: this suite is about the CLAIMS rules, not JWT parsing. */
jest.mock('@bravo/messenger-core', () => {
  const actual = jest.requireActual('@bravo/messenger-core');
  return {...actual, verifySenderCert: jest.fn()};
});
const {verifySenderCert} = require('@bravo/messenger-core') as {verifySenderCert: jest.Mock};

const OK_CLAIMS = {
  senderUserId: 'alice', senderSignalDeviceId: 1, senderIdentityKey: 'IDKEY',
};

beforeEach(() => { verifySenderCert.mockReset(); });

describe('S1 — verifyInTxnSenderClaims', () => {
  it('returns the authority-attested claims when everything matches', async () => {
    verifySenderCert.mockResolvedValue(OK_CLAIMS);
    const got = await verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({'alice.1': 7}),
      keys: undefined, authorityPubKeyB64: 'AUTH',
    });
    expect(got).toEqual(OK_CLAIMS);
  });

  it('THROWS when the cert names a different user than the outer wrap (P1-3)', async () => {
    verifySenderCert.mockResolvedValue({...OK_CLAIMS, senderUserId: 'mallory'});
    const onError = jest.fn();
    await expect(verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({}), keys: undefined,
      authorityPubKeyB64: 'AUTH', onError,
    })).rejects.toThrow('cert_peer_mismatch');
    expect(onError).toHaveBeenCalledWith('sender cert / hint mismatch');
  });

  it('THROWS when the cert pins a different deviceId — cross-device replay (P0-2)', async () => {
    verifySenderCert.mockResolvedValue({...OK_CLAIMS, senderSignalDeviceId: 2});
    const onError = jest.fn();
    await expect(verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({}), keys: undefined,
      authorityPubKeyB64: 'AUTH', onError,
    })).rejects.toThrow('cert_device_mismatch');
    expect(onError).toHaveBeenCalledWith('sender cert / device-id mismatch');
  });

  it('propagates a cert rejection unchanged (signature/expiry stay terminal here)', async () => {
    verifySenderCert.mockRejectedValue(new CryptoError('sender cert signature invalid'));
    await expect(verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({}), keys: undefined,
      authorityPubKeyB64: 'AUTH',
    })).rejects.toThrow('sender cert signature invalid');
  });

  it('passes the LOCAL trust row as the continuity anchor when one exists', async () => {
    verifySenderCert.mockResolvedValue(OK_CLAIMS);
    await verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({'alice.1': 7}),
      keys: undefined, authorityPubKeyB64: 'AUTH',
    });
    expect(verifySenderCert).toHaveBeenCalledWith(
      expect.objectContaining({expectedIdentityKey: toBase64(new Uint8Array(32).fill(7) as never)}),
    );
  });

  it('still verifies (signature/expiry) with NO anchor when the trust row is missing', async () => {
    // Dual-failure posture: continuity is skipped, verification is not.
    verifySenderCert.mockResolvedValue(OK_CLAIMS);
    await verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({}), keys: undefined,
      authorityPubKeyB64: 'AUTH',
    });
    expect(verifySenderCert).toHaveBeenCalledWith(
      expect.objectContaining({expectedIdentityKey: undefined, authorityPubKeyB64: 'AUTH'}),
    );
  });

  it('does not require an onError sink (throwing is the contract, the banner is optional)', async () => {
    verifySenderCert.mockResolvedValue({...OK_CLAIMS, senderUserId: 'mallory'});
    await expect(verifyInTxnSenderClaims({
      cert: 'c', peer: PEER, ownStore: makeStore({}), keys: undefined,
      authorityPubKeyB64: 'AUTH',
    })).rejects.toThrow('cert_peer_mismatch');
  });
});
