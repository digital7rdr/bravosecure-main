/**
 * CPO · Access Ended (BUILD_RUNBOOK Step 17 / §35A §F) — terminal screen shown when a
 * managed guard's agency membership is suspended/removed. On mount it runs the shared
 * revocation teardown (`endCpoAccess`: best-effort off-duty + full signOut, which drops
 * the CPO from Ops Rooms + wipes at-rest) — idempotent, so arriving here from a boot-as-
 * suspended-CPO or from a mid-session re-check both converge. Obsidian + platinum-cobalt
 * theme, matching the CPO shell.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {scaleTextStyles} from '@utils/scaling';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

export default function AccessEndedScreen() {
  const insets = useSafeAreaInsets();
  const endCpoAccess = useAuthStore(s => s.endCpoAccess);
  const clearAccessEnded = useAuthStore(s => s.clearAccessEnded);

  // Why a snapshot and not a live selector: endCpoAccess() below signs the user
  // out, which nulls `user` — reading suspension reactively would flash the
  // reason and then blank it. The lazy initializer captures it on first render,
  // before the effect fires.
  const [suspension] = useState(() => useAuthStore.getState().user?.suspension ?? null);

  // Run the teardown on mount — idempotent (no-op if recheckMembership already did it).
  useEffect(() => { void endCpoAccess(); }, [endCpoAccess]);

  const untilLabel = suspension?.until
    ? new Date(suspension.until).toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    : null;

  return (
    <View style={[s.root, {paddingTop: insets.top + 40, paddingBottom: insets.bottom + 20}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.body}>
        <View style={s.iconWrap}>
          <Icon name="shield-off-outline" size={44} color={D.alert} />
        </View>
        <Text style={s.title}>
          {suspension ? 'You have been suspended' : 'Agency access ended'}
        </Text>
        <Text style={s.sub}>
          {suspension
            ? 'Your agency has suspended your access. You have been signed out and taken off duty.'
            : 'Your access to Bravo was provided by your agency and has been suspended or removed. You have been signed out and taken off duty.'}
        </Text>

        {suspension && (
          <View style={s.reasonCard}>
            <Text style={s.reasonLabel}>REASON</Text>
            <Text style={s.reasonText}>
              {suspension.reason?.trim() || 'No reason was recorded by your agency.'}
            </Text>
            <Text style={s.reasonUntil}>
              {untilLabel ? `Suspended until ${untilLabel}` : 'No end date set'}
            </Text>
          </View>
        )}

        <Text style={s.subDim}>
          If you believe this is a mistake, contact your agency to be reinstated.
        </Text>
      </View>
      <TouchableOpacity activeOpacity={0.85} onPress={clearAccessEnded} style={s.btn}>
        <Text style={s.btnText}>Return to sign in</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, paddingHorizontal: 28, justifyContent: 'space-between'},
  body: {flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14},
  iconWrap: {
    width: 88, height: 88, borderRadius: 28, marginBottom: 8,
    backgroundColor: 'rgba(255,93,93,0.10)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.30)',
    alignItems: 'center', justifyContent: 'center',
  },
  title: {fontFamily: D.fBold, fontSize: 22, color: D.text, letterSpacing: -0.3, textAlign: 'center'},
  sub: {fontFamily: D.fSans, fontSize: 14, lineHeight: 21, color: D.textDim, textAlign: 'center', marginTop: 2},
  subDim: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 19, color: D.textMute, textAlign: 'center', marginTop: 4},
  reasonCard: {
    alignSelf: 'stretch', marginTop: 6, padding: 14, borderRadius: 16, gap: 6,
    backgroundColor: 'rgba(245,199,107,0.07)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.28)',
  },
  reasonLabel: {fontFamily: D.fBold, fontSize: 9.5, color: '#F5C76B', letterSpacing: 1.4},
  reasonText: {fontFamily: D.fSans, fontSize: 14, lineHeight: 20, color: D.text},
  reasonUntil: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textMute, letterSpacing: 0.3},
  btn: {
    height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  btnText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
}));
