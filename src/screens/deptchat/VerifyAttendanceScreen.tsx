import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, StatusBar} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import {CameraView} from 'expo-camera';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {attendanceApi} from '@services/api';
import {OB, ObHeader, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';
import {getGeo, requestCamera} from './geo';
import {runFaceCheck, type FaceCheckResult} from './faceCheck';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'VerifyAttendance'>;

// v2 face confirmation (PDF p.6): a LIVE front-camera preview + on-device MLKit
// face detection (see faceCheck.ts for the biometric stop-conditions — the frame
// never leaves the device and is deleted immediately). Serves BOTH check-in and
// check-out (PDF p.5 requires verification on both). Camera denial degrades to a
// Pending Review submission with the distinct camera_unavailable reason.
export default function VerifyAttendanceScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const mode = params.mode ?? 'checkin';
  const isCheckout = mode === 'checkout';
  const camRef = useRef<CameraView | null>(null);
  const [camOk, setCamOk] = useState<boolean | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async () => { setCamOk(await requestCamera()); }, []);
  useEffect(() => { void ask(); }, [ask]);

  const submit = async (face: Pick<FaceCheckResult, 'face_ok' | 'face_unavailable'> & {face_meta?: FaceCheckResult['face_meta']}) => {
    const geo = await getGeo();
    const geoBody = geo ? {lat: geo.lat, lng: geo.lng, accuracy_m: geo.accuracy_m} : {};
    if (isCheckout) {
      const {data} = await attendanceApi.clockOut({
        ...geoBody, face_ok: face.face_ok,
        ...(face.face_unavailable ? {face_unavailable: true} : {}),
      });
      navigation.replace('AttendanceResult', {
        status: data.attendance_status ?? null,
        reviewReason: data.review_reason ?? null,
        clockInAt: data.clock_out_at ?? data.clock_in_at,
        siteLabel: params.siteLabel ?? null,
        mode: 'checkout',
      });
      return;
    }
    const {data} = await attendanceApi.clockIn({
      shift_id: params.shiftId,
      face_ok: face.face_ok,
      ...(face.face_unavailable ? {face_unavailable: true} : {}),
      // Non-biometric audit metadata only — NO frames / descriptors.
      face_meta: face.face_meta ?? {model: 'presence', version: 'v1', confidenceBucket: 'unavailable'},
      ...geoBody,
    });
    navigation.replace('AttendanceResult', {
      status: data.attendance_status ?? null,
      reviewReason: data.review_reason ?? null,
      clockInAt: data.clock_in_at,
      siteLabel: params.siteLabel ?? null,
      mode: 'checkin',
    });
  };

  const confirm = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      if (camOk && camRef.current) {
        // Capture one frame for the on-device check; faceCheck deletes it.
        const photo = await camRef.current.takePictureAsync({quality: 0.4, skipProcessing: true});
        const face = photo?.uri
          ? await runFaceCheck(photo.uri)
          : {face_ok: false, face_unavailable: true as const, face_meta: {model: 'presence', version: 'v2', confidenceBucket: 'capture_failed'}};
        await submit(face);
      } else {
        // Camera denied/unavailable → Pending Review with the distinct reason.
        await submit({face_ok: false, face_unavailable: true});
      }
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      if (msg === 'no_active_shift_assigned') {
        Alert.alert('Attendance', 'No active shift is assigned to you right now.');
        navigation.goBack();
      } else if (msg === 'shift_already_open') {
        Alert.alert('Attendance', 'You already have an open shift.');
        navigation.goBack();
      } else if (msg === 'no_open_shift') {
        Alert.alert('Attendance', 'You have no open shift to check out of.');
        navigation.goBack();
      } else {
        Alert.alert('Attendance', msg ?? (e as Error).message ?? 'Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const denied = camOk === false;
  const verb = isCheckout ? 'Check Out' : 'Check In';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title={isCheckout ? 'Verify Check-Out' : 'Verify Attendance'}
        onBack={() => navigation.goBack()}
        pill={isCheckout ? 'CHECK-OUT' : 'STEP 1'}
      />

      <View style={s.body}>
        {/* Live face frame (PDF p.6 "Look at the camera") */}
        <View style={s.frameWrap}>
          <LinearGradient
            colors={denied ? ['rgba(245,139,151,0.18)', 'rgba(245,139,151,0.04)'] : ['rgba(91,141,239,0.22)', 'rgba(47,91,224,0.06)']}
            start={{x: 0.2, y: 0}}
            end={{x: 0.9, y: 1}}
            style={[s.frame, denied && {borderColor: 'rgba(245,139,151,0.5)'}]}>
            {camOk ? (
              <CameraView
                ref={camRef}
                style={s.cameraFill}
                facing="front"
                onCameraReady={() => setCamReady(true)}
              />
            ) : (
              <Icon
                name={denied ? 'camera-off-outline' : 'camera-outline'}
                size={64}
                color={denied ? OB.alert : OB.glow}
              />
            )}
          </LinearGradient>
          <View style={[s.scanDot, {backgroundColor: denied ? OB.alert : camReady ? OB.signal : OB.amber}]} />
        </View>

        <Text style={s.title}>
          {denied ? 'Camera access needed' : 'Look at the camera'}
        </Text>
        <Text style={s.sub}>
          {denied
            ? `Allow camera access to confirm you are present. You can still ${verb.toLowerCase()} — it will be sent for admin review.`
            : 'Position your face within the frame, then confirm.'}
        </Text>

        {/* Privacy assurance (PDF p.6) */}
        <Card style={s.note}>
          <View style={s.noteRow}>
            <Icon name="shield-lock-outline" size={16} color={OB.accentSoft} />
            <Text style={s.noteText}>
              Your face is checked on this device only. No photo or face data is uploaded or kept —
              only a pass/fail result and your {isCheckout ? 'check-out' : 'check-in'} location.
            </Text>
          </View>
        </Card>
      </View>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        {denied ? (
          <View style={{gap: 10}}>
            <PrimaryButton label="Allow Camera" icon="camera" onPress={() => { void ask(); }} />
            <Text style={s.link} onPress={() => { void confirm(); }}>
              {verb} without camera (Pending Review)
            </Text>
          </View>
        ) : (
          <PrimaryButton
            label={`Confirm & ${verb}`}
            icon="check-decagram"
            busy={busy}
            disabled={camOk === null || (camOk === true && !camReady)}
            onPress={() => { void confirm(); }}
          />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  body: {flex: 1, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 16},
  frameWrap: {alignItems: 'center', justifyContent: 'center'},
  frame: {
    width: 200, height: 200, borderRadius: 100, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(91,141,239,0.5)', overflow: 'hidden',
  },
  cameraFill: {width: '100%', height: '100%'},
  scanDot: {position: 'absolute', bottom: 6, width: 8, height: 8, borderRadius: 4},
  title: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.4, textAlign: 'center'},
  sub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13.5, textAlign: 'center', lineHeight: 19, paddingHorizontal: 8},
  note: {width: '100%', marginTop: 8},
  noteRow: {flexDirection: 'row', gap: 10, alignItems: 'flex-start'},
  noteText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 17},
  footer: {paddingHorizontal: 24, paddingTop: 12},
  link: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 13, textAlign: 'center', paddingVertical: 8},
}));
