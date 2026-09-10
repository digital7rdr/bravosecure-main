/**
 * 03 / 09 — KYC Verification (upload-driven)
 *
 * 4 KYC slots: Government ID, Proof of Address, Security License, Police
 * Clearance / DBS. Agent attaches a supporting document to each one,
 * which flips the check from `running` to `done` (pending verification
 * by ops on the console). Once all four uploads land, the agent can
 * continue to Coverage Setup.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, ScrollView, StatusBar, StyleSheet, TouchableOpacity,
  ActivityIndicator, BackHandler,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, AlertWarn, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg, prevStepFor} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type KycKind = 'gov_id' | 'proof_address' | 'sia_licence' | 'police';
type KycState = 'done' | 'running' | 'queued' | 'failed';

interface KycCheck {
  key: KycKind;
  icon: string;
  title: string;
  hint: string;
  state: KycState;
  subject: string | null;
}

const KIND_META: Record<KycKind, {icon: string; title: string; hint: string}> = {
  gov_id:        {icon: 'shield-check',           title: 'Government ID',     hint: 'Passport or national ID'},
  proof_address: {icon: 'home-city-outline',      title: 'Proof of Address',  hint: 'Utility bill, < 3 months'},
  sia_licence:   {icon: 'certificate-outline',    title: 'Security License',  hint: 'Front + back, in date'},
  police:        {icon: 'account-search-outline', title: 'Police Clearance',  hint: 'DBS Enhanced or equivalent'},
};

const ORDER: KycKind[] = ['gov_id', 'proof_address', 'sia_licence', 'police'];

export default function AgentKYCScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [checks, setChecks] = useState<KycCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<KycKind | null>(null);

  const refresh = async (): Promise<'advance' | null> => {
    try {
      const {data} = await agentApi.getMe();
      const byKind = new Map(data.kyc.map(k => [k.kind, k]));
      setChecks(ORDER.map(kind => {
        const k = byKind.get(kind);
        return {
          key: kind,
          icon: KIND_META[kind].icon,
          title: KIND_META[kind].title,
          hint: KIND_META[kind].hint,
          state: (k?.state as KycState) ?? 'queued',
          subject: k?.subject ?? null,
        };
      }));
      setLoading(false);
      // Server flipped past KYC → move forward.
      if (data.agent.status === 'DOCS_PENDING' || data.agent.status === 'SUBMITTED') {
        return 'advance';
      }
    } catch {
      setLoading(false);
    }
    return null;
  };

  // Mount: kick KYC into running state (idempotent on the backend) and
  // pull the latest state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { await agentApi.startKyc(); } catch { /* idempotent — ignore */ }
      if (!cancelled) {await refresh();}
    })();
    return () => { cancelled = true; };
  }, []);

  const onUpload = async (kind: KycKind) => {
    if (busy) {return;}
    setBusy(kind);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) {return;}
      const file = res.assets[0];
      // Push the file bytes to the auth-service so it lands on disk and
      // gets a real URL the ops-console can render.
      const fileUrl = await agentApi.uploadFile({
        uri:  file.uri,
        name: file.name ?? `${kind}-${Date.now()}`,
        type: file.mimeType ?? 'application/octet-stream',
      });
      await agentApi.uploadKycDoc(kind, {
        file_url: fileUrl,
        subject:  file.name ?? KIND_META[kind].title,
      });
      const advance = await refresh();
      if (advance === 'advance') {navigation.replace('AgentCoverage');}
    } catch (e) {
      Alert.alert('Upload failed', extractMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const done = checks.filter(c => c.state === 'done').length;
  const total = checks.length || 4;
  const allDone = done === total && total > 0;

  const onContinue = async () => {
    if (!allDone) {return;}
    navigation.replace('AgentCoverage');
  };

  // B-98a — resume/KYC entry replaces the route, leaving nothing to pop, and
  // goBack() is then a silent release no-op (the dead 3/4 chevron). Fall back
  // to the linear previous step; replace keeps the resume stack shallow.
  const handleBack = () => {
    if (navigation.canGoBack()) {navigation.goBack(); return;}
    const prev = prevStepFor('AgentKYC');
    // Why the cast: this stack's typed replace() demands a params arg even
    // for param-less routes; the runtime accepts the single-arg form.
    if (prev) {(navigation as unknown as {replace: (name: string) => void}).replace(prev);}
  };

  // B-98a — hardware back mirrors the header chevron (all three affordances
  // agree: button, gesture, hardware key). Focus-scoped so covered screens
  // don't intercept.
  // NAV-07 (2026-08-26 audit) — read through a ref, matching
  // AgentRegistrationWizardScreen: the []-deps callback froze the FIRST
  // render's handleBack behind a suppressed lint rule.
  const handleBackRef = React.useRef(handleBack);
  handleBackRef.current = handleBack;
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleBackRef.current();
      return true;
    });
    return () => sub.remove();
  }, []));


  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader title="Verification" onBack={handleBack} stepPill="2/4" />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <View style={s.tickerRow}>
          <View>
            <Text style={s.tickerLabel}>Verification Progress</Text>
            <Text style={s.tickerSub}>
              {loading ? 'loading…' : `${done} of ${total} · attach supporting docs`}
            </Text>
          </View>
          <Text style={s.tickerNum}>
            {done}
            <Text style={s.tickerDen}>/{total}</Text>
          </Text>
        </View>

        {checks.map(c => (
          <KycRow
            key={c.key}
            check={c}
            busy={busy === c.key}
            onUpload={() => { void onUpload(c.key); }}
          />
        ))}

        <AlertWarn>
          Uploads are sent to ops for verification. Approval typically completes in <Text style={s.b}>24-72 hours</Text>.
        </AlertWarn>
      </ScrollView>

      <CTAButton
        label={allDone ? 'Continue · Coverage Setup' : `${done}/${total} uploaded · attach to continue`}
        onPress={() => { void onContinue(); }}
        variant={allDone ? 'primary' : 'disabled'}
      />
    </View>
  );
}


function KycRow({
  check, busy, onUpload,
}: {
  check: KycCheck;
  busy: boolean;
  onUpload: () => void;
}) {
  const done = check.state === 'done';
  return (
    <View style={[s.row, done && s.rowDone]}>
      <View style={[s.ic, done && s.icDone]}>
        <Icon
          name={check.icon as React.ComponentProps<typeof Icon>['name']}
          size={14}
          color={done ? Colors.primary : Colors.textSecondary}
        />
      </View>
      <View style={s.body}>
        <Text style={s.title}>{check.title}</Text>
        <Text style={[s.sub, done && s.subDone]} numberOfLines={1}>
          {done ? (check.subject ?? 'Submitted · awaiting verification') : check.hint}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onUpload}
        disabled={busy || done}
        activeOpacity={0.85}
        style={[s.action, done ? s.actionOk : s.actionUp]}>
        {busy ? (
          <ActivityIndicator size="small" color={Colors.textPrimary} />
        ) : (
          <Text style={[s.actionText, done ? s.actionTextOk : s.actionTextUp]}>
            {done ? 'DONE' : 'UPLOAD'}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  tickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  tickerLabel: {
    fontFamily: BravoFont.bold, fontSize: 11, letterSpacing: 1.5,
    color: Colors.textMuted, textTransform: 'uppercase',
  },
  tickerSub: {fontSize: 10, color: Colors.textMuted, marginTop: 3},
  tickerNum: {
    fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5,
    color: BRAND.acc,
  },
  tickerDen: {color: Colors.textMuted, fontSize: 14, fontWeight: '500'},

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 11, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  rowDone: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(30,136,255,0.06)',
  },
  ic: {
    width: 30, height: 30, borderRadius: 7,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  icDone: {borderColor: Colors.primary},
  body: {flex: 1, minWidth: 0},
  title: {
    fontFamily: BravoFont.bold, fontSize: 11.5, color: Colors.textPrimary,
  },
  sub: {fontSize: 10, color: Colors.textMuted, marginTop: 2, letterSpacing: 0.3},
  subDone: {color: BRAND.ok},

  action: {
    minWidth: 64,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 5, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  actionUp: {
    backgroundColor: Colors.surfaceOverlay,
    borderColor: Colors.borderDefault,
  },
  actionOk: {
    backgroundColor: 'rgba(0,200,83,0.12)',
    borderColor: 'rgba(0,200,83,0.3)',
  },
  actionText: {fontFamily: BravoFont.extraBold, fontSize: 9, letterSpacing: 0.8},
  actionTextUp: {color: Colors.textPrimary},
  actionTextOk: {color: BRAND.ok},

  b: {fontWeight: '700', color: BRAND.warn},
}));
