import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Linking,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {Alert} from '@utils/alert';
import {useAuthStore} from '@store/authStore';
import {rejectedBackAction} from './agentFlowHelpers';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// Last-resort placeholder shown when the server hasn't recorded a partner
// review note yet. The screen prefers the live ops decision note when one
// exists (loaded into state below).
const FALLBACK_REASON = {
  title: 'Review notes pending',
  desc: 'Your application was rejected. Contact support for the detailed reason.',
};

const TIPS = [
  'Use original documents, not photocopies',
  'Photograph in natural daylight, no flash glare',
  'Ensure all four corners of the document are visible',
];

export default function AgentRejectedScreen() {
  const [serverReason, setServerReason] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        // Per-server reason from the `partner` review step. Falls back
        // to a generic message if ops didn't leave a note.
        const partner = data.review?.find(r => r.step === 'partner');
        const note = partner?.notes?.toString().trim();
        if (note) {setServerReason(note);}
      } catch { /* keep fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const reasons = serverReason
    ? [{title: 'Reason from ops review', desc: serverReason}]
    : [FALLBACK_REASON];

  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const signOut = useAuthStore(s => s.signOut);

  // B-98a — this screen is reached via replace() (AgentAdminApproval's poll) or as
  // the resume target for status REJECTED, so the stack is usually empty and a bare
  // goBack() is a dead no-op. The agent portal is a top-level authed route
  // (MainNavigator resolveAuthedRoute), so there is no app behind it: signing out is
  // the only real "back". Re-login lands the agent right back here while ops keeps
  // the REJECTED status, which is why we do NOT fall back into the wizard — those
  // screens re-read status on mount and would bounce straight back.
  const onBack = useCallback(() => {
    if (rejectedBackAction(navigation.canGoBack()) === 'pop') { navigation.goBack(); return; }
    Alert.alert(
      'Sign out?',
      'Your application stays rejected. Signing in again brings you back to this screen.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); }},
      ],
    );
  }, [navigation, signOut]);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={onBack}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Back">
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Verification Status</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Icon */}
        <View style={styles.iconSection}>
          <View style={styles.outerRing}>
            <View style={styles.xCircle}>
              <Icon name="close" size={42} color="#F87171" />
            </View>
          </View>
          <Text style={styles.title}>Verification Unsuccessful</Text>
          <Text style={styles.sub}>
            Your KYC verification was not approved. Review the reasons below and resubmit your documents.
          </Text>
        </View>

        {/* Rejection Reasons */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Rejection Reasons</Text>
          <View style={styles.reasonList}>
            {reasons.map((reason, idx) => (
              <View key={idx} style={styles.reasonCard}>
                <Icon name="alert-circle" size={20} color="#F87171" style={styles.reasonIcon} />
                <View style={styles.reasonInfo}>
                  <Text style={styles.reasonTitle}>{reason.title}</Text>
                  <Text style={styles.reasonDesc}>{reason.desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Tips */}
        <View style={styles.tipsCard}>
          <View style={styles.tipsHeader}>
            <Icon name="lightbulb-on" size={16} color={Colors.primary} />
            <Text style={styles.tipsHeaderText}>Tips for Resubmission</Text>
          </View>
          <View style={styles.tipsList}>
            {TIPS.map((tip, idx) => (
              <View key={idx} style={styles.tipRow}>
                <View style={styles.tipBullet} />
                <Text style={styles.tipText}>{tip}</Text>
              </View>
            ))}
          </View>
        </View>

      </ScrollView>

      {/* Footer — resubmit was a dead-end (the AgentRegistration screen
          is a mocked demo with no real POST). Until the server exposes a
          REJECTED → DRAFT reset endpoint the only working path is to
          contact ops, who can re-open the review manually. */}
      <View style={[styles.footer, {paddingBottom: bottomPad(20)}]}>
        <TouchableOpacity
          style={styles.resubmitBtn}
          onPress={() => void Linking.openURL('mailto:support@bravosecure.com?subject=Resubmit%20agent%20application')}
          activeOpacity={0.85}>
          <Icon name="email-outline" size={20} color="#FFF" />
          <Text style={styles.resubmitBtnText}>Email Support to Resubmit</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.supportBtn}
          activeOpacity={0.7}
          onPress={() => void Linking.openURL('mailto:support@bravosecure.com')}>
          <Icon name="headset" size={18} color="#64748B" />
          <Text style={styles.supportBtnText}>Contact Support</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 14, fontWeight: '700', color: '#E2E8F0', flex: 1, textAlign: 'center', marginRight: 36},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 24},

  iconSection: {alignItems: 'center', gap: 12, paddingTop: 8, paddingBottom: 8},
  outerRing: {width: 112, height: 112, borderRadius: 56, backgroundColor: 'rgba(239,68,68,0.06)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  xCircle: {width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 2, borderColor: 'rgba(239,68,68,0.3)', alignItems: 'center', justifyContent: 'center'},
  title: {fontSize: 24, fontWeight: '800', color: '#F1F5F9', textAlign: 'center'},
  sub: {fontSize: 14, color: '#94A3B8', textAlign: 'center', lineHeight: 21, maxWidth: 300},

  section: {gap: 12},
  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5},
  reasonList: {gap: 10},
  reasonCard: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, borderRadius: 12, backgroundColor: 'rgba(239,68,68,0.06)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)'},
  reasonIcon: {marginTop: 2, flexShrink: 0},
  reasonInfo: {flex: 1},
  reasonTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9', marginBottom: 4},
  reasonDesc: {fontSize: 12, color: '#94A3B8', lineHeight: 18},

  tipsCard: {backgroundColor: 'rgba(37,99,235,0.06)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(37,99,235,0.2)', padding: 16},
  tipsHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12},
  tipsHeaderText: {fontSize: 10, fontWeight: '700', color: Colors.primary, textTransform: 'uppercase', letterSpacing: 1.5},
  tipsList: {gap: 6},
  tipRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  tipBullet: {width: 4, height: 4, borderRadius: 2, backgroundColor: '#A78BFA', flexShrink: 0},
  tipText: {fontSize: 11, color: '#94A3B8'},

  footer: {paddingHorizontal: 20, paddingTop: 8, gap: 10, backgroundColor: Colors.background},
  resubmitBtn: {backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  resubmitBtnText: {color: '#FFF', fontSize: 14, fontWeight: '700', letterSpacing: 0.4},
  supportBtn: {paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  supportBtnText: {color: '#64748B', fontSize: 14, fontWeight: '600'},
}));
