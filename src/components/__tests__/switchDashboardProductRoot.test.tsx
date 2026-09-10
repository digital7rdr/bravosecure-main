/**
 * B-393 — the SWITCH DASHBOARD row for the product you are ALREADY in was a
 * silent no-op.
 *
 * `switchProduct` only writes `activeProduct`, and MainNavigator keys the whole
 * client tab tree on that value. Re-selecting the same product therefore wrote
 * the value it already held: no remount, so `SecureTab`'s `initialParams` never
 * re-applied, and the drawer simply closed on the screen the user was already
 * looking at. Founder repro: Secure Services → drawer → "Secure Services"
 * (marked CURRENT) → still the "Book Close Protection" booking hero, never the
 * product root.
 *
 * B-390 fixed where a real product SWITCH lands. This pins the same landing rule
 * for the non-switch, and it is asserted by RENDERING the control and pressing
 * the row — the previous pin was a source scan of MainNavigator, which cannot
 * see that the drawer never reaches MainNavigator's decision at all.
 *
 * PDF-1 #1 update: the secure product root is now the tier resolver
 * `SecureLanding` (PRO→ProDashboard, LITE→the Wave 5d 4-tab shell `SecureShell`),
 * not the `SecureServices` plan chooser. The drawer's same-product tap must name
 * that new root, in lock step with MainNavigator's initialParams. The truncation
 * guard keys on the concrete tier home — `ProDashboard` for PRO, `SecureShell`
 * for LITE — which is the route the resolver actually seeds.
 */
import React from 'react';
import {Text} from 'react-native';
import {render, fireEvent, act} from '@testing-library/react-native';
import {useProductStore, type BravoProduct} from '@store/productStore';
import {SwitchDashboardSection} from '@components/SwitchDashboardSection';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
}));

const mockAlert = jest.fn();
const mockHasLiveCall = jest.fn(() => false);
const mockSetMinimized = jest.fn();
const mockSetGroupMinimized = jest.fn();
jest.mock('@/modules/messenger/runtime/callResumeGuard', () => ({hasLiveCall: () => mockHasLiveCall()}));
/**
 * THE DOUBLES MUST CARRY `getActiveCall` / `getActiveGroupCall`.
 *
 * `minimiseLiveCall` was rewritten by CALL_RACE WI-1.1/1.5 to be IDENTITY-KEYED:
 * it reads the live entry's own key and calls `setMinimized({callId, gen}, true)`
 * / `setGroupCallMinimized(roomId, true)`. It wraps each registry in its own
 * try/catch so a routing convenience can never kill the switch it protects — so
 * a double missing the getter throws a TypeError that is SWALLOWED, the minimise
 * silently no-ops, and this suite reports "0 calls" against a production path
 * that is actually correct.
 *
 * That is CLAUDE.md's recorded trap verbatim: "a mock that does not mutate the
 * registry cannot see either… model the real callback's side effects, or the pin
 * is decorative." Assert the KEYED shape, so a caller that drops back to a bare
 * boolean fails here instead of type-checking as a no-op.
 */
const LIVE_CALL = {callId: 'call-1', gen: 7};
const LIVE_ROOM = {roomId: 'room-1'};
jest.mock('@/modules/messenger/runtime/callRegistry', () => ({
  getActiveCall: () => LIVE_CALL,
  setMinimized: (ref: unknown, v: boolean) => mockSetMinimized(ref, v),
}));
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => ({
  getActiveGroupCall: () => LIVE_ROOM,
  setGroupCallMinimized: (roomId: string, v: boolean) => mockSetGroupMinimized(roomId, v),
}));
const mockConfirmSwitch = jest.fn((_dest: string, onYes: () => void) => { onYes(); });
jest.mock('@utils/alert', () => ({
  // Lazy, like `confirmSwitchDashboard` below it. `jest.mock` is hoisted above
  // `const mockAlert`, so capturing the fn BY VALUE here binds whatever the
  // name held when the factory ran. That was survivable only while nothing
  // imported '@utils/alert' at module load: the factory ran late, from inside a
  // test, by which time the const existed. The moment a module under test
  // imports it at the top level the factory runs during that import and binds
  // `undefined`, and every assertion dies on "Alert.alert is not a function".
  Alert: {alert: (...args: unknown[]) => mockAlert(...args)},
  // vs2 item 18 — the cross-product switch confirms first. Auto-accepting keeps
  // every EXISTING assertion about what a switch does; the confirm itself is
  // asserted separately below.
  confirmSwitchDashboard: (dest: string, onYes: () => void) => mockConfirmSwitch(dest, onYes),
}));

// Default: nothing stacked above the product root, so the landing is a plain
// push and no guard fires. Individual tests flip it.
const mockHasRoutesAbove = jest.fn((_route: string) => false);
jest.mock('@navigation/navigationRef', () => ({
  mountedStackHasRoutesAbove: (r: string) => mockHasRoutesAbove(r),
}));

/** Press the "Continue" (destructive) button of the last Alert raised. */
function pressAlertContinue() {
  const buttons = mockAlert.mock.calls[0][2] as Array<{text: string; onPress?: () => void}>;
  const go = buttons.find(b => b.text === 'Continue');
  expect(go).toBeDefined();
  act(() => { go?.onPress?.(); });
}

// Dirty on purpose: the unfinished-booking confirm must NOT fire for a
// same-product tap, because nothing is being left and the draft survives.
const mockDraftDirty = jest.fn(() => true);
jest.mock('@store/bookingStore', () => ({isBookingDraftDirty: () => mockDraftDirty()}));

// PDF-1 #1 — the secure product root is now tier-dependent, so the same-product
// truncation guard reads the Pro application from the store. Control it per test;
// default LITE (no application) → the guard asks about SecureShell (Wave 5d).
let mockProApplication: {status: string} | null = null;
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: {getState: () => ({application: mockProApplication})},
}));

/** Row labels come from PRODUCT_LABELS via `Switch to ${label}`. */
const ROW: Record<BravoProduct, string> = {
  messenger: 'Switch to Messenger',
  secure: 'Switch to Secure Services',
  vbg: 'Switch to Virtual Bodyguard',
};

function setProduct(p: BravoProduct, returnProduct: BravoProduct | null = null) {
  useProductStore.setState({
    activeProduct: p, pendingProduct: null, gateVisible: false, returnProduct,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations — a `mockReturnValue`
  // set by one test would otherwise leak into every test after it.
  mockDraftDirty.mockReturnValue(true);
  mockHasRoutesAbove.mockReturnValue(false);
  mockProApplication = null;   // default: LITE client
  setProduct('secure');
});

describe('B-393 — selecting the product you are already in lands on its root', () => {
  it('secure → "Secure Services" navigates to the tier resolver (SecureLanding)', () => {
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // THE REQUIREMENT. Before the fix this array was empty — the press wrote
    // activeProduct='secure' over activeProduct='secure' and nothing moved.
    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });

  it('messenger → "Messenger" navigates to the messenger root', () => {
    setProduct('messenger');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.messenger));

    // Same defect, different product: from ProfileTab inside the messenger
    // product this row was equally dead.
    expect(mockNavigate).toHaveBeenCalledWith(
      'MessengerTab', {screen: 'MessengerHome', initial: false},
    );
  });

  it('vbg → "Virtual Bodyguard" navigates to the VBG dashboard', () => {
    setProduct('vbg');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.vbg));

    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'VBGHome', initial: false},
    );
  });

  /**
   * Every same-product nesting carries `initial: false` (R11-1). For
   * SecureLanding that is load-bearing — it keeps BookingHome beneath the tier
   * resolver so the resolver's Lite `pop()` reveals it and it is the Pro back
   * target. For the two leaves that ARE their stack's root it is inert, and
   * asserted anyway so a future edit cannot drop it from one branch unnoticed.
   */
  it('carries initial:false at EVERY branch, never re-rooting a lazy stack', () => {
    for (const p of ['messenger', 'secure', 'vbg'] as BravoProduct[]) {
      mockNavigate.mockClear();
      setProduct(p);
      const ui = render(<SwitchDashboardSection />);
      fireEvent.press(ui.getByLabelText(ROW[p]));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate.mock.calls[0][1]).toMatchObject({initial: false});
      ui.unmount();
    }
  });
});

describe('B-393 — a same-product tap is not a switch, and must not act like one', () => {
  it('does NOT raise the unfinished-booking discard confirm', () => {
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // The draft mock says DIRTY. Asking "leave Secure Services and discard it?"
    // while staying inside Secure Services is both untrue and destructive.
    expect(mockDraftDirty).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalled();
  });

  /**
   * The branch must key on the STORE's `activeProduct`, never on
   * `surface ?? activeProduct` (which is only what badges a row CURRENT).
   *
   * Swapping the two survived the whole render suite, because no host passes
   * `surface` today — so nothing here could tell them apart. It matters: the
   * client shell is keyed on `activeProduct`, so with surface='messenger' and
   * activeProduct='secure', tapping Messenger IS a real switch that must
   * remount the shell. Treating it as a same-product tap would navigate to
   * MessengerTab while leaving the shell mounted on Secure.
   */
  it('keys on the store, not on the `surface` prop', () => {
    // Clean draft: otherwise the real cross-product switch legitimately stops
    // at the B-91 M3 R5 discard confirm and never reaches `switchProduct`,
    // which would make this assert the wrong thing for the wrong reason.
    mockDraftDirty.mockReturnValue(false);
    setProduct('secure');
    const onSwitched = jest.fn();
    const ui = render(<SwitchDashboardSection surface="messenger" onSwitched={onSwitched} />);

    fireEvent.press(ui.getByLabelText(ROW.messenger));

    // messenger !== activeProduct('secure') → a REAL switch, not a navigate.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useProductStore.getState().activeProduct).toBe('messenger');
    expect(onSwitched).toHaveBeenCalledWith('messenger');
  });

  it('still takes the same-product path for the STORE product under a surface', () => {
    mockDraftDirty.mockReturnValue(false);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection surface="messenger" />);

    // 'secure' IS activeProduct even though the CURRENT badge sits on Messenger.
    fireEvent.press(ui.getByLabelText(ROW.secure));

    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });

  it('leaves B-352 returnProduct intact', () => {
    // Arrived at Secure from the VBG dashboard: back at the Secure root must
    // still return to VBG. `setActiveProduct` would have cleared this.
    //
    // CLEAN draft on purpose. With a dirty one the pre-fix code stopped at the
    // discard confirm and never reached `switchProduct`, so returnProduct
    // survived by accident and this assertion passed on the BROKEN code — a pin
    // that is green for the wrong reason is not a pin.
    mockDraftDirty.mockReturnValue(false);
    setProduct('secure', 'vbg');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    expect(useProductStore.getState().returnProduct).toBe('vbg');
    expect(useProductStore.getState().activeProduct).toBe('secure');
  });
});

/**
 * The landing is `navigate`, not `push`. React Navigation's StackRouter pops
 * back to an existing route of that name, dropping everything above it — and
 * `SecureProApplyScreen` holds all fifteen of its fields in local `useState`
 * with no store and no `beforeRemove`, so that pop is unrecoverable. Confirm
 * ONLY in that case; the founder's primary path must stay one tap.
 */
describe('B-393 — the landing never silently truncates a stack', () => {
  it('confirms first when the product root has screens stacked above it', () => {
    mockHasRoutesAbove.mockReturnValue(true);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // PDF-1 #1 / Wave 5d — the guard asks about the concrete tier home
    // (SecureShell for a LITE client, the default here), NOT the transient
    // SecureLanding resolver.
    expect(mockHasRoutesAbove).toHaveBeenCalledWith('SecureShell');
    expect(mockAlert).toHaveBeenCalled();
    // Nothing moves until the user says so.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('lands only after the user confirms', () => {
    mockHasRoutesAbove.mockReturnValue(true);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));
    pressAlertContinue();

    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });

  it('"Stay" cancels — the cancel button carries no handler at all', () => {
    mockHasRoutesAbove.mockReturnValue(true);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    const buttons = mockAlert.mock.calls[0][2] as Array<{text: string; onPress?: () => void}>;
    expect(buttons.find(b => b.text === 'Stay')?.onPress).toBeUndefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT confirm on the founder path, where the landing is a push', () => {
    mockHasRoutesAbove.mockReturnValue(false);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // One tap, no dialog — this is BookingHome -> drawer -> Secure Services.
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('asks about the RIGHT route for each product (secure = the LITE shell by default)', () => {
    for (const [p, root] of [
      ['messenger', 'MessengerHome'], ['secure', 'SecureShell'], ['vbg', 'VBGHome'],
    ] as Array<[BravoProduct, string]>) {
      mockHasRoutesAbove.mockClear();
      setProduct(p);
      const ui = render(<SwitchDashboardSection />);
      fireEvent.press(ui.getByLabelText(ROW[p]));
      expect(mockHasRoutesAbove).toHaveBeenCalledWith(root);
      ui.unmount();
    }
  });

  it('a PRO client guards the SAME home as a LITE one (B-661 re-point of PDF-1 #1)', () => {
    /**
     * The invariant is unchanged: the truncation guard must key on the route the
     * client's home ACTUALLY is, or it fires a spurious confirm for someone
     * sitting on their own dashboard.
     *
     * What changed is the answer. Before B-661 an ACTIVE plan rooted at
     * `ProDashboard` and a LITE one at `SecureShell`, so this asked about
     * `ProDashboard`. The founder reversed that on 2026-08-25 ("it should be for
     * lite and pro version both"): every tier now roots at the shell, and the
     * tier only decides what the shell's Home TAB renders. So the guard asks
     * about `SecureShell` for everyone — and the two tiers can no longer
     * disagree about which route is "home", which is the class of bug that made
     * one phone show a footer and another not.
     */
    mockProApplication = {status: 'ACTIVE'};
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    expect(mockHasRoutesAbove).toHaveBeenCalledWith('SecureShell');
    // The tier must not resurrect a second home route.
    expect(mockHasRoutesAbove).not.toHaveBeenCalledWith('ProDashboard');
    // The navigate target is still the resolver — the tier decision lives there.
    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });
});

describe('B-393 — the real cross-product switch is untouched', () => {
  it('messenger → Secure Services still switches the shell and does NOT navigate', () => {
    setProduct('messenger');
    const onSwitched = jest.fn();
    const ui = render(<SwitchDashboardSection onSwitched={onSwitched} />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // The keyed remount + SecureTab initialParams own this path (B-390/B-95).
    // Navigating on top of it would fight the one-frame unmount hold.
    expect(useProductStore.getState().activeProduct).toBe('secure');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onSwitched).toHaveBeenCalledWith('secure');
  });

  it('leaving secure with a dirty draft still confirms first', () => {
    setProduct('secure');
    const onSwitched = jest.fn();
    const ui = render(<SwitchDashboardSection onSwitched={onSwitched} />);

    fireEvent.press(ui.getByLabelText(ROW.vbg));   // secure -> vbg = a real switch

    expect(mockAlert).toHaveBeenCalled();
    // Held at the confirm: the product must not change until "Leave" is pressed.
    expect(useProductStore.getState().activeProduct).toBe('secure');
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('a host guard still vetoes, for a switch AND for a same-product tap', () => {
    setProduct('secure');
    const ui = render(<SwitchDashboardSection guard={() => false} />);

    fireEvent.press(ui.getByLabelText(ROW.secure));
    fireEvent.press(ui.getByLabelText(ROW.vbg));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useProductStore.getState().activeProduct).toBe('secure');
  });
});

describe('B-393 — drawer choreography', () => {
  afterEach(() => jest.useRealTimers());

  it('closes the host drawer BEFORE navigating underneath it', () => {
    jest.useFakeTimers();
    setProduct('secure');
    const onSwitched = jest.fn();
    const ui = render(<SwitchDashboardSection onSwitched={onSwitched} />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // Navigating while the RN Modal is still up leaves the destination behind a
    // native dialog on Android. Close first, land after the fade.
    expect(onSwitched).toHaveBeenCalledWith('secure');
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(220); });
    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });

  /**
   * Pins the DURATION, not merely "deferred to a macrotask".
   *
   * The assertion above survives `DRAWER_FADE_MS = 0` — under fake timers a
   * 0 ms timer is equally uncalled until the clock is advanced, so it proved
   * nothing about the value. The whole point of the constant is to outlast the
   * host drawer's fade; a 0 ms delay navigates underneath a fully visible
   * Modal, which on Android leaves the destination behind a native dialog.
   */
  it('waits the FULL drawer fade, not just a tick', () => {
    jest.useFakeTimers();
    setProduct('secure');
    const ui = render(<SwitchDashboardSection onSwitched={jest.fn()} />);

    fireEvent.press(ui.getByLabelText(ROW.secure));

    act(() => { jest.advanceTimersByTime(219); });
    expect(mockNavigate).not.toHaveBeenCalled();   // RED at DRAWER_FADE_MS = 0

    act(() => { jest.advanceTimersByTime(1); });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('navigates immediately when there is no drawer to close', () => {
    jest.useFakeTimers();
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);   // ProfileScreen's usage

    fireEvent.press(ui.getByLabelText(ROW.secure));

    // No 220ms of dead time on a plain list row.
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('still fires after the host has unmounted the drawer subtree', () => {
    jest.useFakeTimers();
    setProduct('secure');
    const ui = render(<SwitchDashboardSection onSwitched={jest.fn()} />);

    fireEvent.press(ui.getByLabelText(ROW.secure));
    // RN's Modal renders null while hidden, so this control unmounts the moment
    // the host closes — the pending navigate must survive that.
    ui.unmount();
    act(() => { jest.advanceTimersByTime(220); });

    expect(mockNavigate).toHaveBeenCalledWith(
      'SecureTab', {screen: 'SecureLanding', initial: false},
    );
  });
});

/**
 * vs2 item 18 — the two behaviours the auto-accepting mock above would
 * otherwise hide.
 */
describe('vs2 item 18 — the switch confirms, and never strands a call', () => {
  beforeEach(() => { mockDraftDirty.mockReturnValue(false); });

  it('a cross-product switch ASKS first, and does nothing until Yes', () => {
    mockConfirmSwitch.mockImplementationOnce(() => { /* user has not answered */ });
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);
    fireEvent.press(ui.getByLabelText(ROW.messenger));
    expect(mockConfirmSwitch).toHaveBeenCalledWith('Messenger', expect.any(Function));
    // Not switched — the dialog is still open.
    expect(useProductStore.getState().activeProduct).toBe('secure');
  });

  it('a SAME-product tap does not ask — it is not a switch', () => {
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);
    fireEvent.press(ui.getByLabelText(ROW.secure));
    expect(mockConfirmSwitch).not.toHaveBeenCalled();
  });

  it('minimises a live call on EVERY cross-product path, including the booking one', () => {
    /**
     * `switchProduct` is a plain store write and the shell is keyed on it, so
     * the remount never dispatches `beforeRemove`. A full-screen call is
     * destroyed; a MINIMISED one survives in the overlay with its End button.
     *
     * The booking branch is the one that matters: the overlay's orphan rescue
     * is 1:1-only, so that path was the single way to strand a live GROUP call
     * with no End button and no way back — and it was the path the first
     * version of this fix skipped.
     */
    mockHasLiveCall.mockReturnValue(true);

    setProduct('secure');
    render(<SwitchDashboardSection />).getByLabelText(ROW.messenger);
    fireEvent.press(render(<SwitchDashboardSection />).getByLabelText(ROW.messenger));
    expect(mockSetMinimized).toHaveBeenCalledWith({callId: 'call-1', gen: 7}, true);
    expect(mockSetGroupMinimized).toHaveBeenCalledWith('room-1', true);

    // …and again down the dirty-booking branch.
    jest.clearAllMocks();
    mockHasLiveCall.mockReturnValue(true);
    mockDraftDirty.mockReturnValue(true);
    setProduct('secure');
    const ui = render(<SwitchDashboardSection />);
    fireEvent.press(ui.getByLabelText(ROW.messenger));
    const leave = (mockAlert.mock.calls.at(-1)?.[2] as Array<{text: string; onPress?: () => void}>)
      ?.find(b => b.text === 'Leave');
    expect(leave).toBeTruthy();
    leave?.onPress?.();
    expect(mockSetMinimized).toHaveBeenCalledWith({callId: 'call-1', gen: 7}, true);
    expect(mockSetGroupMinimized).toHaveBeenCalledWith('room-1', true);
  });
});

/**
 * Founder, 2026-08-21: the drawer's SWITCH DASHBOARD shows a fourth row
 * (Workspaces / Channels) and the Profile screen's copy of the same section
 * did not — the same menu answered differently depending on how it was opened.
 *
 * The drawer supplies that row as MARKUP (`extraRow`, pinned by drawerItem18);
 * a host with no row styling of its own supplies it as DATA and this section
 * draws it, so the two can never diverge visually. It leaves the surface, so
 * it confirms first exactly like the drawer's hand-wired copy.
 */
describe('extraRowData — the workspace row a non-drawer host supplies', () => {
  const wsRow = {
    icon: 'forum' as const,
    label: 'Workspaces',
    pill: 'ENTERPRISE',
    go: jest.fn(),
  };

  beforeEach(() => { wsRow.go.mockClear(); });

  it('renders the row, with its pill in the accessibility label', () => {
    const ui = render(<SwitchDashboardSection extraRowData={wsRow} />);
    expect(ui.getByLabelText('Workspaces, ENTERPRISE')).toBeTruthy();
  });

  it('confirms before leaving, and only then runs go', () => {
    const ui = render(<SwitchDashboardSection extraRowData={wsRow} />);
    fireEvent.press(ui.getByLabelText('Workspaces, ENTERPRISE'));
    // The shared confirm, not a bare navigate — same contract as the drawer.
    expect(mockConfirmSwitch).toHaveBeenCalledWith('Workspaces', expect.any(Function));
    expect(wsRow.go).toHaveBeenCalledTimes(1); // the harness auto-accepts
  });

  it('data wins over markup, so a host cannot render the row twice', () => {
    const ui = render(
      <SwitchDashboardSection
        extraRowData={wsRow}
        extraRow={<Text accessibilityLabel="legacy-extra-row">legacy</Text>}
      />,
    );
    expect(ui.getByLabelText('Workspaces, ENTERPRISE')).toBeTruthy();
    expect(ui.queryByLabelText('legacy-extra-row')).toBeNull();
  });
});
