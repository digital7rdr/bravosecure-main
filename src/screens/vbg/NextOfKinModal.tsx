import React, {useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TextInput, TouchableOpacity,
  ActivityIndicator, ScrollView, Keyboard,
} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import * as Contacts from 'expo-contacts';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {vbgApi, type VbgFavorite} from '@/services/api';
import {VBG} from './vbgUi';

interface Draft {name: string; phone: string}

/**
 * Next-of-Kin sheet — a single bottom sheet that LISTS the saved emergency
 * contacts (up to 3) and lets you CALL, EDIT, ADD, or REMOVE them in place:
 *
 *   • Tap a contact row → dials it (fast path for an emergency).
 *   • Tap the pencil → that row expands inline into name + phone fields.
 *   • + Add → appends a new (empty) editing row, up to 3.
 *   • While editing, a trash icon removes the contact.
 *
 * Persisted server-side via the PUT-replace API (vbgApi.setFavorites →
 * /vbg/favorites), so contacts survive an app reinstall once logged back in.
 * `onDial` is owned by the parent so the tel: logic lives in one place;
 * `onSaved` returns the persisted list so the caller stays in sync.
 */
export function NextOfKinModal({
  visible,
  initial,
  onClose,
  onSaved,
  onDial,
}: {
  visible: boolean;
  initial: VbgFavorite[];
  onClose: () => void;
  onSaved: (favorites: VbgFavorite[]) => void;
  onDial: (phone: string, label?: string) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // Which row index is open for editing (-1 = none, just the call list).
  const [editing, setEditing] = useState<number>(-1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // B-184 — this sheet was the in-repo reference for "lift by the keyboard
  // height", but it read the RAW RN number, which under-lifts by the nav bar
  // on Android API>=30. The shared rule owns that arithmetic now.
  const {bottomPad} = useKeyboardLayout();

  // Seed from existing favorites each time the sheet opens. With no contacts
  // yet, open straight into a single empty editing row (first-time setup).
  useEffect(() => {
    if (!visible) {return;}
    const seed = initial.map(f => ({name: f.name, phone: f.phone}));
    setDrafts(seed);
    setEditing(seed.length === 0 ? 0 : -1);
    setError(null);
    if (seed.length === 0) {
      setDrafts([{name: '', phone: ''}]);
    }
  }, [visible, initial]);

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts(d => d.map((row, idx) => (idx === i ? {...row, ...patch} : row)));

  const addRow = () => {
    setDrafts(d => {
      if (d.length >= 3) {return d;}
      const next = [...d, {name: '', phone: ''}];
      setEditing(next.length - 1);   // open the new row for editing
      return next;
    });
    setError(null);
  };

  // Founder 2026-08-01 — fill the editing row from the device contacts list
  // instead of manual typing. Uses the OS contact picker (same expo-contacts
  // stack as the messenger sync); falls back gracefully where unavailable.
  const pickFromContacts = async (i: number) => {
    try {
      if (typeof Contacts.presentContactPickerAsync !== 'function') {
        setError('Contact picker unavailable on this device — type the number manually.');
        return;
      }
      if (typeof Contacts.requestPermissionsAsync === 'function') {
        const perm = await Contacts.requestPermissionsAsync();
        if (perm.status !== Contacts.PermissionStatus.GRANTED) {
          setError('Contacts permission denied — type the number manually.');
          return;
        }
      }
      const contact = await Contacts.presentContactPickerAsync();
      if (!contact) {return;}   // user cancelled the picker
      const name = (contact.name
        ?? [contact.firstName, contact.lastName].filter(Boolean).join(' ')).trim();
      const phone = contact.phoneNumbers?.[0]?.number?.trim() ?? '';
      update(i, {...(name ? {name} : {}), ...(phone ? {phone} : {})});
      setError(phone ? null : 'That contact has no phone number — enter it manually.');
    } catch {
      /* picker dismissed / OS refused — manual entry still works */
    }
  };

  /** Persist the full list (the API is a PUT-replace). */
  const persist = async (rows: Draft[]): Promise<boolean> => {
    const trimmed = rows.map(d => ({name: d.name.trim(), phone: d.phone.trim()}));
    // Validate against the server's bounds BEFORE the round-trip so one bad
    // entry doesn't 400 the whole save. Phone: 6..15 digits and <=32 chars
    // (matches FavoriteDto + server normalizePhone). Name: 1..60 chars.
    const entered = trimmed.filter(d => d.name.length > 0 || d.phone.length > 0);
    for (const d of entered) {
      if (d.name.length === 0) { setError('Give each contact a name.'); return false; }
      const digits = d.phone.replace(/\D/g, '').length;
      if (d.phone.length > 32 || digits < 6 || digits > 15) {
        setError(`"${d.name}" needs a valid phone number (6–15 digits).`);
        return false;
      }
    }
    const clean = entered.slice(0, 3);
    setSaving(true);
    setError(null);
    try {
      const res = await vbgApi.setFavorites(clean);
      onSaved(res.data.favorites);
      setDrafts(res.data.favorites.map(f => ({name: f.name, phone: f.phone})));
      return true;
    } catch (e) {
      const status = (e as {response?: {status?: number}})?.response?.status;
      setError(status === 400
        ? 'One of the contacts was rejected. Check the phone numbers.'
        : 'Could not save. Check your connection and try again.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Save the row currently being edited, then collapse back to the list. */
  const saveRow = async (i: number) => {
    const row = drafts[i];
    if (!row || (row.name.trim().length === 0 && row.phone.trim().length === 0)) {
      // An empty row being saved = discard it.
      const pruned = drafts.filter((_, idx) => idx !== i);
      Keyboard.dismiss();
      setEditing(-1);
      if (pruned.length !== drafts.length) { await persist(pruned); }
      return;
    }
    const ok = await persist(drafts);
    if (ok) { Keyboard.dismiss(); setEditing(-1); }
  };

  const removeRow = async (i: number) => {
    const pruned = drafts.filter((_, idx) => idx !== i);
    setEditing(-1);
    Keyboard.dismiss();
    await persist(pruned.length ? pruned : []);
    if (pruned.length === 0) { setDrafts([]); }
  };

  const hasSaved = drafts.some(d => d.name.trim() && d.phone.trim());

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      {/* The keyboard REPLACES the safe-area inset — while it is up it is
          already covering the home indicator / nav bar. */}
      <View style={[styles.sheet, {paddingBottom: bottomPad(18)}]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <View style={{flex: 1}}>
            <Text style={styles.title}>Next of Kin</Text>
            <Text style={styles.sub}>Tap a contact to call. They’re saved to your account.</Text>
          </View>
          {drafts.length < 3 ? (
            <TouchableOpacity style={styles.addBtn} activeOpacity={0.8} onPress={addRow} disabled={saving}>
              <Svg width={13} height={13} viewBox="0 0 24 24"><Path d="M12 5v14M5 12h14" stroke={VBG.accentSoft} strokeWidth={2} strokeLinecap="round" /></Svg>
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <ScrollView style={{maxHeight: 380}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {drafts.map((d, i) => {
            const isEditing = editing === i;
            const phoneValid = d.phone.replace(/\D/g, '').length >= 6;
            if (isEditing) {
              return (
                <View key={i} style={[styles.row, styles.rowEditing]}>
                  <TextInput
                    value={d.name}
                    onChangeText={t => update(i, {name: t})}
                    placeholder="Name (e.g. Spouse, Brother)"
                    placeholderTextColor={VBG.textMute}
                    maxLength={60}
                    autoFocus
                    style={styles.input}
                  />
                  <TextInput
                    value={d.phone}
                    onChangeText={t => update(i, {phone: t})}
                    placeholder="Phone number"
                    placeholderTextColor={VBG.textMute}
                    keyboardType="phone-pad"
                    maxLength={32}
                    style={[styles.input, {marginTop: 8}]}
                  />
                  <TouchableOpacity
                    style={styles.pickBtn}
                    activeOpacity={0.8}
                    onPress={() => { Keyboard.dismiss(); void pickFromContacts(i); }}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="Choose from contacts">
                    <Svg width={14} height={14} viewBox="0 0 24 24">
                      <Path d="M16 11a4 4 0 1 0-4-4M3 20a6 6 0 0 1 12 0" stroke={VBG.accentSoft} strokeWidth={1.7} fill="none" strokeLinecap="round" />
                      <Path d="M17 14l2 2 4-4" stroke={VBG.accentSoft} strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                    <Text style={styles.pickText}>Choose from Contacts</Text>
                  </TouchableOpacity>
                  <View style={styles.editActions}>
                    <TouchableOpacity style={styles.trashBtn} activeOpacity={0.8} onPress={() => { void removeRow(i); }} disabled={saving}>
                      <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke="#FF8B8B" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
                      <Text style={styles.trashText}>Remove</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.saveRowBtn} activeOpacity={0.85} onPress={() => { void saveRow(i); }} disabled={saving}>
                      {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveRowText}>SAVE</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }
            // Display (call) row — whole row dials; pencil opens the editor.
            return (
              <TouchableOpacity
                key={i}
                activeOpacity={0.85}
                style={styles.row}
                onPress={() => { if (phoneValid) { onDial(d.phone, d.name || 'Next of kin'); onClose(); } }}
                disabled={!phoneValid}
              >
                <View style={styles.avatar}><Text style={styles.avatarText}>{(d.name.trim()[0] ?? '?').toUpperCase()}</Text></View>
                <View style={{flex: 1}}>
                  <Text style={styles.name} numberOfLines={1}>{d.name.trim() || 'Unnamed contact'}</Text>
                  <Text style={styles.phone} numberOfLines={1}>{d.phone.trim() || 'No number'}</Text>
                </View>
                <TouchableOpacity
                  style={styles.pencilBtn}
                  activeOpacity={0.7}
                  onPress={() => { setError(null); setEditing(i); }}
                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                >
                  <Svg width={16} height={16} viewBox="0 0 24 24"><Path d="M4 20h4L18 10l-4-4L4 16v4ZM14 6l4 4" stroke={VBG.textMute} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
                </TouchableOpacity>
                <View style={styles.callBtn}>
                  <Svg width={17} height={17} viewBox="0 0 24 24"><Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke="#fff" strokeWidth={1.7} fill="none" strokeLinejoin="round" /></Svg>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!hasSaved && editing === -1 ? (
          <TouchableOpacity style={styles.addRow} activeOpacity={0.8} onPress={addRow}>
            <Svg width={15} height={15} viewBox="0 0 24 24"><Path d="M12 5v14M5 12h14" stroke={VBG.accentSoft} strokeWidth={1.9} strokeLinecap="round" /></Svg>
            <Text style={styles.addText}>Add an emergency contact</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  backdrop: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#0B0E14', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderWidth: 1, borderColor: VBG.hair2, paddingHorizontal: 20, paddingTop: 12,
  },
  grabber: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 16},
  head: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14},
  title: {fontSize: 18, fontWeight: '700', color: VBG.text, letterSpacing: -0.3},
  sub: {fontSize: 11.5, lineHeight: 16, color: VBG.textDim, marginTop: 4},
  addBtn: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 34, borderRadius: 10, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: VBG.accentGlow},
  addBtnText: {fontSize: 12, fontWeight: '700', color: VBG.accentSoft, letterSpacing: 0.3},

  row: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair},
  rowEditing: {flexDirection: 'column', alignItems: 'stretch', gap: 0, borderColor: VBG.accentGlow},
  avatar: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: VBG.accentGlow, alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: VBG.accentSoft, fontSize: 16, fontWeight: '700'},
  name: {fontSize: 14, fontWeight: '600', color: VBG.text, letterSpacing: -0.2},
  phone: {fontSize: 11.5, color: VBG.textMute, marginTop: 2},
  pencilBtn: {width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: VBG.hair},
  callBtn: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: VBG.signal ?? '#2BB673'},

  input: {
    height: 44, borderRadius: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair2,
    color: VBG.text, fontSize: 13,
  },
  pickBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 8, height: 42, borderRadius: 10,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  pickText: {fontSize: 12.5, fontWeight: '700', color: VBG.accentSoft},
  editActions: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 10},
  trashBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 40, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,139,139,0.3)'},
  trashText: {fontSize: 12, fontWeight: '600', color: '#FF8B8B'},
  saveRowBtn: {flex: 1, height: 40, borderRadius: 10, backgroundColor: VBG.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  saveRowText: {fontSize: 11.5, fontWeight: '700', letterSpacing: 1.2, color: '#fff'},

  addRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: VBG.hair2, borderStyle: 'dashed', marginTop: 2},
  addText: {fontSize: 12.5, fontWeight: '600', color: VBG.accentSoft},
  error: {fontSize: 11.5, color: '#FF8B8B', textAlign: 'center', marginTop: 4, marginBottom: 8, lineHeight: 16},
}));
