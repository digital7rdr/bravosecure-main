/**
 * 06 / 09 — Document Upload
 *
 * 6 document slots (3 REQ, 3 OPT). Each row shows file icon, title,
 * req/opt badge, and a DONE or UPLOAD state badge.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, BackHandler} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg, prevStepFor} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type DocState = 'done' | 'upload';
type DocSlot  = 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
interface DocRow {key: DocSlot; icon: string; title: string; req: 'REQ' | 'OPT'; state: DocState}

const META: Record<DocSlot, {icon: string; title: string; req: 'REQ' | 'OPT'}> = {
  sia:       {icon: 'certificate-outline',           title: 'Security License / CPO Profile',   req: 'REQ'},
  passport:  {icon: 'card-account-details-outline',  title: 'Passport / National ID',           req: 'REQ'},
  insurance: {icon: 'file-document-outline',         title: 'Professional Indemnity Insurance', req: 'REQ'},
  dbs:       {icon: 'account-search-outline',        title: 'Police Clearance / DBS Enhanced',  req: 'REQ'},
  firstaid:  {icon: 'medical-bag',                   title: 'First Aid Certificate',            req: 'OPT'},
  cv:        {icon: 'file-document-multiple-outline',title: 'Professional CV / Résumé',         req: 'OPT'},
};

const EMPTY_DOCS: DocRow[] = (Object.keys(META) as DocSlot[]).map(k => ({
  key: k, icon: META[k].icon, title: META[k].title, req: META[k].req, state: 'upload',
}));

export default function AgentDocsUploadScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const signOut = useAuthStore(s => s.signOut);
  const [docs, setDocs] = useState<DocRow[]>(EMPTY_DOCS);
  const [busy, setBusy] = useState<DocSlot | 'submit' | null>(null);

  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  // Pull real upload state from the server.
  const refresh = async () => {
    try {
      const {data} = await agentApi.getMe();
      setAgentStatus(data.agent.status);
      // Already submitted? This screen must not re-appear as a second
      // "submitted"-looking page (the ping-pong the CPO hit). The review is
      // terminal until ops decides, so land straight on the approval screen.
      const st = data.agent.status;
      if (st === 'SUBMITTED' || st === 'UNDER_REVIEW') {
        navigation.replace('AgentAdminApproval');
        return;
      }
      setDocs(EMPTY_DOCS.map(d => {
        const server = data.documents.find(x => x.slot === d.key);
        return {...d, state: server?.state === 'done' ? 'done' : 'upload'};
      }));
    } catch { /* keep defaults */ }
  };
  useEffect(() => { void refresh(); }, []);

  const done = docs.filter(d => d.state === 'done').length;
  const total = docs.length;
  const requiredDone = docs.filter(d => d.req === 'REQ' && d.state === 'done').length;
  const requiredTotal = docs.filter(d => d.req === 'REQ').length;
  const canSubmit = requiredDone === requiredTotal;
  // Once submitted / under review, don't show the submit button — just
  // let the agent update individual docs and go back to approval.
  const alreadySubmitted = agentStatus === 'SUBMITTED' || agentStatus === 'UNDER_REVIEW' ||
    agentStatus === 'APPROVED' || agentStatus === 'ACTIVE';

  const handleUpload = async (slot: DocSlot) => {
    if (busy) {return;}
    // Already uploaded? — bail without re-prompting.
    if (docs.find(d => d.key === slot)?.state === 'done') {return;}
    setBusy(slot);
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
        name: file.name ?? `${slot}-${Date.now()}`,
        type: file.mimeType ?? 'application/octet-stream',
      });
      await agentApi.uploadDoc({
        slot,
        title: META[slot].title,   // always the human label, not the raw filename
        file_url: fileUrl,
      });
      await refresh();
    } catch (e) {
      Alert.alert('Upload failed', extractMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = async () => {
    if (!canSubmit || busy) {return;}
    setBusy('submit');
    try {
      await agentApi.submit();
      navigation.navigate('AgentAdminApproval');
    } catch (e) {
      Alert.alert('Could not submit', extractMsg(e));
    } finally {
      setBusy(null);
    }
  };

  // B-98a — resume/KYC entry replaces the route, leaving nothing to pop, and
  // goBack() is then a silent release no-op (the dead 3/4 chevron). Fall back
  // to the linear previous step; replace keeps the resume stack shallow.
  //
  // B-199 — but this screen is the FIRST (and only initial) route of
  // CpoOnboardingNavigator for a managed CPO, where the linear previous step
  // (AgentAvailability) is NOT registered — so `replace('AgentAvailability')`
  // was a silent no-op and the chevron looked dead. When the fallback target
  // isn't a real route in THIS stack, the only meaningful "back" is out of
  // onboarding entirely: sign out to the login screen (the same terminal-exit
  // pattern AgentRejectedScreen uses). In the agency wizard the target IS
  // registered, so that path is unchanged.
  const handleBack = () => {
    if (navigation.canGoBack()) {navigation.goBack(); return;}
    const prev = prevStepFor('AgentDocsUpload');
    const routeNames = navigation.getState()?.routeNames ?? [];
    if (prev && routeNames.includes(prev)) {
      // Why the cast: this stack's typed replace() demands a params arg even
      // for param-less routes; the runtime accepts the single-arg form.
      (navigation as unknown as {replace: (name: string) => void}).replace(prev);
      return;
    }
    Alert.alert(
      'Leave verification?',
      "You'll be signed out. Your uploaded documents are saved — sign in again to continue.",
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); }},
      ],
    );
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
      <NavHeader title="Document Upload" onBack={handleBack} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <View style={s.tickerRow}>
          <View>
            <Text style={s.tickerLabel}>Compliance Pack</Text>
            <Text style={s.tickerSub}>3 required · 3 optional</Text>
          </View>
          <Text style={s.tickerNum}>
            {done}
            <Text style={s.tickerDen}>/{total}</Text>
          </Text>
        </View>

        {docs.map(d => {
          const isDone = d.state === 'done';
          const isBusy = busy === d.key;
          return (
            <TouchableOpacity
              key={d.key}
              onPress={() => { void handleUpload(d.key); }}
              disabled={isDone || isBusy}
              activeOpacity={0.85}
              style={[s.row, isDone && s.rowDone]}>
              <View style={[s.ic, isDone && s.icDone]}>
                <Icon
                  name={d.icon as React.ComponentProps<typeof Icon>['name']}
                  size={14}
                  color={isDone ? Colors.primary : Colors.textSecondary}
                />
              </View>
              <View style={s.body}>
                <View style={s.titleRow}>
                  <Text style={s.title} numberOfLines={1}>{d.title}</Text>
                  <View style={[s.reqBadge, d.req === 'REQ' ? s.reqNeed : s.reqOpt]}>
                    <Text style={[s.reqText, d.req === 'REQ' ? s.reqTextNeed : s.reqTextOpt]}>
                      {d.req}
                    </Text>
                  </View>
                </View>
              </View>
              <View style={[s.state, isDone ? s.stateOk : s.stateUp]}>
                <Text style={[s.stateText, isDone ? s.stateTextOk : s.stateTextUp]}>
                  {isBusy ? '…' : isDone ? 'DONE' : 'UPLOAD'}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {alreadySubmitted ? (
        <CTAButton
          label="← Back to Approval Status"
          onPress={() => navigation.navigate('AgentAdminApproval')}
          variant="primary"
        />
      ) : (
        <CTAButton
          label={
            busy === 'submit' ? 'Submitting…' :
            canSubmit          ? 'Submit for Admin Review' :
            `${requiredDone}/${requiredTotal} required · finish uploading`
          }
          onPress={() => { void onSubmit(); }}
          variant={canSubmit && busy !== 'submit' ? 'primary' : 'disabled'}
        />
      )}
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
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  title: {fontFamily: BravoFont.bold, fontSize: 11.5, color: Colors.textPrimary, flexShrink: 1},

  reqBadge: {paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, borderWidth: 1},
  reqNeed: {
    backgroundColor: 'rgba(213,0,0,0.1)', borderColor: 'rgba(213,0,0,0.3)',
  },
  reqOpt: {backgroundColor: Colors.surfaceOverlay, borderColor: Colors.surfaceBorder},
  reqText: {fontFamily: BravoFont.extraBold, fontSize: 8, letterSpacing: 0.5},
  reqTextNeed: {color: BRAND.err},
  reqTextOpt:  {color: Colors.textMuted},

  state: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1},
  stateOk: {
    backgroundColor: 'rgba(0,200,83,0.12)', borderColor: 'rgba(0,200,83,0.3)',
  },
  stateUp: {
    backgroundColor: Colors.surfaceOverlay, borderColor: Colors.borderDefault,
  },
  stateText: {fontFamily: BravoFont.extraBold, fontSize: 9, letterSpacing: 0.8},
  stateTextOk: {color: BRAND.ok},
  stateTextUp: {color: Colors.textSecondary},
}));
