/**
 * CpoNavigator (BUILD_RUNBOOK Step 17 / §35A) — the managed-guard shell: 4 bottom tabs
 * (On Duty / Mission / Comms / Me). Capability hiding (PR5) is STRUCTURAL — no booking
 * wizard, client wallet, job-offer accept, roster, assign-crew, or org-money screen is
 * registered here; a CPO simply cannot reach them. Comms reuses the existing messenger
 * stack (Ops Room). Tab CONTENTS for Duty/Mission/Me are fleshed out in the CPO-UI step;
 * this step ships the shell + the activation gate (in MainNavigator) + the mid-session
 * revocation re-check below.
 */
import React, {useEffect} from 'react';
import {View, StyleSheet} from 'react-native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useAuthStore} from '@store/authStore';
import MessengerNavigator from './MessengerNavigator';
import DepartmentalNavigator from './DepartmentalNavigator';
import OnDutyHomeScreen from '@screens/cpo/OnDutyHomeScreen';
import AssignedMissionDetailScreen from '@screens/cpo/AssignedMissionDetailScreen';
import AgentLiveTrackerScreen from '@screens/agent/AgentLiveTrackerScreen';
import OrgCpoProfileScreen from '@screens/agent/OrgCpoProfileScreen';
import CpoProMissionScreen from '@screens/cpo/CpoProMissionScreen';
import CpoProtectionScreen from '@screens/cpo/CpoProtectionScreen';
import CpoProtectionSessionScreen from '@screens/cpo/CpoProtectionSessionScreen';
import CpoProtectionHistoryScreen from '@screens/cpo/CpoProtectionHistoryScreen';
import AgentProfileScreen from '@screens/agent/AgentProfileScreen';
import {useDeptUnreadTotal} from '@screens/deptchat/useDeptUnread';
import type {CpoTabParamList, CpoRootStackParamList} from './types';
import {DEPT_CHAT_V2} from '@utils/constants';
import {ObsidianTabBar, type ObsidianTabIcon} from './ObsidianTabBar';

const Tab = createBottomTabNavigator<CpoTabParamList>();
const RootStack = createNativeStackNavigator<CpoRootStackParamList>();

// Icon map for the shared ObsidianTabBar — the SAME renderer the root app
// shell and DepartmentalNavigator use, so this bar is pixel-identical to those.
const TAB_ICONS: Record<string, ObsidianTabIcon> = {
  CpoDuty:    {default: 'radar',                        active: 'radar',                        label: 'On Duty'},
  CpoMission: {default: 'shield-account-outline',       active: 'shield-account',                label: 'Mission'},
  CpoComms:   {default: 'message-text-outline',         active: 'message-text',                  label: 'Comms'},
  CpoDept:    {default: 'office-building-outline',      active: 'office-building',                label: 'Dept'},
  CpoMe:      {default: 'account-circle-outline',       active: 'account-circle',                label: 'Me'},
};

// The Departmental module is its own tab navigator, so it can't be mounted as a
// nested tab here (double footer). This placeholder never renders content — the
// tab's tabPress listener preventDefaults and jumps to the full-screen root
// `Departmental` route instead (see CpoTabs below).
const DeptTabPlaceholder = () => <View style={styles.root} />;
const styles = StyleSheet.create({root: {flex: 1, backgroundColor: '#07090D'}});

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

// Default export = a thin native stack wrapping the 4-tab guard shell, so the
// dedicated Departmental module (Step 19) can be PUSHED full-screen over the tabs
// (its own footer, no nested-tab double footer) — reached from the On-Duty home.
// The four guard tabs live in CpoTabs below; capability lockdown (§35A §D) is
// unchanged (the source-scan test still sees exactly four <Tab.Screen>).
export default function CpoNavigator() {
  const recheckMembership = useAuthStore(s => s.recheckMembership);

  // §35A §F — mid-session revocation, mount-time check only. The foreground-
  // resume recheck now lives at the root (MainNavigator) so it covers EVERY
  // shell, not just this one — see RS-06. Keeping just the mount call here avoids
  // a double /auth/me on resume while still catching a guard suspended/removed
  // right before this shell mounts (force-logged-out via recheckMembership →
  // endCpoAccess).
  useEffect(() => {
    void recheckMembership();
  }, [recheckMembership]);

  return (
    <RootStack.Navigator screenOptions={{headerShown: false, freezeOnBlur: true, contentStyle: {backgroundColor: D.bg}}}>
      <RootStack.Screen name="CpoTabs" component={CpoTabs} />
      <RootStack.Screen name="Departmental" component={DepartmentalNavigator} />
      {/* Step 31 — the map-first live tracker (design), pushed over the tabs. */}
      <RootStack.Screen name="CpoLiveTracker" component={AgentLiveTrackerScreen} options={{animation: 'fade'}} />
      <RootStack.Screen name="OrgCpoProfile" component={OrgCpoProfileScreen} />
      {/* Bravo Secure Pro — mission-code gate + dedicated Pro mission view. */}
      <RootStack.Screen name="CpoProMission" component={CpoProMissionScreen} />
      {/* Protection sessions (spec §6) — overview + one live session (map + trail). */}
      <RootStack.Screen name="CpoProtection" component={CpoProtectionScreen} />
      <RootStack.Screen name="CpoProtectionSession" component={CpoProtectionSessionScreen} options={{animation: 'slide_from_right'}} />
      <RootStack.Screen name="CpoProtectionHistory" component={CpoProtectionHistoryScreen} options={{animation: 'slide_from_right'}} />
    </RootStack.Navigator>
  );
}

function CpoTabs() {
  const deptUnread = useDeptUnreadTotal();
  const deptBadge = deptUnread > 0 ? (deptUnread > 9 ? '9+' : deptUnread) : undefined;
  return (
    <Tab.Navigator
      sceneContainerStyle={{backgroundColor: D.bg}}
      screenOptions={{headerShown: false}}
      tabBar={props => <ObsidianTabBar {...props} icons={TAB_ICONS} bg={D.bg} accent={D.accent} mute={D.textMute} />}>
      <Tab.Screen name="CpoDuty" component={OnDutyHomeScreen} />
      <Tab.Screen name="CpoMission" component={AssignedMissionDetailScreen} />
      <Tab.Screen name="CpoComms" component={MessengerNavigator} />
      {/* Dark behind the flag, like every other Dept Chat v2 entry point (the
          agent-dashboard row and the On-Duty home card are already gated). */}
      {DEPT_CHAT_V2 ? (
        <Tab.Screen name="CpoDept" component={DeptTabPlaceholder}
          options={{tabBarBadge: deptBadge}}
          listeners={({navigation}) => ({
            tabPress: e => {
              e.preventDefault();
              // Land on the Channels tab (the channel LIST) so all the CPO's
              // channels show, rather than the workspace Home dashboard.
              navigation.navigate('Departmental', {screen: 'Channels'});
            },
          })} />
      ) : null}
      <Tab.Screen name="CpoMe" component={AgentProfileScreen} />
    </Tab.Navigator>
  );
}
