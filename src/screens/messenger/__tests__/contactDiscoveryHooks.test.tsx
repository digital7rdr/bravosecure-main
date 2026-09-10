/**
 * EXECUTABLE coverage for the two contact-discovery hooks — both at 0 % before
 * this file:
 *
 *   `useDiscoveredContacts` (76 stmts) — permission → address book → E.164 →
 *   /users/lookup → pair back to the user's OWN contact label → patch the
 *   conversation rows that were still sitting on a `Bravo · <hex>` placeholder.
 *
 *   `useRegisteredNames` (30 stmts) — the gap-filler for peers who are NOT in
 *   your address book: resolve their REGISTERED Bravo name via /users/profiles,
 *   once per userId per session.
 *
 * The behaviours pinned here are the ones the code's own comments call out:
 *
 *  • PASSIVE mode (MessengerHomeScreen's background sweep) must never show a
 *    system prompt and must report `unknown`, not `denied` — reporting `denied`
 *    flips NewChatScreen into its "Open Settings" dead end purely because the
 *    background sweep happened to run first.
 *  • The 500-phone batch. auth-service rejects a bigger array outright
 *    ("phones must contain no more than 500 elements"), so a long-lived address
 *    book found ZERO contacts — the failure mode is silent.
 *  • Audit fix #33 — a user-customised conversation name is never overwritten.
 *  • B-411 — a discovered peer is BY CONSTRUCTION in the address book, so
 *    `name_source` is restamped to 'contact' even when the label already
 *    matches; otherwise a saved contact keeps a wrong "· Unsaved" notification
 *    tag forever.
 *  • Name precedence: custom > address-book > registered > placeholder.
 *    `useRegisteredNames` re-reads the row after its await precisely so the
 *    address-book sweep can win a race against it.
 */

const mockRequestPermissions = jest.fn();
const mockGetPermissions     = jest.fn();
const mockGetContacts        = jest.fn();

jest.mock('expo-contacts', () => ({
  __esModule: true,
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getPermissionsAsync:     (...a: unknown[]) => mockGetPermissions(...a),
  getContactsAsync:        (...a: unknown[]) => mockGetContacts(...a),
  PermissionStatus: {GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined'},
  Fields: {Name: 'name', PhoneNumbers: 'phoneNumbers'},
}));

import {act, renderHook, waitFor} from '@testing-library/react-native';
import * as ContactsNS from 'expo-contacts';
import {
  useDiscoveredContacts, clearDiscoveredContactsCache,
} from '@modules/messenger/contacts/useDiscoveredContacts';
import {useRegisteredNames} from '@modules/messenger/contacts/useRegisteredNames';
import {useMessengerStore} from '@modules/messenger/store';
import type {LocalConversation} from '@modules/messenger/store';

const ContactsMock = ContactsNS as unknown as Record<string, unknown>;

const ALICE = 'alice-uuid-1234abcd';
const BOB   = 'bob-uuid-5678efgh';

const st = () => useMessengerStore.getState();

/** A device address-book entry in the shape expo-contacts returns. */
const deviceContact = (name: string | undefined, ...numbers: string[]) => ({
  id: `dev-${name ?? 'anon'}`,
  name,
  phoneNumbers: numbers.map(number => ({number})),
});

const serverMatch = (userId: string, displayName: string, phone: string, avatarUrl: string | null = null) =>
  ({userId, displayName, phone, avatarUrl});

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          'Bravo · alice-uu',
    name_source:   'placeholder',
    participants:  [ALICE],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    peer:          {userId: ALICE, deviceId: 1},
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

const grant = () => {
  mockRequestPermissions.mockResolvedValue({status: 'granted'});
  mockGetPermissions.mockResolvedValue({status: 'granted'});
};

beforeEach(() => {
  st().reset();
  // B-655 — `useDiscoveredContacts` keeps a MODULE-LEVEL session cache keyed by
  // `${ownPhoneE164}:${region}`, so without this every case after the first
  // would be served the previous case's address book (they all run as the same
  // anonymous user in region '1') and would assert against stale rows.
  clearDiscoveredContactsCache();
  mockRequestPermissions.mockReset();
  mockGetPermissions.mockReset();
  mockGetContacts.mockReset();
  mockGetContacts.mockResolvedValue({data: []});
});

// ───────────────────────── useDiscoveredContacts ─────────────────────────

describe('useDiscoveredContacts — permission gate', () => {
  it('does nothing at all while `enabled` is false', async () => {
    const users = {lookup: jest.fn()};
    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1', enabled: false}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetPermissions).not.toHaveBeenCalled();
    expect(result.current.permission).toBe('unknown');
    expect(users.lookup).not.toHaveBeenCalled();
  });

  it('reports `unavailable` where expo-contacts cannot run (web / jest / Expo Go)', async () => {
    const saved = ContactsMock.requestPermissionsAsync;
    delete ContactsMock.requestPermissionsAsync;
    try {
      const {result} = renderHook(() => useDiscoveredContacts({users: null, defaultRegion: '1'}));
      await waitFor(() => expect(result.current.permission).toBe('unavailable'));
      // …and it never flips `loading` on, so no spinner is left hanging.
      expect(result.current.loading).toBe(false);
    } finally {
      ContactsMock.requestPermissionsAsync = saved;
    }
  });

  it('a foreground denial is terminal: permission `denied`, no address-book read', async () => {
    mockRequestPermissions.mockResolvedValue({status: 'denied'});
    const users = {lookup: jest.fn()};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.permission).toBe('denied'));
    expect(result.current.loading).toBe(false);
    expect(mockGetContacts).not.toHaveBeenCalled();
    expect(users.lookup).not.toHaveBeenCalled();
  });

  it('PASSIVE mode never prompts, and a missing grant reports `unknown` — not `denied`', async () => {
    mockGetPermissions.mockResolvedValue({status: 'undetermined'});
    const users = {lookup: jest.fn()};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1', passive: true}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The system prompt belongs to the foreground screen, never to the
    // background sweep.
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetPermissions).toHaveBeenCalled();
    // Reporting 'denied' here would flip NewChatScreen's settings-prompt block
    // on purely because Home's background sweep ran first.
    expect(result.current.permission).toBe('unknown');
  });

  it('PASSIVE mode with permission ALREADY granted runs the full sweep without prompting', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1', passive: true}));

    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(result.current.permission).toBe('granted');
  });
});

describe('useDiscoveredContacts — pairing the address book to the directory', () => {
  it('shows the USER\'S OWN label for a match, not the peer\'s registered display name', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([
      serverMatch(ALICE, 'Alice Bartholomew', '+14155550100', 'https://cdn/a.jpg'),
    ])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    const row = result.current.matches[0];
    expect(row.localName).toBe('Mum');
    expect(row.displayName).toBe('Alice Bartholomew');
    expect(row.userId).toBe(ALICE);
    expect(row.phoneE164).toBe('+14155550100');
    expect(row.avatarUrl).toBe('https://cdn/a.jpg');
    expect(result.current.error).toBeNull();
  });

  it('sorts by the local label and falls back to the display name for an unpaired phone', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [
      deviceContact('Zoe', '+14155550100'),
      deviceContact('Adam', '+14155550101'),
    ]});
    const users = {lookup: jest.fn().mockResolvedValue([
      serverMatch(ALICE, 'Alice B', '+14155550100'),
      serverMatch(BOB,   'Bob C',   '+14155550101'),
      // A phone the server returned that we never sent — belt-and-braces
      // fallback to the registered name.
      serverMatch('carol', 'Carol D', '+14155559999'),
    ])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.matches).toHaveLength(3));
    expect(result.current.matches.map(m => m.localName)).toEqual(['Adam', 'Carol D', 'Zoe']);
  });

  it('normalizes local-format numbers off the caller\'s OWN phone when no region is passed', async () => {
    grant();
    // A UK trunk-prefixed local number in the address book, and a UK own-phone.
    mockGetContacts.mockResolvedValue({data: [deviceContact('Nan', '07946 0958 12')]});
    const users = {lookup: jest.fn().mockResolvedValue([])};

    renderHook(() => useDiscoveredContacts({users: users as never, ownPhoneE164: '+442079460958'}));

    await waitFor(() => expect(users.lookup).toHaveBeenCalled());
    expect(users.lookup.mock.calls[0][0]).toEqual(['+447946095812']);
  });

  it('first entry wins when two contacts normalise to the same E.164', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [
      deviceContact('Mum',      '+14155550100'),
      deviceContact('Mum Work', '(415) 555-0100'),
    ]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    // Address-book order is what the user expects to win.
    expect(result.current.matches[0].localName).toBe('Mum');
    expect(users.lookup.mock.calls[0][0]).toEqual(['+14155550100']);
  });

  it('an unnamed contact falls back to its first phone string as the label', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact(undefined, '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    expect(result.current.matches[0].localName).toBe('+14155550100');
  });

  it('skips the server round-trip entirely when no phone normalises', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [
      deviceContact('No Number'),
      deviceContact('Junk', '123'),          // too short for E.164
      deviceContact('Blank', ''),
    ]});
    const users = {lookup: jest.fn()};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(users.lookup).not.toHaveBeenCalled();
    expect(result.current.matches).toEqual([]);
    expect(result.current.permission).toBe('granted');
  });

  it('reads the address book but skips the lookup when no users client is wired', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});

    const {result} = renderHook(() => useDiscoveredContacts({users: null, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.permission).toBe('granted');
    expect(result.current.matches).toEqual([]);
  });

  it('batches at 500 phones — auth-service rejects a larger array outright', async () => {
    grant();
    // 1 200 distinct US numbers.
    const data = Array.from({length: 1200}, (_, i) =>
      deviceContact(`C${String(i).padStart(4, '0')}`, `+1415${String(5550000 + i).padStart(7, '0')}`));
    mockGetContacts.mockResolvedValue({data});
    const users = {lookup: jest.fn().mockResolvedValue([])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(users.lookup).toHaveBeenCalledTimes(3);
    const sizes = users.lookup.mock.calls.map(c => (c[0] as string[]).length);
    expect(sizes).toEqual([500, 500, 200]);
    // Chunks must not overlap — a duplicated phone means a duplicated match row.
    const all = users.lookup.mock.calls.flatMap(c => c[0] as string[]);
    expect(new Set(all).size).toBe(1200);
  });

  it('merges the matches from EVERY batch, not just the last one', async () => {
    grant();
    const data = Array.from({length: 600}, (_, i) =>
      deviceContact(`C${String(i).padStart(4, '0')}`, `+1415${String(5550000 + i).padStart(7, '0')}`));
    mockGetContacts.mockResolvedValue({data});
    const users = {
      lookup: jest.fn()
        .mockResolvedValueOnce([serverMatch(ALICE, 'Alice B', '+14155550000')])
        .mockResolvedValueOnce([serverMatch(BOB,   'Bob C',   '+14155550500')]),
    };

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.matches).toHaveLength(2));
    expect(result.current.matches.map(m => m.userId).sort()).toEqual([ALICE, BOB].sort());
  });

  it('surfaces a lookup failure as `error` and clears `loading`', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockRejectedValue(new Error('502 bad gateway'))};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.error).toBe('502 bad gateway'));
    expect(result.current.loading).toBe(false);
    expect(result.current.matches).toEqual([]);
  });

  it('a non-Error throw still produces a stable error code', async () => {
    grant();
    mockGetContacts.mockRejectedValue('nope');

    const {result} = renderHook(() => useDiscoveredContacts({users: null, defaultRegion: '1'}));

    await waitFor(() => expect(result.current.error).toBe('contact_lookup_failed'));
    expect(result.current.loading).toBe(false);
  });

  it('`refresh()` re-runs the whole sweep on demand', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(users.lookup).toHaveBeenCalledTimes(1));

    await act(async () => { await result.current.refresh(); });

    expect(users.lookup).toHaveBeenCalledTimes(2);
  });
});

describe('useDiscoveredContacts — patching conversations that are still placeholders', () => {
  const sweep = async (rows: Array<ReturnType<typeof serverMatch>>, localName = 'Mum', phone = '+14155550100') => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact(localName, phone)]});
    const users = {lookup: jest.fn().mockResolvedValue(rows)};
    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    return result;
  };

  it('upgrades a `Bravo · <hex>` placeholder to the saved contact label and tags it `contact`', async () => {
    st().upsertConversation(convo('conv-a'));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    await waitFor(() => expect(st().conversations['conv-a']?.name).toBe('Mum'));
    expect(st().conversations['conv-a']?.name_source).toBe('contact');
    expect(st().conversations['conv-a']?.phoneE164).toBe('+14155550100');
  });

  it('B-18 — patches the CANONICAL server-UUID row too, not only `direct:<peer>` slots', async () => {
    // The old `direct:` prefix lookup silently skipped UUID rows, so a synced
    // 1:1 kept its hex label forever.
    st().upsertConversation(convo('9d1c2f3a-0000-4000-8000-000000000001'));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    await waitFor(() =>
      expect(st().conversations['9d1c2f3a-0000-4000-8000-000000000001']?.name).toBe('Mum'));
  });

  it('audit fix #33 — a name the USER set is never overwritten, nor re-tagged', async () => {
    st().upsertConversation(convo('conv-a', {name: 'My Lawyer', is_custom_name: true, name_source: 'custom'}));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    expect(st().conversations['conv-a']?.name).toBe('My Lawyer');
    expect(st().conversations['conv-a']?.name_source).toBe('custom');
  });

  it('B-411 — restamps `name_source` to `contact` even when the label already matches', async () => {
    // A saved contact stuck on 'profile' keeps a wrong "· Unsaved" tag in every
    // notification until this restamp runs.
    st().upsertConversation(convo('conv-a', {name: 'Mum', name_source: 'profile'}));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    await waitFor(() => expect(st().conversations['conv-a']?.name_source).toBe('contact'));
    expect(st().conversations['conv-a']?.name).toBe('Mum');
  });

  it('leaves a GROUP row alone even when a member matches', async () => {
    st().upsertConversation(convo('grp', {
      type: 'group', name: 'Ops Team', participants: [ALICE, BOB],
    }));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    expect(st().conversations.grp?.name).toBe('Ops Team');
  });

  it('leaves conversations for peers the sweep did not match untouched', async () => {
    st().upsertConversation(convo('conv-bob', {
      name: 'Bravo · bob-uuid', peer: {userId: BOB, deviceId: 1}, participants: [BOB],
    }));

    await sweep([serverMatch(ALICE, 'Alice B', '+14155550100')]);

    expect(st().conversations['conv-bob']?.name).toBe('Bravo · bob-uuid');
    expect(st().conversations['conv-bob']?.name_source).toBe('placeholder');
  });
});

// ───────────────────────── useRegisteredNames ─────────────────────────

describe('useRegisteredNames — the non-contact gap-filler (B-79)', () => {
  const placeholder = (id: string, over: Partial<LocalConversation> = {}) =>
    convo(id, {name: `Bravo · ${ALICE.slice(0, 8)}`, name_source: 'placeholder', ...over});

  it('resolves a still-placeholder 1:1 to the registered name, tagged `profile`', async () => {
    st().upsertConversation(placeholder('conv-a'));
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([{userId: ALICE, displayName: 'Alice B'}])};

    renderHook(() => useRegisteredNames({users: users as never}));

    await waitFor(() => expect(st().conversations['conv-a']?.name).toBe('Alice B'));
    expect(users.getProfilesByIds).toHaveBeenCalledWith([ALICE]);
    // 'profile', not 'contact' — the notification title carries "· Unsaved"
    // because this name came from the directory, not the address book.
    expect(st().conversations['conv-a']?.name_source).toBe('profile');
  });

  it('does nothing without a users client, or while disabled', async () => {
    st().upsertConversation(placeholder('conv-a'));
    const users = {getProfilesByIds: jest.fn()};

    renderHook(() => useRegisteredNames({users: null}));
    renderHook(() => useRegisteredNames({users: users as never, enabled: false}));

    await act(async () => { await Promise.resolve(); });
    expect(users.getProfilesByIds).not.toHaveBeenCalled();
    expect(st().conversations['conv-a']?.name).toBe(`Bravo · ${ALICE.slice(0, 8)}`);
  });

  it('never queries a custom-named, a group, or an already-resolved conversation', async () => {
    st().upsertConversation(convo('custom', {name: 'My Lawyer', is_custom_name: true}));
    st().upsertConversation(convo('group',  {type: 'group', name: `Bravo · ${ALICE.slice(0, 8)}`, id: 'group'}));
    st().upsertConversation(convo('named',  {name: 'Alice B', name_source: 'profile'}));
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([])};

    renderHook(() => useRegisteredNames({users: users as never}));

    await act(async () => { await Promise.resolve(); });
    expect(users.getProfilesByIds).not.toHaveBeenCalled();
  });

  it('an id the directory omits (unknown/blocked) keeps the placeholder and is NOT re-queried', async () => {
    st().upsertConversation(placeholder('conv-a'));
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([])};

    renderHook(() => useRegisteredNames({users: users as never}));
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalledTimes(1));

    // A conversations change re-runs the effect; the attempted-set must stop it
    // from re-hammering the endpoint for a stranger who simply is not listed.
    act(() => { st().upsertConversation(placeholder('conv-b', {peer: {userId: BOB, deviceId: 1}})); });
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalledTimes(2));
    expect(users.getProfilesByIds.mock.calls[1][0]).toEqual([BOB]);
    expect(st().conversations['conv-a']?.name).toBe(`Bravo · ${ALICE.slice(0, 8)}`);
  });

  it('a failed fetch is best-effort — it marks nothing attempted and retries on the next change', async () => {
    st().upsertConversation(placeholder('conv-a'));
    const users = {getProfilesByIds: jest.fn().mockRejectedValue(new Error('offline'))};

    renderHook(() => useRegisteredNames({users: users as never}));
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalledTimes(1));

    users.getProfilesByIds.mockResolvedValue([{userId: ALICE, displayName: 'Alice B'}]);
    act(() => { st().setConversationMuted('conv-a', true); });

    await waitFor(() => expect(st().conversations['conv-a']?.name).toBe('Alice B'));
  });

  /**
   * DOCUMENTS a live defect — the post-await "re-read" guard does not re-read.
   *
   * `useRegisteredNames.run()` captures `const store = useMessengerStore.getState()`
   * BEFORE its `await users.getProfilesByIds(...)`, then checks
   * `store.conversations[c.id]` afterwards. Zustand + immer replace the ROOT
   * state object on every `set`, so that captured `store.conversations` is a
   * SNAPSHOT frozen at fetch time — the "fresh" row is the stale one. The
   * documented precedence (custom > address-book > registered) therefore fails
   * for exactly the window the guard was written to cover: a saved contact
   * label that lands WHILE the profile fetch is in flight is overwritten by the
   * registered directory name, and the chat + every notification for it flip
   * back to "· Unsaved" until the next address-book sweep runs.
   *
   * Pinned as-is so the fix is a visible flip, not a silent behaviour change.
   * WHEN FIXED (re-read `useMessengerStore.getState().conversations[c.id]`
   * inside the loop instead of the captured `store`), the two assertions at the
   * end must become:
   *     expect(...name).toBe('Mum');
   *     expect(...name_source).toBe('contact');
   */
  it('DOCUMENTS: an address-book name set MID-FLIGHT is clobbered by the registered name', async () => {
    st().upsertConversation(placeholder('conv-a'));
    let release!: (v: Array<{userId: string; displayName: string}>) => void;
    const users = {
      getProfilesByIds: jest.fn().mockReturnValue(
        new Promise<Array<{userId: string; displayName: string}>>(res => { release = res; }),
      ),
    };

    renderHook(() => useRegisteredNames({users: users as never}));
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalled());

    // useDiscoveredContacts lands its saved label while the profile fetch is
    // still in flight.
    act(() => {
      st().upsertConversation({
        ...(st().conversations['conv-a'] as LocalConversation),
        name: 'Mum', name_source: 'contact',
      });
    });
    await act(async () => {
      release([{userId: ALICE, displayName: 'Alice B'}]);
      await Promise.resolve();
    });

    // CURRENT (wrong) behaviour — see the block comment above.
    expect(st().conversations['conv-a']?.name).toBe('Alice B');
    expect(st().conversations['conv-a']?.name_source).toBe('profile');
  });

  it('a name set BEFORE the fetch starts is correctly left alone (the guard works pre-await)', async () => {
    // The same guard IS effective when the address-book sweep wins the race
    // outright: the row is no longer a placeholder when `pending` is computed,
    // so it is never queried at all. This is the half that works today, and it
    // must keep working after the mid-flight case above is fixed.
    st().upsertConversation(placeholder('conv-a', {name: 'Mum', name_source: 'contact'}));
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([{userId: ALICE, displayName: 'Alice B'}])};

    renderHook(() => useRegisteredNames({users: users as never}));
    await act(async () => { await Promise.resolve(); });

    expect(users.getProfilesByIds).not.toHaveBeenCalled();
    expect(st().conversations['conv-a']?.name).toBe('Mum');
  });

  it('resolves several placeholders in ONE request and applies each to its own row', async () => {
    st().upsertConversation(placeholder('conv-a'));
    st().upsertConversation(placeholder('conv-b', {
      peer: {userId: BOB, deviceId: 1}, participants: [BOB], name: `Bravo · ${BOB.slice(0, 8)}`,
    }));
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([
      {userId: ALICE, displayName: 'Alice B'},
      {userId: BOB,   displayName: 'Bob C'},
    ])};

    renderHook(() => useRegisteredNames({users: users as never}));

    await waitFor(() => expect(st().conversations['conv-a']?.name).toBe('Alice B'));
    expect(st().conversations['conv-b']?.name).toBe('Bob C');
    expect((users.getProfilesByIds.mock.calls[0][0] as string[]).sort()).toEqual([ALICE, BOB].sort());
  });
});

/**
 * PERF (2026-08-22) — this hook is mounted in `MainNavigator`, so its selector
 * identity decides whether the ROOT NAVIGATOR re-renders. It used to select the
 * whole `conversations` map, which `appendMessage` replaces on every message.
 *
 * The narrowing has a sharp edge, and the first cut fell off it: a failed fetch
 * is documented to retry "on the next conversations change", and muting a chat
 * does not change WHICH peers are unresolved — so a pending-ids-only key made
 * the retry above stop working. Both halves are pinned here.
 */
describe('useRegisteredNames — the subscription narrows only in the steady state', () => {
  it('does NOT re-run on an unrelated change once every name is resolved', async () => {
    // Steady state: nothing is a placeholder, so a message landing in another
    // chat must not wake this hook (and must not re-render the navigator).
    const users = {getProfilesByIds: jest.fn().mockResolvedValue([])};
    st().upsertConversation({
      ...convo('conv-named'), name: 'Real Name', is_custom_name: true, name_source: 'custom',
    });
    renderHook(() => useRegisteredNames({users: users as never}));
    await act(async () => { await Promise.resolve(); });
    expect(users.getProfilesByIds).not.toHaveBeenCalled();

    act(() => { st().setConversationMuted('conv-named', true); });
    await act(async () => { await Promise.resolve(); });
    expect(users.getProfilesByIds).not.toHaveBeenCalled();
  });

  it('DOES still re-run on an unrelated change while something is pending', async () => {
    // The retry contract. Anything unresolved keeps the broad subscription, so
    // an ordinary edit is a retry chance — which is what the failed-fetch test
    // above depends on.
    st().upsertConversation(convo('conv-a'));
    const users = {getProfilesByIds: jest.fn().mockRejectedValue(new Error('offline'))};
    renderHook(() => useRegisteredNames({users: users as never}));
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalledTimes(1));

    act(() => { st().setConversationMuted('conv-a', true); });
    await waitFor(() => expect(users.getProfilesByIds).toHaveBeenCalledTimes(2));
  });
});

// ───────────────── B-655 — the discovery sweep is session-cached ─────────────

describe('B-655 — useDiscoveredContacts caches the sweep across mounts', () => {
  /**
   * WHY THIS EXISTS. `ForwardList` (the forward / News-share picker) lives
   * inside a `<Modal>`, and RN unmounts a hidden Modal's children — so every
   * time the share sheet opened, the picker remounted and re-ran the ENTIRE
   * sweep: read the address book, normalise every number, then one
   * `/users/lookup` request per 500 phones. Meanwhile `MessengerHomeScreen` had
   * already run the identical sweep and was holding the answer.
   *
   * The duplicated NETWORK request is the cost being removed here (the JS side
   * is a few ms — an early draft of the audit wrongly attributed it to
   * libphonenumber-js, which this repo does not even depend on).
   */
  it('a second mount reuses the first sweep — no second address-book read, no second lookup', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const first = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(first.result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(1);
    const readsAfterFirst = mockGetContacts.mock.calls.length;

    // The picker opening again — a fresh mount of the same hook.
    const second = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(second.result.current.matches).toHaveLength(1));

    expect(users.lookup).toHaveBeenCalledTimes(1);                  // NOT 2
    expect(mockGetContacts.mock.calls.length).toBe(readsAfterFirst); // NOT +1
    // A cache hit must still report the permission the sweep established, or a
    // UI gating on `permission === 'granted'` renders an empty picker.
    expect(second.result.current.permission).toBe('granted');
  });

  it('refresh() FORCES a re-sweep — a "refresh" that served the cache would be a lie', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const {result} = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.refresh(); });
    expect(users.lookup).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT signed-in user is never served the previous account\'s directory', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const a = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1', ownPhoneE164: '+14155550001'}));
    await waitFor(() => expect(a.result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(1);

    // Same device, same address book, DIFFERENT account: the cache key carries
    // the owner, so this must go to the network rather than reuse the answer.
    const b = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1', ownPhoneE164: '+14155550002'}));
    await waitFor(() => expect(b.result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(2);
  });

  it('clearDiscoveredContactsCache() drops it — the sign-out contract', async () => {
    grant();
    mockGetContacts.mockResolvedValue({data: [deviceContact('Mum', '+14155550100')]});
    const users = {lookup: jest.fn().mockResolvedValue([serverMatch(ALICE, 'Alice B', '+14155550100')])};

    const a = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(a.result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(1);

    clearDiscoveredContactsCache();

    const b = renderHook(() =>
      useDiscoveredContacts({users: users as never, defaultRegion: '1'}));
    await waitFor(() => expect(b.result.current.matches).toHaveLength(1));
    expect(users.lookup).toHaveBeenCalledTimes(2);
  });
});
