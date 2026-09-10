import React, {useEffect, useRef} from 'react';
import {Text, StyleSheet, Animated, Easing} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {TransportState} from '@bravo/messenger-core';

/**
 * Thin status strip that surfaces the transport state machine to the
 * user. Hidden when connected; otherwise shows a copy + icon pair
 * sized for a chat-header underlay:
 *   connecting/reconnecting → amber, spinning cloud-outline
 *   unauthorized            → red, lock-open
 *   disconnected            → slate, cloud-off (when user is offline)
 *
 * The banner slides in from the top (translateY) and fades in so it
 * doesn't jar — mobile users read connection drops as "bad app",
 * calm animation tells them we noticed and are handling it.
 *
 * Why disconnected is now shown: previously the banner hid on disconnected,
 * which is the state the client lands in when the user actually has no
 * network. Hiding it left chat-screen visually identical to "connected"
 * — the user had no idea why messages weren't going through.
 */
export function ConnectionBanner({state}: {state: TransportState}) {
  const op = useRef(new Animated.Value(0)).current;
  const visible = state !== 'connected';

  useEffect(() => {
    Animated.timing(op, {
      toValue: visible ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, op]);

  if (state === 'connected') {return null;}

  const {label, tone, icon} = describe(state);
  return (
    <Animated.View style={[
      styles.wrap,
      toneStyle(tone),
      {opacity: op, transform: [{translateY: op.interpolate({inputRange: [0, 1], outputRange: [-8, 0]})}]},
    ]}>
      <Icon name={icon} size={12} color={toneText(tone)} />
      <Text style={[styles.text, {color: toneText(tone)}]}>{label}</Text>
    </Animated.View>
  );
}

function describe(state: TransportState): {label: string; tone: 'warn' | 'danger' | 'mute'; icon: 'cloud-sync-outline' | 'cloud-off-outline' | 'lock-open-outline'} {
  switch (state) {
    case 'connecting':    return {label: 'Connecting…',        tone: 'warn',   icon: 'cloud-sync-outline'};
    case 'reconnecting':  return {label: 'Reconnecting…',      tone: 'warn',   icon: 'cloud-sync-outline'};
    case 'unauthorized':  return {label: 'Signed out — please sign in again', tone: 'danger', icon: 'lock-open-outline'};
    // B-11 — single-device takeover. This account is now active on a
    // newer device; this one stays disconnected (no ping-pong) until
    // the user foregrounds it again (which reconnects + takes over).
    case 'superseded':    return {label: 'Active on another device — reopen here to switch back', tone: 'danger', icon: 'cloud-off-outline'};
    case 'disconnected':  return {label: 'Offline — messages will send when you reconnect', tone: 'mute', icon: 'cloud-off-outline'};
    default:              return {label: '',                    tone: 'warn',   icon: 'cloud-off-outline'};
  }
}

function toneStyle(tone: 'warn' | 'danger' | 'mute') {
  if (tone === 'danger') {
    return {backgroundColor: 'rgba(248,113,113,0.12)', borderColor: 'rgba(248,113,113,0.3)'};
  }
  if (tone === 'mute') {
    return {backgroundColor: 'rgba(148,163,184,0.12)', borderColor: 'rgba(148,163,184,0.3)'};
  }
  return {backgroundColor: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.3)'};
}

function toneText(tone: 'warn' | 'danger' | 'mute'): string {
  if (tone === 'danger') {return '#F87171';}
  if (tone === 'mute')   {return '#94A3B8';}
  return '#FBBF24';
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    borderBottomWidth: 1,
  },
  text: {fontSize: 11, fontWeight: '600'},
});
