import React from 'react';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import TierPaywall from './TierPaywall';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'TierPaywall'>;
type Rt = RouteProp<BookingStackParamList, 'TierPaywall'>;

/**
 * M1A — in-app upgrade route (Settings → Pricing, locked-feature prompts).
 * Thin wrapper: the standalone post-auth ask renders <TierPaywall> directly
 * from MainNavigator; this gives the same flow a navigable address.
 */
export default function TierPaywallScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const {tier, returnTo} = route.params;

  const close = () => {
    if (returnTo) {
      navigation.navigate(returnTo as never);
    } else {
      navigation.goBack();
    }
  };

  return <TierPaywall tier={tier} onDone={close} onBack={() => navigation.goBack()} />;
}
