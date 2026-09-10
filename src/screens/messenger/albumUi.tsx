/**
 * Album UI shared by the Files tab and the Vault (founder 2026-08-08).
 *
 * Presentational only — no store, no persistence, no knowledge of WHICH album
 * space it is showing. Files albums and Vault albums are separate spaces
 * (see `modules/messenger/fileAlbums/fileAlbums.ts`), and the only thing that
 * keeps them separate is that each screen passes its own state in. A component
 * that reached for a store itself would be one import away from merging them.
 */
import React, {useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, Pressable, TextInput,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {OB} from '@screens/deptchat/_obsidian';
import {scaleTextStyles} from '@utils/scaling';
import {MAX_ALBUM_NAME, type Album, type AlbumError} from '@/modules/messenger/fileAlbums/fileAlbums';

/** `null` = Unfiled; `undefined` = All (no album filter). */
export type AlbumFilter = string | null | undefined;

const errorText = (e: AlbumError): string => ({
  empty:     'Give the album a name.',
  too_long:  `Keep it under ${MAX_ALBUM_NAME} characters.`,
  duplicate: 'You already have an album with that name.',
  not_found: 'That album no longer exists.',
}[e]);

/* ------------------------------------------------------------------ *
 * AlbumBar — the horizontal filter strip above the list.
 * ------------------------------------------------------------------ */

interface BarProps {
  albums:   readonly Album[];
  counts:   Map<string | null, number>;
  /** Total across every album AND unfiled — the "All" count. */
  total:    number;
  active:   AlbumFilter;
  onSelect: (f: AlbumFilter) => void;
  onCreate: () => void;
  /** Long-press an album chip to rename/delete it. */
  onManage: (album: Album) => void;
}

export function AlbumBar({albums, counts, total, active, onSelect, onCreate, onManage}: BarProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.barContent}
      style={s.bar}>
      <Chip label="All" count={total} on={active === undefined} onPress={() => onSelect(undefined)} />
      {albums.map(a => (
        <Chip
          key={a.id}
          label={a.name}
          count={counts.get(a.id) ?? 0}
          icon="folder-outline"
          on={active === a.id}
          onPress={() => onSelect(a.id)}
          onLongPress={() => onManage(a)}
        />
      ))}
      {/* Unfiled sits AFTER the albums: with none created it is the whole
          library and showing it would be noise, so it only appears once
          something has been filed away from it. */}
      {albums.length > 0 && (
        <Chip
          label="Unfiled"
          count={counts.get(null) ?? 0}
          on={active === null}
          onPress={() => onSelect(null)}
        />
      )}
      <TouchableOpacity
        style={[s.chip, s.chipNew]}
        onPress={onCreate}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="New album">
        <Icon name="folder-plus-outline" size={14} color={OB.accentSoft} />
        <Text style={s.chipNewText}>New</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Chip({label, count, on, onPress, onLongPress, icon}: {
  label: string; count: number; on: boolean;
  onPress: () => void; onLongPress?: () => void;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  return (
    <TouchableOpacity
      style={[s.chip, on && s.chipOn]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{selected: on}}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'item' : 'items'}`}>
      {icon ? <Icon name={icon} size={13} color={on ? OB.accentSoft : OB.textMute} /> : null}
      <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>{label}</Text>
      <Text style={[s.chipCount, on && s.chipCountOn]}>{count}</Text>
    </TouchableOpacity>
  );
}

/* ------------------------------------------------------------------ *
 * NameAlbumModal — create or rename.
 * ------------------------------------------------------------------ */

interface NameProps {
  visible: boolean;
  /** Present = rename mode; the field starts on the current name. */
  initial?: string;
  title:   string;
  onClose: () => void;
  /** Return an error to keep the sheet open and show it inline. */
  onSubmit: (name: string) => AlbumError | null;
}

export function NameAlbumModal({visible, initial, title, onClose, onSubmit}: NameProps) {
  const [name, setName] = useState(initial ?? '');
  const [err, setErr] = useState<AlbumError | null>(null);
  /**
   * B-708 — the sheet autofocuses its field, so the IME is ALWAYS up while this
   * dialog is on screen, and a vertically centred box put Cancel/Save straight
   * behind the keyboard (founder screenshot, Files ▸ New album).
   *
   * `overlap` is the documented choice for a container that lifts a whole
   * column (CLAUDE.md § Keyboard / focused input). On a CENTRED backdrop a
   * `marginBottom` of the full overlap re-centres the box in the space the
   * keyboard leaves — the margin is part of the child's outer box, so
   * `justifyContent: 'center'` shifts it up by exactly half, which is the
   * definition of centred above the IME. Never a dp constant: the IME height
   * differs per device, per language and per keyboard app.
   */
  const {overlap} = useKeyboardLayout();

  // Reset per opening rather than per mount — the host keeps this mounted.
  React.useEffect(() => {
    if (visible) { setName(initial ?? ''); setErr(null); }
  }, [visible, initial]);

  const submit = () => {
    const e = onSubmit(name);
    setErr(e);
    if (!e) {onClose();}
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable
          style={[s.sheet, overlap > 0 && {marginBottom: overlap}]}
          onPress={e => e.stopPropagation()}>
          <Text style={s.sheetTitle}>{title}</Text>
          <TextInput
            style={[s.input, err && s.inputBad]}
            value={name}
            onChangeText={t => { setName(t); if (err) {setErr(null);} }}
            placeholder="Album name"
            placeholderTextColor={OB.textMute}
            maxLength={MAX_ALBUM_NAME}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Album name"
          />
          {err ? <Text style={s.err}>{errorText(err)}</Text> : null}
          <View style={s.sheetRow}>
            <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={onClose} activeOpacity={0.8}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={submit} activeOpacity={0.85}>
              <Text style={s.btnPrimaryText}>Save</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * MoveToAlbumSheet — the destination picker for a multi-selection.
 * ------------------------------------------------------------------ */

interface MoveProps {
  visible:  boolean;
  count:    number;
  albums:   readonly Album[];
  onClose:  () => void;
  onPick:   (albumId: string | null) => void;
  onCreate: () => void;
}

export function MoveToAlbumSheet({visible, count, albums, onClose, onPick, onCreate}: MoveProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={e => e.stopPropagation()}>
          <Text style={s.sheetTitle}>
            Move {count} {count === 1 ? 'item' : 'items'} to…
          </Text>

          <ScrollView style={s.moveList} keyboardShouldPersistTaps="handled">
            {albums.map(a => (
              <TouchableOpacity
                key={a.id}
                style={s.moveRow}
                onPress={() => onPick(a.id)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`Move to ${a.name}`}>
                <Icon name="folder-outline" size={18} color={OB.accentSoft} />
                <Text style={s.moveName} numberOfLines={1}>{a.name}</Text>
              </TouchableOpacity>
            ))}
            {/* Always offered, even with no albums — it is how the user gets
                out of an album, and with none created it is simply inert. */}
            <TouchableOpacity
              style={s.moveRow}
              onPress={() => onPick(null)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Remove from album">
              <Icon name="folder-off-outline" size={18} color={OB.textMute} />
              <Text style={[s.moveName, s.moveNameMuted]}>Remove from album</Text>
            </TouchableOpacity>
          </ScrollView>

          <TouchableOpacity style={s.newRow} onPress={onCreate} activeOpacity={0.8}
            accessibilityRole="button" accessibilityLabel="New album">
            <Icon name="folder-plus-outline" size={18} color={OB.accentSoft} />
            <Text style={s.newRowText}>New album…</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.btn, s.btnGhost, s.btnWide]} onPress={onClose} activeOpacity={0.8}>
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  bar:        {flexGrow: 0, flexShrink: 0},
  barContent: {paddingHorizontal: 16, paddingBottom: 10, gap: 8, alignItems: 'center'},

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    maxWidth: '60%',
  },
  chipOn:      {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.4)'},
  chipText:    {flexShrink: 1, color: OB.textDim, fontSize: 12.5, fontWeight: '600'},
  chipTextOn:  {color: OB.text},
  chipCount:   {color: OB.textDim, fontSize: 10.5, fontWeight: '700'},
  chipCountOn: {color: OB.accentSoft},
  chipNew:     {borderStyle: 'dashed', borderColor: 'rgba(91,141,239,0.45)'},
  chipNewText: {color: OB.accentSoft, fontSize: 12.5, fontWeight: '700'},

  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  sheet: {
    width: '100%', maxWidth: 380, borderRadius: 20, padding: 18,
    backgroundColor: '#0D1219', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  sheetTitle: {color: OB.text, fontSize: 15, fontWeight: '700', marginBottom: 14},
  sheetRow:   {flexDirection: 'row', gap: 10, marginTop: 16},

  input: {
    minHeight: 46, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, color: OB.text, fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  inputBad: {borderColor: 'rgba(255,93,93,0.55)'},
  err:      {color: '#FF8A8A', fontSize: 11.5, marginTop: 8},

  moveList: {maxHeight: 260},
  moveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  moveName:      {flex: 1, minWidth: 0, color: OB.text, fontSize: 13.5, fontWeight: '600'},
  moveNameMuted: {color: OB.textMute},

  newRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 4, marginTop: 2,
  },
  newRowText: {color: OB.accentSoft, fontSize: 13.5, fontWeight: '700'},

  btn:      {flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  btnWide:  {flex: 0, marginTop: 6},
  btnGhost: {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)'},
  btnGhostText:   {color: OB.textDim, fontSize: 13.5, fontWeight: '700'},
  btnPrimary:     {backgroundColor: '#2F5BE0'},
  btnPrimaryText: {color: '#FFFFFF', fontSize: 13.5, fontWeight: '700'},
}));
