/**
 * B-697 ROOT CAUSE — FIXED 2026-08-29 (this file was the DOCUMENTS half; the
 * fix flipped it, per the bug-regression contract).
 *
 * The mobile-local `src/modules/messenger/transport/keysClient.ts` line 2 is:
 *
 *     import {fetchWithTimeout} from '@bravo/messenger-core';
 *
 * and until 2026-08-29 the `packages/messenger-core/src/index.ts` barrel
 * re-exported the transport layer SELECTIVELY — `TRANSPORT_TIMEOUT_MS` only,
 * never the function. The binding resolved to `undefined` and EVERY method
 * of the class died with `TypeError: (0, _src.fetchWithTimeout) is not a
 * function` before a single byte reached the network.
 *
 * Why it survived three shipped builds:
 *   - `tsc` DID flag it (TS2305), but inside the 47-error baseline allowance.
 *   - The one live consumer chain — vaultOps.mintVaultProof →
 *     mintActionToken — swallowed the TypeError into null, which the vault
 *     rendered as "the server declined the MFA challenge": a security-shaped
 *     costume over an import bug. Server-side packet capture (2026-08-29)
 *     showed rich app traffic with ZERO /auth/biometric/assert arrivals —
 *     the B-697 investigation's exact signature.
 *
 * The fix: export `fetchWithTimeout` (and `isTimeoutError`) from the barrel.
 * These assertions are the INVERTED pins the DOCUMENTS header prescribed:
 * the binding is a function, every request path reaches fetch, and the mint
 * resolves a real action token. Deliberately NO `jest.mock` of the barrel —
 * the whole point is the REAL module resolution.
 *
 * sqa.md bug register — this suite pins: B-697.
 */

import * as core from '@bravo/messenger-core';
import {KeysHttpClient} from '../transport/keysClient';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok:         true,
    status:     200,
    statusText: 'OK',
    headers:    {get: () => null},
    text:       async () => JSON.stringify({
      actionToken:     'act-1',
      registrationId:  1,
      identityKey:     'k',
      signedPrekeyId:  1,
      signedPrekey:    'p',
      signedPrekeySig: 's',
      oneTimePrekey:   null,
    }),
  });
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

const newClient = () => new KeysHttpClient({
  baseUrl:  'https://auth.example.test',
  getToken: async () => 'tok-1',
});

describe('B-697 — the fetchWithTimeout barrel binding is ALIVE', () => {
  it('the @bravo/messenger-core barrel exports fetchWithTimeout (the B-697 fix)', () => {
    const barrel = core as unknown as Record<string, unknown>;
    expect(typeof barrel.fetchWithTimeout).toBe('function');
    expect(typeof barrel.TRANSPORT_TIMEOUT_MS).toBe('number');
  });

  it('fetchPeerBundle reaches the network and resolves a bundle', async () => {
    const bundle = await newClient().fetchPeerBundle('peer-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bundle.registrationId).toBe(1);
    expect(bundle.address).toEqual({userId: 'peer-1', deviceId: 1});
  });

  it('uploadBundle reaches the network', async () => {
    await newClient().uploadBundle({
      registrationId: 1,
      identityKey:    'k',
      signedPreKey:   {keyId: 1, publicKey: 'p', signature: 's'},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mintActionToken resolves a REAL action token — the vault gate can finally open', async () => {
    await expect(newClient().mintActionToken('vault-access'))
      .resolves.toEqual({actionToken: 'act-1'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
