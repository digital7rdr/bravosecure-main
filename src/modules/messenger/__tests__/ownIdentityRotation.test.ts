/**
 * purgeStaleRecipientQueue — covers all backend availability modes.
 *
 * Validates:
 *   1. Backend confirms purge → returns purged count
 *   2. No superseded identity → no-op (defensive)
 *   3. Backend missing (404) → backend-missing, NO throw
 *   4. Other HTTP error → unavailable, NO throw
 *   5. Network failure (non-Relay error) → unavailable, NO throw
 *
 * The "never throws" guarantee matters because the caller's
 * identity-rotation flow is already complete by the time we get
 * here; failure to purge must not abort it.
 */

import {purgeStaleRecipientQueue} from '../crypto/ownIdentityRotation';
import {RelayHttpError} from '@bravo/messenger-core';

function fakeRelay(impl: {
  purgeStaleRecipientQueue: () => Promise<{purged: number}>;
}): import('@bravo/messenger-core').RelayHttpClient {
  return impl as unknown as import('@bravo/messenger-core').RelayHttpClient;
}

describe('purgeStaleRecipientQueue', () => {
  it('returns purged count when backend confirms', async () => {
    const relay = fakeRelay({
      purgeStaleRecipientQueue: async () => ({purged: 7}),
    });
    const out = await purgeStaleRecipientQueue(relay, 'oldIdB64');
    expect(out).toEqual({result: 'purged', count: 7});
  });

  it('no-ops defensively when superseded identity is empty', async () => {
    let called = false;
    const relay = fakeRelay({
      purgeStaleRecipientQueue: async () => { called = true; return {purged: 0}; },
    });
    const out = await purgeStaleRecipientQueue(relay, '');
    expect(out.result).toBe('no-op');
    expect(called).toBe(false);
  });

  it('returns backend-missing on 404, does NOT throw', async () => {
    const relay = fakeRelay({
      purgeStaleRecipientQueue: async () => { throw new RelayHttpError(404, 'not_found'); },
    });
    const out = await purgeStaleRecipientQueue(relay, 'oldIdB64');
    expect(out.result).toBe('backend-missing');
  });

  it('returns unavailable on other HTTP status', async () => {
    const relay = fakeRelay({
      purgeStaleRecipientQueue: async () => { throw new RelayHttpError(503, 'service_unavailable'); },
    });
    const out = await purgeStaleRecipientQueue(relay, 'oldIdB64');
    expect(out.result).toBe('unavailable');
    expect(out.reason).toContain('503');
  });

  it('returns unavailable on network errors, does NOT throw', async () => {
    const relay = fakeRelay({
      purgeStaleRecipientQueue: async () => { throw new Error('ECONNRESET'); },
    });
    const out = await purgeStaleRecipientQueue(relay, 'oldIdB64');
    expect(out.result).toBe('unavailable');
    expect(out.reason).toContain('ECONNRESET');
  });
});
