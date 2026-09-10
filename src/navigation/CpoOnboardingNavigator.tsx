/**
 * CPO onboarding — the document-upload flow a managed CPO walks before they reach the
 * CpoNavigator home. A managed CPO is seeded DOCS_PENDING with a compliance pack
 * (org-cpo.service.ts), but the org supplies their identity, so they SKIP the agency
 * self-signup wizard (type-select / coverage) and start straight at the doc upload.
 *
 * Reuses the existing agent onboarding screens + their working backend endpoints
 * (POST /agents/me/documents, /agents/me/submit; ops decides via /ops/agents/:id/decide).
 * Routed here by resolveAuthedRoute === 'cpo-onboarding' (account_kind='cpo' AND
 * cpo_needs_onboarding). Once ops approves (agent status → ACTIVE), an /auth/me refresh
 * flips cpo_needs_onboarding=false and MainNavigator swaps to CpoNavigator.
 */
import React, {useEffect} from 'react';
import {View, StyleSheet} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {AgentStackParamList} from './types';
import {Colors} from '@theme/colors';
import {useAuthStore} from '@store/authStore';
import LoadingView from '@components/LoadingView';

import AgentDocsUploadScreen from '@screens/agent/AgentDocsUploadScreen';
import AgentAdminApprovalScreen from '@screens/agent/AgentAdminApprovalScreen';
import AgentVerificationStatusScreen from '@screens/agent/AgentVerificationStatusScreen';
import AgentVerifiedScreen from '@screens/agent/AgentVerifiedScreen';
import AgentRejectedScreen from '@screens/agent/AgentRejectedScreen';

const Stack = createNativeStackNavigator<AgentStackParamList>();

// The shared agency screens navigate to 'AgentDashboard' once an agent is approved.
// For a managed CPO that destination is wrong — they belong on the CPO home. Re-fetch
// /auth/me (recheckMembership) so cpo_needs_onboarding flips false and MainNavigator
// re-routes to CpoNavigator; render a spinner while that resolves.
function ApprovedRedirect() {
  const recheckMembership = useAuthStore(s => s.recheckMembership);
  useEffect(() => { void recheckMembership(); }, [recheckMembership]);
  return (
    <View style={s.center}>
      <LoadingView label="Checking your status…" />
    </View>
  );
}

export default function CpoOnboardingNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="AgentDocsUpload"
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: Colors.background},
        gestureEnabled: true,
        // NAV-23 (2026-08-26 audit) — blurred screens must not keep rendering
        // through the pop transition (MessengerNavigator has carried this since
        // MX-13; the other stacks never got it).
        freezeOnBlur: true,
      }}>
      <Stack.Screen name="AgentDocsUpload" component={AgentDocsUploadScreen} />
      {/* Terminal waiting state — no swipe-back (B-199); the screen swallows the
          hardware back too and auto-advances when ops decides. */}
      <Stack.Screen name="AgentAdminApproval" component={AgentAdminApprovalScreen} options={{gestureEnabled: false}} />
      <Stack.Screen name="AgentVerificationStatus" component={AgentVerificationStatusScreen} />
      <Stack.Screen name="AgentVerified" component={AgentVerifiedScreen} />
      <Stack.Screen name="AgentRejected" component={AgentRejectedScreen} />
      {/* Intercept the agency screens' "approved → dashboard" hop and send the CPO home. */}
      <Stack.Screen name="AgentDashboard" component={ApprovedRedirect} />
    </Stack.Navigator>
  );
}

const s = StyleSheet.create({
  center: {flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center'},
});
