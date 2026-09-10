/**
 * B-451 / B-452 / B-453 — the Files browser's album moves and its PIN gate.
 *
 * Founder, 2026-08-15:
 *   B-451 "moving files into an album makes a copy instead of moving"
 *   B-452 "cannot move multiple images into an album, only 1 at a time"
 *   B-453 "even the phone vault must be password protected (4 pin or biometric)"
 *
 * B-451/B-452 were ONE defect wearing two faces. The album model is
 * single-valued (`assignments: itemId -> albumId`), so a copy is structurally
 * impossible — what the founder saw was a move that did not stick:
 *
 *   - a view-driven `prune(rows.map(r => r.id))` ran on every `rows` change and
 *     DELETED every assignment outside the current list, persisted at once. And
 *     `rows` is never the whole key space: empty before SQLCipher hydration,
 *     capped at 200 messages per conversation, and scoped to company
 *     conversations inside the workspace shell;
 *   - the move handler mapped `selectedRows` (the scope-filtered VIEW) instead
 *     of the `selected` id set, so ids that fell out of the view were skipped;
 *   - no row ever displayed its album, so even a move that worked looked
 *     exactly like nothing happening — i.e. like a copy.
 *
 * This suite mounts the real screen against the REAL `useFileAlbumStore`, so it
 * sees what the persisted map actually holds after each interaction.
 *
 * `albumUi` is replaced by a two-button harness: the destination sheet is a
 * `Modal`, and driving it through RTL pins the sheet's markup rather than
 * FilesScreen's handler contract — which is where all three defects live.
 * `albumWiring.test.ts` scans that the real sheet stays wired to these handlers.
 */
import React from 'react';
import {render, fireEvent, act} from '@testing-library/react-native';

const mockInShell = jest.fn();
const mockCompanyConvIds = jest.fn();
const mockDeptConversationIds: {value: Record<string, true>} = {value: {'conv-channel': true}};
const mockReplace = jest.fn();
const mockAlert = jest.fn();
/** Drives the vault gate: both are read through `useVaultStore.getState()`. */
const vaultGate = {unlocked: true, hasPin: true, hydrated: true};
/** Hydration listeners the screen registered, so a test can finish hydration. */
const mockHydrationCbs: Array<() => void> = [];
const mockNav = {
  navigate: jest.fn(), goBack: jest.fn(), isFocused: () => true,
  replace: (...a: unknown[]) => mockReplace(...a),
  addListener: () => () => undefined,
};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// B-663 batch - FilesScreen now imports the direct-upload pickers.
jest.mock('react-native-image-picker', () => ({launchImageLibrary: jest.fn(), launchCamera: jest.fn()}));
jest.mock('expo-document-picker', () => ({getDocumentAsync: jest.fn()}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  // STABLE identity, like the real one. A fresh object per render changes
  // `guardLock`'s identity, which re-fires the focus effect on EVERY render and
  // silently masks whether the gate reacts to the lock at all — a vacuous pin.
  useNavigation: () => mockNav,
  // LIVE, unlike `filesScreenCompanyScope.test.tsx` — the B-453 gate is a
  // focus effect, so a no-op stub would make every gate case vacuous.
  useFocusEffect: (cb: () => void) => {
    (require('react') as typeof React).useEffect(() => { cb(); }, [cb]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('expo-sharing', () => ({isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn()}));
jest.mock('react-native-svg', () => ({__esModule: true, default: 'Svg', Rect: 'Rect'}));
jest.mock('@components/Halo', () => ({Halo: () => null}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/ui/AttachmentFileViewer', () => ({AttachmentFileViewer: () => null}));
jest.mock('@/modules/messenger/media', () => ({readUriBytes: jest.fn(), resolveAttachmentFileUri: jest.fn()}));
jest.mock('@utils/haptics', () => ({haptics: {
  tap: jest.fn(), select: jest.fn(), impact: jest.fn(), heavy: jest.fn(),
}}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn()}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({isOrgAffiliated: true, hasCloudVault: true}),
  showTierUpgradePrompt: jest.fn(),
}));

/**
 * A real store shape, not a bare selector function: the B-453 gate reads
 * `useVaultStore.getState()`, which the existing harness's plain-function mock
 * cannot answer.
 */
jest.mock('@/modules/messenger/vault', () => {
  const useVaultStore = (sel: (s: unknown) => unknown) => sel({
    files: [], removeFile: jest.fn(),
    // The gate subscribes to this so a relock re-runs it under a focused
    // screen. Driven from `vaultGate` so a locked case is genuinely locked.
    unlockedUntil: vaultGate.unlocked ? Date.now() + 5 * 60_000 : null,
  });
  (useVaultStore as unknown as {getState: () => unknown}).getState = () => ({
    files: [],
    isUnlocked: () => vaultGate.unlocked,
    hasPin: () => vaultGate.hasPin,
  });
  return {
    openVault: jest.fn(), moveBytesToVault: jest.fn(), findVaultRow: jest.fn(() => null),
    useVaultStore,
    // Real builds gate on AsyncStorage rehydration; the mocked store has no
    // persist middleware, so it is hydrated by definition.
    vaultHydrated: () => vaultGate.hydrated,
    vaultPersistApi: () => ({
      hasHydrated: () => vaultGate.hydrated,
      onFinishHydration: (cb: () => void) => {
        mockHydrationCbs.push(cb);
        return () => { mockHydrationCbs.splice(mockHydrationCbs.indexOf(cb), 1); };
      },
    }),
    isDepartmentConversation: (id: string) => !!mockDeptConversationIds.value[id],
  };
});
jest.mock('@/modules/messenger/vault/useCompanyShelf', () => ({
  useCompanyConversationIds: () => mockCompanyConvIds(),
}));
jest.mock('@screens/deptchat/_obsidian', () => ({
  ...jest.requireActual('@screens/deptchat/_obsidian'),
  useInDepartmentalShell: () => mockInShell(),
}));

jest.mock('../albumUi', () => {
  const R = require('react');
  const {Text} = require('react-native');
  return {
    __esModule: true,
    // Renders the ACTIVE filter so a test can see which album the list is
    // showing. The real bar is only mounted outside selection mode, which is
    // exactly the state a completed move returns to.
    // Renders the ACTIVE filter so a test can see which view the list is
    // showing, plus pressable stand-ins for the chips so a test can switch
    // views. The real bar mounts only outside selection mode, which is the
    // state a completed move returns to.
    AlbumBar: ({active, albums, onSelect}: {
      active: string | null | undefined;
      albums: readonly {id: string; name: string}[];
      onSelect: (f: string | null | undefined) => void;
    }) => R.createElement(
      R.Fragment,
      null,
      R.createElement(Text, {accessibilityLabel: 'active-album-filter'},
        active === undefined ? 'ALL' : active === null ? 'UNFILED' : active),
      R.createElement(Text, {
        accessibilityLabel: 'chip-all', onPress: () => onSelect(undefined),
      }, 'all'),
      R.createElement(Text, {
        accessibilityLabel: 'chip-unfiled', onPress: () => onSelect(null),
      }, 'unfiled'),
      // Children are deliberately NOT the album name: `queryAllByText(name)`
      // counts the album label on the ROWS, and a chip carrying the same text
      // would inflate every one of those assertions.
      ...albums.map(a => R.createElement(Text, {
        key: a.id,
        accessibilityLabel: `chip-album-${a.name}`,
        onPress: () => onSelect(a.id),
      }, 'chip')),
    ),
    NameAlbumModal: () => null,
    MoveToAlbumSheet: ({visible, albums, onPick}: {
      visible: boolean;
      albums: readonly {id: string; name: string}[];
      onPick: (id: string | null) => void;
    }) => (visible ? R.createElement(
      R.Fragment,
      null,
      R.createElement(Text, {
        accessibilityLabel: 'pick-first-album',
        onPress: () => onPick(albums[0]?.id ?? null),
      }, 'first'),
      R.createElement(Text, {
        // An album id that is not in the store — the `not_found` lane.
        accessibilityLabel: 'pick-ghost-album',
        onPress: () => onPick('alb_ghost'),
      }, 'ghost'),
    ) : null),
  };
});

const companyPdf = {
  id: 'm-co', conversation_id: 'conv-channel', sender_id: 'u2', type: 'file',
  content: '', created_at: '2026-08-02T10:00:00.000Z', is_encrypted: true,
  media_object_key: 'o-co', media_key: 'k', media_iv: 'i',
  media_mime: 'application/pdf', media_meta: {name: 'BOARD-MINUTES.pdf', sizeBytes: 10},
};
const personalPdf = {
  ...companyPdf,
  id: 'm-dm', conversation_id: 'conv-dm',
  media_object_key: 'o-dm', media_meta: {name: 'HOLIDAY-SNAP.pdf', sizeBytes: 10},
};
const mockMessages: {value: unknown[]} = {value: [companyPdf, personalPdf]};

jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({
    conversations: {
      'conv-channel': {id: 'conv-channel', name: 'Board'},
      'conv-dm': {id: 'conv-dm', name: 'Alice'},
    },
    messages: {},
    deptConversationIds: mockDeptConversationIds.value,
    removeMessage: jest.fn(),
  }),
  selectMediaMessages: () => mockMessages.value,
}));

import FilesScreen from '../FilesScreen';
import {useFileAlbumStore} from '@/modules/messenger/fileAlbums/fileAlbumStore';

/** Seed an album + assignments straight into the REAL persisted store. */
function seedAlbum(name: string, itemIds: readonly string[]): string {
  const {id} = useFileAlbumStore.getState().create(name);
  if (!id) {throw new Error('fixture album not created');}
  if (itemIds.length > 0) {useFileAlbumStore.getState().move(itemIds, id);}
  return id;
}

const assignments = () => useFileAlbumStore.getState().assignments;

beforeEach(() => {
  jest.clearAllMocks();
  useFileAlbumStore.getState().reset();
  mockCompanyConvIds.mockReturnValue(new Set(['conv-channel']));
  mockDeptConversationIds.value = {'conv-channel': true};
  mockMessages.value = [companyPdf, personalPdf];
  mockInShell.mockReturnValue(false);
  vaultGate.unlocked = true;
  vaultGate.hasPin = true;
  vaultGate.hydrated = true;
  mockHydrationCbs.length = 0;
});

describe('B-451/B-452 — no view of the rows may destroy an album assignment', () => {
  /**
   * The workspace Vault tab filters `rows` to company conversations, so the old
   * sweep unfiled every PERSONAL file the moment that tab was focused. This is
   * the "I moved four and one stuck" report: the four were filed, then the next
   * focus of the other instance deleted three of them.
   */
  it('B-452 — the workspace-scoped instance never prunes a personal assignment', () => {
    const albumId = seedAlbum('Trip', ['m-dm', 'm-co']);
    mockInShell.mockReturnValue(true);        // rows = company conversations only

    render(<FilesScreen />);

    expect(assignments()['m-dm']).toBe(albumId);
    expect(assignments()['m-co']).toBe(albumId);
  });

  /**
   * `rows` is empty until SQLCipher message hydration lands, so the sweep ran
   * once per cold boot against an empty list and wiped the WHOLE map.
   */
  it('B-451 — a cold boot with nothing hydrated keeps every assignment', () => {
    const albumId = seedAlbum('Trip', ['m-dm', 'm-co']);
    mockMessages.value = [];                  // pre-hydration

    render(<FilesScreen />);

    expect(assignments()).toEqual({'m-dm': albumId, 'm-co': albumId});
  });

  /**
   * The store hydrates at most 200 messages per conversation, so even the
   * full-scope list is incomplete on a long thread — which is why the fix is
   * event-driven rather than a better-guarded sweep.
   */
  it('B-451 — a file below the hydration cap keeps its album', () => {
    const albumId = seedAlbum('Trip', ['m-old']);   // not in mockMessages at all
    mockInShell.mockReturnValue(false);

    render(<FilesScreen />);

    expect(assignments()['m-old']).toBe(albumId);
  });
});

describe('B-452 — the move files the whole selection', () => {
  /**
   * RED before the fix: the handler mapped `selectedRows`, which is `rows`
   * filtered by the company scope. A selection made outside the shell and moved
   * after the scope narrowed filed only the surviving row.
   */
  it('B-452 — every selected id is filed, including ones the VIEW has dropped', () => {
    const albumId = seedAlbum('Trip', []);
    const {getByText, getByLabelText, rerender} = render(<FilesScreen />);

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');   // personal
    fireEvent.press(getByText('BOARD-MINUTES.pdf'));         // + company

    // The view narrows underneath the selection — the id set does not.
    mockInShell.mockReturnValue(true);
    rerender(<FilesScreen />);

    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-first-album'));

    expect(assignments()).toEqual({'m-dm': albumId, 'm-co': albumId});
  });

  it('B-452 — a plain multi-selection files ALL of it, not one at a time', () => {
    const albumId = seedAlbum('Trip', []);
    const {getByText, getByLabelText} = render(<FilesScreen />);

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');
    fireEvent.press(getByText('BOARD-MINUTES.pdf'));
    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-first-album'));

    expect(Object.keys(assignments()).sort()).toEqual(['m-co', 'm-dm']);
    expect(assignments()['m-dm']).toBe(albumId);
  });

  /**
   * `move` returns an AlbumError. Discarding it meant a `not_found` filed
   * NOTHING while the sheet closed and the selection cleared — indistinguishable
   * from success, and the second half of "it made a copy".
   */
  it('B-452 — a not_found move surfaces an alert instead of closing silently', () => {
    seedAlbum('Trip', []);
    const {getByText, getByLabelText} = render(<FilesScreen />);

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');
    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-ghost-album'));

    expect(mockAlert).toHaveBeenCalledWith('Not moved', expect.stringContaining('no longer exists'));
    expect(assignments()['m-dm']).toBeUndefined();
    // The selection SURVIVES a failed move, so a retry is one tap.
    expect(getByText('1 SELECTED')).toBeTruthy();
  });
});

describe('B-451 — a move is visible on the row', () => {
  it('B-451 — the row renders the album it is filed under', async () => {
    seedAlbum('Site Recce', ['m-dm']);
    const {findByText, queryAllByText, getByLabelText} = render(<FilesScreen />);

    // B-607 r2 — with a folder present the browser opens on UNFILED, which by
    // definition excludes the filed row. Switch to All to see it; the rule
    // under test is what the ROW renders, not which view is default.
    fireEvent.press(getByLabelText('chip-all'));

    expect(await findByText('Site Recce')).toBeTruthy();
    // Only the filed row — the other one shows nothing, not "Unfiled".
    expect(queryAllByText('Site Recce')).toHaveLength(1);
  });

  it('B-451 — a file under a DELETED album shows nothing, not a dead id', () => {
    const albumId = seedAlbum('Gone', ['m-dm']);
    act(() => { useFileAlbumStore.getState().remove(albumId); });

    const {queryByText} = render(<FilesScreen />);

    expect(queryByText('Gone')).toBeNull();
    expect(queryByText(albumId)).toBeNull();
  });

  it('B-451 — the album appears on the row as soon as the move lands', () => {
    seedAlbum('Trip', []);
    const {getByText, getByLabelText, queryAllByText} = render(<FilesScreen />);

    expect(queryAllByText('Trip')).toHaveLength(0);

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');
    fireEvent.press(getByText('BOARD-MINUTES.pdf'));
    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-first-album'));

    // Both rows now carry the album name — the proof the founder never had.
    expect(queryAllByText('Trip')).toHaveLength(2);
  });

  /**
   * B-607 — founder, 2026-08-21: "when I move images into a folder it only
   * creates a duplicate (copy), it doesn't move them."
   *
   * Nothing was ever copied — `assignments` is single-valued, so it cannot
   * hold two albums for one id. The move landed and then dropped the user back
   * on the DEFAULT view, which is `albumFilter === undefined` = All, and All
   * lists every file whatever its album. The rows therefore sat exactly where
   * they had been, now labelled with the destination — indistinguishable from
   * "it copied them in and left the originals".
   *
   * The sheet is a folder affordance, so it must behave like one: following
   * the move into the destination is what makes the label model read as the
   * folder it is drawn as.
   */
  it('B-607 — a completed move lands the list IN the destination album', () => {
    const albumId = seedAlbum('Trip', []);
    const {getByText, getByLabelText} = render(<FilesScreen />);

    // A folder exists, so the browser opens on UNFILED — both files are loose,
    // so both are on screen and a move will visibly remove them.
    expect(getByLabelText('active-album-filter').props.children).toBe('UNFILED');

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');
    fireEvent.press(getByText('BOARD-MINUTES.pdf'));
    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-first-album'));

    expect(getByLabelText('active-album-filter').props.children).toBe(albumId);
  });

  /**
   * B-607 r2 — THE ACTUAL COMPLAINT, reported twice.
   *
   * "It only creates a duplicate into the folder I selected. It doesn't move
   * them." Nothing was ever duplicated — the founder's own screenshot shows
   * `All 2 · Test 1 2 · Unfiled 0`, i.e. two files, filed once. What made it
   * read as a copy is that the view they were standing in still listed the
   * files afterwards, and the same count appeared on two chips.
   *
   * A move is only a move if the file LEAVES where it was. That is what this
   * asserts, and it is the assertion the first fix did not make: following the
   * move into the destination showed the result, but All still contained the
   * originals, so a user who tapped back saw the same thing they complained
   * about.
   */
  it('B-607 r2 — after a move the file is GONE from the view it was in', () => {
    seedAlbum('Trip', []);
    const {getByText, getByLabelText, queryByText} = render(<FilesScreen />);

    // Standing in Unfiled, holding both loose files.
    expect(getByLabelText('active-album-filter').props.children).toBe('UNFILED');
    expect(getByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
    expect(getByText('BOARD-MINUTES.pdf')).toBeTruthy();

    fireEvent(getByText('HOLIDAY-SNAP.pdf'), 'longPress');
    fireEvent.press(getByText('BOARD-MINUTES.pdf'));
    fireEvent.press(getByLabelText('Album'));
    fireEvent.press(getByLabelText('pick-first-album'));

    // Back to where the move started from — it must now be empty.
    fireEvent.press(getByLabelText('chip-unfiled'));
    expect(queryByText('HOLIDAY-SNAP.pdf')).toBeNull();
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();

    // …and still present in the library view, because nothing was deleted.
    fireEvent.press(getByLabelText('chip-all'));
    expect(getByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
    expect(getByText('BOARD-MINUTES.pdf')).toBeTruthy();
  });

  it('B-607 r2 — with NO folders yet the default stays All, not an empty Unfiled', () => {
    const {getByLabelText, getByText} = render(<FilesScreen />);

    // Unfiled would be the whole library here, so the default must not change
    // for a user who has never made a folder.
    expect(getByLabelText('active-album-filter').props.children).toBe('ALL');
    expect(getByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
  });
});

describe('B-453 — the on-device Files browser is PIN gated', () => {
  it('B-453 — a locked vault sends the Files browser to the lock screen', () => {
    vaultGate.unlocked = false;
    vaultGate.hasPin = true;

    render(<FilesScreen />);

    expect(mockReplace).toHaveBeenCalledWith('VaultLock', {next: 'Files'});
  });

  it('B-453 — a first-time user is sent to PIN SETUP, never to an empty keypad', () => {
    vaultGate.unlocked = false;
    vaultGate.hasPin = false;

    render(<FilesScreen />);

    expect(mockReplace).toHaveBeenCalledWith('VaultNewPin', {next: 'Files'});
  });

  /**
   * The gate must return the user to the screen they asked for. Inside the
   * workspace shell FilesScreen is registered as 'MessengerHome' (the Vault
   * tab's root), so the return target differs — and getting it wrong is the
   * lock↔files ping-pong.
   */
  it('B-453 — inside the workspace shell it returns to the Vault tab root', () => {
    mockInShell.mockReturnValue(true);
    vaultGate.unlocked = false;

    render(<FilesScreen />);

    expect(mockReplace).toHaveBeenCalledWith('VaultLock', {next: 'MessengerHome'});
  });

  it('B-453 — an unlocked vault renders the files and redirects nowhere', async () => {
    vaultGate.unlocked = true;

    const {findByText} = render(<FilesScreen />);

    expect(await findByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  /**
   * ENTITLEMENT. The phone-files PIN must hold for every user, so the gate is
   * NOT routed through `openVault()` — that helper TierGates on the Cloud Vault
   * entitlement, which would bounce a Lite user to a paywall and leave their
   * on-device files ungated. `@store/entitlements` is mocked with
   * `hasCloudVault: false` here to prove the gate does not consult it.
   */
  it('B-453 — a user with NO cloud-vault entitlement is still gated', () => {
    jest.isolateModules(() => undefined);
    const ent = require('@store/entitlements') as {useEntitlements: () => unknown};
    const spy = jest.spyOn(ent, 'useEntitlements').mockReturnValue({isOrgAffiliated: false, hasCloudVault: false});
    vaultGate.unlocked = false;

    render(<FilesScreen />);

    expect(mockReplace).toHaveBeenCalledWith('VaultLock', {next: 'Files'});
    spy.mockRestore();
  });
});

/**
 * The gate's three blind spots, all of which leave real bytes readable.
 *
 * It only ever ran on FOCUS and on a foreground transition, so nothing at all
 * re-checked it while the user simply sat on the screen — and it answered from
 * an UNHYDRATED store, which is worse than not answering.
 */
describe('B-453 — the gate reacts to the lock, not only to navigation', () => {
  it('a relock under a focused screen re-gates immediately', () => {
    // `lock()` (BiometricGate's relock lands after an await, a later tick than
    // the AppState change) and the 5-minute window expiring both move the
    // deadline without any focus or foreground event. Before this, the screen
    // kept listing every attachment on the device.
    const {rerender} = render(<FilesScreen />);
    expect(mockReplace).not.toHaveBeenCalled();

    vaultGate.unlocked = false;
    rerender(<FilesScreen />);

    expect(mockReplace).toHaveBeenCalledWith('VaultLock', {next: 'Files'});
  });

  it('the list is NOT rendered while the gate is refusing', async () => {
    // `replace` animates; every frame of that transition showed the full index.
    vaultGate.unlocked = false;

    const {queryByText} = render(<FilesScreen />);

    expect(queryByText('HOLIDAY-SNAP.pdf')).toBeNull();
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
  });

  it('SECURITY — a pre-hydration mount routes NOWHERE (it must not clobber a real PIN)', () => {
    // Rehydration is async; until it lands `pinHash` reads as initialState's
    // null, which is indistinguishable from "this user has no PIN". Answering
    // in that window sends a real-PIN user to VaultNewPin, where a fresh
    // setupPin OVERWRITES the hash they cannot recover.
    vaultGate.hydrated = false;
    vaultGate.unlocked = false;
    vaultGate.hasPin = true;

    const {queryByText} = render(<FilesScreen />);

    expect(mockReplace).not.toHaveBeenCalled();
    // ...and it does not fall open either — the list stays hidden.
    expect(queryByText('HOLIDAY-SNAP.pdf')).toBeNull();
  });

  it('...and it answers as soon as hydration finishes', () => {
    vaultGate.hydrated = false;
    vaultGate.unlocked = false;
    vaultGate.hasPin = true;

    render(<FilesScreen />);
    expect(mockReplace).not.toHaveBeenCalled();

    // The screen must have SUBSCRIBED, or declining above is a permanent stall.
    expect(mockHydrationCbs.length).toBeGreaterThan(0);
    vaultGate.hydrated = true;
    for (const cb of [...mockHydrationCbs]) {cb();}

    expect(mockReplace).toHaveBeenCalledWith('VaultLock', {next: 'Files'});
  });
});
