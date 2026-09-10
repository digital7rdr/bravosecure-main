import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

/**
 * Why: audit S5 — Mission Chat, Department Chat, Department Channels,
 * and the standalone Group Info screen shipped with hardcoded demo
 * content (fake operator names, fake bubbles, fake channel rows). They
 * looked real, sent nothing, persisted nothing, and were not wired to
 * the messenger runtime at all. Until each feature is backed by real
 * group state (M9 + admin-action plumbing), the screens fail honest:
 * one shared "Coming soon" body so users see clearly that the feature
 * is not available yet rather than chatting into a void that nothing
 * ever receives.
 *
 * Caller passes the feature title and a one-sentence description so
 * the placeholder still feels purposeful per route.
 */
export interface ComingSoonProps {
  title:   string;
  detail:  string;
  iconName?: keyof typeof Icon.glyphMap;
}

export default function ComingSoonScreen({title, detail, iconName = 'rocket-launch-outline'}: ComingSoonProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Icon name={iconName} size={36} color="#5B8DEF" />
        </View>
        <Text style={styles.title}>Coming soon</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(229,233,242,0.62)'},

  body: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32},
  iconWrap: {width: 76, height: 76, borderRadius: 24, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  title: {fontSize: 20, fontWeight: '800', color: '#F2F4F8', marginBottom: 8, textAlign: 'center'},
  detail: {fontSize: 13, color: 'rgba(229,233,242,0.62)', lineHeight: 20, textAlign: 'center'},
}));
