/**
 * B-91 M0/M1 — the shared left-side profile drawer (spec pp.12/21/26).
 *
 * One drawer component, mounted by MessengerHomeScreen — which is itself
 * shared across THREE different navigation shells: the standalone client
 * Messenger product, the agency Agent Portal (AgentNavigator), and the CPO
 * tab shell (CpoNavigator). Only the client shell has "products" to switch
 * between (Messenger / Secure Services / Virtual Bodyguard) or a Bravo Pro
 * paywall to upsell — an agency/CPO account has neither, so those rows are
 * dead ends there (no matching route in their stacks) and the SwitchDashboard
 * section is a distinct product model that doesn't apply. Branch on
 * `account_kind` instead of assuming the client shell.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Image, ScrollView} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {CommonActions, useNavigation} from '@react-navigation/native';
import {useAuthStore} from '@store/authStore';
import {confirmSwitchDashboard} from '@utils/alert';
import {isWorkspaceTenant} from '@screens/deptchat/workspaceTenant';
import {SwitchDashboardSection} from '@components/SwitchDashboardSection';
import {resolveAuthedRoute} from '@navigation/resolveRoute';
import {findNavigatorWithRoute, openDepartmentChannels} from '@navigation/departmentalEntry';
import {navigationRef, mountedTreeHasRoute} from '@navigation/navigationRef';
import {useEntitlements, showEnterpriseUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';
import type {BravoProduct} from '@store/productStore';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Veto a product switch (e.g. unsaved booking). */
  switchGuard?: (next: BravoProduct) => boolean;
}

type MenuRow = {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  go: () => void;
  /** Small right-aligned tag, e.g. ENTERPRISE on Departmental Chat. */
  pill?: string;
  /** Dimmed when the account is not entitled (the row still opens the upsell). */
  dimmed?: boolean;
  /**
   * vs2 edge A6 — this row LEAVES the current surface, so it confirms first.
   *
   * The same physical row (Workspaces / Channels) is rendered twice: the client
   * arm draws it inside `SwitchDashboardSection`'s `extraRow`, which wires the
   * confirm by hand, and the provider arm draws it through the `rows` map,
   * which did not. So one persona was asked and the other was teleported.
   */
  confirm?: boolean;
};

export function ProfileDrawerModal({visible, onClose, switchGuard}: Props) {
  const insets = useSafeAreaInsets();
  // `getParent`/`getState` are REQUIRED, not decorative: openDepartmentChannels
  // resolves 'DepartmentChannels' against the navigator tree that is actually
  // mounted. This drawer is hosted by the messenger, booking AND VBG shells, and
  // only the messenger stack registers that route — a `{navigate}`-only handle
  // typechecks fine while making every candidate miss, which is Issue 18 (a
  // silently dropped navigate) all over again.
  const navigation = useNavigation<{
    navigate: (name: string, params?: object) => void;
    getParent: () => never;
    getState: () => never;
  }>();
  const {user, signOut} = useAuthStore();
  const entitlements = useEntitlements();

  const initials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';

  const go = (name: string, params?: object) => {
    onClose();
    // NAV-08 (2026-08-26 audit) — a back press inside the 220 ms window pops
    // the hosting screen; the timer must not then navigate on its behalf. The
    // handle is typed narrowly above, so isFocused is probed dynamically.
    setTimeout(() => {
      const isFocused = (navigation as unknown as {isFocused?: () => boolean}).isFocused;
      if (isFocused && !isFocused.call(navigation)) {return;}
      navigation.navigate(name, params);
    }, 220);
  };

  // Agency owners/managers and CPOs are provider accounts, not client
  // subscribers — no bookings to list, no Pro tier to sell, and no product
  // to switch away from. They get their real identity + a way back to the
  // shell root instead.
  //
  // MUST match MainNavigator's own shell decision exactly, not just
  // `account_kind === 'agency'` — a legacy self-signup agent (role 'agent'/
  // 'service_provider') is mounted inside AgentNavigator via resolveAuthedRoute's
  // fallback even though account_kind hasn't flipped server-side yet. Checking
  // account_kind alone put that account back in the client-shaped drawer
  // (My Bookings / Bravo Pro / Switch Dashboard) despite living in the agency
  // shell the whole time.
  const authedRoute = resolveAuthedRoute({
    accountKind: user?.account_kind,
    mustSetPassword: user?.must_set_password,
    membershipStatus: user?.membership_status,
    cpoNeedsOnboarding: user?.cpo_needs_onboarding,
    legacyRole: user?.role,
    hasWorkspaceAffiliation: user?.owns_workspace === true || (user?.workspaces?.length ?? 0) > 0,
  });
  const isProvider = authedRoute === 'agency' || authedRoute === 'cpo';
  const dashboardRoute = authedRoute === 'cpo' ? 'CpoDuty' : 'AgentDashboard';
  // CPO's shell has a real "Me" tab (CpoMe); agency gets the dedicated
  // AgentProfile screen registered in AgentNavigator.
  const profileRoute = authedRoute === 'cpo' ? 'CpoMe' : 'AgentProfile';

  // Founder 2026-08-04: no "Bravo Secure Pro" row here — Pro is reached via
  // Switch Dashboard → Secure Services (one sanctioned path, no duplicate entry).
  // Founder 2026-08-05 — Departmental Chat moved OFF the Groups screen and into
  // the drawer. It is a workspace-level destination, not one of "your groups",
  // and it sat above the group list pushing the real content down. Entitlement
  // only DIMS the row: a non-entitled user may be holding a printed induction
  // code, so the tap still runs the resolver and only falls back to the upsell
  // when there is genuinely no door (same two-branch behaviour the banner had —
  // this is a move, not a redesign).
  const openDeptChatNow = () => {
    // Founder QA 2026-08-08 — a workspace member/owner gets their DASHBOARD
    // (Home tab: counts, announcements, quick actions); everyone else keeps
    // the directory, which owns the join gate and the upsell.
    const res = openDepartmentChannels(navigation, {preferHome: entitlements.isOrgAffiliated});
    // Torn-tree fallback ONLY. Since the resolver gained its sibling branch
    // (2026-08-07) every mounted shell has a door, so a non-entitled user now
    // LANDS on the DepartmentChannels gate — which owns the live Enterprise
    // pitch ("View Enterprise plans" → pricing). This modal remains for the
    // one residue where no dispatch was possible at all (mid-logout /
    // pre-ready ref), so the locked row is still never a dead tap there.
    if (!res.ok && !entitlements.hasDeptChannels) {
      showEnterpriseUpgradePrompt({onViewPlans: openPricing});
    }
  };
  const openDeptChat = () => {
    onClose();
    setTimeout(openDeptChatNow, 220);
  };

  // F-WSHUB — an AFFILIATED user (owns a workspace, or their org IS one —
  // both flags the drawer already holds; no myInvites fetch here) gets the
  // Workspace Hub. Resolved against the mounted tree like every other
  // cross-shell destination: the hub route lives on MessengerNavigator, and
  // this drawer is also hosted by the booking/VBG shells (sibling branch) and
  // the Agent/CPO shells (no hub route — fall back to the existing entry).
  const hasWorkspaceAffiliation = isWorkspaceTenant(user);
  const openWorkspaceHub = () => {
    onClose();
    setTimeout(() => {
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
    }, 220);
  };

  const deptRow: MenuRow = hasWorkspaceAffiliation
    ? {
      icon: 'forum',
      label: 'Workspaces',
      pill: 'ENTERPRISE',
      go: openWorkspaceHub,
      confirm: true,
    }
    : {
      icon: entitlements.hasDeptChannels ? 'forum' : 'lock-outline',
      // vs2 item 18 — ONLY the unaffiliated arm is renamed. The hub arm stays
      // "Workspaces": that destination is an organisations / invites / join
      // hub, and calling it "Channels" would both mislabel it and collide with
      // item 17's "Channels" header one screen away.
      label: 'Channels',
      pill: 'ENTERPRISE',
      dimmed: !entitlements.hasDeptChannels,
      go: openDeptChat,
      confirm: true,
    };

  /**
   * vs2 item 18 — the CLIENT drawer moves this row down into SWITCH DASHBOARD;
   * the PROVIDER drawer keeps it where it is.
   *
   * Not symmetry for its own sake: the provider drawer has no switch section at
   * all (it renders "Return to Dashboard" instead), so moving the row there
   * would delete a provider's only workspace door.
   */
  const rows: MenuRow[] = isProvider
    ? [{icon: 'account', label: 'My Profile', go: () => go(profileRoute)}, deptRow]
    : [
      {icon: 'account', label: 'My Profile', go: () => go('ProfileTab')},
      // Why: BookingHome is the NEW-booking wizard and the default SecureTab
      // landing, so routing there was a silent no-op. BookingHistory is the list.
      // N3 — `initial: false` seeds BookingHome BENEATH BookingHistory in the
      // lazy Booking stack; without it the stack initialises AT BookingHistory
      // and back falls out of the stack (the cold-stack-seed rule).
      {icon: 'calendar', label: 'My Bookings', go: () => go('SecureTab', {screen: 'BookingHistory', initial: false})},
    ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close drawer">
        <Pressable
          style={[s.panel, {paddingTop: insets.top + 18, paddingBottom: insets.bottom + 16}]}
          onPress={e => e.stopPropagation()}>
          {/* Identity */}
          <View style={s.identity}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={s.avatar} />
            ) : (
              <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarText}>{initials}</Text>
              </View>
            )}
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.name} numberOfLines={1}>{user?.full_name ?? 'Bravo user'}</Text>
              <Text style={s.email} numberOfLines={1}>{user?.email ?? ''}</Text>
            </View>
          </View>

          <ScrollView style={{flex: 1}} showsVerticalScrollIndicator={false}>
            {rows.map(row => (
              <TouchableOpacity
                key={row.label}
                style={[s.row, row.dimmed && s.rowDimmed]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={row.pill ? `${row.label}, ${row.pill}` : row.label}
                // The shared helper — NOT a second implementation. Note the
                // client arm renders this same row through `extraRow` below
                // with its own hand-wired confirm; the two never both fire
                // because `rows` only carries `deptRow` on the provider arm.
                // Unify the two renderers and you must drop one of the calls.
                onPress={() => (row.confirm ? confirmSwitchDashboard(row.label, row.go) : row.go())}>
                <View style={s.rowLeft}>
                  <Icon name={row.icon} size={19} color="#5B8DEF" />
                  <Text style={s.rowLabel} numberOfLines={1}>{row.label}</Text>
                </View>
                <View style={s.rowRight}>
                  {row.pill ? (
                    <View style={s.rowPill}><Text style={s.rowPillText}>{row.pill}</Text></View>
                  ) : null}
                  <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
                </View>
              </TouchableOpacity>
            ))}

            <View style={{marginTop: 18}}>
              {isProvider ? (
                <TouchableOpacity
                  style={s.row}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Return to dashboard"
                  // vs2 edge A6 — leaves the current surface, so it asks first,
                  // through the same helper the client drawer uses.
                  // Proper noun, like every other site (Workspaces / Channels /
                  // Secure Services): "Go to your dashboard?" read as a typo
                  // beside them, and the row itself says "Return to Dashboard".
                  onPress={() => confirmSwitchDashboard('Dashboard', () => go(dashboardRoute))}>
                  <View style={s.rowLeft}>
                    <Icon name="view-dashboard-outline" size={19} color="#5B8DEF" />
                    <Text style={s.rowLabel}>Return to Dashboard</Text>
                  </View>
                  <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
                </TouchableOpacity>
              ) : (
                <SwitchDashboardSection
                  guard={switchGuard}
                  onSwitched={() => onClose()}
                  extraRow={
                    <TouchableOpacity
                      // paddingHorizontal 4 to match the product rows it now sits
                      // under — the drawer's own rows have none, so the moved row's
                      // icon sat 4dp inboard of everything above it.
                      style={[s.row, {paddingHorizontal: 4}, deptRow.dimmed && s.rowDimmed]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={deptRow.pill ? `${deptRow.label}, ${deptRow.pill}` : deptRow.label}
                      // vs2 item 18 — the confirm hangs off `go`, NOT off the
                      // label. This row is a ternary and only the unaffiliated
                      // arm is called "Channels", so wiring by label would have
                      // left the workspace-affiliated user — most of the
                      // enterprise audience — with no confirm from the same
                      // physical row.
                      onPress={() => confirmSwitchDashboard(deptRow.label, deptRow.go)}>
                      <View style={s.rowLeft}>
                        <Icon name={deptRow.icon} size={19} color="#5B8DEF" />
                        <Text style={s.rowLabel}>{deptRow.label}</Text>
                      </View>
                      <View style={s.rowRight}>
                        {deptRow.pill ? (
                          <View style={s.rowPill}><Text style={s.rowPillText}>{deptRow.pill}</Text></View>
                        ) : null}
                        <Icon name="chevron-right" size={17} color="rgba(180,188,204,0.45)" />
                      </View>
                    </TouchableOpacity>
                  }
                />
              )}
            </View>
          </ScrollView>

          <TouchableOpacity
            style={s.logout}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Log out"
            onPress={() => { onClose(); void signOut(); }}>
            <Icon name="logout" size={18} color="#FF5D5D" />
            <Text style={s.logoutText}>Log Out</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row'},
  panel: {
    width: '78%', maxWidth: 340, height: '100%',
    backgroundColor: '#07090D', paddingHorizontal: 18,
    borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.08)',
  },
  identity: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingBottom: 16, marginBottom: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  avatar: {width: 46, height: 46, borderRadius: 23},
  avatarFallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  avatarText: {color: '#A9C5FF', fontSize: 15, fontWeight: '800'},
  name: {color: '#F2F4F8', fontSize: 15, fontWeight: '700'},
  email: {color: 'rgba(180,188,204,0.45)', fontSize: 11.5, marginTop: 2},
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowLeft: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12},
  rowLabel: {flexShrink: 1, minWidth: 0, color: '#F2F4F8', fontSize: 14, fontWeight: '600'},
  // Departmental Chat row (moved here from the Groups screen, 2026-08-05).
  rowRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowDimmed: {opacity: 0.55},
  rowPill: {backgroundColor: '#2F5BE0', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2},
  rowPillText: {color: '#FFFFFF', fontSize: 9, fontWeight: '800', letterSpacing: 0.8},
  logout: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    height: 48, borderRadius: 14, marginTop: 12,
    backgroundColor: 'rgba(255,93,93,0.07)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.26)',
  },
  logoutText: {color: '#FF5D5D', fontSize: 13.5, fontWeight: '700'},
});
