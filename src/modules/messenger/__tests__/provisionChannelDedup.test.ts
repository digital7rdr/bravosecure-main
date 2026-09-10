/**
 * `orgWorkspace/provisionChannel` — department-channel E2EE bootstrap.
 *
 * 0% executable coverage before this file: `ensureChannelProvisioned` is called
 * from the create flow, the channel list and the Q3 self-heal sweep, and none of
 * those paths had a test that ran it.
 *
 * Everything asserted here is a named regression the module's own header
 * records, so each test states which one:
 *
 *   - SAME-DEVICE dedup: the self-heal sweep racing a channel tap ran
 *     `createGroupChat` TWICE for one channel — two local conversations, two
 *     master keys, one permanent orphan row in the encrypted store.
 *   - D1-d `allowZeroDelivered`: a 0-delivered create threw BEFORE
 *     `registerGroup`, so the channel re-forged a fresh master key on EVERY
 *     open.
 *   - Founder QA 2026-08-08 `allowSolo`: a fresh workspace's channels have only
 *     the admin, and the old refusal left every one of them Inactive and
 *     unopenable from the screen meant to open them.
 *   - First-writer-wins: a racing admin may already have registered a DIFFERENT
 *     group id, so we adopt the canonical one rather than navigating into a fork
 *     only this device can see.
 *
 * Group crypto itself is not re-tested here — `createGroupChat` is the seam, and
 * this module's job is exactly which arguments reach it and what happens after.
 */

const mockListMembers = jest.fn(async (_id: string) => ({data: {members: [{user_id: 'u2'}]}}));
const mockRegisterGroup = jest.fn(async (_c: string, _g: string) => ({data: {}}));
const mockListChannels = jest.fn(async () => ({data: {channels: [] as Array<{id: string; group_conversation_id?: string | null}>}}));
const mockCreateGroupChat = jest.fn(async (_a: unknown) => ({conversationId: 'conv-new'}));

jest.mock('@services/api', () => ({
  departmentApi: {
    listMembers:   (id: string) => mockListMembers(id),
    registerGroup: (c: string, g: string) => mockRegisterGroup(c, g),
    listChannels:  () => mockListChannels(),
  },
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: async (_mode: string) => ({createGroupChat: (a: unknown) => mockCreateGroupChat(a)}),
}));

import {ensureChannelProvisioned} from '../orgWorkspace/provisionChannel';

/** A promise the test resolves by hand, so two callers genuinely overlap. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return {promise, resolve};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListMembers.mockResolvedValue({data: {members: [{user_id: 'u2'}]}});
  mockRegisterGroup.mockResolvedValue({data: {}});
  mockListChannels.mockResolvedValue({data: {channels: []}});
  mockCreateGroupChat.mockResolvedValue({conversationId: 'conv-new'});
});

describe('ensureChannelProvisioned — idempotence', () => {
  it('an already-provisioned channel returns its id and touches NOTHING', async () => {
    const res = await ensureChannelProvisioned('ch-1', 'Ops', 'conv-existing');

    expect(res).toEqual({status: 'already', groupConversationId: 'conv-existing'});
    expect(mockCreateGroupChat).not.toHaveBeenCalled();
    expect(mockRegisterGroup).not.toHaveBeenCalled();
    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], ['']])('provisions when the current id is %p', async (current) => {
    await ensureChannelProvisioned('ch-1', 'Ops', current as string | null | undefined);
    expect(mockCreateGroupChat).toHaveBeenCalledTimes(1);
  });
});

describe('ensureChannelProvisioned — the happy path forges exactly one group', () => {
  it('creates the group with the channel members and registers the id', async () => {
    mockListMembers.mockResolvedValue({data: {members: [{user_id: 'u2'}, {user_id: 'u3'}]}});
    const res = await ensureChannelProvisioned('ch-1', 'Close Protection', null);

    expect(mockCreateGroupChat).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Close Protection',
      members: ['u2', 'u3'],
    }));
    expect(mockRegisterGroup).toHaveBeenCalledWith('ch-1', 'conv-new');
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });

  /**
   * D1-d — without `allowZeroDelivered` a create that reached nobody (members
   * with no Signal keys yet) threw before `registerGroup`, so the channel
   * re-forged a fresh master key on every single open. Without `allowSolo` a
   * brand-new workspace's channels were all permanently Inactive.
   */
  it('passes BOTH tolerance flags — each one is a shipped regression', async () => {
    await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(mockCreateGroupChat).toHaveBeenCalledWith(expect.objectContaining({
      allowZeroDelivered: true,
      allowSolo: true,
    }));
  });

  it('provisions a solo channel with no other members at all', async () => {
    mockListMembers.mockResolvedValue({data: {members: []}});
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(mockCreateGroupChat).toHaveBeenCalledWith(expect.objectContaining({members: []}));
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });

  it('drops members the server returned without a user id', async () => {
    mockListMembers.mockResolvedValue({data: {members: [{user_id: 'u2'}, {user_id: ''}, {user_id: null as unknown as string}]}});
    await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(mockCreateGroupChat).toHaveBeenCalledWith(expect.objectContaining({members: ['u2']}));
  });
});

describe('ensureChannelProvisioned — first-writer-wins', () => {
  it('ADOPTS the canonical id when a racing admin registered a different group', async () => {
    // We minted conv-new, but the server already holds conv-theirs for ch-1.
    // Returning our own id here navigates the user into a fork only this device
    // can decrypt.
    mockListChannels.mockResolvedValue({data: {channels: [
      {id: 'ch-other', group_conversation_id: 'conv-x'},
      {id: 'ch-1', group_conversation_id: 'conv-theirs'},
    ]}});
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-theirs'});
  });

  it('keeps the freshly minted id when the canonical refetch fails', async () => {
    mockListChannels.mockRejectedValue(new Error('offline'));
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    // A transient refetch failure must not lose a group we already registered.
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });

  it('keeps the minted id when the refetch does not know the channel yet', async () => {
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-other', group_conversation_id: 'conv-x'}]}});
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });

  it('keeps the minted id when the refetch reports the channel with no group', async () => {
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', group_conversation_id: null}]}});
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });
});

describe('ensureChannelProvisioned — SAME-DEVICE dedup', () => {
  /**
   * The bug this map exists for: the Q3 self-heal sweep and a concurrent channel
   * tap both called through, and one channel ended up with TWO local
   * conversations, TWO master keys and a permanent orphan row.
   */
  it('two concurrent callers share ONE createGroupChat and one registration', async () => {
    const gate = deferred<{conversationId: string}>();
    mockCreateGroupChat.mockReturnValue(gate.promise);

    const a = ensureChannelProvisioned('ch-1', 'Ops', null);
    const b = ensureChannelProvisioned('ch-1', 'Ops', null);
    gate.resolve({conversationId: 'conv-shared'});

    const [ra, rb] = await Promise.all([a, b]);
    expect(mockCreateGroupChat).toHaveBeenCalledTimes(1);
    expect(mockRegisterGroup).toHaveBeenCalledTimes(1);
    expect(ra).toEqual({status: 'ok', groupConversationId: 'conv-shared'});
    expect(rb).toEqual(ra);
  });

  it('does NOT dedup across different channels', async () => {
    const gate = deferred<{conversationId: string}>();
    mockCreateGroupChat.mockReturnValue(gate.promise);

    const a = ensureChannelProvisioned('ch-1', 'Ops', null);
    const b = ensureChannelProvisioned('ch-2', 'Board', null);
    gate.resolve({conversationId: 'conv-shared'});
    await Promise.all([a, b]);

    expect(mockCreateGroupChat).toHaveBeenCalledTimes(2);
    expect(mockRegisterGroup.mock.calls.map(c => c[0]).sort()).toEqual(['ch-1', 'ch-2']);
  });

  /**
   * The in-flight entry must be released when the work settles. A map that kept
   * the entry would serve one stale answer forever; a map that kept it after a
   * FAILURE would make the channel permanently unprovisionable — no retry, from
   * any surface, until the app was restarted.
   */
  it('a later call re-provisions rather than replaying a settled promise', async () => {
    await ensureChannelProvisioned('ch-1', 'Ops', null);
    await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(mockCreateGroupChat).toHaveBeenCalledTimes(2);
  });

  it('a FAILED provision can be retried immediately', async () => {
    mockListMembers.mockRejectedValueOnce(new Error('500 boom'));
    const first = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(first).toMatchObject({status: 'failed'});

    const second = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(second).toEqual({status: 'ok', groupConversationId: 'conv-new'});
  });
});

describe('ensureChannelProvisioned — failures stay legible', () => {
  /**
   * "No other member" is an expected STATE, not a failure. Collapsing it into
   * `failed` is what produced the silent permanent "not yet active" the module
   * was written to remove.
   */
  it('classifies the no-other-member throw as needs_members, distinctly', async () => {
    mockCreateGroupChat.mockRejectedValue(new Error('A group needs at least one other member'));
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'needs_members'});
    expect(mockRegisterGroup).not.toHaveBeenCalled();
  });

  it('matches that classification case-insensitively', async () => {
    mockCreateGroupChat.mockRejectedValue(new Error('needs AT LEAST ONE OTHER MEMBER to exist'));
    expect(await ensureChannelProvisioned('ch-1', 'Ops', null)).toEqual({status: 'needs_members'});
  });

  it('surfaces a real error message instead of a silent inactive channel', async () => {
    mockRegisterGroup.mockRejectedValue(new Error('403 forbidden'));
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'failed', message: '403 forbidden'});
  });

  it('falls back to an actionable message when the throw carries none', async () => {
    mockListMembers.mockRejectedValue(new Error(''));
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toEqual({status: 'failed', message: 'Could not set up channel encryption.'});
  });

  it('survives a non-Error throw', async () => {
    mockListMembers.mockRejectedValue('plain string');
    const res = await ensureChannelProvisioned('ch-1', 'Ops', null);
    expect(res).toMatchObject({status: 'failed'});
    if (res.status === 'failed') {expect(res.message).toBeTruthy();}
  });
});
