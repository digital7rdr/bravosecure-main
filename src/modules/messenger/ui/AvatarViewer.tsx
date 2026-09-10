/**
 * Founder 2026-08-01 — full-screen profile-photo viewer. Tapping an avatar
 * (chat-list row, Chat Info header) opens the picture edge-to-edge so the
 * person — or text inside the photo — can actually be identified. View-only:
 * tap anywhere (or the X) to close.
 */
import React from 'react';
import {View, Text, StyleSheet, Modal, Pressable, Image, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

export interface AvatarViewTarget {
  uri:  string;
  name: string;
}

export function AvatarViewer({target, onClose}: {
  target:  AvatarViewTarget | null;
  onClose: () => void;
}) {
  if (!target) {return null;}
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.root} onPress={onClose} accessibilityLabel="Close photo">
        <Image source={{uri: target.uri}} style={styles.photo} resizeMode="contain" />
        <View style={styles.captionWrap} pointerEvents="none">
          <Text style={styles.caption} numberOfLines={1}>{target.name}</Text>
        </View>
        <TouchableOpacity
          style={styles.close}
          onPress={onClose}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          accessibilityRole="button"
          accessibilityLabel="Close">
          <Icon name="close" size={20} color="#F2F4F8" />
        </TouchableOpacity>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'rgba(0,0,0,0.96)', alignItems: 'center', justifyContent: 'center'},
  photo: {width: '100%', height: '78%'},
  captionWrap: {position: 'absolute', bottom: 48, left: 24, right: 24, alignItems: 'center'},
  caption: {color: '#F2F4F8', fontSize: 15, fontWeight: '700', letterSpacing: -0.2},
  close: {
    position: 'absolute', top: 54, right: 20, width: 36, height: 36, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
});
