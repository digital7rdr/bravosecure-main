/**
 * Scope v2 Phase 4 — a COMPANY file can never be copied into the PERSONAL
 * vault, enforced at the one place every path ends.
 *
 * ── WHY HERE AND NOT AT THE BUTTONS ─────────────────────────────────────────
 *
 * The first fix hid the "Move to Vault" button on the Company shelf. Review
 * round 2 found that was one of FOUR ways in — the Files row shield, the Files
 * batch lane, the chat viewer and the Files viewer all still offered it, and
 * `allowVaultActions` defaults to true, so safety was opt-in. Hiding buttons is
 * an enumeration; a new surface re-opens it.
 *
 * `moveBytesToVault` is the single writer into the personal vault, so the
 * refusal lives there and every caller inherits it whether or not they
 * remembered.
 *
 * ── WHY AN ADDITIVE REGISTRY, NOT THE POINTER MAP ───────────────────────────
 *
 * The refusal reads `deptConversationIds`: a persisted, purely ADDITIVE set of
 * every conversation ever known to be departmental. Over-approximating is the
 * safe direction for a refusal — refusing a stale department conversation costs
 * a user nothing, while missing one leaks a copy that outlives their membership.
 * (Deciding what to SHOW uses the narrow server list instead; companyShelf.ts.)
 *
 * It is NOT `deptGroupByChannel`. That map is a channel→conversation POINTER
 * which B-206 deliberately OVERWRITES to migrate a channel's history to a new
 * conversation id — so it is pruned by overwrite, and reading it alone would
 * un-refuse every file still filed under the old id. An earlier version of this
 * phase also "healed" that map from the server, which silently satisfied
 * B-206's remap guard without migrating and left members' thread history
 * orphaned permanently. Two different questions, two different structures.
 */
const mockVaultState = {
  hasPin: jest.fn(() => true),
  addFile: jest.fn(),
  files: [],
};
const mockDeptGroupByChannel: {value: Record<string, string>} = {value: {}};
const mockDeptConversationIds: {value: Record<string, true>} = {value: {}};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://x.invalid', MSG_BASE_URL: 'https://y.invalid'}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({success: true})),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({getItem: jest.fn(async () => 'tok')}));
jest.mock('../transport/keysClient', () => ({
  KeysHttpClient: class { mintActionToken() { return Promise.resolve({actionToken: 'proof'}); } },
}));
// The REAL method name is `uploadEncrypted` — my first draft invented
// `encryptAndUpload`, so the allow-path cases failed with `transfer_failed`
// and would have "passed" for the wrong reason had they been asserting a
// refusal. `size` is read too, so the row is indexed.
jest.mock('../vault/vaultClient', () => ({
  VaultClient: class {
    uploadEncrypted() {
      return Promise.resolve({objectKey: 'vault/u/1', keyB64: 'k', ivB64: 'i', size: 3});
    }
  },
}));
jest.mock('../vault/vaultStore', () => ({
  useVaultStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel(mockVaultState),
    {getState: () => mockVaultState},
  ),
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({
    deptGroupByChannel: mockDeptGroupByChannel.value,
    deptConversationIds: mockDeptConversationIds.value,
  })},
}));

import {moveBytesToVault, isDepartmentConversation} from '../vault/vaultOps';

const BYTES = new Uint8Array([1, 2, 3]);
const base = {sourceKey: 'msg:m1', name: 'f.pdf', mimeType: 'application/pdf', bytes: BYTES};

beforeEach(() => {
  jest.clearAllMocks();
  mockVaultState.hasPin.mockReturnValue(true);
  mockDeptGroupByChannel.value = {'ch-1': 'conv-company', 'ch-2': 'conv-company-2'};
  mockDeptConversationIds.value = {};
});

describe('the personal vault refuses a company file, whatever asked', () => {
  it('REFUSES a file whose conversation is a department channel', async () => {
    const res = await moveBytesToVault({...base, conversationId: 'conv-company'});
    expect(res).toMatchObject({ok: false, reason: 'company_file'});
    // Nothing was uploaded or indexed — it fails before the MFA ceremony.
    expect(mockVaultState.addFile).not.toHaveBeenCalled();
  });

  it('the refusal explains WHY, rather than looking like a failure', async () => {
    const res = await moveBytesToVault({...base, conversationId: 'conv-company'});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/organisation|workspace/i);
      expect(res.message).not.toMatch(/error|failed/i);
    }
  });

  it('refuses BEFORE the PIN / MFA ceremony, so it cannot be worn down', async () => {
    // If the order were reversed a user could be prompted for biometrics and
    // only then told no — and a missing PIN would mask the real reason.
    mockVaultState.hasPin.mockReturnValue(false);
    const res = await moveBytesToVault({...base, conversationId: 'conv-company'});
    expect(res).toMatchObject({reason: 'company_file'});
  });

  it('ALLOWS a personal 1:1 conversation', async () => {
    const res = await moveBytesToVault({...base, conversationId: 'conv-dm'});
    expect(res).toMatchObject({ok: true});
  });

  it('ALLOWS a genuine local pick (no conversation at all)', async () => {
    const res = await moveBytesToVault({...base, sourceKey: 'local:1', conversationId: null});
    expect(res).toMatchObject({ok: true});
  });

  /**
   * The map is never pruned, so it still holds channels the user has left.
   * Refusing those is deliberate: a copy taken after losing membership is
   * exactly the leak this rule exists to stop.
   */
  it('refuses a STALE department conversation the user may no longer be in', async () => {
    mockDeptGroupByChannel.value = {'ch-old': 'conv-left-months-ago'};
    const res = await moveBytesToVault({...base, conversationId: 'conv-left-months-ago'});
    expect(res).toMatchObject({ok: false, reason: 'company_file'});
  });

  it('matches on the conversation VALUE, not the channel key', async () => {
    // The map is channelId -> conversationId. Comparing against the keys would
    // let every real conversation through.
    mockDeptGroupByChannel.value = {'conv-company': 'conv-actual'};
    expect(isDepartmentConversation('conv-actual')).toBe(true);
    expect(isDepartmentConversation('conv-company')).toBe(false);
  });

  it('refuses on the ADDITIVE registry alone, with an empty pointer map', async () => {
    mockDeptGroupByChannel.value = {};
    mockDeptConversationIds.value = {'conv-recorded': true};
    const res = await moveBytesToVault({...base, conversationId: 'conv-recorded'});
    expect(res).toMatchObject({ok: false, reason: 'company_file'});
  });

  /**
   * THE B-206 CASE, and the reason the registry exists.
   *
   * When a channel's conversation is re-minted, `deptGroupByChannel` is
   * OVERWRITTEN to point at the new id. Files already filed under the OLD id
   * must still be refused — reading the pointer map alone would un-refuse every
   * one of them the moment the remap ran.
   */
  it('still refuses the OLD conversation after a B-206 remap', async () => {
    mockDeptGroupByChannel.value = {'ch-1': 'conv-NEW'};        // pointer moved
    mockDeptConversationIds.value = {'conv-OLD': true, 'conv-NEW': true};
    expect(isDepartmentConversation('conv-OLD')).toBe(true);
    const res = await moveBytesToVault({...base, conversationId: 'conv-OLD'});
    expect(res).toMatchObject({ok: false, reason: 'company_file'});
  });

  /**
   * Neither source knowing the conversation is the residual window: a device
   * that has never opened the thread AND never opened a surface that fetches
   * the channel list cannot yet tell this is a company file. Documented rather
   * than blessed — it is the honest limit of a device-local check.
   */
  it('an unrecorded conversation is the known residual window', async () => {
    mockDeptGroupByChannel.value = {};
    mockDeptConversationIds.value = {};
    const res = await moveBytesToVault({...base, conversationId: 'conv-never-seen'});
    expect(res).toMatchObject({ok: true});
  });
});
