import React from 'react';
import {Platform} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {AuthStackParamList} from './types';

import SplashScreen from '@screens/auth/SplashScreen';
import OnboardingScreen from '@screens/auth/OnboardingScreen';
import LoginScreen from '@screens/auth/LoginScreen';
import RegisterScreen from '@screens/auth/RegisterScreen';
import OTPVerificationScreen from '@screens/auth/OTPVerificationScreen';
import OtpVerifyScreen from '@screens/auth/OtpVerifyScreen';
import RoleSelectionScreen from '@screens/auth/RoleSelectionScreen';
import ProfileCompletionScreen from '@screens/auth/ProfileCompletionScreen';
import HomeSelectionScreen from '@screens/auth/HomeSelectionScreen';
import SignupSuccessScreen from '@screens/auth/SignupSuccessScreen';
import PermissionsScreen from '@screens/auth/PermissionsScreen';

const Stack = createNativeStackNavigator<AuthStackParamList>();

export default function AuthNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Splash"
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        contentStyle: {backgroundColor: '#0A0A0F'},
        // Round 7 / back-button audit — enable Android swipe-back
        // globally. createNativeStackNavigator's Android default is
        // OFF; without this every screen ignores the swipe gesture.
        gestureEnabled: true,
        // B-372 — Android-only; iOS keeps the standard edge swipe so
        // horizontal pans can't back-pop.
        fullScreenGestureEnabled: Platform.OS === 'android',
        // NAV-23 (2026-08-26 audit) — blurred screens must not keep rendering
        // through the pop transition (MessengerNavigator has carried this since
        // MX-13; the other stacks never got it).
        freezeOnBlur: true,
      }}>
      <Stack.Screen name="Splash" component={SplashScreen} />
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
      <Stack.Screen name="OTPVerification" component={OTPVerificationScreen} />
      <Stack.Screen name="OtpVerify" component={OtpVerifyScreen} />
      <Stack.Screen name="RoleSelection" component={RoleSelectionScreen} />
      <Stack.Screen name="ProfileCompletion" component={ProfileCompletionScreen} />
      <Stack.Screen name="HomeSelection" component={HomeSelectionScreen} />
      <Stack.Screen name="SignupSuccess" component={SignupSuccessScreen} />
      <Stack.Screen name="Permissions" component={PermissionsScreen} />
    </Stack.Navigator>
  );
}
