import {useCallback, useRef, useState} from 'react';
import {Platform, PermissionsAndroid} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Geolocation from 'react-native-geolocation-service';

export interface VbgFix {
  lat: number;
  lng: number;
}

/**
 * GPS fix for the VBG screens. Drives the region-based SRA / threats /
 * key-points calls. Mirrors the permission + getCurrentPosition pattern
 * already used by LocationPickerScreen, but returns null (not an error) when
 * location is unavailable so every VBG screen degrades to its graceful
 * "no fix" state rather than blocking.
 *
 * Refreshes on every screen FOCUS (audit L-3) — a principal who moves and
 * returns to a mounted screen gets a current fix, not the mount-time one.
 * `ready` turns true after the FIRST attempt settles and stays true.
 */
export function useVbgLocation(): {fix: VbgFix | null; ready: boolean} {
  const [fix, setFix] = useState<VbgFix | null>(null);
  const [ready, setReady] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    if (busy.current) {return;}
    busy.current = true;
    const finish = (v: VbgFix | null) => {
      busy.current = false;
      if (!alive.current) {return;}
      // A failed refresh never clobbers a previous good fix.
      if (v) {setFix(v);}
      setReady(true);
    };
    void (async () => {
      try {
        if (Platform.OS === 'android') {
          // Already-granted permission resolves without showing a dialog.
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {return finish(null);}
        } else {
          await Geolocation.requestAuthorization('whenInUse');
        }
        Geolocation.getCurrentPosition(
          pos => finish({lat: pos.coords.latitude, lng: pos.coords.longitude}),
          () => finish(null),
          {enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000},
        );
      } catch {
        finish(null);
      }
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      alive.current = true;
      refresh();
      return () => { alive.current = false; };
    }, [refresh]),
  );

  return {fix, ready};
}
