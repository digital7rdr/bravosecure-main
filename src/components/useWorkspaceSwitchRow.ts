/**
 * The Workspaces / Channels row that sits at the bottom of SWITCH DASHBOARD.
 *
 * Extracted so the drawer and the Profile screen render the SAME row rather
 * than two hand-written copies. ProfileDrawerModal already carried a warning
 * that the row is drawn twice and that the copies must be kept in step; adding
 * a third renderer on Profile without a shared source would have made that a
 * guarantee of drift instead of a risk. Its label, pill and destination all
 * depend on affiliation, which is exactly the part that must not fork.
 *
 * `dismiss` exists because the two hosts leave differently: the drawer is a
 * modal that must animate out BEFORE the navigate (220ms, matching its own
 * close), while the Profile screen is already a full screen and navigates
 * immediately. Passing the host's exit in keeps that difference at the call
 * site instead of duplicating the destination logic to accommodate it.
 */
import type React from 'react';
import type Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {CommonActions, useNavigation} from '@react-navigation/native';
import {useAuthStore} from '@store/authStore';
import {isWorkspaceTenant} from '@screens/deptchat/workspaceTenant';
import {findNavigatorWithRoute, openDepartmentChannels} from '@navigation/departmentalEntry';
import {navigationRef, mountedTreeHasRoute} from '@navigation/navigationRef';
import {useEntitlements, showEnterpriseUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';

export interface WorkspaceSwitchRow {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  pill: string;
  /** Not entitled — the row still opens the upsell, so it dims, never hides. */
  dimmed?: boolean;
  go: () => void;
}

export function useWorkspaceSwitchRow(dismiss?: () => void): WorkspaceSwitchRow {
  // `getParent`/`getState` are REQUIRED, not decorative: openDepartmentChannels
  // resolves 'DepartmentChannels' against the navigator tree that is actually
  // mounted, and this row is hosted by the messenger, booking AND VBG shells.
  const navigation = useNavigation<{
    navigate: (name: string, params?: object) => void;
    getParent: () => never;
    getState: () => never;
  }>();
  const {user} = useAuthStore();
  const entitlements = useEntitlements();

  /** Leave the host first when there is one to leave, then navigate. */
  const leave = (go: () => void) => {
    if (!dismiss) { go(); return; }
    dismiss();
    setTimeout(go, 220);
  };

  const openDeptChatNow = () => {
    // A workspace member/owner gets their DASHBOARD (Home tab); everyone else
    // keeps the directory, which owns the join gate and the upsell.
    const res = openDepartmentChannels(navigation, {preferHome: entitlements.isOrgAffiliated});
    // Torn-tree fallback ONLY — a non-entitled user normally LANDS on the
    // DepartmentChannels gate, which owns the live Enterprise pitch. This
    // covers the residue where no dispatch was possible at all.
    if (!res.ok && !entitlements.hasDeptChannels) {
      showEnterpriseUpgradePrompt({onViewPlans: openPricing});
    }
  };

  const openWorkspaceHub = () => {
    const hub = findNavigatorWithRoute(navigation, 'WorkspaceHub');
    if (hub) {
      (hub as {navigate: (name: string) => void}).navigate('WorkspaceHub');
      return;
    }
    if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
      navigationRef.dispatch(CommonActions.navigate('Main', {
        screen: 'MessengerTab',
        params: {screen: 'WorkspaceHub', initial: false},
      }));
      return;
    }
    openDeptChatNow();
  };

  // An AFFILIATED user (owns a workspace, or their org IS one) gets the
  // Workspace Hub. ONLY the unaffiliated arm is renamed: the hub arm stays
  // "Workspaces" because that destination is an organisations / invites / join
  // hub, and calling it "Channels" would both mislabel it and collide with the
  // "Channels" header one screen away.
  return isWorkspaceTenant(user)
    ? {icon: 'forum', label: 'Workspaces', pill: 'ENTERPRISE', go: () => leave(openWorkspaceHub)}
    : {
      icon: entitlements.hasDeptChannels ? 'forum' : 'lock-outline',
      label: 'Channels',
      pill: 'ENTERPRISE',
      dimmed: !entitlements.hasDeptChannels,
      go: () => leave(openDeptChatNow),
    };
}
