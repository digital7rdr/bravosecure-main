/**
 * Channels vs2 item 17b — the sheet must never present a guess as state.
 *
 * The dangerous shape is not a crash, it is a plausible-looking default: the
 * toggles start "everything shown", which is indistinguishable from a workspace
 * that hides nothing. With Save enabled, one tap on a failed load PATCHed an
 * empty set and un-hid both modules org-wide — recorded in the audit as the
 * admin's deliberate change.
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

const mockGet = jest.fn();
const mockSet = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// vs2 item 4 — the sheet now asks WHICH workspace it is drawing. Left
// unmocked, the real store answers `null`, `asked` is null, and every
// wrong-org assertion short-circuits into passing vacuously.
const mockOrgParam = jest.fn<{orgId: string} | undefined, []>();
jest.mock('@store/activeWorkspace', () => ({activeWorkspaceOrgParam: () => mockOrgParam()}));
jest.mock('@services/api', () => ({
  orgApi: {
    workspaceSettings: () => mockGet(),
    setWorkspaceSettings: (h: string[]) => mockSet(h),
  },
}));

import {ModuleVisibilitySheet} from '../ModuleVisibilitySheet';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgParam.mockReturnValue(undefined);
  mockSet.mockResolvedValue({data: {orgUserId: 'o1', hiddenModules: []}});
});

describe('a FAILED load never becomes a saveable state', () => {
  it('shows no toggles and refuses to save', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    const u = render(<ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await waitFor(() => expect(u.getByText(/Could not load/)).toBeTruthy());
    // No default-looking rows…
    expect(u.queryByLabelText(/Attendance, shown/)).toBeNull();
    expect(u.queryByLabelText(/Incidents, shown/)).toBeNull();
    // …and Save cannot fire.
    fireEvent.press(u.getByLabelText('Save module visibility'));
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('offers a retry that recovers', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({data: {orgUserId: 'o1', hiddenModules: ['attendance']}});
    const u = render(<ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />);
    await waitFor(() => expect(u.getByLabelText('Retry loading module settings')).toBeTruthy());
    await act(async () => { fireEvent.press(u.getByLabelText('Retry loading module settings')); });
    expect(await u.findByLabelText('Attendance, hidden')).toBeTruthy();
  });
});

describe('a successful load is the only thing that can be saved', () => {
  it('renders the server state and writes the WHOLE set back', async () => {
    mockGet.mockResolvedValue({data: {orgUserId: 'o1', hiddenModules: ['incidents']}});
    const onSaved = jest.fn();
    const u = render(<ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={onSaved} />);
    expect(await u.findByLabelText('Incidents, hidden')).toBeTruthy();
    expect(u.getByLabelText('Attendance, shown')).toBeTruthy();
    // Hide attendance too, then save.
    fireEvent.press(u.getByLabelText('Attendance, shown'));
    await act(async () => { fireEvent.press(u.getByLabelText('Save module visibility')); });
    expect(mockSet).toHaveBeenCalledWith(['incidents', 'attendance']);
  });

  it('a malformed payload is treated as "nothing hidden", not as a crash', async () => {
    // A 200 with a non-JSON body makes `data` a string; a renamed field makes
    // the array undefined. Neither may throw inside render.
    mockGet.mockResolvedValue({data: {orgUserId: 'o1'}});
    const u = render(<ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />);
    expect(await u.findByLabelText('Attendance, shown')).toBeTruthy();
  });
});


describe('vs2 item 4 — the sheet refuses to edit another organisation', () => {
  const ACME = 'acme-uuid';
  const BOREALIS = 'borealis-uuid';

  it('shows the wrong-org state when the server answers about a DIFFERENT org', async () => {
    /**
     * Dana manages Acme (January) and Borealis (June). She is inside Borealis;
     * the header says Borealis. If the server still answers with Acme, the
     * toggles on screen belong to a company she is not looking at — and Save
     * would rewrite it, silently, with a 200 and an audit row.
     */
    mockOrgParam.mockReturnValue({orgId: BOREALIS});
    mockGet.mockResolvedValue({data: {orgUserId: ACME, hiddenModules: ['attendance']}});
    const {getByLabelText, queryByLabelText} = render(
      <ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />,
    );
    await waitFor(() => getByLabelText('Settings belong to a different organisation'));
    // The toggles must not render at all — a visible toggle invites the tap.
    expect(queryByLabelText(/Attendance, /)).toBeNull();
  });

  it('DISABLES Save in that state, so the tap cannot land anywhere', async () => {
    mockOrgParam.mockReturnValue({orgId: BOREALIS});
    mockGet.mockResolvedValue({data: {orgUserId: ACME, hiddenModules: []}});
    const {getByLabelText} = render(
      <ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />,
    );
    await waitFor(() => getByLabelText('Settings belong to a different organisation'));
    await act(async () => { fireEvent.press(getByLabelText('Save module visibility')); });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('treats "no org at all" as a mismatch when a workspace IS selected', async () => {
    // orgUserId null means the server resolved NOTHING, which serialises as an
    // empty hidden set — indistinguishable from "hides nothing", with Save
    // enabled. That is one tap from un-hiding every module org-wide.
    mockOrgParam.mockReturnValue({orgId: BOREALIS});
    mockGet.mockResolvedValue({data: {orgUserId: null, hiddenModules: []}});
    const {getByLabelText} = render(
      <ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />,
    );
    await waitFor(() => getByLabelText('Settings belong to a different organisation'));
    await act(async () => { fireEvent.press(getByLabelText('Save module visibility')); });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does NOT misfire for a single-org user, who selects no workspace at all', async () => {
    // The common case, and the one a careless comparison breaks: no context
    // means "my primary org", and the server naming it is agreement.
    mockOrgParam.mockReturnValue(undefined);
    mockGet.mockResolvedValue({data: {orgUserId: ACME, hiddenModules: ['incidents']}});
    const {getByLabelText, queryByLabelText} = render(
      <ModuleVisibilitySheet visible onClose={jest.fn()} onSaved={jest.fn()} />,
    );
    await waitFor(() => getByLabelText(/Incidents, /));
    expect(queryByLabelText('Settings belong to a different organisation')).toBeNull();
  });

  it('says the change LANDED ELSEWHERE when the PATCH resolves to another org', async () => {
    /**
     * The write-side race the read-side check cannot cover: Dana is removed
     * from Borealis between the GET and the PATCH. Telling her to "close and
     * re-open" would imply nothing happened — the write already did.
     */
    mockOrgParam.mockReturnValue({orgId: BOREALIS});
    mockGet.mockResolvedValue({data: {orgUserId: BOREALIS, hiddenModules: []}});
    mockSet.mockResolvedValue({data: {orgUserId: ACME, hiddenModules: []}});
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const {getByLabelText} = render(
      <ModuleVisibilitySheet visible onClose={onClose} onSaved={onSaved} />,
    );
    await waitFor(() => getByLabelText(/Attendance, /));
    await act(async () => { fireEvent.press(getByLabelText('Save module visibility')); });
    // Not reported as success, and the sheet stays open to carry the message.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getByLabelText('Settings belong to a different organisation')).toBeTruthy();
  });
});
