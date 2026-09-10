/**
 * B-87/MX-04 — pre-send review tray for multi-photo selection. Obsidian
 * bottom sheet matching the ChatScreen attach sheet: thumbnail strip,
 * per-item remove, explicit "Send N" — so a 10-photo pick is a reviewed
 * action, not a burst of accidental sends.
 *
 * B-707 — it now carries the CAPTION field too, and every library pick and
 * camera shot routes through it (a single pick used to fire straight down the
 * queue, so a one-photo send had nowhere to type). `sendMedia` has always put
 * `opts.caption` in the message body and the bubble has always rendered it
 * under the attachment — the only thing missing was this input.
 */
import React from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TouchableOpacity,
  Image, FlatList, TextInput,
} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import type {PickedAsset} from './pickedAssets';

const T = {
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  signal:     '#4ADE80',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  glassFill:  'rgba(255,255,255,0.04)',
} as const;
const SHEET_GRADIENT = ['#131A28', '#0C111B'] as const;
const SEND_GRADIENT  = ['#4C86F0', T.accentDeep] as const;

function fmtDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || ms <= 0) {return null;}
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * B-707 — the caption field's own ceiling. NOT the message ceiling: the runtime
 * refuses a body over `MAX_MESSAGE_CHARS` (65_536) and the composer sets no
 * limit at all, so this is a UI bound, chosen so the field cannot grow the
 * sheet past the screen — a caption is a label on a photo, not a thread.
 */
const MAX_CAPTION_CHARS = 1000;

export function MediaPreviewTray({assets, onRemoveAt, onCancel, onSend}: {
  assets:     PickedAsset[];
  onRemoveAt: (index: number) => void;
  onCancel:   () => void;
  /** B-707 — the typed caption, trimmed by the caller via `withBatchCaption`. */
  onSend:     (caption: string) => void;
}) {
  const visible = assets.length > 0;
  /**
   * B-707 — the host keeps this component MOUNTED across openings (it renders
   * unconditionally and gates on `assets.length`), so the field has to be reset
   * per close. Without it the next pick inherits the last caption — text the
   * user wrote for a different photo, silently published on this one.
   */
  const [caption, setCaption] = React.useState('');
  React.useEffect(() => { if (!visible) {setCaption('');} }, [visible]);
  /**
   * B-284 — Cancel / Send sat UNDER the navigation bar.
   *
   * The sheet padded its bottom with a hardcoded `26`, which is not a safe-area
   * inset: on a 3-button nav bar it is ~22dp short and the system icons draw
   * straight over the buttons (founder screenshot), and on a gesture-pill phone
   * or a tablet it is wrong by a different amount. There is no dp constant that
   * is right on every device, which is exactly why the app has ONE rule.
   *
   * `bottomPad(gap)` is the documented choice for a bottom-anchored sheet
   * (CLAUDE.md § Keyboard / focused input): it adds the real inset, REPLACES it
   * with the keyboard overlap if an IME is ever up over this sheet rather than
   * stacking the two, and compensates the nav bar RN strips under edge-to-edge on
   * Android API >= 30. Dynamic on every phone, by construction.
   */
  const {bottomPad} = useKeyboardLayout();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Discard selected media">
        <Pressable>
          <LinearGradient
            colors={SHEET_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}}
            style={[styles.sheet, {paddingBottom: bottomPad(14)}]}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>
                {assets.length} {assets.length === 1 ? 'item' : 'items'} selected
              </Text>
              <View style={styles.encBadge}>
                <Icon name="lock" size={11} color={T.signal} />
                <Text style={styles.encBadgeText}>Encrypted</Text>
              </View>
            </View>

            <FlatList
              data={assets}
              horizontal
              keyExtractor={(a, i) => `${a.uri}:${i}`}
              showsHorizontalScrollIndicator={false}
              // With the caption field focused, the first tap on a remove
              // button would otherwise be spent dismissing the keyboard.
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.strip}
              renderItem={({item, index}) => {
                const dur = fmtDuration(item.meta.durationMs);
                return (
                  <View style={styles.thumbWrap}>
                    <Image source={{uri: item.uri}} style={styles.thumb} resizeMode="cover" />
                    {item.kind === 'video' && (
                      <View style={styles.videoBadge}>
                        <Icon name="play" size={11} color="#FFF" />
                        {dur ? <Text style={styles.videoBadgeText}>{dur}</Text> : null}
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => onRemoveAt(index)}
                      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove item ${index + 1}`}>
                      <Icon name="close" size={13} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                );
              }}
            />

            {/* B-707 — the caption. Deliberately NOT autoFocused: most sends
                are wordless, and raising the IME on every pick would bury the
                thumbnails the tray exists to show. */}
            <View style={styles.captionRow}>
              <TextInput
                style={styles.captionInput}
                value={caption}
                onChangeText={setCaption}
                placeholder={assets.length > 1 ? 'Add a message to the first photo…' : 'Add a message…'}
                placeholderTextColor={T.textMute}
                maxLength={MAX_CAPTION_CHARS}
                multiline
                returnKeyType="default"
                accessibilityLabel="Message to send with this attachment"
              />
            </View>

            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={onCancel}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Cancel sending">
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sendBtn}
                onPress={() => onSend(caption)}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`Send ${assets.length} ${assets.length === 1 ? 'item' : 'items'}`}>
                <LinearGradient
                  colors={SEND_GRADIENT}
                  start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, styles.sendBtnFill]}
                />
                <Icon name="send" size={15} color="#FFF" />
                <Text style={styles.sendText}>{assets.length > 1 ? `Send ${assets.length}` : 'Send'}</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(4,6,10,0.72)'},
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    // paddingBottom is applied INLINE from bottomPad(14) — see B-284 above. A
    // constant here would stack under the dynamic inset and re-open the bug.
    paddingHorizontal: 18, paddingTop: 10,
    borderTopWidth: 1, borderColor: T.hair2,
  },
  handle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: T.hair2, marginBottom: 12},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  title: {color: T.text, fontSize: 15, fontWeight: '800'},
  encBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.26)'},
  encBadgeText: {color: T.signal, fontSize: 10, fontWeight: '700', letterSpacing: 0.4},
  strip: {gap: 10, paddingVertical: 4},
  thumbWrap: {position: 'relative'},
  thumb: {width: 92, height: 92, borderRadius: 14, backgroundColor: T.glassFill, borderWidth: 1, borderColor: T.hair},
  videoBadge: {position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: 'rgba(4,6,10,0.75)'},
  videoBadgeText: {color: '#FFF', fontSize: 9, fontWeight: '700'},
  removeBtn: {position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: '#2A3348', borderWidth: 1, borderColor: T.hair2, alignItems: 'center', justifyContent: 'center'},
  // B-707 — caption field. `maxHeight` caps the growth of the multiline input
  // so a long caption scrolls inside the field instead of pushing Send off the
  // screen; `minHeight` keeps a one-line field from collapsing under a large
  // OS font scale.
  captionRow:   {marginTop: 12},
  captionInput: {
    minHeight: 44, maxHeight: 100,
    // `paddingVertical`, deliberately: the B-284 pin (mediaPreviewTrayInset)
    // forbids a literal `paddingBottom` anywhere in this file, because that is
    // the exact shape that put Cancel/Send under the navigation bar.
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    color: T.text, fontSize: 14, lineHeight: 19,
    backgroundColor: T.glassFill, borderWidth: 1, borderColor: T.hair2,
    textAlignVertical: 'top',
  },
  actionsRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16},
  cancelBtn: {flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 14, backgroundColor: T.glassFill, borderWidth: 1, borderColor: T.hair2},
  cancelText: {color: T.textDim, fontSize: 13, fontWeight: '700'},
  sendBtn: {flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 14, overflow: 'hidden'},
  sendBtnFill: {borderRadius: 14},
  sendText: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.3},
});
