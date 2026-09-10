import {useState, useEffect} from 'react';
import Geolocation from 'react-native-geolocation-service';
import {Platform, PermissionsAndroid} from 'react-native';
import type {Location} from '@appTypes/index';

interface LocationState {
  location: Location | null;
  error: string | null;
  isLoading: boolean;
}

export function useLocation(watchMode = false): LocationState {
  const [state, setState] = useState<LocationState>({
    location: null,
    error: null,
    isLoading: true,
  });

  useEffect(() => {
    let watchId: number | null = null;

    const requestPermission = async (): Promise<boolean> => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
      const auth = await Geolocation.requestAuthorization('whenInUse');
      return auth === 'granted';
    };

    const start = async () => {
      const hasPermission = await requestPermission();
      if (!hasPermission) {
        setState({location: null, error: 'Location permission denied', isLoading: false});
        return;
      }

      const onSuccess = (pos: {coords: {latitude: number; longitude: number}}) => {
        setState({
          location: {latitude: pos.coords.latitude, longitude: pos.coords.longitude},
          error: null,
          isLoading: false,
        });
      };

      const onError = (err: {message: string}) => {
        setState(s => ({...s, error: err.message, isLoading: false}));
      };

      if (watchMode) {
        watchId = Geolocation.watchPosition(onSuccess, onError, {
          enableHighAccuracy: true,
          distanceFilter: 5,
          interval: 10_000,
          fastestInterval: 5_000,
        });
      } else {
        // Why: without a timeout some devices never resolve indoors — hang forever.
        Geolocation.getCurrentPosition(onSuccess, onError, {
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 30_000,
        });
      }
    };

    void start();

    return () => {
      if (watchId !== null) {Geolocation.clearWatch(watchId);}
    };
  }, [watchMode]);

  return state;
}
