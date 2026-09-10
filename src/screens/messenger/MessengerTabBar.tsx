/**
 * The Messenger footer bar — Chats · Calls · Files · News · Channels (PDF-2 N5),
 * PERSISTENT (N1): MessengerHome keeps it always mounted and swaps tab bodies
 * inline; and, since the client's 2026-08-22 feedback ("No Nav bar?" on Files),
 * the pushed Files screen renders the SAME bar with Files lit, so the footer
 * never disappears inside Messenger.
 *
 * Extracted from MessengerHomeScreen so two screens share ONE bar (the
 * duplicate-copy bug class: one behaviour, N drifted copies). The tab semantics
 * are unchanged:
 *   `tab`   — a LOCAL tab of MessengerHome (Chats / Calls / News): the host flips
 *             its body inline via `onSelectTab`; from Files the host navigates
 *             back to MessengerHome carrying the tab as a route param.
 *   `route` — a BARE in-stack PUSH (Files only; its B-453 vault-PIN gate uses
 *             navigation.replace and cannot embed, so it stays full-screen —
 *             but it now renders this bar beneath its list).
 *   `exit`  — a shell-aware EXIT-HOP out of the messenger stack (Channels), so it
 *             reaches a cross-shell MessengerTarget a bare navigate would drop in
 *             some shells (B-414).
 */
import React, {useRef} from 'react';
import {View, TouchableOpacity, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList, MessengerHomeTab} from '@navigation/types';
import {navigateToMessengerScreen, type MessengerTarget} from '@navigation/messengerDeepLink';
import {findNavigatorWithRoute, navigateVia} from '@navigation/departmentalEntry';
import {NAV_GUARD_MS} from '@navigation/tapGuard';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';

/** The tabs MessengerHome renders INLINE (local state, no navigation). */
export type MsgLocalTab = MessengerHomeTab;
/** What the bar can show as lit: a local tab, or Files while the Files screen hosts it. */
export type MsgBarTab = MsgLocalTab | 'Files';

/** Height of the bar's content above the safe-area pad — hosts clear it. */
export const MSG_TAB_HEIGHT = 60;

/**
 * What the bar needs from its host's navigation: `navigate` only. Structural,
 * so a host typed for ANY route of the stack (MessengerHome, Files) can pass
 * its own prop — `NativeStackNavigationProp<P, 'Files'>` is not assignable to
 * `NativeStackNavigationProp<P>` (the route-bound members differ).
 */
export type MessengerBarNavigation = Pick<NativeStackNavigationProp<MessengerStackParamList>, 'navigate'>;

const BAR_BG = '#07090D';

type MsgTab = {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  tab?: MsgLocalTab;
  route?: keyof MessengerStackParamList;
  exit?: MessengerTarget;
};
// N5 (PDF-2) — footer is Chats · Calls · Files · News · Channels. The Groups
// footer tab was dropped: group conversations still appear in the Chats list
// and "New Group" lives on the header pencil (NewChat). Channels is an EXIT-HOP
// to the departmental tree, reached in every shell via the resolver.
export const MSG_TABS: MsgTab[] = [
  {icon: 'message-text-outline',      label: 'Chats',    tab: 'Chats'},
  {icon: 'phone-outline',             label: 'Calls',    tab: 'Calls'},
  {icon: 'folder-outline',            label: 'Files',    route: 'Files'},
  {icon: 'newspaper-variant-outline', label: 'News',     tab: 'News'},
  {icon: 'pound-box-outline',         label: 'Channels', exit: 'DepartmentChannels'},
];


export function MessengerTabBar({
  navigation,
  insets,
  activeTab,
  onSelectTab,
  // Defaults TRUE: an un-updated caller keeps the tab rather than silently
  // losing a door. Hiding on omission would be the worse failure.
  showChannels = true,
}: {
  navigation: MessengerBarNavigation;
  insets: {bottom: number};
  activeTab: MsgBarTab;
  onSelectTab: (tab: MsgLocalTab) => void;
  /**
   * B-661 - whether this account is offered Channels. The HOSTS decide, via
   * the shared canSeeChannels(user) rule; the bar deliberately does NOT read
   * the auth store itself - see channelsAccess.ts for why that shape was
   * backed out. Defaults to TRUE so an un-updated caller keeps the tab
   * rather than silently losing a door.
   */
  showChannels?: boolean;
}) {
  // B-661 - LITE does not get Channels. Rule: channelsAccess.canSeeChannels.
  const visibleTabs = React.useMemo(
    () => (showChannels ? MSG_TABS : MSG_TABS.filter(t => t.exit !== 'DepartmentChannels')),
    [showChannels],
  );

  // NAV-10 (2026-08-26 audit) — drop same-tab repeats inside the guard
  // window: a local tab press fully remounts its body (B-655 gating), so a
  // mash used to queue one full unmount/remount cycle per tap. A press on a
  // DIFFERENT tab always passes.
  const lastTabTapRef = useRef<{label: string; t: number} | null>(null);
  const handlePress = (tab: MsgTab) => {
    const now = Date.now();
    const last = lastTabTapRef.current;
    if (last && last.label === tab.label && now - last.t < NAV_GUARD_MS) {return;}
    lastTabTapRef.current = {label: tab.label, t: now};
    /**
     * Channels lands on the WORKSPACE LIST, not inside one workspace.
     *
     * Client 2026-08-22: "if I click Channels it redirects to my workspace's
     * manage channels — it does not make sense; it should go to the workspace
     * interface where all the workspaces are listed." It is also the fix for the
     * mixed-organisation list: the org context every scoped surface reads
     * (`activeWorkspace`) is set by PICKING a workspace on that hub, and is null
     * on every other entry — which is precisely when the server returns channels
     * from every org at once.
     *
     * Resolved, never assumed: `WorkspaceHub` is registered on the messenger and
     * agency stacks, but a shell without it must not get a dead tap (B-414/N2),
     * so an unresolved hub falls back to the previous channels exit-hop.
     */
    if (tab.exit === 'DepartmentChannels') {
      const hub = findNavigatorWithRoute(navigation as never, 'WorkspaceHub');
      if (hub) {navigateVia(hub, 'WorkspaceHub'); return;}
      navigateToMessengerScreen(navigation as never, 'DepartmentChannels', {}, {initial: false});
      return;
    }
    // Files STAYS a push — embedding its vault-PIN gate would run
    // navigation.replace against MessengerHome and strand the user. A re-press
    // while Files already hosts the bar is a no-op (never a second push).
    if (tab.route === 'Files') {
      if (activeTab !== 'Files') {navigation.navigate('Files');}
      return;
    }
    // A local tab: the host decides (MessengerHome flips its inline body; Files
    // pops back to MessengerHome with the tab) — the bar never navigates itself.
    if (tab.tab) {onSelectTab(tab.tab);}
  };
  return (
    <View style={[msgTabStyles.bar, {paddingBottom: Math.max(insets.bottom, 8)}]}>
      <View style={msgTabStyles.hairline} />
      <View style={msgTabStyles.row}>
        {visibleTabs.map(tab => {
          // The highlight follows what the HOST declares is live — a local tab on
          // MessengerHome, or Files while the Files screen hosts the bar. Channels
          // is never "active" (it leaves this surface).
          const active = (tab.tab ?? tab.route) === activeTab;
          return (
            <TouchableOpacity
              key={tab.label}
              style={msgTabStyles.item}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={tab.label}
              accessibilityState={{selected: active}}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}
              onPress={() => handlePress(tab)}>
              {active && <View style={msgTabStyles.activeBar} />}
              <Icon name={tab.icon} size={22} color={active ? '#5B8DEF' : 'rgba(180,188,204,0.45)'} />
              <FitLine style={[msgTabStyles.label, active && msgTabStyles.labelActive]} floorScale={0.75} text={tab.label} />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const msgTabStyles = StyleSheet.create(scaleTextStyles({
  bar: {
    backgroundColor: BAR_BG,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: 10,
  },
  hairline: {},
  row: {flexDirection: 'row', alignItems: 'flex-start'},
  item: {flex: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 3, position: 'relative'},
  activeBar: {
    position: 'absolute', top: -10, width: 28, height: 2.5, borderRadius: 2,
    backgroundColor: '#5B8DEF',
    shadowColor: '#5B8DEF', shadowOpacity: 1, shadowRadius: 8, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  label: {fontFamily: BravoFont.sans, fontSize: 10, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', textAlign: 'center', color: 'rgba(180,188,204,0.45)'},
  labelActive: {color: '#F2F4F8'},
}));
