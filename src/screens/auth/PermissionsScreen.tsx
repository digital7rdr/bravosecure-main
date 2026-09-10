import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Platform, PermissionsAndroid, Linking } from 'react-native';
import {Alert} from '@utils/alert';
import {requestPreciseLocation} from '@utils/locationPermission';
import {SafeAreaView} from 'react-native-safe-area-context';
import Geolocation from 'react-native-geolocation-service';
import {Camera} from 'expo-camera';
import {Audio} from 'expo-av';
import * as Contacts from 'expo-contacts';
import {useAuthStore} from '@store/authStore';
import type {AuthScreenProps} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {LinearGradient} from 'expo-linear-gradient';
import BravoMark from '@components/BravoMark';
import {goBackOnce} from '@navigation/tapGuard';

type Props = Partial<AuthScreenProps<'Permissions'>> & {onDone?: () => void};
type PermStatus = 'idle' | 'granted' | 'denied' | 'blocked';

interface PermDef {
  id: string;
  label: string;
  icon: string;
  desc: string;
  required: boolean;
}

const PERM_LIST: PermDef[] = [
  {id:'location',      label:'Location',      icon:'map-marker-outline', desc:'Live tracking, SOS response, and bookings',  required:true},
  {id:'contacts',      label:'Contacts',      icon:'account-multiple-outline', desc:'See which of your contacts use Bravo Secure', required:false},
  {id:'notifications', label:'Notifications', icon:'bell-outline', desc:'Alerts, SOS updates, booking confirmations', required:false},
  {id:'camera',        label:'Camera',        icon:'camera-outline', desc:'Document scanning and video calls',          required:false},
  {id:'microphone',    label:'Microphone',    icon:'microphone-outline', desc:'Voice notes and secure calls',               required:false},
];

// ─── Per-permission OS request ───────────────────────────────────────────────

async function requestPerm(id: string): Promise<PermStatus> {
  try {
    // Contacts is cross-platform via expo-contacts — handle it before the
    // Android/iOS split so the same flow runs on both.
    if (id === 'contacts') {
      const perm = await Contacts.requestPermissionsAsync();
      if (perm.status === Contacts.PermissionStatus.GRANTED) {return 'granted';}
      // canAskAgain === false means the user permanently denied — route to
      // Settings like the other blocked permissions.
      if (perm.canAskAgain === false) {return 'blocked';}
      return 'denied';
    }
    if (Platform.OS === 'android') {
      // B-89 MG-06 — location requests FINE+COARSE together (the Android 12+
      // contract) and detects an approximate-only grant instead of silently
      // running the live maps on ~km-accurate fixes.
      if (id === 'location') {
        const grant = await requestPreciseLocation({
          title: 'Location Access',
          message: 'Bravo Secure needs your location for live mission tracking.',
        });
        if (grant === 'precise' || grant === 'approximate') {return 'granted';}
        return grant;
      }
      let androidPerm: string;
      switch (id) {
        case 'location':
          androidPerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION; break;
        case 'camera':
          androidPerm = PermissionsAndroid.PERMISSIONS.CAMERA; break;
        case 'microphone':
          androidPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO; break;
        case 'notifications':
          // POST_NOTIFICATIONS only exists on Android 13+ (API 33+)
          if ((Platform.Version as number) < 33) {return 'granted';}
          androidPerm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS; break;
        default:
          return 'granted';
      }
      const result = await PermissionsAndroid.request(androidPerm, {
        title:          `${id.charAt(0).toUpperCase() + id.slice(1)} Access`,
        message:        `Bravo Secure needs ${id} permission to work correctly.`,
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      if (result === PermissionsAndroid.RESULTS.GRANTED)        {return 'granted';}
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {return 'blocked';}
      return 'denied';
    }

    // iOS
    switch (id) {
      case 'location': {
        // B-89 MG-16 — was 'always', which iOS treats as the scariest
        // prompt and most users deny; nothing in the app implements
        // background location yet (the mission foreground service is
        // Android). whenInUse matches every runtime call site.
        const auth = await Geolocation.requestAuthorization('whenInUse');
        if (auth === 'granted')  {return 'granted';}
        if (auth === 'denied')   {return 'denied';}
        return 'blocked'; // restricted / disabled
      }
      case 'camera': {
        const {status} = await Camera.requestCameraPermissionsAsync();
        if (status === 'granted') {return 'granted';}
        if (status === 'denied')  {return 'blocked';} // iOS: denied = blocked, no re-ask
        return 'denied';
      }
      case 'microphone': {
        const {status} = await Audio.requestPermissionsAsync();
        return status === 'granted' ? 'granted' : 'denied';
      }
      case 'notifications':
        return 'granted'; // handled separately via expo-notifications if needed
      default:
        return 'granted';
    }
  } catch {
    return 'denied';
  }
}

async function checkPerm(id: string): Promise<PermStatus> {
  try {
    if (id === 'contacts') {
      const perm = await Contacts.getPermissionsAsync();
      return perm.status === Contacts.PermissionStatus.GRANTED ? 'granted' : 'idle';
    }
    if (Platform.OS === 'android') {
      let androidPerm: string;
      switch (id) {
        case 'location':
          androidPerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION; break;
        case 'camera':
          androidPerm = PermissionsAndroid.PERMISSIONS.CAMERA; break;
        case 'microphone':
          androidPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO; break;
        case 'notifications':
          if ((Platform.Version as number) < 33) {return 'granted';}
          androidPerm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS; break;
        default:
          return 'granted';
      }
      const granted = await PermissionsAndroid.check(androidPerm);
      return granted ? 'granted' : 'idle';
    }
    return 'idle';
  } catch {
    return 'idle';
  }
}

const FOOTER_H = 148;

export default function PermissionsScreen({navigation, onDone}: Props) {
  const {completeAuth} = useAuthStore();
  const [statuses, setStatuses] = useState<Record<string, PermStatus>>(
    Object.fromEntries(PERM_LIST.map(p => [p.id, 'idle'])),
  );
  const [requesting, setRequesting] = useState<string | null>(null);
  const [locationError, setLocationError] = useState(false);

  // Pre-populate statuses from what's already granted (e.g. returning user).
  useEffect(() => {
    void (async () => {
      const results = await Promise.all(PERM_LIST.map(p => checkPerm(p.id)));
      setStatuses(Object.fromEntries(PERM_LIST.map((p, i) => [p.id, results[i]])));
    })();
  }, []);

  const handleAllow = useCallback(async (id: string) => {
    const current = statuses[id];
    if (current === 'granted') {return;}

    // Blocked = user permanently denied — send to OS settings.
    if (current === 'blocked') {
      Alert.alert(
        'Permission blocked',
        'You permanently denied this permission. Open Settings to re-enable it.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Open Settings', onPress: () => { void Linking.openSettings(); }},
        ],
      );
      return;
    }

    setRequesting(id);
    const result = await requestPerm(id);
    setStatuses(prev => ({...prev, [id]: result}));
    setRequesting(null);

    if (id === 'location' && result !== 'granted') {setLocationError(true);}
    if (id === 'location' && result === 'granted')  {setLocationError(false);}
  }, [statuses]);

  // Universal "Allow all" — request every not-yet-granted permission in
  // sequence. Blocked ones are skipped (they need OS settings, not a prompt).
  const handleAllowAll = useCallback(async () => {
    for (const perm of PERM_LIST) {
      if (statuses[perm.id] === 'granted' || statuses[perm.id] === 'blocked') {continue;}
      setRequesting(perm.id);
      const result = await requestPerm(perm.id);
      setStatuses(prev => ({...prev, [perm.id]: result}));
      if (perm.id === 'location') {setLocationError(result !== 'granted');}
    }
    setRequesting(null);
  }, [statuses]);

  const finish = useCallback(() => {
    if (onDone) {
      onDone(); // gate mode — RootNavigator handles the rest
    } else {
      void completeAuth(); // auth-flow mode — flip isAuthenticated
    }
  }, [onDone, completeAuth]);

  const handleContinue = useCallback(() => {
    const locStatus = statuses.location;
    if (locStatus !== 'granted') {
      setLocationError(true);
      void handleAllow('location');
      return;
    }
    finish();
  }, [statuses, handleAllow, finish]);

  const handleSkip = useCallback(() => {
    const locStatus = statuses.location;
    if (locStatus !== 'granted') {
      setLocationError(true);
      void handleAllow('location');
      return;
    }
    finish();
  }, [statuses, handleAllow, finish]);

  const allGranted = PERM_LIST.every(p => statuses[p.id] === 'granted');
  const locGranted = statuses.location === 'granted';

  const grantedCount = PERM_LIST.filter(p => statuses[p.id] === 'granted').length;

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.glow} pointerEvents="none" />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces>

        {/* BB-5 (2026-08-15 back audit) — the PermGate mount renders this
            screen as the ROOT stack's only route AND passes no navigation
            prop at all, so the arrow was a dead (and crash-prone) control on
            the one path everyone actually sees. Optional-chained: prop absent
            on PermGate, present on the (unreachable) AuthNavigator route. */}
        {navigation?.canGoBack?.() ? (
          <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="chevron-left" size={22} color="#F2F4F8" />
          </TouchableOpacity>
        ) : null}

        {/* Hero — the Bravo logo replaces the old guard/shield emblem
            (founder, design import 2026-08-27: Bravo Permissions - Android). */}
        <View style={s.hero}>
          <View style={s.markWrap}>
            <View style={s.halo} />
            <View style={s.halo2} />
            <View style={s.markTile}>
              <BravoMark size={40} primary="#FFFFFF" accent="#5B8DEF" />
            </View>
          </View>
          <Text style={s.title}>
            A few permissions and{'\n'}you&apos;re <Text style={s.titleAccent}>fully protected</Text>
          </Text>
          <Text style={s.lede}>
            Bravo only uses these while you&apos;re on an active booking or an SOS is
            running. You can revoke any of them later.
          </Text>
        </View>

        <View style={s.metaRow}>
          <View style={s.cntWrap}>
            <View style={s.cntDot} />
            <Text style={s.cntText} numberOfLines={1}>{grantedCount} of {PERM_LIST.length} granted</Text>
          </View>
          {!allGranted && (
            <TouchableOpacity
              style={s.allowAllBtn}
              onPress={() => { void handleAllowAll(); }}
              disabled={!!requesting}
              activeOpacity={0.85}>
              <Text style={s.allowAllText} numberOfLines={1}>{requesting ? 'Requesting…' : 'Allow all'}</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.list}>
          {PERM_LIST.map(perm => {
            const status  = statuses[perm.id];
            const loading = requesting === perm.id;
            const isBlocked = status === 'blocked';
            const isDenied  = status === 'denied';
            const isGranted = status === 'granted';
            const showRequired = perm.required && !isGranted;

            return (
              <View
                key={perm.id}
                style={[
                  s.row,
                  showRequired && s.rowRequired,
                  perm.required && locationError && perm.id === 'location' && s.rowError,
                  isGranted && s.rowGranted,
                ]}>
                <View style={[s.iconBox, showRequired && s.iconBoxRequired, isGranted && s.iconBoxGranted]}>
                  <Icon
                    name={perm.icon as never}
                    size={21}
                    color={isGranted ? '#9BEFBE' : showRequired ? '#FFAFAF' : '#A9C6FF'}
                  />
                </View>

                <View style={s.rowText}>
                  <View style={s.rowLabelRow}>
                    <Text style={s.rowLabel} numberOfLines={1}>{perm.label}</Text>
                    {perm.required && (
                      <View style={[s.reqBadge, isGranted && s.reqBadgeGranted]}>
                        <Text style={[s.reqBadgeText, isGranted && s.reqBadgeTextGranted]} numberOfLines={1}>
                          REQUIRED
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.rowDesc}>{perm.desc}</Text>
                  {isDenied && !isBlocked && (
                    <Text style={s.deniedHint}>Denied — tap Allow to try again</Text>
                  )}
                  {isBlocked && (
                    <Text style={s.deniedHint}>Blocked — tap to open Settings</Text>
                  )}
                </View>

                {isGranted ? (
                  <View style={s.doneWrap}>
                    <Icon name="check" size={15} color="#4ADE80" />
                    <Text style={s.doneText}>Allowed</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[
                      s.allowBtn,
                      status === 'idle'   && s.allowBtnPrimary,
                      isDenied            && s.allowBtnRetry,
                      isBlocked           && s.allowBtnBlocked,
                      loading             && s.allowBtnLoading,
                    ]}
                    onPress={() => { void handleAllow(perm.id); }}
                    disabled={loading}
                    activeOpacity={0.8}>
                    <Text style={[s.allowBtnText, (isDenied || isBlocked) && s.allowBtnTextMuted]} numberOfLines={1}>
                      {loading ? '…' : isBlocked ? 'Settings' : isDenied ? 'Retry' : 'Allow'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        <View style={s.note}>
          <Icon name="lock-outline" size={13} color="rgba(180,188,204,0.45)" style={{marginTop: 1}} />
          <Text style={s.noteText}>
            Nothing is shared with third parties. Location stops being read the
            moment a booking ends.
          </Text>
        </View>

        {locationError && !locGranted && (
          <View style={s.errorBanner}>
            <Text style={s.errorBannerText}>Location is required to continue. Please allow access above.</Text>
          </View>
        )}

        <View style={{height: FOOTER_H + 20}} />
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity onPress={handleContinue} activeOpacity={0.85} style={s.ctaWrap}>
          <LinearGradient
            colors={locGranted ? ['#6FA0FF', '#5B8DEF'] : ['#33415E', '#2A3550']}
            start={{x: 0.5, y: 0}}
            end={{x: 0.5, y: 1}}
            style={s.cta}>
            <Text style={s.ctaText} numberOfLines={1}>
              {allGranted ? 'Continue' : locGranted ? 'Continue' : 'Allow Location to continue'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
        {locGranted && (
          <TouchableOpacity onPress={handleSkip} activeOpacity={0.7}>
            <Text style={s.skipText}>Set up later</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

// Obsidian surface (design-system master; G8 — this screen was the last of the
// auth flow still on Command-Navy).
const BG     = '#07090D';
const ACCENT = '#5B8DEF';
const HAIR   = 'rgba(255,255,255,0.07)';
const OK     = '#4ADE80';
const ERR    = '#FF5D5D';
const WARN   = '#F5B544';

const s = StyleSheet.create(scaleTextStyles({
  safe:    {flex:1, backgroundColor:BG},
  glow:    {position:'absolute', top:-190, alignSelf:'center', width:600, height:470, borderRadius:300, backgroundColor:'rgba(91,141,239,0.07)'},
  scroll:  {flex:1},
  content: {paddingHorizontal:20},

  backBtn:  {marginTop:8, marginBottom:4, width:40, height:40, borderRadius:13, backgroundColor:'rgba(255,255,255,0.05)', borderWidth:1, borderColor:HAIR, alignItems:'center', justifyContent:'center'},

  hero:     {paddingTop:18, paddingBottom:24},
  markWrap: {width:60, height:60, marginBottom:20},
  halo:     {position:'absolute', top:-14, left:-14, right:-14, bottom:-14, borderRadius:26, borderWidth:1, borderColor:'rgba(91,141,239,0.13)'},
  halo2:    {position:'absolute', top:-27, left:-27, right:-27, bottom:-27, borderRadius:34, borderWidth:1, borderColor:'rgba(91,141,239,0.06)'},
  markTile: {width:60, height:60, borderRadius:19, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(91,141,239,0.14)', borderWidth:1, borderColor:'rgba(91,141,239,0.4)',
    shadowColor:ACCENT, shadowOpacity:0.45, shadowRadius:15, shadowOffset:{width:0, height:6}, elevation:8},
  title:       {fontSize:29, fontWeight:'400', lineHeight:34, letterSpacing:-0.9, color:'#F2F4F8'},
  titleAccent: {fontWeight:'700', color:ACCENT},
  lede:        {fontSize:13.5, lineHeight:21, color:'rgba(180,188,204,0.75)', marginTop:13, maxWidth:318},

  metaRow: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:13},
  cntWrap: {flexDirection:'row', alignItems:'center', gap:8, flexShrink:1, minWidth:0},
  cntDot:  {width:5, height:5, borderRadius:3, backgroundColor:OK},
  cntText: {fontSize:11.5, fontWeight:'500', letterSpacing:1.4, textTransform:'uppercase', color:'rgba(180,188,204,0.45)', flexShrink:1},
  allowAllBtn:  {flexShrink:0, paddingHorizontal:16, paddingVertical:8, borderRadius:100, backgroundColor:'rgba(91,141,239,0.08)', borderWidth:1, borderColor:'rgba(91,141,239,0.34)'},
  allowAllText: {fontSize:12.5, fontWeight:'500', color:'#8CB3FF'},

  list: {gap:9},

  row: {
    flexDirection:'row', alignItems:'center', gap:13,
    backgroundColor:'rgba(22,27,37,0.72)',
    borderWidth:1, borderColor:HAIR,
    padding:15, borderRadius:20,
  },
  rowRequired: {borderColor:'rgba(255,93,93,0.26)', backgroundColor:'rgba(36,23,34,0.72)'},
  rowGranted:  {borderColor:'rgba(74,222,128,0.22)', backgroundColor:'rgba(20,36,30,0.72)'},
  rowError:    {borderColor:'rgba(255,93,93,0.5)'},

  iconBox:         {width:44, height:44, borderRadius:14, alignItems:'center', justifyContent:'center', flexShrink:0,
    backgroundColor:'rgba(91,141,239,0.14)', borderWidth:1, borderColor:'rgba(120,168,255,0.26)'},
  iconBoxRequired: {backgroundColor:'rgba(255,93,93,0.14)', borderColor:'rgba(255,140,140,0.3)'},
  iconBoxGranted:  {backgroundColor:'rgba(74,222,128,0.14)', borderColor:'rgba(127,227,165,0.3)'},

  rowText:     {flex:1, minWidth:0},
  rowLabelRow: {flexDirection:'row', alignItems:'center', gap:7, marginBottom:2},
  rowLabel:    {fontSize:14.5, fontWeight:'500', color:'#F2F4F8', letterSpacing:-0.1, flexShrink:1, minWidth:0},
  rowDesc:     {fontSize:12, color:'rgba(180,188,204,0.75)', lineHeight:16},
  deniedHint:  {fontSize:11, color:WARN, marginTop:4, fontStyle:'italic'},

  reqBadge:           {flexShrink:0, paddingHorizontal:6, paddingVertical:2.5, borderRadius:5, backgroundColor:'rgba(255,93,93,0.14)', borderWidth:1, borderColor:'rgba(255,93,93,0.28)'},
  reqBadgeGranted:    {backgroundColor:'rgba(74,222,128,0.14)', borderColor:'rgba(74,222,128,0.35)'},
  reqBadgeText:       {fontSize:8.5, fontWeight:'700', color:'#FF9494', letterSpacing:1, textTransform:'uppercase'},
  reqBadgeTextGranted:{color:OK},

  doneWrap: {flexDirection:'row', alignItems:'center', gap:6, flexShrink:0, paddingRight:4},
  doneText: {fontSize:12.5, fontWeight:'500', color:OK},

  allowBtn:        {flexShrink:0, paddingHorizontal:18, paddingVertical:9, borderRadius:100},
  allowBtnPrimary: {backgroundColor:ACCENT},
  allowBtnRetry:   {backgroundColor:'rgba(245,181,68,0.12)', borderWidth:1, borderColor:'rgba(245,181,68,0.5)'},
  allowBtnBlocked: {backgroundColor:'rgba(255,93,93,0.1)',   borderWidth:1, borderColor:'rgba(255,93,93,0.4)'},
  allowBtnLoading: {opacity:0.5},
  allowBtnText:    {fontSize:13, fontWeight:'500', color:'#fff'},
  allowBtnTextMuted:{color:'rgba(180,188,204,0.75)'},

  note:     {flexDirection:'row', alignItems:'flex-start', gap:9, marginTop:16, marginHorizontal:2},
  noteText: {flex:1, minWidth:0, fontSize:11.5, lineHeight:17, color:'rgba(180,188,204,0.45)'},

  errorBanner: {
    marginTop:16, padding:12, borderRadius:12,
    backgroundColor:'rgba(255,93,93,0.1)', borderWidth:1, borderColor:'rgba(255,93,93,0.35)',
  },
  errorBannerText: {fontSize:12, color:ERR, lineHeight:18, fontWeight:'600'},

  footer: {
    position:'absolute', bottom:0, left:0, right:0, minHeight:FOOTER_H,
    paddingHorizontal:20, paddingTop:14, paddingBottom:32, gap:4, alignItems:'center',
    backgroundColor:BG, borderTopWidth:1, borderTopColor:HAIR,
  },
  ctaWrap: {width:'100%', borderRadius:17, overflow:'hidden',
    shadowColor:ACCENT, shadowOpacity:0.4, shadowRadius:16, shadowOffset:{width:0, height:8}, elevation:8},
  cta:     {minHeight:56, alignItems:'center', justifyContent:'center', paddingHorizontal:16, paddingVertical:16},
  ctaText: {fontSize:15, fontWeight:'600', color:'#fff', letterSpacing:0.1},
  skipText:{fontSize:12.5, color:'rgba(180,188,204,0.45)', fontWeight:'500', padding:12},
}));
