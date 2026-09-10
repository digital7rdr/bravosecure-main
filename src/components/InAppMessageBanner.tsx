/**
 * B-692 S-3 — the in-app message notification banner (WhatsApp parity).
 *
 * Global overlay host, mounted once in App.tsx beside FloatingCallOverlay so
 * it survives navigation in every shell. backgroundMessageNotifier routes
 * committed foreground arrivals (non-active, non-muted conversations) to
 * inAppMessageNotifier; this host renders them as a top-slide card.
 *
 * Animation is transform/opacity ONLY with useNativeDriver:true — the receive
 * path is exactly when the JS thread is busiest (B-692 RC-6), so the slide
 * must not depend on JS frames.
 *
 * Tap routing mirrors fcmBootstrap's navigateToThread, NOT a bare
 * navigate('Chat'): this overlay lives above every shell, and a department
 * channel must land on the departmental surface (the "screen in 2 shells,
 * route in 1 → navigate silently DROPPED" class). NAV loop: the press carries
 * a synchronous ref guard + the banner hides itself synchronously on tap, so
 * a double-fire cannot dispatch twice (navigateOnce can't wrap this door —
 * the destination is rewritten per shell by navigateToMessengerScreen).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {navigationRef} from '@navigation/navigationRef';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';
import {setInAppMessageBannerListener, type InAppMessageEvent} from '@/modules/messenger/push/inAppMessageNotifier';
import {useMessengerStore} from '@/modules/messenger/store';

export const BANNER_AUTO_DISMISS_MS = 3500;
const TAP_GUARD_MS = 600;

/** Exported for the tap test — one dispatch per gesture, then the banner is gone. */
export function openFromBanner(event: InAppMessageEvent): void {
  const nav = navigationRef as unknown as {isReady?: () => boolean};
  if (nav.isReady && !nav.isReady()) {return;}
  const dept = resolveDeptConversation(event.conversationId, useMessengerStore.getState());
  if (dept?.channelId) {
    navigateToMessengerScreen(navigationRef as never, 'DepartmentChat', {
      channelId:           dept.channelId,
      channelName:         event.title ?? '',
      channelDesc:         '',
      groupConversationId: event.conversationId,
    }, {initial: false});
    return;
  }
  if (dept) {
    navigateToMessengerScreen(navigationRef as never, 'DepartmentChannels', {}, {initial: false});
    return;
  }
  navigateToMessengerScreen(navigationRef as never, 'Chat', {
    conversationId: event.conversationId,
    name:           event.title ?? '',
    isGroup:        event.isGroup,
  }, {initial: false});
}

export function InAppMessageBanner(): React.JSX.Element | null {
  const insets = useSafeAreaInsets();
  const [event, setEvent] = useState<InAppMessageEvent | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const showGen = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapAt = useRef(0);
  const activeConversationId = useMessengerStore(s => s.activeConversationId);

  const hide = (gen: number) => {
    if (gen !== showGen.current) {return;}
    if (hideTimer.current) {clearTimeout(hideTimer.current); hideTimer.current = null;}
    Animated.timing(progress, {
      toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true,
    }).start(({finished}) => {
      if (finished && gen === showGen.current) {setEvent(null);}
    });
  };

  useEffect(() => {
    const unsub = setInAppMessageBannerListener(e => {
      const gen = ++showGen.current;
      setEvent(e);
      Animated.timing(progress, {
        toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
      if (hideTimer.current) {clearTimeout(hideTimer.current);}
      hideTimer.current = setTimeout(() => hide(gen), BANNER_AUTO_DISMISS_MS);
    });
    return () => {
      unsub();
      if (hideTimer.current) {clearTimeout(hideTimer.current); hideTimer.current = null;}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening the conversation by any other door retires its banner at once.
  useEffect(() => {
    if (event && activeConversationId === event.conversationId) {hide(showGen.current);}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  if (!event) {return null;}

  const onPress = () => {
    const now = Date.now();
    if (now - lastTapAt.current < TAP_GUARD_MS) {return;}
    lastTapAt.current = now;
    const target = event;
    hide(showGen.current);
    openFromBanner(target);
  };

  const subtitle = event.isGroup && event.senderName && event.body
    ? `${event.senderName}: ${event.body}`
    : (event.body ?? 'New message');

  return (
    <View pointerEvents="box-none" style={[styles.host, {top: insets.top + 6}]}>
      <Animated.View
        style={[styles.card, {
          opacity: progress,
          transform: [{translateY: progress.interpolate({inputRange: [0, 1], outputRange: [-96, 0]})}],
        }]}>
        <Pressable
          testID="in-app-msg-banner"
          accessibilityRole="button"
          accessibilityLabel="Open conversation"
          onPress={onPress}
          style={styles.row}>
          <View style={styles.iconWrap}>
            <Icon name={event.isGroup ? 'account-group' : 'message-text'} size={18} color={ACCENT} />
          </View>
          <View style={styles.textCol}>
            <Text numberOfLines={1} style={styles.title}>{event.title ?? 'New message'}</Text>
            <Text numberOfLines={2} style={styles.body}>{subtitle}</Text>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const ACCENT = '#5B8DEF';

const styles = StyleSheet.create({
  host: {
    position: 'absolute', left: 10, right: 10, zIndex: 40, elevation: 40,
  },
  card: {
    backgroundColor: '#0B1017',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(91,141,239,0.35)',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: {width: 0, height: 6},
    elevation: 12,
  },
  row: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11},
  iconWrap: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)',
  },
  textCol: {flex: 1},
  title: {color: '#F3F6FB', fontSize: 13.5, fontWeight: '700', letterSpacing: 0.2},
  body: {color: '#94A3B8', fontSize: 12.5, marginTop: 1},
});

export default InAppMessageBanner;
