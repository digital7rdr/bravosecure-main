/**
 * VBG footer — dynamic active-tab + routing contract.
 *
 * B-91 M2 R7 — the footer is the VBG module's own THREE-tab bottom nav
 * (spec p.21: Home · News Feed · Messenger). Two invariants matter:
 *
 *  1. DYNAMIC HIGHLIGHT — the active tab is derived from the CURRENT route
 *     (not a per-screen literal), so the indicator is always correct and
 *     follows navigation. Key Points / GeoRisk / SRA are Home drill-downs
 *     and light the Home tab while open.
 *  2. ROUTING CONTRACT — tapping a tab navigates to the right destination:
 *     within-stack tabs (Home/News Feed) push a BookingStack route; the
 *     Messenger tab hops to MessengerTab → nested screen (the communication
 *     MODULE mount). Tapping the already-active tab is a no-op.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {
  VbgFooter, VBG_ROUTE_TO_TAB, TAB_TARGET, tabForRoute, type VbgTab,
} from '../VbgFooter';

// react-native-svg → host strings so the footer renders without the native
// module (mirrors the established idiom in OTPVerificationScreen.keypad.test).
jest.mock('react-native-svg', () => ({
  __esModule: true, default: 'Svg', Path: 'Path', Circle: 'Circle',
}));

// Drive useRoute()/useNavigation() deterministically. `mockRouteName` is
// flipped per test to simulate "which VBG screen am I on". Both must be
// `mock`-prefixed so jest's mock-factory hoisting allows the reference.
const mockNavigate = jest.fn();
const mockRouteState = {name: 'VBGHome'};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
  useRoute: () => ({name: mockRouteState.name, key: `${mockRouteState.name}-key`, params: {}}),
}));

/** Set the simulated current route for the next render. */
function setRoute(name: string) { mockRouteState.name = name; }

const TABS: VbgTab[] = ['home', 'news', 'messenger'];
const LABEL: Record<VbgTab, string> = {
  home: 'Home', news: 'News Feed', messenger: 'Messenger',
};

beforeEach(() => {
  mockNavigate.mockReset();
  setRoute('VBGHome');
});

// ── Pure mapping (no render) ──────────────────────────────────────────────────
describe('tabForRoute (pure)', () => {
  it('maps every VBG stack route to its footer tab', () => {
    expect(tabForRoute('VBGHome')).toBe('home');
    // Home drill-downs (their dedicated tabs were removed by spec p.21).
    expect(tabForRoute('VBGNearby')).toBe('home');
    expect(tabForRoute('VBGGeoRisk')).toBe('home');
    expect(tabForRoute('VBGSRA')).toBe('home');
    expect(tabForRoute('VBGOSINT')).toBe('news');
  });

  it('falls back to Home for an unknown / off-map route', () => {
    expect(tabForRoute('SomethingElse')).toBe('home');
    expect(tabForRoute(undefined)).toBe('home');
  });

  it('honours an explicit override over the route', () => {
    expect(tabForRoute('VBGHome', 'messenger')).toBe('messenger');
    expect(tabForRoute('VBGOSINT', 'home')).toBe('home');
  });

  it('VBG_ROUTE_TO_TAB only references real tabs', () => {
    for (const tab of Object.values(VBG_ROUTE_TO_TAB)) {
      expect(TABS).toContain(tab);
    }
  });
});

// ── Routing contract (pure data) ──────────────────────────────────────────────
describe('TAB_TARGET (routing contract)', () => {
  it('within-stack tabs point at the correct BookingStack route', () => {
    expect(TAB_TARGET.home).toEqual({kind: 'stack', route: 'VBGHome'});
  });

  it('cross-tab tabs hop to MessengerTab with the right nested screen', () => {
    // Founder 2026-08-01 — News Feed opens the main news dashboard, not the
    // VBG-local OSINT feed (which stays reachable as a Home drill-down).
    expect(TAB_TARGET.news).toEqual({kind: 'tab', tab: 'MessengerTab', screen: 'NewsFeed'});
    expect(TAB_TARGET.messenger).toEqual({kind: 'tab', tab: 'MessengerTab', screen: 'MessengerHome'});
  });

  it('defines a target for every tab and nothing else', () => {
    for (const tab of TABS) {expect(TAB_TARGET[tab]).toBeDefined();}
    expect(Object.keys(TAB_TARGET).sort()).toEqual([...TABS].sort());
  });
});

// ── Dynamic highlight (render) ────────────────────────────────────────────────
describe('VbgFooter — dynamic active highlight', () => {
  // The active tab renders an indicator pip; inactive tabs don't. We assert
  // via testID on the indicator node (added in the component).
  const routeToTab: Array<[string, VbgTab]> = [
    ['VBGHome', 'home'],
    ['VBGNearby', 'home'],
    ['VBGGeoRisk', 'home'],
    ['VBGSRA', 'home'],
    ['VBGOSINT', 'news'],
  ];

  it.each(routeToTab)('on route %s the active indicator is on the %s tab', (routeName, tab) => {
    setRoute(routeName);
    const {getByTestId, queryByTestId} = render(<VbgFooter />);
    // Exactly the expected tab carries the indicator.
    expect(getByTestId(`vbg-tab-indicator-${tab}`)).toBeTruthy();
    for (const other of TABS.filter(t => t !== tab)) {
      expect(queryByTestId(`vbg-tab-indicator-${other}`)).toBeNull();
    }
  });

  it('an explicit override beats the route', () => {
    setRoute('VBGHome');
    const {getByTestId, queryByTestId} = render(<VbgFooter active="messenger" />);
    expect(getByTestId('vbg-tab-indicator-messenger')).toBeTruthy();
    expect(queryByTestId('vbg-tab-indicator-home')).toBeNull();
  });

  it('renders exactly the three spec tabs', () => {
    const {getByText, queryByText} = render(<VbgFooter />);
    for (const tab of TABS) {expect(getByText(LABEL[tab])).toBeTruthy();}
    expect(queryByText('Key Points')).toBeNull();
    expect(queryByText('GeoRisk')).toBeNull();
  });
});

// ── Press behaviour (render + navigate) ───────────────────────────────────────
describe('VbgFooter — tab press navigates', () => {
  it('within-stack tabs navigate to their BookingStack route', () => {
    setRoute('VBGOSINT'); // news is active, so home fires
    const {getByText} = render(<VbgFooter />);

    fireEvent.press(getByText(LABEL.home));
    expect(mockNavigate).toHaveBeenCalledWith('VBGHome');
  });

  it('News Feed hops to the main news dashboard (founder 2026-08-01)', () => {
    setRoute('VBGHome');
    const {getByText} = render(<VbgFooter />);

    fireEvent.press(getByText(LABEL.news));
    expect(mockNavigate).toHaveBeenCalledWith('MessengerTab', {screen: 'NewsFeed'});
  });

  it('cross-tab tabs hop to MessengerTab with the nested screen', () => {
    setRoute('VBGHome');
    const {getByText} = render(<VbgFooter />);

    fireEvent.press(getByText(LABEL.messenger));
    expect(mockNavigate).toHaveBeenCalledWith('MessengerTab', {screen: 'MessengerHome'});
  });

  it('tapping the already-active tab ON its target route is a no-op', () => {
    setRoute('VBGHome');
    const {getByText} = render(<VbgFooter />);

    fireEvent.press(getByText(LABEL.home));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('Home RETURNS to the dashboard from a drill-down (active but off-route)', () => {
    setRoute('VBGNearby'); // Home tab is lit, but we are not on VBGHome
    const {getByText} = render(<VbgFooter />);

    fireEvent.press(getByText(LABEL.home));
    expect(mockNavigate).toHaveBeenCalledWith('VBGHome');
  });
});
