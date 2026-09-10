import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
} from 'react-native';
import {DIAL_CODES, type DialCode} from '@utils/constants';

interface Props {
  visible: boolean;
  onSelect: (code: DialCode) => void;
  onClose: () => void;
}

export function CountryPicker({visible, onSelect, onClose}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={s.sheet}>
          <View style={s.handle} />
          <Text style={s.title}>Select country</Text>
          <FlatList
            data={DIAL_CODES}
            keyExtractor={c => c.code}
            renderItem={({item}) => (
              <TouchableOpacity
                style={s.row}
                onPress={() => onSelect(item)}
                activeOpacity={0.7}>
                <Text style={s.flag}>{item.flag}</Text>
                <Text style={s.label}>{item.label}</Text>
                <Text style={s.dial}>{item.dial}</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: '#0D1929',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 24, paddingTop: 12, paddingBottom: 32, maxHeight: '70%',
  },
  handle: {
    width: 40, height: 4, backgroundColor: '#1E2D45', borderRadius: 2,
    alignSelf: 'center', marginBottom: 16,
  },
  title: {fontSize: 16, fontWeight: '700', color: '#f1f5f9', marginBottom: 12},
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1E2D45',
  },
  flag:  {fontSize: 24},
  label: {flex: 1, fontSize: 15, color: '#f1f5f9'},
  dial:  {fontSize: 14, fontWeight: '600', color: '#60A5FA'},
});
