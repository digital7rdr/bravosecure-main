/**
 * Audit P0-S4 + P0-S5 residual — focused unit tests for the assertion
 * surface of openCompartmentedDb. The real op-sqlite native module can't
 * load in the Node jest project (it transitively imports react-native
 * which is flow-typed and fails node parse), so we mock it. These tests
 * exercise:
 *   - assertSafeHexKey (via openCompartmentedDb) — rejects any key that
 *     isn't exactly 64 chars of [0-9a-fA-F], including SQL-injection
 *     shapes that could escape the single-quoted PRAGMA interpolation.
 *   - assertCipherUseHmac (via openCompartmentedDb) — refuses to open
 *     when PRAGMA cipher_use_hmac reports 0, guarding against an
 *     op-sqlite fork that flips the SQLCipher 4 default.
 */

// Distinctive marker the open() mock throws when validation has passed.
// Tests assert this string is NOT `/64-char hex/` so the acceptance case
// proves the validation gate let the call through to open(). Per-test
// toggles are exposed on globalThis with a `mock`-prefixed property name
// — jest's mock-factory scope guard allows `mock*`-named identifiers.
declare global {

  var mockOpSqliteState: {
    cipherUseHmacValue: number | string;
    openShouldThrow: boolean;
    postValidationMarker: string;
  };
}
globalThis.mockOpSqliteState = {
  cipherUseHmacValue: 1,
  openShouldThrow: true,
  postValidationMarker: 'op-sqlite-native-unavailable-in-node',
};

jest.mock('@op-engineering/op-sqlite', () => ({
  // The new openCompartmentedDb resolves the ATTACH path via
  // `getOpSqliteDocsDir`, which reads these constants off the module
  // namespace. They're populated by the native module at boot in
  // production; in tests we expose stable test-only string values.
  IOS_DOCUMENT_PATH: '/tmp/op-sqlite-ios-docs',
  ANDROID_DATABASE_PATH: '/tmp/op-sqlite-android-db',
  open: jest.fn(() => {
    const state = (globalThis as unknown as {mockOpSqliteState: {
      cipherUseHmacValue: number | string;
      openShouldThrow: boolean;
      postValidationMarker: string;
    }}).mockOpSqliteState;
    if (state.openShouldThrow) {
      throw new Error(state.postValidationMarker);
    }
    return {
      async execute(sql: string): Promise<{rows: Array<Record<string, unknown>>}> {
        const s = sql.trim();
        // The two PRAGMAs the test path actually queries the row shape
        // for. Everything else (cipher_memory_security set, WAL pragmas,
        // ATTACH, DDL, schema_version probe) returns an empty rowset.
        if (/^PRAGMA\s+cipher_use_hmac\s*$/i.test(s)) {
          return {rows: [{cipher_use_hmac: state.cipherUseHmacValue}]};
        }
        if (/^PRAGMA\s+(id|msg)\.cipher_use_hmac\s*$/i.test(s)) {
          return {rows: [{cipher_use_hmac: state.cipherUseHmacValue}]};
        }
        return {rows: []};
      },
    };
  }),
}));

import {openCompartmentedDb} from '../crypto/db';

// 64 deterministic hex chars (0x00..0x1f) — passes the [0-9a-fA-F]{64}
// regex and is otherwise valueless.
const goodHex = Buffer.from(
  new Uint8Array(32).map((_, i) => i),
).toString('hex');

describe('openCompartmentedDb — P0-S5 residual key validation', () => {
  beforeEach(() => {
    globalThis.mockOpSqliteState.cipherUseHmacValue = 1;
    globalThis.mockOpSqliteState.openShouldThrow = true;
  });

  it('rejects when keys.id is empty string', async () => {
    await expect(
      openCompartmentedDb({
        keys: {id: '', rt: goodHex, msg: goodHex},
      }),
    ).rejects.toThrow(/64-char hex/);
  });

  it('rejects when keys.rt contains a single-quote (SQL-injection class)', async () => {
    // The exact shape the validator exists to guard against: a payload
    // that could escape op-sqlite's single-quoted PRAGMA key=... interp.
    const injected = "' OR 1=1 --".padEnd(64, '0');
    await expect(
      openCompartmentedDb({
        keys: {id: goodHex, rt: injected, msg: goodHex},
      }),
    ).rejects.toThrow(/64-char hex/);
  });

  it('rejects when keys.msg is too short (32 hex chars)', async () => {
    const short = '0'.repeat(32);
    await expect(
      openCompartmentedDb({
        keys: {id: goodHex, rt: goodHex, msg: short},
      }),
    ).rejects.toThrow(/64-char hex/);
  });

  it('rejects when keys.id is too long (128 hex chars)', async () => {
    const long = '0'.repeat(128);
    await expect(
      openCompartmentedDb({
        keys: {id: long, rt: goodHex, msg: goodHex},
      }),
    ).rejects.toThrow(/64-char hex/);
  });

  it('rejects when keys.id contains a non-hex char', async () => {
    // 63 hex chars + 'g' = right length, wrong charset.
    const nonHex = '0'.repeat(63) + 'g';
    await expect(
      openCompartmentedDb({
        keys: {id: nonHex, rt: goodHex, msg: goodHex},
      }),
    ).rejects.toThrow(/64-char hex/);
  });

  it('accepts three valid 64-hex-char keys (validation gate passes through to open)', async () => {
    // open() is mocked to throw POST_VALIDATION_MARKER. The validator
    // running first would surface as /64-char hex/ — its absence proves
    // all three keys cleared assertSafeHexKey.
    await expect(
      openCompartmentedDb({
        keys: {id: goodHex, rt: goodHex, msg: goodHex},
      }),
    ).rejects.not.toThrow(/64-char hex/);
  });
});

describe('openCompartmentedDb — P0-S4 cipher_use_hmac fail-loud', () => {
  beforeEach(() => {
    globalThis.mockOpSqliteState.cipherUseHmacValue = 1;
    globalThis.mockOpSqliteState.openShouldThrow = false;
  });

  it('throws when cipher_use_hmac PRAGMA reports 0', async () => {
    globalThis.mockOpSqliteState.cipherUseHmacValue = 0;
    await expect(
      openCompartmentedDb({
        keys: {id: goodHex, rt: goodHex, msg: goodHex},
      }),
    ).rejects.toThrow(/cipher_use_hmac is OFF/);
  });

  it('accepts cipher_use_hmac=1 and proceeds past the HMAC gate', async () => {
    // With open() mocked to a working stub and HMAC=1, the assertion
    // gate must not throw. The call may still throw later (ATTACH and
    // DDL run against the stub which returns empty rows for everything)
    // but it must NOT throw the cipher_use_hmac message.
    globalThis.mockOpSqliteState.cipherUseHmacValue = 1;
    await expect(
      openCompartmentedDb({
        keys: {id: goodHex, rt: goodHex, msg: goodHex},
      }),
    ).resolves.toBeDefined();
  });
});
