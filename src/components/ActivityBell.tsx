/**
 * ActivityBell (Step 18 / B2) — header bell + unread badge, mounted in all three role
 * shells. Reads the unread count from the activity store; tapping opens the ActivityCenter.
 * Presentational + a tap callback so each shell wires its own navigation.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useActivityStore, selectUnreadCount} from '@store/activityStore';
import {UI} from './ui/tokens';
import {scaleTextStyles} from '@utils/scaling';

export default function ActivityBell({onPress, color = UI.text}: {onPress: () => void; color?: string}) {
  const unread = useActivityStore(selectUnreadCount);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={s.btn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
      <Icon name={unread > 0 ? 'bell-ring-outline' : 'bell-outline'} size={22} color={color} />
      {unread > 0 && (
        <View style={s.badge}>
          <Text style={s.badgeText} numberOfLines={1}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  btn: {width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: UI.hair},
  badge: {position: 'absolute', top: 2, right: 2, minWidth: 16, minHeight: 16, maxWidth: 36, borderRadius: 9, paddingHorizontal: 3, paddingVertical: 1,
    backgroundColor: UI.alert, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: UI.bg},
  badgeText: {fontFamily: UI.fBold, fontSize: 9, color: '#fff'},
}));
