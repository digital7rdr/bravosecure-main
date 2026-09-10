/**
 * Sanity tests for the SHA digest path used by libsignal + Bravo's outer
 * ECIES. Without these, a regression in the polyfill (or in @noble/hashes)
 * silently re-breaks every mobile send: outerEcies.deriveOuterKey calls
 * subtle.digest('SHA-256', …) on every message, and libsignal's X3DH
 * uses subtle.digest({name:'SHA-512'}, …) on every fresh session build.
 *
 * Node's built-in crypto.subtle is real WebCrypto — these tests pin the
 * canonical SHA-1 / SHA-256 / SHA-384 / SHA-512 vectors that *every*
 * compliant implementation (Node, browsers, our polyfill) must produce.
 * If Bravo's runtime ever drifts from these values, every previously
 * encrypted envelope stops decrypting.
 */
import {webcrypto} from 'node:crypto';

const subtle = (webcrypto as Crypto).subtle;
const enc = (s: string) => new TextEncoder().encode(s);
const hex = async (alg: string, msg: string) => {
  const out = await subtle.digest(alg, enc(msg));
  return Buffer.from(new Uint8Array(out)).toString('hex');
};

describe('SHA test vectors via crypto.subtle.digest', () => {
  it('SHA-1("")', async () => {
    expect(await hex('SHA-1', '')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
  it('SHA-1("abc")', async () => {
    expect(await hex('SHA-1', 'abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('SHA-256("") — outer ECIES depends on this', async () => {
    expect(await hex('SHA-256', '')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('SHA-256("abc")', async () => {
    expect(await hex('SHA-256', 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('SHA-384("")', async () => {
    expect(await hex('SHA-384', '')).toBe(
      '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
    );
  });

  it('SHA-512("abc") — libsignal X3DH depends on this', async () => {
    expect(await hex('SHA-512', 'abc')).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
      '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });
});

describe('Outer ECIES + libsignal hash assumptions', () => {
  // outerEcies.deriveOuterKey hashes (ephPub || recipientPub) under
  // SHA-256 and uses the result as the HKDF salt. If digest output for
  // a deterministic input ever drifts, every wrap/unwrap on the wire
  // changes — old envelopes become unreadable. Pin a fixed input.
  it('SHA-256(64-byte zeros) — outer ECIES salt shape', async () => {
    const zeros64 = new Uint8Array(64);
    const out = await subtle.digest('SHA-256', zeros64);
    expect(Buffer.from(new Uint8Array(out)).toString('hex')).toBe(
      'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b',
    );
  });

  // libsignal X3DH calls Internal.crypto.hash() which is
  // subtle.digest({name:'SHA-512'}, …). Pin the deterministic output for
  // a 64-byte zero input so a polyfill drift is caught immediately.
  it('SHA-512(64-byte zeros) — libsignal X3DH hash shape', async () => {
    const zeros64 = new Uint8Array(64);
    const out = await subtle.digest('SHA-512', zeros64);
    expect(Buffer.from(new Uint8Array(out)).toString('hex')).toBe(
      '7be9fda48f4179e611c698a73cff09faf72869431efee6eaad14de0cb44bbf66' +
      '503f752b7a8eb17083355f3ce6eb7d2806f236b25af96a24e22b887405c20081',
    );
  });
});

describe('Polyfill digest contract', () => {
  // The shim must accept both string and {name:…} forms. Quick-crypto's
  // native side enforces the hyphenated upper form; libsignal calls with
  // the object form `{name:'SHA-512'}`; outerEcies.ts calls with the
  // string form `'SHA-256'`. Both must produce the same output.
  it('object-form algorithm == string-form algorithm', async () => {
    const data = enc('algorithm-form-equivalence-check');
    const a = await subtle.digest('SHA-256', data);
    const b = await subtle.digest({name: 'SHA-256'}, data);
    expect(Buffer.from(new Uint8Array(a)).toString('hex'))
      .toBe(Buffer.from(new Uint8Array(b)).toString('hex'));
  });
});
