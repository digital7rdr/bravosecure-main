import React from 'react';
import {Platform} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {BookingStackParamList} from './types';
import {Colors} from '@theme/colors';

import BookingHomeScreen from '@screens/booking/BookingHomeScreen';
import ProDashboardScreen from '@screens/pro/ProDashboardScreen';
import ZoneMapScreen from '@screens/booking/ZoneMapScreen';
import AddOnsScreen from '@screens/booking/AddOnsScreen';
import BookingConfirmationScreen from '@screens/booking/BookingConfirmationScreen';
import TripSummaryScreen from '@screens/booking/TripSummaryScreen';
import BookingHistoryScreen from '@screens/booking/BookingHistoryScreen';
import MissionCompleteScreen from '@screens/booking/MissionCompleteScreen';
import InvoiceScreen from '@screens/booking/InvoiceScreen';
import RateAgencyScreen from '@screens/booking/RateAgencyScreen';
import SettingsScreen from '@screens/settings/SettingsScreen';
import CreditsScreen from '@screens/wallet/CreditsScreen';
import PaymentMethodsScreen from '@screens/wallet/PaymentMethodsScreen';
import LiveTrackingScreen from '@screens/liveops/LiveTrackingScreen';
import SOSScreen from '@screens/liveops/SOSScreen';
import TripHistoryScreen from '@screens/pro/TripHistoryScreen';
import VBGHomeScreen from '@screens/vbg/VBGHomeScreen';
import VBGMapScreen from '@screens/vbg/VBGMapScreen';
import VBGSRAScreen from '@screens/vbg/VBGSRAScreen';
import VBGOSINTScreen from '@screens/vbg/VBGOSINTScreen';
import VBGNearbyScreen from '@screens/vbg/VBGNearbyScreen';
import VBGGeoRiskScreen from '@screens/vbg/VBGGeoRiskScreen';
import VBGEmergencyScreen from '@screens/vbg/VBGEmergencyScreen';
import ProAssignedTeamScreen from '@screens/pro/ProAssignedTeamScreen';
import ProLiveMissionScreen from '@screens/pro/ProLiveMissionScreen';
import ProtectionHistoryScreen from '@screens/pro/ProtectionHistoryScreen';
import IndividualProfileScreen from '@screens/settings/IndividualProfileScreen';
import CorporateProfileScreen from '@screens/settings/CorporateProfileScreen';
import OpsDashboardScreen from '@screens/ops/OpsDashboardScreen';
import OpsMissionDetailScreen from '@screens/ops/OpsMissionDetailScreen';
import OpsRoomReviewScreen from '@screens/ops/OpsRoomReviewScreen';
import ProActivityHistoryScreen from '@screens/pro/ProActivityHistoryScreen';
import CreditPaywallScreen from '@screens/booking/CreditPaywallScreen';
import PricingScreen from '@screens/settings/PricingScreen';
import TierPaywallScreen from '@screens/pro/TierPaywallScreen';
import ServiceTypeScreen from '@screens/booking/ServiceTypeScreen';
import BaselinePackageScreen from '@screens/booking/BaselinePackageScreen';
import CustomizeAddOnsScreen from '@screens/booking/CustomizeAddOnsScreen';
import BookingDateTimeScreen from '@screens/booking/BookingDateTimeScreen';
import LocationPickerScreen from '@screens/booking/LocationPickerScreen';
import FindingDetailScreen from '@screens/booking/FindingDetailScreen';
import NoDetailScreen from '@screens/booking/NoDetailScreen';
import AgencyAcceptedScreen from '@screens/booking/AgencyAcceptedScreen';
import ActivityCenterScreen from '@screens/activity/ActivityCenterScreen';
import SecureLandingScreen from '@screens/securepro/SecureLandingScreen';
import SecureTabNavigator from './SecureTabNavigator';
import SecureServicesScreen from '@screens/securepro/SecureServicesScreen';
import SecureLuxScreen from '@screens/securepro/SecureLuxScreen';
import SecureProIntroScreen from '@screens/securepro/SecureProIntroScreen';
import SecureProApplyScreen from '@screens/securepro/SecureProApplyScreen';
import SecureProStatusScreen from '@screens/securepro/SecureProStatusScreen';
import SecureProProposalScreen from '@screens/securepro/SecureProProposalScreen';
import SecureProPaymentScreen from '@screens/securepro/SecureProPaymentScreen';
import SecureProMembersScreen from '@screens/securepro/SecureProMembersScreen';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import SecureProMissionsScreen from '@screens/securepro/SecureProMissionsScreen';
import ExecDurationScreen from '@screens/executive/ExecDurationScreen';
import ExecScheduleScreen from '@screens/executive/ExecScheduleScreen';
import ExecTaskScreen from '@screens/executive/ExecTaskScreen';
import ExecTransportScreen from '@screens/executive/ExecTransportScreen';
import ExecTeamScreen from '@screens/executive/ExecTeamScreen';
import ExecReviewScreen from '@screens/executive/ExecReviewScreen';

const Stack = createNativeStackNavigator<BookingStackParamList>();

export default function BookingNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: Colors.surface},
        headerTintColor: Colors.textPrimary,
        headerShadowVisible: false,
        contentStyle: {backgroundColor: Colors.background},
        // Round 7 / back-button audit — enable Android swipe-back.
        gestureEnabled: true,
        // B-372 — Android-only; iOS keeps the standard edge swipe so
        // horizontal pans (sliders, map drags, carousels) can't back-pop.
        fullScreenGestureEnabled: Platform.OS === 'android',
        // NAV-23 (2026-08-26 audit) — blurred screens must not keep rendering
        // through the pop transition (MessengerNavigator has carried this since
        // MX-13; the other stacks never got it).
        freezeOnBlur: true,
      }}>
      <Stack.Screen
        name="BookingHome"
        component={BookingHomeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProDashboard"
        component={ProDashboardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="TripHistory"
        component={TripHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VBGHome"
        component={VBGHomeScreen}
        // animation:'none' — VBG screens are a footer "tab group"; a tab tap
        // should swap content instantly, not slide like a page push.
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGMap"
        component={VBGMapScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProAssignedTeam"
        component={ProAssignedTeamScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProLiveMission"
        component={ProLiveMissionScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProtectionHistory"
        component={ProtectionHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VBGSRA"
        component={VBGSRAScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGOSINT"
        component={VBGOSINTScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGNearby"
        component={VBGNearbyScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGGeoRisk"
        component={VBGGeoRiskScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGEmergency"
        component={VBGEmergencyScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="IndividualProfile"
        component={IndividualProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CorporateProfile"
        component={CorporateProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ZoneMap"
        component={ZoneMapScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AddOns"
        component={AddOnsScreen}
        options={{title: 'Add-Ons'}}
      />
      <Stack.Screen
        name="BookingConfirmation"
        component={BookingConfirmationScreen}
        // BB-9 — the wizard is PUSHED beneath and its Confirm step stays
        // live: a back swipe from a PAID booking offered to book it again.
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="TripSummary"
        component={TripSummaryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BookingHistory"
        component={BookingHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="MissionComplete"
        component={MissionCompleteScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="Invoice"
        component={InvoiceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="RateAgency"
        component={RateAgencyScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Credits"
        component={CreditsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="PaymentMethods"
        component={PaymentMethodsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="LiveTracking"
        component={LiveTrackingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SOSScreen"
        component={SOSScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsDashboard"
        component={OpsDashboardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsMissionDetail"
        component={OpsMissionDetailScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsRoomReview"
        component={OpsRoomReviewScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProActivityHistory"
        component={ProActivityHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CreditPaywall"
        component={CreditPaywallScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Pricing"
        component={PricingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="TierPaywall"
        component={TierPaywallScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ServiceType"
        component={ServiceTypeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BaselinePackage"
        component={BaselinePackageScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CustomizeAddOns"
        component={CustomizeAddOnsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BookingDateTime"
        component={BookingDateTimeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="LocationPicker"
        component={LocationPickerScreen}
        options={{headerShown: false, presentation: 'modal', animation: 'slide_from_bottom'}}
      />
      {/* Step 19 — client auto-dispatch flow. Back-gesture is disabled on Finding while
          the search is live (managed inside the screen), so no swipe out mid-search. */}
      <Stack.Screen
        name="FindingDetail"
        component={FindingDetailScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="AgencyAccepted"
        component={AgencyAcceptedScreen}
        // BB-9 — same stale-wizard hazard as BookingConfirmation.
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="NoDetail"
        component={NoDetailScreen}
        options={{headerShown: false}}
      />
      {/* N-18/GAP-3 — the notification centre behind the header bell. The
          store/sync/server inbox all pre-existed; this route was the dead
          link that kept the whole feature unreachable. */}
      <Stack.Screen
        name="ActivityCenter"
        component={ActivityCenterScreen}
        options={{headerShown: false}}
      />
      {/* Tier-aware landing resolver — the Secure product's seeded entry. It
          resolves the Pro/Lite gate and swaps itself for ProDashboard or
          BookingHome; animation:'none' so it reads as a direct landing, not a
          screen that slides in and back out. */}
      <Stack.Screen
        name="SecureLanding"
        component={SecureLandingScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      {/* Wave 5d (PDF-2 A7) — the LITE 4-tab shell (Home · Book · Summary ·
          Messenger). Full-screen (its own ObsidianTabBar is the only footer);
          animation:'none' so the resolver's reset reads as a direct landing, not
          a slide. The deeper booking routes stay in THIS stack, so drilling in
          from a shell tab bubbles up here and resolves unchanged. NOT the stack's
          initial route — BookingHome stays first so every deep-linked booking
          screen still seeds it beneath (the cold-stack-seed rule). */}
      <Stack.Screen
        name="SecureShell"
        component={SecureTabNavigator}
        options={{headerShown: false, animation: 'none'}}
      />
      {/* Bravo Secure Pro — request-and-approval custom plan flow. */}
      <Stack.Screen
        name="SecureServices"
        component={SecureServicesScreen}
        options={{headerShown: false}}
      />
      {/* Bravo Secure Lux — coming-soon premium-tier teaser. */}
      <Stack.Screen
        name="SecureLux"
        component={SecureLuxScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProIntro"
        component={SecureProIntroScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProApply"
        component={SecureProApplyScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProStatus"
        component={SecureProStatusScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProProposal"
        component={SecureProProposalScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProPayment"
        component={SecureProPaymentScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProMembers"
        component={SecureProMembersScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProCalendar"
        component={SecureProCalendarScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SecureProMissions"
        component={SecureProMissionsScreen}
        options={{headerShown: false}}
      />
      {/* Executive Protection — executive protection in fixed 3–24 h time blocks. */}
      <Stack.Screen
        name="ExecDuration"
        component={ExecDurationScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ExecSchedule"
        component={ExecScheduleScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ExecTask"
        component={ExecTaskScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ExecTransport"
        component={ExecTransportScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ExecTeam"
        component={ExecTeamScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ExecReview"
        component={ExecReviewScreen}
        options={{headerShown: false}}
      />
    </Stack.Navigator>
  );
}
