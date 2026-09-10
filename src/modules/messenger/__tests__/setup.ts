/**
 * Test env setup — Node 18+ exposes WebCrypto, TextEncoder, and Buffer
 * globally, so the libsignal TS port works out of the box. We only need
 * to make sure `globalThis.crypto` is the WebCrypto object (some CI
 * runners expose it as `require('crypto').webcrypto` only).
 */

import { webcrypto } from 'node:crypto';

if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

// The pure-TS libsignal port does elliptic-curve math in JS — a 10-msg
// alternating chain comfortably exceeds Jest's 5s default on a cold run.
jest.setTimeout(30000);
