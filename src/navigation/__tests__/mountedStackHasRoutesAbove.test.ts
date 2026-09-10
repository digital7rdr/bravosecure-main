/**
 * B-393 — the predicate that keeps a "go to this section's root" control from
 * silently eating the user's work.
 *
 * React Navigation's NAVIGATE does not push when a route of that name is
 * already in the stack: StackRouter returns `routes.slice(0, index + 1)` and
 * everything above is gone. So the landing is a harmless push in one shape and
 * a destructive pop in another, and only the navigation STATE can tell them
 * apart. `SecureProApplyScreen` keeps all fifteen application fields in local
 * `useState` with no store and no `beforeRemove`, so getting this wrong is
 * unrecoverable data loss, not a cosmetic misstep.
 */
const mockIsReady = jest.fn(() => true);
const mockGetRootState = jest.fn<unknown, []>(() => undefined);

jest.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    isReady: () => mockIsReady(),
    getRootState: () => mockGetRootState(),
  }),
}));

import {mountedStackHasRoutesAbove} from '@navigation/navigationRef';

/** The client shell: a tab navigator whose SecureTab hosts BookingNavigator. */
function shell(secureStack: string[], messengerStack: string[] = ['MessengerHome']) {
  return {
    routeNames: ['Main'],
    routes: [{
      name: 'Main',
      state: {
        routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
        routes: [
          {name: 'MessengerTab', state: {routes: messengerStack.map(name => ({name}))}},
          {name: 'SecureTab', state: {routes: secureStack.map(name => ({name}))}},
          {name: 'ProfileTab'},
        ],
      },
    }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsReady.mockReturnValue(true);
});

describe('mountedStackHasRoutesAbove', () => {
  it('false when the route is absent — the landing would be a plain push', () => {
    // BookingHome -> drawer -> Secure Services: the founder's primary path.
    mockGetRootState.mockReturnValue(shell(['BookingHome']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
  });

  it('false when the route is already the TOP — the landing is a no-op', () => {
    mockGetRootState.mockReturnValue(shell(['BookingHome', 'SecureServices']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
  });

  it('TRUE when the booking wizard sits above it', () => {
    mockGetRootState.mockReturnValue(
      shell(['BookingHome', 'SecureServices', 'ZoneMap', 'ServiceType']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(true);
  });

  it('TRUE for the unrecoverable case — the Pro application form', () => {
    mockGetRootState.mockReturnValue(
      shell(['BookingHome', 'SecureServices', 'SecureProIntro', 'SecureProApply']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(true);
  });

  it('answers per-branch, not per-tree — a SIBLING tab must not trigger it', () => {
    // MessengerHome has screens above it in ITS stack; SecureServices does not.
    // A tree-wide "does anything have routes above" would wrongly say true and
    // put a dialog in front of the founder's one-tap path.
    mockGetRootState.mockReturnValue(
      shell(['BookingHome', 'SecureServices'], ['MessengerHome', 'ChatScreen']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
    expect(mountedStackHasRoutesAbove('MessengerHome')).toBe(true);
  });

  it('finds the route at any depth, not just the first level', () => {
    mockGetRootState.mockReturnValue(shell(['BookingHome', 'SecureServices', 'ZoneMap']));
    // 'SecureServices' lives two navigators down (root -> Main -> tabs -> stack).
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(true);
  });

  it('false for a route nothing has heard of', () => {
    mockGetRootState.mockReturnValue(shell(['BookingHome', 'SecureServices', 'ZoneMap']));
    expect(mountedStackHasRoutesAbove('NoSuchScreen')).toBe(false);
  });

  it('false — never blocking — when the ref is not ready', () => {
    // An unmounted tree has nothing to destroy. Returning true here would put a
    // dialog in front of the first tap after boot.
    mockIsReady.mockReturnValue(false);
    mockGetRootState.mockReturnValue(shell(['BookingHome', 'SecureServices', 'ZoneMap']));
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
    expect(mockGetRootState).not.toHaveBeenCalled();
  });

  it('survives a malformed / empty state instead of throwing', () => {
    mockGetRootState.mockReturnValue(undefined);
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
    mockGetRootState.mockReturnValue({routes: []});
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
    mockGetRootState.mockReturnValue({routes: [{name: 'Main'}]});
    expect(mountedStackHasRoutesAbove('SecureServices')).toBe(false);
  });

  it('terminates on a cyclic state rather than blowing the stack', () => {
    const cyclic: {name: string; state?: unknown} = {name: 'Main'};
    cyclic.state = {routes: [cyclic]};
    mockGetRootState.mockReturnValue({routes: [cyclic]});
    expect(() => mountedStackHasRoutesAbove('SecureServices')).not.toThrow();
  });
});
