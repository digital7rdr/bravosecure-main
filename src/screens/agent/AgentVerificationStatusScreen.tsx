import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Animated,
  Easing,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

const CHECKLIST = [
  {icon: 'check', label: 'Documents received', status: 'Done', statusColor: '#4ADE80', bg: 'rgba(34,197,94,0.15)', iconColor: '#4ADE80'},
  {icon: 'timer-sand', label: 'Identity verification', status: 'Pending', statusColor: '#FBBF24', bg: 'rgba(245,158,11,0.12)', iconColor: '#FBBF24', border: 'rgba(245,158,11,0.25)'},
  {icon: 'lock-outline', label: 'Security clearance check', status: 'Waiting', statusColor: '#475569', bg: '#07111f', iconColor: '#475569', border: '#1E2D45'},
  {icon: 'card-account-details-outline', label: 'Agent activation', status: 'Waiting', statusColor: '#475569', bg: '#07111f', iconColor: '#475569', border: '#1E2D45'},
];

export default function AgentVerificationStatusScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [notifyOn, setNotifyOn] = useState(true);

  // Pulse ring animations
  const pulse1 = useRef(new Animated.Value(0)).current;
  const pulse2 = useRef(new Animated.Value(0)).current;
  // Clock tick animation
  const clockTick = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const p1 = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse1, {toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse1, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    const p2 = Animated.loop(
      Animated.sequence([
        Animated.delay(800),
        Animated.timing(pulse2, {toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse2, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    const tick = Animated.loop(
      Animated.sequence([
        Animated.timing(clockTick, {toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(clockTick, {toValue: -1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(clockTick, {toValue: 0, duration: 0, useNativeDriver: true}),
      ]),
    );
    p1.start(); p2.start(); tick.start();
    return () => { p1.stop(); p2.stop(); tick.stop(); };
    // pulse + clockTick are stable refs; deps would re-run animation on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p1Scale = pulse1.interpolate({inputRange: [0, 1], outputRange: [1, 1.6]});
  const p1Opacity = pulse1.interpolate({inputRange: [0, 1], outputRange: [0.4, 0]});
  const p2Scale = pulse2.interpolate({inputRange: [0, 1], outputRange: [1, 1.6]});
  const p2Opacity = pulse2.interpolate({inputRange: [0, 1], outputRange: [0.35, 0]});
  const clockRot = clockTick.interpolate({inputRange: [-1, 0, 1], outputRange: ['-5deg', '0deg', '5deg']});

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        {/* BB-4 (2026-08-15 back audit) — the only live entry is
            AgentInviteCode's reset(), which makes this index 0 of the stack:
            the arrow was a dead control on every real path. Same
            render-only-when-poppable pattern as AgentProfileScreen. */}
        {navigation.canGoBack() ? (
          <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text style={styles.headerTitle}>Verification Status</Text>
      </View>

      {/* Progress bar */}
      <View style={styles.progressSection}>
        <View style={styles.progressLabels}>
          <Text style={styles.progressStep}>Step 4 of 4</Text>
          <Text style={styles.progressStatus}>Under Review</Text>
        </View>
        <View style={styles.progressBar}>
          {[0, 1, 2].map(i => (
            <View key={i} style={[styles.progressSegment, styles.progressSegmentDone]} />
          ))}
          <View style={[styles.progressSegment, styles.progressSegmentReview]} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 120}]}
        showsVerticalScrollIndicator={false}>

        {/* Clock icon hero */}
        <View style={styles.heroSection}>
          <View style={styles.clockContainer}>
            <Animated.View style={[styles.pulseRing, {transform: [{scale: p1Scale}], opacity: p1Opacity, borderColor: 'rgba(245,158,11,0.3)'}]} />
            <Animated.View style={[styles.pulseRing, {transform: [{scale: p2Scale}], opacity: p2Opacity, borderColor: 'rgba(245,158,11,0.2)'}]} />
            <View style={styles.clockCircle}>
              <Animated.View style={{transform: [{rotate: clockRot}]}}>
                <Icon name="clock-time-four" size={52} color="#F59E0B" />
              </Animated.View>
            </View>
          </View>
          <Text style={styles.heroTitle}>Under Review</Text>
          <Text style={styles.heroSub}>
            Our compliance team will review your documents within 24–48 hours.
          </Text>
        </View>

        {/* Estimated completion card */}
        <View style={styles.estimationCard}>
          <View style={styles.estimationHeader}>
            <Icon name="calendar-clock" size={18} color="#FBBF24" />
            <Text style={styles.estimationHeaderText}>ESTIMATED COMPLETION</Text>
          </View>
          <View style={styles.estimationBody}>
            <Text style={styles.estimationDate}>17 March 2026</Text>
            <Text style={styles.estimationSub}>Usually within 1–2 business days</Text>
          </View>
        </View>

        {/* Review checklist */}
        <View style={styles.checklistCard}>
          <Text style={styles.checklistLabel}>Review Checklist</Text>
          {CHECKLIST.map((item, i) => (
            <View key={i} style={styles.checklistRow}>
              <View style={[styles.checklistIcon, {backgroundColor: item.bg, borderColor: item.border ?? 'transparent', borderWidth: item.border ? 1 : 0}]}>
                <Icon name={item.icon} size={14} color={item.iconColor} />
              </View>
              <Text style={[styles.checklistText, {color: item.statusColor === '#475569' ? '#64748B' : '#CBD5E1'}]}>{item.label}</Text>
              <Text style={[styles.checklistStatus, {color: item.statusColor}]}>{item.status}</Text>
            </View>
          ))}
        </View>

        {/* Notify toggle */}
        <View style={styles.notifyCard}>
          <Icon name="bell-ring" size={22} color="#2563EB" />
          <View style={{flex: 1}}>
            <Text style={styles.notifyTitle}>Notify me when verified</Text>
            <Text style={styles.notifySub}>Push + email notification</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, notifyOn && styles.toggleOn]}
            onPress={() => setNotifyOn(v => !v)}
            activeOpacity={0.8}>
            <View style={[styles.toggleThumb, notifyOn && styles.toggleThumbOn]} />
          </TouchableOpacity>
        </View>

        {/* Contact support */}
        <TouchableOpacity style={styles.supportBtn}>
          <Text style={styles.supportText}>Contact Support</Text>
          <Icon name="open-in-new" size={14} color="#475569" />
        </TouchableOpacity>

      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, {paddingBottom: bottomPad(20)}]}>
        <TouchableOpacity
          style={styles.approvedBtn}
          onPress={() => navigation.navigate('AgentVerified' as never)}
          activeOpacity={0.85}>
          <Icon name="check-circle-outline" size={16} color="#FFF" />
          <Text style={styles.approvedBtnText}>Preview: Approved</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.rejectedBtn}
          onPress={() => navigation.navigate('AgentRejected' as never)}
          activeOpacity={0.85}>
          <Icon name="cancel" size={16} color="#F87171" />
          <Text style={styles.rejectedBtnText}>Preview: Rejected</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, gap: 4},
  backBtn: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18},
  headerTitle: {flex: 1, fontSize: 14, fontWeight: '700', color: '#E2E8F0', textAlign: 'center', marginRight: 36},

  progressSection: {paddingHorizontal: 20, paddingBottom: 16},
  progressLabels: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8},
  progressStep: {fontSize: 12, fontWeight: '600', color: '#60A5FA'},
  progressStatus: {fontSize: 12, color: '#64748B', fontWeight: '500', textTransform: 'uppercase', letterSpacing: 1},
  progressBar: {flexDirection: 'row', gap: 6, height: 6},
  progressSegment: {flex: 1, borderRadius: 3},
  progressSegmentDone: {backgroundColor: '#2563EB'},
  progressSegmentReview: {backgroundColor: '#F59E0B'},

  content: {paddingHorizontal: 20, paddingTop: 4, gap: 16},

  heroSection: {alignItems: 'center', paddingTop: 16, paddingBottom: 8},
  clockContainer: {width: 112, height: 112, alignItems: 'center', justifyContent: 'center', marginBottom: 24},
  pulseRing: {position: 'absolute', width: 112, height: 112, borderRadius: 56, borderWidth: 2},
  clockCircle: {width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 2, borderColor: 'rgba(245,158,11,0.25)', alignItems: 'center', justifyContent: 'center'},
  heroTitle: {fontSize: 24, fontWeight: '800', color: '#E2E8F0', marginBottom: 8},
  heroSub: {fontSize: 14, color: '#94A3B8', textAlign: 'center', lineHeight: 21, maxWidth: 280},

  estimationCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 16, overflow: 'hidden'},
  estimationHeader: {height: 56, backgroundColor: 'rgba(37,99,235,0.12)', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8},
  estimationHeaderText: {fontSize: 10, fontWeight: '700', letterSpacing: 2, color: '#FBBF24', textTransform: 'uppercase'},
  estimationBody: {paddingVertical: 20, alignItems: 'center'},
  estimationDate: {fontSize: 20, fontWeight: '700', color: '#E2E8F0'},
  estimationSub: {fontSize: 12, color: '#64748B', marginTop: 4},

  checklistCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 16, padding: 16, gap: 12},
  checklistLabel: {fontSize: 10, fontWeight: '700', letterSpacing: 2, color: '#64748B', textTransform: 'uppercase', marginBottom: 4},
  checklistRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  checklistIcon: {width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  checklistText: {flex: 1, fontSize: 12, lineHeight: 18},
  checklistStatus: {fontSize: 10, fontWeight: '700'},

  notifyCard: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 16, padding: 16},
  notifyTitle: {fontSize: 14, fontWeight: '600', color: '#E2E8F0'},
  notifySub: {fontSize: 10, color: '#64748B', marginTop: 2},
  toggle: {width: 48, height: 26, borderRadius: 13, backgroundColor: '#1E2D45', justifyContent: 'center'},
  toggleOn: {backgroundColor: '#2563EB'},
  toggleThumb: {width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF', marginLeft: 3, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.3, shadowRadius: 2},
  toggleThumbOn: {marginLeft: 25},

  supportBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4},
  supportText: {fontSize: 12, color: '#64748B'},

  footer: {flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 12},
  approvedBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 12},
  approvedBtnText: {fontSize: 12, fontWeight: '700', color: '#FFF', letterSpacing: 0.5},
  rejectedBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(220,38,38,0.1)', borderWidth: 1, borderColor: 'rgba(220,38,38,0.25)', borderRadius: 12, paddingVertical: 12},
  rejectedBtnText: {fontSize: 12, fontWeight: '700', color: '#F87171', letterSpacing: 0.5},
}));
