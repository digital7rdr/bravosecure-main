/**
 * B-111-B - Android/iOS FrameCryptor parity pins.
 *
 * The two native modules (BravoFrameCryptorModule.kt / BravoFrameCryptor.swift)
 * must stay method-for-method identical, and the interop-critical constants
 * live ONLY in frameCryptorTransport.ts so both platforms consume the same
 * values. These tests pin:
 *   1. the 10-method JS contract shape (a platform module missing a method
 *      would silently no-op at runtime);
 *   2. fail-closed: no native module => isAvailable() false => callers refuse;
 *   3. the salt + key-provider knobs baked into BOTH native sources (string
 *      scan - a drifted salt means connects-then-cannot-decrypt, the worst
 *      failure mode).
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('react-native', () => ({
  Platform: {OS: 'ios'},
  NativeModules: {}, // no BravoFrameCryptor => must fail closed
}));

import {isAvailable} from '../webrtc/frameCryptorTransport';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const KOTLIN = path.join(REPO, 'android', 'app', 'src', 'main', 'java', 'com', 'bravosecure', 'app', 'BravoFrameCryptorModule.kt');
const SWIFT = path.join(REPO, 'native', 'ios', 'BravoFrameCryptor.swift');
const OBJC = path.join(REPO, 'native', 'ios', 'BravoFrameCryptor.m');
const TRANSPORT = path.join(REPO, 'src', 'modules', 'messenger', 'webrtc', 'frameCryptorTransport.ts');

const METHODS = [
  'isAvailable',
  'createKeyProvider',
  'setKey',
  'ratchetKey',
  'attachSenderCryptor',
  'attachReceiverCryptor',
  'setCryptorEnabled',
  'setCryptorKeyIndex',
  'disposeCryptor',
  'disposeKeyProvider',
];

describe('B-111-B parity pins', () => {
  // Audit Rev2 QA-01 — this suite reads four files from the native tree. All
  // four ARE git-tracked (android/ is in .gitignore, but tracked files win),
  // so a fresh Linux clone finds them. The guard is belt-and-braces against an
  // `expo prebuild` that wipes android/ mid-session.
  //
  // It FAILS LOUDLY rather than `describe.skip`-ing, deliberately. Most of the
  // assertions below are POSITIVE (`toContain('fun setKey')`), so skipping them
  // is a vacuous pass wearing a different hat — and a drifted
  // "bravo-sframe-v1" salt means connects-then-cannot-decrypt, the worst
  // failure mode this suite exists to catch. A green badge over an unrun parity
  // check is worse than a red one.
  //
  // The assertions themselves are substring matches on raw bytes, so they are
  // EOL-agnostic and need no CRLF normalisation.
  beforeAll(() => {
    const missing = [KOTLIN, SWIFT, OBJC, TRANSPORT]
      .filter(p => !fs.existsSync(p) || fs.readFileSync(p).length === 0);
    if (missing.length > 0) {
      throw new Error(
        'B-111-B parity targets missing or empty — this suite cannot vouch for ' +
        `FrameCryptor salt/method parity:\n  ${missing.join('\n  ')}`,
      );
    }
  });

  it('fails closed on iOS when the native module is absent', () => {
    expect(isAvailable()).toBe(false);
  });

  it('Kotlin, Swift, and the ObjC bridge all declare the full 10-method contract', () => {
    const kotlin = fs.readFileSync(KOTLIN, 'utf8');
    const swift = fs.readFileSync(SWIFT, 'utf8');
    const objc = fs.readFileSync(OBJC, 'utf8');
    for (const m of METHODS) {
      expect(kotlin).toContain(`fun ${m}`);
      expect(swift).toContain(`func ${m}`);
      expect(objc).toContain(m);
    }
  });

  it('the SFrame salt is byte-identical in both native modules', () => {
    const kotlin = fs.readFileSync(KOTLIN, 'utf8');
    const swift = fs.readFileSync(SWIFT, 'utf8');
    expect(kotlin).toContain('"bravo-sframe-v1"');
    expect(swift).toContain('"bravo-sframe-v1"');
  });

  it('key-provider knobs live only in the transport and match the documented values', () => {
    const transport = fs.readFileSync(TRANSPORT, 'utf8');
    expect(transport).toContain('RATCHET_WINDOW_SIZE = 8');
    expect(transport).toContain('FAILURE_TOLERANCE   = -1');
    expect(transport).toContain('KEY_RING_SIZE       = 16');
    // Neither native file may hard-code its own copies of these knobs.
    const swift = fs.readFileSync(SWIFT, 'utf8');
    const kotlin = fs.readFileSync(KOTLIN, 'utf8');
    for (const nativeSrc of [swift, kotlin]) {
      expect(nativeSrc).not.toContain('RATCHET_WINDOW_SIZE');
      expect(nativeSrc).not.toContain('KEY_RING_SIZE');
    }
  });

  it('both native modules start cryptors DISABLED (enable only after epoch key push)', () => {
    const kotlin = fs.readFileSync(KOTLIN, 'utf8');
    const swift = fs.readFileSync(SWIFT, 'utf8');
    expect(kotlin).toContain('cryptor.setEnabled(false)');
    expect(swift).toContain('built.enabled = false');
  });
});
