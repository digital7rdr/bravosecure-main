/**
 * N-31 — a denied POST_NOTIFICATIONS grant (or a blocked "Messages" channel)
 * was silently swallowed after onboarding: no banner, no re-ask, no settings
 * link — indistinguishable from "notifications are broken". This banner checks
 * the live notification-settings state on focus and, when notifications are
 * off, offers a one-tap deep-link to system settings. Dismissible per session.
 */
import React, {useState, useCallback} from 'react';
import {View, Text, TouchableOpacity, Linking, Platform, StyleSheet} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

export default function NotificationPermissionBanner() {
  const [blocked, setBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (Platform.OS !== 'android') {return;}
      const notifeeMod = require('@notifee/react-native') as {
        default: {
          getNotificationSettings: () => Promise<{authorizationStatus: number}>;
          getChannel: (id: string) => Promise<{blocked?: boolean} | null>;
        };
        AuthorizationStatus: {DENIED: number};
      };
      const check = async () => {
        try {
          const notifee = notifeeMod.default;
          const settings = await notifee.getNotificationSettings();
          let denied = settings.authorizationStatus === notifeeMod.AuthorizationStatus.DENIED;
          // Notifications on, but the Messages channel specifically blocked.
          try {
            const ch = await notifee.getChannel('bravo-messages');
            if (ch?.blocked) {denied = true;}
          } catch { /* channel not created yet — ignore */ }
          if (!cancelled) {setBlocked(denied);}
        } catch {
          if (!cancelled) {setBlocked(false);}
        }
      };
      check().catch(() => { /* best-effort */ });
      return () => { cancelled = true; };
    }, []),
  );

  if (!blocked || dismissed) {return null;}
  return (
    <View style={s.wrap}>
      <Icon name="bell-off-outline" size={16} color="#FCA5A5" />
      <Text style={s.text} numberOfLines={2}>
        Notifications are off — you won't get message or call alerts.
      </Text>
      <TouchableOpacity onPress={() => { Linking.openSettings().catch(() => { /* ignore */ }); }} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Text style={s.action}>Settings</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setDismissed(true)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="close" size={15} color="#94A3B8" />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(239,68,68,0.25)',
  },
  text: {flex: 1, color: '#F5D6D6', fontSize: 12.5},
  action: {color: '#5B8DEF', fontSize: 12.5, fontWeight: '700'},
});
