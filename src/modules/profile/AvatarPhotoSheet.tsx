/**
 * Bottom action-sheet for choosing a profile photo. Presentational only —
 * the owning screen holds the useAvatarPicker() instance (so it can also show
 * a busy overlay on the avatar) and passes the handlers in. Styling matches the
 * obsidian profile sheet used across the app.
 */
import React from 'react';
import {Modal, View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

const T = {
  text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.06)',
  hair2: 'rgba(255,255,255,0.09)',
  blue: '#A9C5FF',
  alert: '#FF8585',
} as const;

interface Props {
  visible: boolean;
  onClose: () => void;
  hasPhoto: boolean;
  onLibrary: () => void;
  onCamera: () => void;
  onRemove: () => void;
}

export function AvatarPhotoSheet({visible, onClose, hasPhoto, onLibrary, onCamera, onRemove}: Props) {
  // Close the sheet first, then run the (async) picker action.
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          <Text style={styles.title}>Profile photo</Text>
          <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={run(onLibrary)}>
            <Icon name="image-outline" size={20} color={T.blue} />
            <Text style={styles.rowText}>Choose from Library</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={run(onCamera)}>
            <Icon name="camera-outline" size={20} color={T.blue} />
            <Text style={styles.rowText}>Take Photo</Text>
          </TouchableOpacity>
          {hasPhoto ? (
            <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={run(onRemove)}>
              <Icon name="trash-can-outline" size={20} color={T.alert} />
              <Text style={[styles.rowText, {color: T.alert}]}>Remove Photo</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.cancel} activeOpacity={0.8} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: T.hair2, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 28},
  title: {fontFamily: 'Manrope_700Bold', fontSize: 13, letterSpacing: 1, color: T.textMute, textTransform: 'uppercase', marginBottom: 6, marginLeft: 4},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: T.hair},
  rowText: {fontFamily: 'Manrope_600SemiBold', fontSize: 15.5, color: T.text},
  cancel: {marginTop: 12, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  cancelText: {fontFamily: 'Manrope_700Bold', fontSize: 15, color: T.textDim},
});
