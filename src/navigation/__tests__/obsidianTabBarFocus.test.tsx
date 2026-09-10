/**
 * Scope v2 Phase 6 — the tab bar's focus behaviour, tested by RENDERING it.
 *
 * The sibling source scan (`workspaceBottomNav.test.ts`) proves the *structural*
 * half — which routes stay registered — because no render can see reachability.
 * That argument does NOT transfer to focus: which item is highlighted is exactly
 * what a render test can observe, and the first version of the focus assertions
 * matched the implementation's own source text verbatim, so it would have failed
 * on a correct refactor and passed on a broken one (invert the ternary; reorder
 * the routes).
 *
 * So the requirement is asserted here against real output: with a hidden route
 * active, exactly one item is rendered as selected and it is the named stand-in.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {ObsidianTabBar, type ObsidianTabIcon} from '../ObsidianTabBar';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@hooks/useBottomInset', () => ({useReportBottomTabBar: () => undefined}));

const ICONS: Record<string, ObsidianTabIcon> = {
  Home:      {default: 'home-outline', active: 'home', label: 'Home'},
  Channels:  {default: 'forum-outline', active: 'forum', label: 'Channels'},
  Attend:    {default: 'calendar-check-outline', active: 'calendar-check', label: 'Attend'},
  Messenger: {default: 'message-outline', active: 'message', label: 'Messenger'},
};

const HIDDEN = ['Channels', 'Attend'];
const NAMES = ['Home', 'Channels', 'Attend', 'Messenger'];

/** A BottomTabBarProps just real enough for the bar to render from. */
function props(activeIndex: number, standInTab?: string, nav?: {
  emit?: () => {defaultPrevented: boolean};
  navigate?: (name: string) => void;
  dispatch?: (action: unknown) => void;
}, nestedStateKey?: string): BottomTabBarProps & {icons: typeof ICONS; standInTab?: string} {
  const routes = NAMES.map((name, i) => ({
    key: `${name}-${i}`,
    name,
    params: undefined,
    ...(nestedStateKey && i === activeIndex ? {state: {key: nestedStateKey}} : {}),
  }));
  const descriptors = Object.fromEntries(
    routes.map(r => [r.key, {
      options: HIDDEN.includes(r.name) ? {tabBarButton: () => null} : {},
    }]),
  );
  return {
    state: {routes, index: activeIndex} as never,
    descriptors: descriptors as never,
    navigation: {
      emit: nav?.emit ?? (() => ({defaultPrevented: false})),
      navigate: nav?.navigate ?? (() => undefined),
      dispatch: nav?.dispatch ?? (() => undefined),
    } as never,
    insets: {top: 0, bottom: 0, left: 0, right: 0},
    icons: ICONS,
    standInTab,
  };
}

/** Labels of the items the bar actually drew. */
function rendered(ui: ReturnType<typeof render>): string[] {
  return NAMES.filter(n => ui.queryAllByText(n).length > 0);
}

/** Labels the bar rendered as SELECTED — counted from real output. */
function selected(ui: ReturnType<typeof render>): string[] {
  return rendered(ui).filter(
    n => ui.getByLabelText(n).props.accessibilityState?.selected === true,
  );
}

describe('ObsidianTabBar focus', () => {
  it('draws only the non-hidden tabs', () => {
    const ui = render(<ObsidianTabBar {...props(0, 'Home')} />);
    expect(rendered(ui)).toEqual(['Home', 'Messenger']);
  });

  it('marks exactly one item selected when a VISIBLE tab is active', () => {
    const ui = render(<ObsidianTabBar {...props(0, 'Home')} />);
    expect(selected(ui)).toEqual(['Home']);
  });

  /**
   * THE REQUIREMENT. Active route = Attend (hidden). Before the stand-in the bar
   * highlighted NOTHING, for the majority of workspace usage.
   */
  it('highlights the named stand-in while a HIDDEN route is active', () => {
    const ui = render(<ObsidianTabBar {...props(2, 'Home')} />);   // index 2 = Attend
    // Exactly ONE, and it is Home — not "whichever visible route came first".
    expect(selected(ui)).toEqual(['Home']);
  });

  /**
   * The stand-in must be NAMED, not inferred from declaration order. Inferring
   * it as "the first visible route" made the highlight depend on the order of
   * the <Tab.Screen> list — reorder it and the bar lights the wrong tab, which
   * no source scan can see.
   */
  it('does NOT fall back to declaration order when no stand-in is named', () => {
    const ui = render(<ObsidianTabBar {...props(2)} />);   // hidden active, no stand-in
    expect(selected(ui)).toEqual([]);
  });

  it('names the stand-in explicitly — Messenger can be it too', () => {
    const ui = render(<ObsidianTabBar {...props(2, 'Messenger')} />);
    expect(selected(ui)).toEqual(['Messenger']);
  });

  /** Inert for every navigator that hides nothing — MainNavigator, CpoNavigator. */
  it('is a no-op when nothing is hidden', () => {
    const routes = ['Home', 'Messenger'].map((name, i) => ({key: `${name}-${i}`, name, params: undefined}));
    const descriptors = Object.fromEntries(routes.map(r => [r.key, {options: {}}]));
    const ui = render(
      <ObsidianTabBar
        state={{routes, index: 1} as never}
        descriptors={descriptors as never}
        navigation={{emit: () => ({defaultPrevented: false}), navigate: () => undefined} as never}
        insets={{top: 0, bottom: 0, left: 0, right: 0}}
        icons={ICONS}
        standInTab="Home"
      />,
    );
    // The ACTIVE route wins; the stand-in must not steal the highlight.
    expect(ui.getByLabelText('Messenger').props.accessibilityState.selected).toBe(true);
    expect(ui.getByLabelText('Home').props.accessibilityState.selected).toBe(false);
    expect(rendered(ui)).toEqual(['Home', 'Messenger']);
  });
});

/**
 * Client review vs2 item 9 — "the HOME button must return you to the dashboard".
 *
 * The stand-in highlight above and the press guard below were in direct
 * conflict: while a hidden route is active the stand-in item RENDERS as
 * selected, and the press handler skipped navigation for any item it read as
 * already focused. So HOME did nothing from inside Channels / Attend /
 * Incident / Vault — the whole workspace, since those four are the only places
 * you can be. Focus is observable (tested above); the swallowed press is not,
 * which is why it survived.
 */
describe('ObsidianTabBar press — item 9', () => {
  it('NAVIGATES on a stand-in press while a hidden route is active', () => {
    const navigate = jest.fn();
    const ui = render(<ObsidianTabBar {...props(2, 'Home', {navigate})} />); // Attend active
    fireEvent.press(ui.getByLabelText('Home'));
    expect(navigate).toHaveBeenCalledWith('Home');
  });

  it('stays a no-op when the stand-in tab is GENUINELY the active route', () => {
    const navigate = jest.fn();
    const ui = render(<ObsidianTabBar {...props(0, 'Home', {navigate})} />); // Home active
    fireEvent.press(ui.getByLabelText('Home'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still honours a tabPress listener that calls preventDefault', () => {
    const navigate = jest.fn();
    const ui = render(
      <ObsidianTabBar {...props(2, 'Home', {navigate, emit: () => ({defaultPrevented: true})})} />,
    );
    fireEvent.press(ui.getByLabelText('Home'));
    // The Departmental shell's Messenger tab relies on this to redirect out.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves ordinary (non-stand-in) tabs on the unchanged rule', () => {
    const navigate = jest.fn();
    const ui = render(<ObsidianTabBar {...props(0, 'Home', {navigate})} />); // Home active
    fireEvent.press(ui.getByLabelText('Messenger'));
    expect(navigate).toHaveBeenCalledWith('Messenger');
  });

  /**
   * The CpoNavigator shape: same bar, hidden route active, but NO standInTab.
   * `pressIsStandIn` must stay false there, so that navigator's press
   * behaviour is byte-identical to before this change.
   */
  /**
   * The bar must NEVER reset the module it is leaving.
   *
   * A popToTop was tried here and reverted: the module stacks hold unsaved
   * forms (a 62-day day-status batch, a walked geofence, a mandatory
   * correction reason) and only the chat thread hides this bar, so HOME was
   * pressable from all of them and the pop discarded the lot with no warning.
   */
  it('never resets the abandoned module — no dispatch on the way out', () => {
    const navigate = jest.fn();
    const dispatch = jest.fn();
    const ui = render(
      <ObsidianTabBar {...props(2, 'Home', {navigate, dispatch}, 'attend-stack')} />,
    );
    fireEvent.press(ui.getByLabelText('Home'));
    expect(navigate).toHaveBeenCalledWith('Home');
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * A stand-in naming a HIDDEN route can never highlight anything — no rendered
   * item can match its key. The filter alone cannot fix that (the outcome is
   * identical either way), so the actual guarantee is that the misconfiguration
   * is LOUD in dev instead of silent. Assert the warn, or this is a test of
   * nothing.
   */
  it('warns in dev when standInTab names a hidden route', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const navigate = jest.fn();
    const ui = render(<ObsidianTabBar {...props(2, 'Attend', {navigate})} />); // Attend is hidden
    expect(selected(ui)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('standInTab "Attend"'));
    fireEvent.press(ui.getByLabelText('Home'));
    // Falls through to the ordinary rule — Home is not the active route, so it
    // still navigates rather than becoming a dead button.
    expect(navigate).toHaveBeenCalledWith('Home');
    warn.mockRestore();
  });

  it('is inert on a bar that names no stand-in', () => {
    const navigate = jest.fn();
    const ui = render(<ObsidianTabBar {...props(2, undefined, {navigate})} />); // hidden active
    fireEvent.press(ui.getByLabelText('Messenger'));
    expect(navigate).toHaveBeenCalledWith('Messenger');
    navigate.mockClear();
    // Nothing is highlighted without a stand-in, so Home is simply unfocused
    // and takes the ordinary path — not the new branch.
    fireEvent.press(ui.getByLabelText('Home'));
    expect(navigate).toHaveBeenCalledWith('Home');
  });
});
