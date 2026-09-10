/**
 * The shared channel opener — the FIRST test to import it.
 *
 * Round 3 fixed four things here (liveness, the spinner window, the alert
 * gating, the if/else split) and round 4 found that reverting any of them left
 * the suite green: nothing imported the module, and the only references were
 * source scans. Under this repo's contract that means none of them were fixed.
 *
 * Everything below is about the ASYNC WINDOW. `waitForMessengerReady` resolves
 * on a 4-second timeout when hydration never lands, so between the tap and the
 * navigate there is a window in which the user can leave, tap again, or lose
 * the network — and each of those was a defect.
 */
import React from 'react';
import {Text, TouchableOpacity} from 'react-native';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockAlert = jest.fn();
const mockEnsure = jest.fn();
const mockRuntime = jest.fn();
const mockReady = jest.fn();
let mockFocused = true;
let mockGroups: Record<string, {masterKeyB64?: string}>;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
  useIsFocused: () => mockFocused,
}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'me'}}),
}));
const mockReset = jest.fn().mockResolvedValue({});
jest.mock('@services/api', () => ({departmentApi: {resetGroup: (...a: unknown[]) => mockReset(...a)}}));
jest.mock('@/modules/messenger/orgWorkspace/provisionChannel', () => ({
  ensureChannelProvisioned: (...a: unknown[]) => mockEnsure(...a),
}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({groups: mockGroups})},
}));
jest.mock('@/modules/messenger/runtime', () => ({getMessengerRuntime: () => mockRuntime()}));
jest.mock('@/modules/messenger/hooks', () => ({waitForMessengerReady: () => mockReady()}));

import {useOpenDepartmentChannel} from '../openDepartmentChannel';

const CH = {
  id: 'ch1', name: 'Fort Hunter', description: null, my_role: 'viewer',
  post_mode: 'open', group_conversation_id: 'g1', created_by: 'someone',
};

/** A one-row harness so the hook is exercised through a real press. */
function Harness({channel = CH, onProvisioning}: {channel?: Record<string, unknown>; onProvisioning?: (id: string | null) => void}) {
  const open = useOpenDepartmentChannel({onProvisioning});
  return (
    <TouchableOpacity accessibilityLabel="row" onPress={() => { void open(channel as never); }}>
      <Text>row</Text>
    </TouchableOpacity>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  mockGroups = {g1: {masterKeyB64: 'k'}};
  mockRuntime.mockResolvedValue({});
  mockReady.mockResolvedValue(undefined);
});

describe('the async window', () => {
  it('opens the channel with isOwner and postMode', async () => {
    const u = render(<Harness />);
    fireEvent.press(u.getByLabelText('row'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'ch1', postMode: 'open', isOwner: false})));
  });

  it('does NOT navigate once the screen has lost focus', async () => {
    /**
     * The window is up to FOUR SECONDS. A member who taps a row and then
     * switches tabs, or drills into the tree, used to be yanked into a chat
     * from wherever they had gone — and the directory is a tab root, so React
     * Navigation never unmounts it and an unmount-only guard missed all of it.
     */
    let release!: () => void;
    mockReady.mockReturnValue(new Promise<void>(r => { release = r; }));
    const u = render(<Harness />);
    fireEvent.press(u.getByLabelText('row'));
    mockFocused = false;
    u.rerender(<Harness />);
    await act(async () => { release(); });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the spinner for the WHOLE wait, not just the provisioning part', async () => {
    // The spinner used to start after both awaits, so the 0-4s hydration wait
    // left the row enabled and visually inert — the "tap registers late"
    // symptom, manufactured.
    let release!: () => void;
    mockReady.mockReturnValue(new Promise<void>(r => { release = r; }));
    const seen: Array<string | null> = [];
    const u = render(<Harness onProvisioning={id => seen.push(id)} />);
    fireEvent.press(u.getByLabelText('row'));
    expect(seen).toEqual(['ch1']);
    await act(async () => { release(); });
    expect(seen).toEqual(['ch1', null]);
  });

  it('a REJECTING runtime clears the spinner and says so — it does not kill the row', async () => {
    /**
     * `getMessengerRuntime` rejects on an offline cold boot and after a wipe.
     * With no catch the rejection escaped into `void onPress(…)`, the clear
     * never ran, and the row kept its spinner and its `disabled` for the life
     * of the screen: dead, silent, unrecoverable — and reachable precisely when
     * the screen is showing its offline retry strip.
     */
    mockRuntime.mockRejectedValue(new Error('offline'));
    const seen: Array<string | null> = [];
    const u = render(<Harness onProvisioning={id => seen.push(id)} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    expect(seen).toEqual(['ch1', null]);
    // The channel NAME is load-bearing: these alerts are on an app-global queue
    // and can surface on another screen, where 'Network request failed' alone
    // tells the user nothing about which channel failed.
    expect(mockAlert).toHaveBeenCalledWith('Could not open channel', 'Fort Hunter: offline');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a SECOND tap during the wait is dropped, not queued', async () => {
    // Two chains in flight both reached navigate, and the second's spinner
    // clear stopped the first's. Without a per-channel route key the second
    // navigate only swapped params on the mounted chat, which keeps its group
    // id in state — so the header renamed itself while the transcript, and
    // every message sent, stayed on the first channel's Signal group.
    let release!: () => void;
    mockReady.mockReturnValue(new Promise<void>(r => { release = r; }));
    const u = render(<Harness />);
    fireEvent.press(u.getByLabelText('row'));
    fireEvent.press(u.getByLabelText('row'));
    await act(async () => { release(); });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('provisioning SUCCESS does not fire the failure alert', async () => {
    // Splitting the if/else-if chain to slip the liveness check in turned its
    // trailing `else` into a catch-all that alerted on success.
    mockEnsure.mockResolvedValue({status: 'ok', groupConversationId: 'gNew'});
    const u = render(<Harness channel={{...CH, group_conversation_id: null, my_role: 'admin'}} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({groupConversationId: 'gNew'}));
  });

  it('a key-less OWNER is offered recovery instead of a silently dead thread', async () => {
    mockGroups = {};
    const u = render(<Harness channel={{...CH, created_by: 'me'}} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    expect(mockAlert).toHaveBeenCalledWith('Reactivate channel?', expect.any(String), expect.any(Array));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('the LATCH holds: coming back mid-wait does not resurrect the navigate', async () => {
    // `alive` re-arms on focus, so tap → switch tab → switch back inside the
    // 4s window restored exactly the state the guard exists to catch, and the
    // user was teleported anyway. Abandoned means abandoned.
    let release!: () => void;
    mockReady.mockReturnValue(new Promise<void>(r => { release = r; }));
    const u = render(<Harness />);
    fireEvent.press(u.getByLabelText('row'));
    mockFocused = false;
    u.rerender(<Harness />);
    mockFocused = true;
    u.rerender(<Harness />);
    await act(async () => { release(); });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a key-less NON-owner still opens — recovery is the owner\'s to do', async () => {
    // Re-share cannot rescue an owner; for everyone else the key can still
    // arrive, and blocking the door would strand them with no route at all.
    mockGroups = {};
    const u = render(<Harness />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    expect(mockNavigate).toHaveBeenCalled();
  });
});

describe('recoverChannel — the destructive path, which nothing covered', () => {
  /** Confirm the "Reactivate channel?" alert the opener raises. */
  const confirmReactivate = async () => {
    const buttons = mockAlert.mock.calls.at(-1)?.[2] as Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => b.text === 'Reactivate');
    expect(go).toBeTruthy();
    await act(async () => { go?.onPress?.(); });
  };

  beforeEach(() => { mockGroups = {}; });

  it('reports SUCCESS even when the screen is gone — the transcript is destroyed either way', async () => {
    /**
     * The navigate IS the success report, so leaving the screen removed the
     * only feedback from the most common outcome. `resetGroup` has already made
     * every earlier message in the channel permanently unreadable for every
     * member by then; silence is not an option a confirmed destructive action
     * gets.
     */
    mockEnsure.mockResolvedValue({status: 'ok', groupConversationId: 'gNew'});
    const u = render(<Harness channel={{...CH, created_by: 'me'}} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    mockFocused = false;
    u.rerender(<Harness channel={{...CH, created_by: 'me'}} />);
    await confirmReactivate();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Channel reactivated',
      expect.stringContaining('Fort Hunter'));
  });

  it('needs_members does NOT wear a success title', async () => {
    // The history is gone and nothing was re-keyed; "Channel reactivated" over
    // that is a lie the owner has no way to check.
    mockEnsure.mockResolvedValue({status: 'needs_members'});
    const u = render(<Harness channel={{...CH, created_by: 'me'}} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    await confirmReactivate();
    expect(mockAlert).toHaveBeenCalledWith('Channel reset',
      expect.stringContaining('unreadable'));
  });

  it('a SECOND reactivate is refused while the first is still running', async () => {
    /**
     * THE DESTRUCTIVE RACE. `recoverChannel` runs from an Alert button, long
     * after the press — by which time the opener's `finally` had released the
     * in-flight flag and cleared the spinner, re-enabling the row mid-recovery.
     * A second tap saw the stale key-less dto, prompted again, and ran a second
     * `resetGroup` that destroyed the group the first had just minted and
     * re-keyed members into.
     */
    let release!: (v: unknown) => void;
    mockEnsure.mockReturnValue(new Promise(r => { release = r; }));
    const u = render(<Harness channel={{...CH, created_by: 'me'}} />);
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    await confirmReactivate();
    expect(mockReset).toHaveBeenCalledTimes(1);
    // The row is live again as far as the DOM is concerned — press it, and
    // CONFIRM the prompt. Stopping at the press proved nothing: the opener only
    // RAISES a second alert, and it is confirming that alert which would fire
    // the second destructive reset. (Verified: without the guard this reaches
    // two.)
    await act(async () => { fireEvent.press(u.getByLabelText('row')); });
    if (mockAlert.mock.calls.at(-1)?.[0] === 'Reactivate channel?') {
      await confirmReactivate();
    }
    expect(mockReset).toHaveBeenCalledTimes(1);
    await act(async () => { release({status: 'ok', groupConversationId: 'gNew'}); });
  });
});
