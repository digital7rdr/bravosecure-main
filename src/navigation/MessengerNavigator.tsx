import React from 'react';
import {Platform} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from './types';
import {Colors} from '@theme/colors';

import MessengerHomeScreen from '@screens/messenger/MessengerHomeScreen';
import ChatScreen from '@screens/messenger/ChatScreen';
import NewChatScreen from '@screens/messenger/NewChatScreen';
import VaultScreen from '@screens/messenger/VaultScreen';
import FileVaultPurchaseScreen from '@screens/messenger/FileVaultPurchaseScreen';
import CallScreen from '@screens/messenger/CallScreen';
import GroupCallScreen from '@screens/messenger/GroupCallScreen';
import IncomingGroupCallScreen from '@screens/messenger/IncomingGroupCallScreen';
import VaultLockScreen from '@screens/messenger/VaultLockScreen';
import VaultForgotScreen from '@screens/messenger/VaultForgotScreen';
import VaultOTPVerifyScreen from '@screens/messenger/VaultOTPVerifyScreen';
import VaultNewPinScreen from '@screens/messenger/VaultNewPinScreen';
import CallsLogScreen from '@screens/messenger/CallsLogScreen';
import LinksScreen from '@screens/messenger/LinksScreen';
import GroupsScreen from '@screens/messenger/GroupsScreen';
import ChatInfoScreen from '@screens/messenger/ChatInfoScreen';
import FilesScreen from '@screens/messenger/FilesScreen';
import VBGEmergencyScreen from '@screens/vbg/VBGEmergencyScreen';
import DepartmentChannelsScreen from '@screens/messenger/DepartmentChannelsScreen';
import ManageChannelsScreen from '@screens/deptchat/ManageChannelsScreen';
import EmployeesScreen from '@screens/deptchat/EmployeesScreen';
import ApprovalsScreen from '@screens/deptchat/ApprovalsScreen';
import JoinWorkspaceScreen from '@screens/deptchat/JoinWorkspaceScreen';
import EnterpriseSetupScreen from '@screens/deptchat/EnterpriseSetupScreen';
import CreateWorkspaceScreen from '@screens/deptchat/CreateWorkspaceScreen';
import ApprovalStatusScreen from '@screens/deptchat/ApprovalStatusScreen';
import WorkspaceHubScreen from '@screens/deptchat/WorkspaceHubScreen';
import InviteMemberScreen from '@screens/deptchat/InviteMemberScreen';
import DepartmentalNavigator from './DepartmentalNavigator';
import ChannelEditorScreen from '@screens/deptchat/ChannelEditorScreen';
import ChannelMembersScreen from '@screens/deptchat/ChannelMembersScreen';
import OrgCpoProfileScreen from '@screens/agent/OrgCpoProfileScreen';
import DepartmentChatScreen from '@screens/messenger/DepartmentChatScreen';
import VoiceCallScreen from '@screens/messenger/VoiceCallScreen';
import MessengerSettingsScreen from '@screens/messenger/MessengerSettingsScreen';
import BackupSetupScreen from '@screens/messenger/BackupSetupScreen';
import BackupRestoreScreen from '@screens/messenger/BackupRestoreScreen';
import NewsHubScreen from '@screens/news/NewsHubScreen';
import IntelFeedScreen from '@screens/news/IntelFeedScreen';
import NewsFeedScreen from '@screens/news/NewsFeedScreen';
import NewsArticleScreen from '@screens/news/NewsArticleScreen';
import NewsPreferencesScreen from '@screens/news/NewsPreferencesScreen';

const Stack = createNativeStackNavigator<MessengerStackParamList>();

export default function MessengerNavigator() {
  return (
    <Stack.Navigator
      // B-85 — MUST stay "MessengerHome". Without it, a cold deep-link
      // (notification tap / cross-tab hop targeting Main→MessengerTab→Chat
      // while this lazy tab was never mounted) seeds the stack as [Chat]
      // alone, so back has nothing to pop and bubbles to the tab
      // navigator's backBehavior="history" → lands on Dashboard instead
      // of the chat list. initialRouteName makes React Navigation seed
      // MessengerHome BENEATH the deep-linked screen.
      initialRouteName="MessengerHome"
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: Colors.background},
        // Freeze inactive screens so they stop rendering / fighting for the
        // main thread during transitions.
        freezeOnBlur: true,
        // Native slide feels faster and avoids the OLED "flash" that
        // cross-fade produces on dark backgrounds. Fabric is happy with
        // slide_from_right now that the Zustand infinite-loop bug is fixed.
        animation: 'slide_from_right',
        animationDuration: 220,
        // Round 7 / back-button audit — enable swipe-back globally on
        // Android. createNativeStackNavigator's default is OFF for
        // Android (iOS gets it for free), which is why swipe-from-edge
        // never popped any screen. Screens that must NOT be swipeable
        // (BackupRestore, VaultLock, IncomingGroupCall, CallScreen,
        // GroupCallScreen) opt out per-screen.
        gestureEnabled: true,
        // B-372 — Android-only: on iOS a full-screen recognizer turns EVERY
        // horizontal pan into a back-pop and fights the GroupCall tile pager
        // + FloatingCallOverlay drag; iOS keeps the standard edge swipe.
        fullScreenGestureEnabled: Platform.OS === 'android',
      }}>
      <Stack.Screen
        name="MessengerHome"
        component={MessengerHomeScreen}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
      />
      <Stack.Screen
        name="NewChat"
        component={NewChatScreen}
      />
      <Stack.Screen
        name="VaultScreen"
        component={VaultScreen}
      />
      <Stack.Screen
        name="FileVaultPurchase"
        component={FileVaultPurchaseScreen}
      />
      <Stack.Screen
        name="CallScreen"
        component={CallScreen}
        // Call screens own their own beforeRemove minimize-on-swipe
        // logic (BS-022); leave swipe ON so it can fire that path.
        options={{headerShown: false, animation: 'fade'}}
      />
      <Stack.Screen
        name="GroupCallScreen"
        component={GroupCallScreen}
        options={{headerShown: false, animation: 'fade'}}
      />
      <Stack.Screen
        name="IncomingGroupCallScreen"
        component={IncomingGroupCallScreen}
        // Disable swipe — the ring screen must dispatch
        // sfu.ring.decline through the explicit Decline button (or
        // hardware back), not get silently popped on a swipe.
        options={{headerShown: false, animation: 'fade', presentation: 'modal', gestureEnabled: false}}
      />
      <Stack.Screen
        name="VaultLock"
        component={VaultLockScreen}
        // Swipe must NOT bypass the lock — keep gestures off here so
        // the user has to authenticate (or hit hardware back, which
        // routes to MessengerHome).
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="VaultForgot"
        component={VaultForgotScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VaultOTPVerify"
        component={VaultOTPVerifyScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VaultNewPin"
        component={VaultNewPinScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CallsLog"
        component={CallsLogScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Links"
        component={LinksScreen}
        options={{headerShown: false}}
      />
      {/* Client 2026-08-22 — the Calls header's "Emergency" door. The same page
          Virtual Bodyguard shows (every country + search); it drops the VBG
          product footer outside that stack, whose tabs this one cannot resolve. */}
      <Stack.Screen
        name="EmergencyServices"
        component={VBGEmergencyScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Groups"
        component={GroupsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ChatInfo"
        component={ChatInfoScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Files"
        component={FilesScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="DepartmentChannels"
        component={DepartmentChannelsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="DepartmentChat"
        component={DepartmentChatScreen}
        /**
         * KEYED BY CHANNEL. Without this, `navigate('DepartmentChat', …)` for a
         * DIFFERENT channel reuses the mounted screen and only swaps its
         * params — and the screen seeds `groupConversationId`, `myRole` and
         * `postMode` into `useState` once, adopting a new group id only when
         * its own is null. So the header renamed itself to channel B while the
         * transcript, and every message SENT, stayed on channel A's Signal
         * group: delivery to the wrong member set, with the UI insisting
         * otherwise.
         *
         * Reachable from an ordinary notification tap (`fcmBootstrap`'s
         * navigateToThread) as well as from two quick opens racing each other.
         */
        getId={({params}) => (params as {channelId?: string} | undefined)?.channelId}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ManageChannels"
        component={ManageChannelsScreen}
        options={{headerShown: false}}
      />
      {/* vs2 item 6 — registered on BOTH shells. A route mounted in only one
          navigator is SILENTLY DROPPED when navigated from the other: the
          B-258 class this module has hit repeatedly. */}
      <Stack.Screen
        name="Employees"
        component={EmployeesScreen}
        options={{headerShown: false}}
      />
      {/* Scope v2 Phase 3 — the join → approve loop (A11 / M5 / M11A).
          JoinWorkspace and ApprovalStatus are reachable by someone who is NOT
          yet a member, so they must live in a shell an applicant can actually
          be in — this one.

          They are ALSO registered on DepartmentalNavigator's Channels stack
          (R6-2): every approver persona, owner and promoted manager alike, is
          routed into the Agent shell, which does not mount this navigator — so
          registering them only here meant no admin could open the inbox and the
          loop ended at "pending" forever. Duplicate names in separate
          navigators are legal; `openJoinFlowScreen` picks deterministically for
          in-app callers, and push taps route through `navigateToMessengerScreen`
          (messengerDeepLink owns the per-shell table) — those two resolvers are
          the only sanctioned ways to reach any of the three. */}
      <Stack.Screen
        name="Approvals"
        component={ApprovalsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="JoinWorkspace"
        component={JoinWorkspaceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="EnterpriseSetup"
        component={EnterpriseSetupScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CreateWorkspace"
        component={CreateWorkspaceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ApprovalStatus"
        component={ApprovalStatusScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="InviteMember"
        component={InviteMemberScreen}
        options={{headerShown: false}}
      />
      {/* F-WSHUB — the workspace list page (Discord/Slack style). Entering a
          workspace from it goes through the departmentalEntry resolvers. */}
      <Stack.Screen
        name="WorkspaceHub"
        component={WorkspaceHubScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Departmental"
        component={DepartmentalNavigator}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ChannelEditor"
        component={ChannelEditorScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ChannelMembers"
        component={ChannelMembersScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgCpoProfile"
        component={OrgCpoProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VoiceCall"
        component={VoiceCallScreen}
        options={{headerShown: false, animation: 'fade'}}
      />
      <Stack.Screen
        name="MessengerSettings"
        component={MessengerSettingsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BackupSetup"
        component={BackupSetupScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BackupRestore"
        component={BackupRestoreScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="NewsHub"
        component={NewsHubScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen name="IntelFeed"       component={IntelFeedScreen}       options={{headerShown: false}} />
      <Stack.Screen name="NewsFeed"        component={NewsFeedScreen}        options={{headerShown: false}} />
      <Stack.Screen name="NewsArticle"     component={NewsArticleScreen}     options={{headerShown: false}} />
      <Stack.Screen name="NewsPreferences" component={NewsPreferencesScreen} options={{headerShown: false}} />
    </Stack.Navigator>
  );
}
