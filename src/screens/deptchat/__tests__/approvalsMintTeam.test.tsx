/**
 * Q14 (founder, 2026-08-08) — the multi-use REFERRAL-LINK lane is retired.
 *
 * A referral code was never consumed on use: any number of people could apply
 * with one code and the code never disappeared from the admin's screen — both
 * reported as bugs. Direct invites (bound to one person, single-use, atomically
 * claimed server-side) are now the ONLY mint lane, so this file pins:
 *
 *   1. ApprovalsScreen renders NO referral mint affordance and never calls the
 *      referral endpoints — the direct-invite entry is what renders instead.
 *   2. The team picker moved WITH the mint into InviteMemberScreen, and the
 *      R9-3 stale-closure lesson moves with it: a source scan on
 *      `team_channel_id: teamId` stays green while the VALUE is stale, so the
 *      pick→mint interaction is driven for real and the wire body asserted.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockCreateInvite = jest.fn();
const mockListPending = jest.fn();
const mockListManaged = jest.fn();
const mockListInvites = jest.fn();
const mockCreateLink = jest.fn();
const mockListLinks = jest.fn();

// DIAL_CODES rides along: InviteMemberScreen imports phoneNormalize, whose
// module-level KNOWN_CALLING_CODES maps over it at require time.
jest.mock('@utils/constants', () => ({
  API_BASE_URL: 'https://example.invalid',
  DIAL_CODES: [{code: 'BD', dial: '+880', digits: 10}, {code: 'US', dial: '+1', digits: 10}],
}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
// `useKeyboardOverlap` is needed too: the invite form is wrapped in
// KeyboardAvoidingScreen (client review vs2 item 3), which reads it.
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
}));
// deptNoun reads the auth store, which drags expo-local-authentication (ESM)
// into a node test — the noun VALUE is irrelevant to what this file pins.
jest.mock('../deptNoun', () => ({
  deptMemberNoun: () => 'Member',
  deptEmployeeNoun: () => 'Member',
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+8801711111111'}}),
}));
// Q13 — the in-app contact picker's deps: the hook would touch expo-contacts
// and the users lookup; neither belongs in this test (picker stays closed).
jest.mock('@/modules/messenger/contacts/useDiscoveredContacts', () => ({
  useDiscoveredContacts: () => ({permission: 'unknown', loading: false, error: null, matches: [], refresh: jest.fn()}),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
// Mock the REAL method names and the REAL `{data: {...}}` envelope (the
// invented-payload trap: a wrong name silently exercises the empty branch).
// The referral methods stay mocked so a resurrected call FAILS the "never
// called" assertions instead of throwing into the screen's try/catch.
jest.mock('@services/api', () => ({
  enterpriseApi: {
    createInvite: (...a: unknown[]) => mockCreateInvite(...a),
    createReferralLink: (...a: unknown[]) => mockCreateLink(...a),
    listReferralLinks: () => mockListLinks(),
    revokeReferralLink: jest.fn(),
    listJoinRequests: () => mockListPending(),
    approveJoinRequest: jest.fn(),
    declineJoinRequest: jest.fn(),
    listInvites: () => mockListInvites(),
    revokeInvite: jest.fn(),
  },
  departmentApi: {listManagedChannels: () => mockListManaged()},
  tokenStore: {get: () => null},
}));

import ApprovalsScreen from '../ApprovalsScreen';
import InviteMemberScreen from '../InviteMemberScreen';

/** Must survive the picker's filter: not archived, not broadcast, not
 *  restricted, not an incident channel. */
const team = (id: string, name: string) => ({
  id, name, channel_type: 'department', level: 2,
  archived: false, is_broadcast: false, access: 'open',
});
const TEAM_A = team('ch-a', 'Alpha Team');
const TEAM_B = team('ch-b', 'Bravo Team');
/** Negative fixtures — each must be filtered OUT of the picker. */
const ARCHIVED = {...team('ch-x', 'Retired Team'), archived: true};
const BROADCAST = {...team('ch-y', 'Announcements'), is_broadcast: true};
const RESTRICTED = {...team('ch-z', 'Locked Team'), access: 'restricted'};
const INCIDENT = {...team('ch-i', 'Incident Room'), channel_type: 'incident'};

beforeEach(() => {
  jest.clearAllMocks();
  mockListPending.mockResolvedValue({data: {requests: []}});
  mockListManaged.mockResolvedValue({data: {channels: [TEAM_A, TEAM_B]}});
  mockListInvites.mockResolvedValue({data: {invites: []}});
  mockCreateInvite.mockResolvedValue({data: {code: 'ABC123', expires_at: null}});
});

describe('Q14 — the referral-code lane is gone from Approvals', () => {
  it('renders no referral mint affordance; the direct-invite entry renders instead', async () => {
    const {findByLabelText, queryByLabelText} = render(<ApprovalsScreen />);
    expect(await findByLabelText('Invite by phone or email')).toBeTruthy();
    expect(queryByLabelText('Create an invite code')).toBeNull();
    expect(queryByLabelText('Create a new invite code')).toBeNull();
  });

  it('never calls the referral endpoints on load', async () => {
    const {findByLabelText} = render(<ApprovalsScreen />);
    await findByLabelText('Invite by phone or email');
    expect(mockCreateLink).not.toHaveBeenCalled();
    expect(mockListLinks).not.toHaveBeenCalled();
  });
});

describe('Item E — the direct-invite mint carries the picked team (R9-3 heir)', () => {
  const fillPhone = async (utils: ReturnType<typeof render>) => {
    fireEvent.changeText(
      await utils.findByPlaceholderText('Phone number (with country code)'),
      '+8801712345678');
  };

  it('picking a team then Create sends that team_channel_id', async () => {
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText(`Join team ${TEAM_B.name}`));
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: TEAM_B.id, contact_phone: '+8801712345678'}));
  });

  it('changing the pick before Create sends the LATEST team, not the first', async () => {
    // The stale closure is a staleness bug, so one pick could pass by luck if
    // the callback happened to be recreated. Two picks cannot.
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText(`Join team ${TEAM_A.name}`));
    fireEvent.press(await utils.findByLabelText(`Join team ${TEAM_B.name}`));
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: TEAM_B.id}));
  });

  it('archived, broadcast, restricted and incident channels are NOT offerable', async () => {
    /**
     * RE-ANCHORED by vs2 item 2 — and STRENGTHENED, not relaxed.
     *
     * "Not offerable" used to mean "absent from the list". The picker now groups
     * rows into a tree, and removing a row before grouping deletes a restricted
     * ORGANISATION ROOT and promotes its children to top-level organisations —
     * the flat pile item 2 exists to kill. So the rule became group-first,
     * disable-second: the three still render, greyed, and cannot be selected.
     *
     * Absence proved only that no row carried the label. Asserting the disabled
     * state AND that pressing it does not select is a strictly stronger claim:
     * it would still fail if the row became live again, which is the regression
     * that actually matters.
     *
     * TWO exceptions stay fully ABSENT rather than greyed:
     *   - a #broadcast, which is not a node of the tree at all;
     *   - an ARCHIVED channel. The group-first rule needs the dropped row to
     *     have live children, and an archived row cannot have any (archive
     *     refuses while an active non-broadcast child exists, and create refuses
     *     an archived parent), so it is always a leaf among live rows. Keeping
     *     them would grow the picker monotonically with dead entries.
     */
    mockListManaged.mockResolvedValue({
      data: {channels: [TEAM_A, ARCHIVED, BROADCAST, RESTRICTED, INCIDENT]},
    });
    const utils = render(<InviteMemberScreen />);
    // Positive anchor first — otherwise every absence below passes while the
    // list simply has not rendered.
    expect(await utils.findByLabelText(`Join team ${TEAM_A.name}`)).toBeTruthy();

    for (const gone of [BROADCAST, ARCHIVED]) {
      expect(utils.queryByLabelText(`Join team ${gone.name}`)).toBeNull();
    }

    for (const c of [RESTRICTED, INCIDENT]) {
      const row = utils.getByLabelText(`Join team ${c.name}`);
      expect(row.props.accessibilityState).toMatchObject({disabled: true});
      fireEvent.press(row);
    }
    // None of those presses may have selected anything: submit must still omit
    // the field entirely.
    fireEvent.changeText(
      await utils.findByPlaceholderText('Phone number (with country code)'),
      '+8801712345678');
    fireEvent.press(await utils.findByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect('team_channel_id' in (mockCreateInvite.mock.calls[0][0] as Record<string, unknown>))
      .toBe(false);
  });

  it('with NO team picked the field is omitted, never sent as null', async () => {
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    const body = mockCreateInvite.mock.calls[0][0] as Record<string, unknown>;
    expect('team_channel_id' in body).toBe(false);
  });
});
