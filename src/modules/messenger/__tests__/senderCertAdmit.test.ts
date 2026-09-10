/**
 * sqa.md bug register — this suite pins: B-139.
 *
 * B-139 (a two-minute clock error destroyed the message permanently — verifySenderCert
 * allows +/-120s of skew then throws, and every cert throw was acked "discarded", which
 * DELETES the envelope off the relay) is pinned by the M6 cases here. Deliberately narrow:
 * malformed / wrong-issuer / bad-signature / revoked stay terminal.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isTransientCertError} from '../runtime/receiveTransaction';

/**
 * M6 — a TRANSIENT verification failure must leave the envelope redeliverable.
 *
 * `verifySenderCert` allows ±120s of clock skew and then throws two
 * clock-window errors. Those say nothing about whether the sender is genuine —
 * only that this device's clock disagrees. Acking `discarded` for them DELETED
 * the envelope off the relay, so a momentary clock problem destroyed the
 * message permanently, with no redelivery and nothing in the log.
 *
 * Everything else `verifySenderCert` throws is a real rejection and must stay
 * terminal, or a forged envelope would live on the relay for its full 30-day
 * dwell being retried.
 */
describe('M6 — isTransientCertError', () => {
  it('treats the two CLOCK-WINDOW failures as transient', () => {
    expect(isTransientCertError(new Error('sender cert expired'))).toBe(true);
    expect(isTransientCertError(new Error('sender cert not yet valid'))).toBe(true);
  });

  it('treats every REAL rejection as terminal', () => {
    // Widening the classifier to "any cert error" would keep genuinely forged
    // envelopes alive on the relay. Each of these is a verdict about the
    // sender, not about the clock.
    for (const msg of [
      'sender cert malformed',
      'sender cert signature invalid',
      'sender cert signature wrong length',
      'sender cert revoked',
      'sender cert wrong issuer: evil',
      'sender identity key mismatch',
      'authority public key wrong length',
    ]) {
      expect(isTransientCertError(new Error(msg))).toBe(false);
    }
  });

  it('is not fooled by a substring or a null-ish error', () => {
    expect(isTransientCertError(new Error('sender cert expired yesterday'))).toBe(false);
    expect(isTransientCertError(undefined)).toBe(false);
    expect(isTransientCertError(null)).toBe(false);
    expect(isTransientCertError('sender cert expired')).toBe(false); // not an Error
  });

  it('matches the EXACT strings messenger-core throws', () => {
    // This classifier mirrors two `throw new CryptoError(...)` sites. If their
    // wording drifts, the clock-skew path silently reverts to destroying
    // messages — so pin the source, not just the behaviour.
    const core = readFileSync(
      join(process.cwd(), 'packages', 'messenger-core', 'src', 'crypto', 'senderCert.ts'),
      'utf8',
    );
    expect(core).toContain("throw new CryptoError('sender cert expired')");
    expect(core).toContain("throw new CryptoError('sender cert not yet valid')");
  });
});

describe('M6 — the shared admission leaves clock-skew envelopes on the relay', () => {
  const ADMIT = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'senderCertAdmit.ts');

  it('routes a transient cert error to leave-on-relay, not ack-discard', () => {
    const src = readFileSync(ADMIT, 'utf8');
    expect(src).toMatch(/if \(isTransientCertError\(e\)\)[\s\S]{0,300}?return \{kind: 'leave-on-relay'\}/);
  });

  it('the transient check runs BEFORE the terminal ack-discard fallback', () => {
    const src = readFileSync(ADMIT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const transient = src.indexOf('isTransientCertError(e)');
    const terminal  = src.indexOf('v3 cert pre-verify failed');
    expect(transient).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(transient);
  });

  it('AUDIT #11 lane 5 — a transient SQL failure also leaves the envelope on the relay', () => {
    // The try opens with a LIVE SQL read (resolveExpectedSenderIdentity →
    // loadIdentityKey) and refreshPeerIdentityIfRotated writes
    // trusted_identities. A db_closed/BUSY there is not a verdict about
    // the sender — the ack-discard fallback hard-deleted the envelope on
    // BOTH receive paths, before the decrypt, on every v3 envelope.
    const src = readFileSync(ADMIT, 'utf8');
    // Line-start anchored (trailing-comment decoys cannot satisfy it).
    const gateLine = src.split(/\r?\n/).some(l =>
      l.trim().startsWith('if (isTransientSqlError(e)) {'));
    expect(gateLine).toBe(true);
    // …and the gate returns leave-on-relay BEFORE the terminal fallback.
    const gate = src.indexOf('if (isTransientSqlError(e)) {');
    const terminal = src.indexOf('v3 cert pre-verify failed');
    expect(gate).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(gate);
    expect(src.slice(gate, terminal)).toContain("return {kind: 'leave-on-relay'};");
  });
});
