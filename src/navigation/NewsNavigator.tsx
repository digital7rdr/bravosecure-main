import React from 'react';
import {Platform} from 'react-native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {NewsStackParamList} from './types';
import {Colors} from '@theme/colors';

import NewsHubScreen from '@screens/news/NewsHubScreen';
import NewsFeedScreen from '@screens/news/NewsFeedScreen';
import NewsArticleScreen from '@screens/news/NewsArticleScreen';
import IntelFeedScreen from '@screens/news/IntelFeedScreen';
import NewsPreferencesScreen from '@screens/news/NewsPreferencesScreen';

const Stack = createNativeStackNavigator<NewsStackParamList>();

export default function NewsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: Colors.background},
        // Round 7 / back-button audit — enable Android swipe-back.
        gestureEnabled: true,
        // B-372 — Android-only; iOS keeps the standard edge swipe so
        // horizontal carousels (country chips, article strips) can't back-pop.
        fullScreenGestureEnabled: Platform.OS === 'android',
        // NAV-23 (2026-08-26 audit) — blurred screens must not keep rendering
        // through the pop transition (MessengerNavigator has carried this since
        // MX-13; the other stacks never got it).
        freezeOnBlur: true,
      }}>
      <Stack.Screen name="NewsHub" component={NewsHubScreen} />
      <Stack.Screen name="NewsFeed" component={NewsFeedScreen} />
      <Stack.Screen name="NewsArticle" component={NewsArticleScreen} />
      <Stack.Screen name="IntelFeed" component={IntelFeedScreen} />
      <Stack.Screen name="NewsPreferences" component={NewsPreferencesScreen} />
    </Stack.Navigator>
  );
}
