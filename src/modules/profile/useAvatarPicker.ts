/**
 * Shared profile-photo picker used by every "set my avatar" surface
 * (individual ProfileScreen, CPO "Me" tab, service-provider/agent profile).
 *
 * One code path so all roles behave identically: pick (library or camera) →
 * native square crop (allowsEditing + aspect 1:1) → upload to the public
 * `avatars` Supabase bucket → persist the URL via `setAvatar`. Removing clears
 * `avatar_url`. The picker returns base64 which we hand to userService.uploadAvatar.
 */
import {useCallback, useState} from 'react';
import {Alert} from '@utils/alert';
import * as ImagePicker from 'expo-image-picker';
import {useAuthStore} from '@store/authStore';
import {userService} from '@/services/supabase';

const CROP_OPTS = {
  allowsEditing: true,
  aspect: [1, 1] as [number, number],
  quality: 0.7,
  base64: true,
} as const;

export interface AvatarPicker {
  busy: boolean;
  hasPhoto: boolean;
  pickFromLibrary: () => Promise<void>;
  takePhoto: () => Promise<void>;
  removePhoto: () => Promise<void>;
}

export function useAvatarPicker(): AvatarPicker {
  const userId = useAuthStore(s => s.user?.id);
  const hasPhoto = useAuthStore(s => !!s.user?.avatar_url);
  const setAvatar = useAuthStore(s => s.setAvatar);
  const [busy, setBusy] = useState(false);

  const applyAsset = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      if (!asset.base64 || !userId) {return;}
      setBusy(true);
      try {
        const url = await userService.uploadAvatar(userId, asset.base64, asset.mimeType ?? 'image/jpeg');
        await setAvatar(url);
      } catch {
        Alert.alert('Could not update photo', 'Please try again.');
      } finally {
        setBusy(false);
      }
    },
    [userId, setAvatar],
  );

  const pickFromLibrary = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to set a profile picture.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], ...CROP_OPTS});
    if (!res.canceled && res.assets[0]) {await applyAsset(res.assets[0]);}
  }, [applyAsset]);

  const takePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow camera access to take a profile picture.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({cameraType: ImagePicker.CameraType.front, ...CROP_OPTS});
    if (!res.canceled && res.assets[0]) {await applyAsset(res.assets[0]);}
  }, [applyAsset]);

  const removePhoto = useCallback(async () => {
    setBusy(true);
    try {
      await setAvatar(null);
    } catch {
      Alert.alert('Could not remove photo', 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [setAvatar]);

  return {busy, hasPhoto, pickFromLibrary, takePhoto, removePhoto};
}
