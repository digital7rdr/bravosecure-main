/**
 * UI corrections 2026-08-15 item 10 — "This add member option should allow you
 * to select contacts on the Bravo App, along side email and manual number
 * insert."
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND PICKER.
 *
 * `InviteMemberScreen` already shipped exactly this sheet — same hook, same
 * filter, same permission states — and item 10 needs it on `EmployeesScreen`
 * too. Writing it twice is this repo's most-shipped defect shape (one behaviour,
 * N drifted copies), and the drift here would be silent: a permission state or
 * an E.164 normalisation fixed on one screen and not the other looks identical
 * until someone denies contacts access.
 *
 * So the sheet moved here verbatim and both screens render it. The two callers
 * differ ONLY in what they do with the picked row, which is the `onPick` prop.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - It does not enumerate non-Bravo contacts. `useDiscoveredContacts` returns
 *     matches against the Bravo directory, so every row is someone who can
 *     actually receive what the caller is about to send. Somebody not on Bravo
 *     is reached through the manual field the caller keeps alongside this.
 *   - It does not ask for contacts permission on mount. `enabled` is the
 *     caller's `visible`, so the OS prompt fires on the first OPEN — asking for
 *     the address book of someone who only wanted to type an email is the kind
 *     of thing that gets an app uninstalled.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, FlatList, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {UsersHttpClient} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import {useDiscoveredContacts, type DiscoveredRow} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {filterContacts} from '@/modules/messenger/contacts/contactSearch';
import {OB, GhostButton} from './_obsidian';

export interface BravoContactPickerProps {
  visible: boolean;
  onClose: () => void;
  /** The caller decides what a pick MEANS — fill a field, or submit outright. */
  onPick: (row: DiscoveredRow) => void;
  /** Excluded from the matches so nobody picks themselves. */
  ownPhoneE164?: string | null;
  /** Sheet heading. Defaults to the invite wording. */
  title?: string;
  /**
   * Shown when the address book has NO Bravo users in it. The two callers give
   * different advice (invite anyway vs. they must sign up first), and getting
   * that wrong sends the admin down a road that cannot work.
   */
  emptyHint?: string;
}

export function BravoContactPicker({
  visible, onClose, onPick, ownPhoneE164, title = 'Pick a contact', emptyHint,
}: BravoContactPickerProps) {
  // The bottom-most element of the surface owns the keyboard inset — the
  // app-wide rule (CLAUDE.md § Keyboard). bottomPad REPLACES the safe-area
  // inset while the IME is up; it never stacks on it.
  const {bottomPad} = useKeyboardLayout();
  const [query, setQuery] = useState('');

  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl: API_BASE_URL,
      getToken: () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  // `enabled: visible` waits for intent — see the docblock.
  const {permission, loading, matches, refresh} = useDiscoveredContacts({
    users: usersClient,
    ownPhoneE164: ownPhoneE164 ?? undefined,
    enabled: visible,
  });
  const shown = useMemo(() => filterContacts(matches, query), [matches, query]);

  const close = useCallback(() => { setQuery(''); onClose(); }, [onClose]);
  const pick = useCallback((m: DiscoveredRow) => { setQuery(''); onPick(m); }, [onPick]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={s.backdrop}>
        <View style={[s.card, {paddingBottom: bottomPad(16)}]}>
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <TouchableOpacity hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
              accessibilityRole="button" accessibilityLabel="Close contact picker"
              onPress={close}>
              <Icon name="close" size={20} color={OB.textMute} />
            </TouchableOpacity>
          </View>
          <View style={s.search}>
            <Icon name="magnify" size={16} color={OB.textMute} />
            <TextInput style={s.searchInput} placeholder="Search name or number"
              placeholderTextColor={OB.textMute} value={query}
              onChangeText={setQuery} autoCorrect={false} />
          </View>
          {/* Every state is NAMED. A picker that shows an empty list for
              "permission denied", "no Bravo contacts" and "your search matched
              nothing" alike leaves the admin with no idea which one they are
              looking at — and only one of the three is fixable by them. */}
          {permission === 'denied' ? (
            <Text style={s.hint}>
              Contacts permission is off — type the details manually, or allow
              contacts in system settings and try again.
            </Text>
          ) : permission === 'unavailable' ? (
            <Text style={s.hint}>
              Contact access isn&apos;t available on this device — type the details manually.
            </Text>
          ) : loading ? (
            <View style={s.loading}><ActivityIndicator size="small" color={OB.accentSoft} /></View>
          ) : shown.length === 0 ? (
            <Text style={s.hint}>
              {matches.length === 0
                ? (emptyHint ?? 'None of your contacts use Bravo Secure yet.')
                : 'No contact matches that search.'}
            </Text>
          ) : (
            <FlatList
              data={shown}
              keyExtractor={m => m.userId}
              style={{maxHeight: 380}}
              keyboardShouldPersistTaps="handled"
              renderItem={({item: m}) => (
                <TouchableOpacity style={s.row} activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${m.localName ? m.localName : m.displayName}`}
                  onPress={() => pick(m)}>
                  <View style={s.avatar}>
                    <Icon name="account" size={18} color={OB.accentSoft} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.name} numberOfLines={1}>{m.localName ? m.localName : m.displayName}</Text>
                    <Text style={s.phone} numberOfLines={1}>{m.phoneE164}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
          {permission === 'denied' && (
            <GhostButton label="Try again" icon="refresh" onPress={() => { void refresh(); }} />
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  card: {
    backgroundColor: '#0E1218', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 18, borderTopWidth: 1, borderColor: OB.hair2,
  },
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  title: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16},
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 12,
    borderRadius: 12, borderWidth: 1, borderColor: OB.hair2,
    backgroundColor: 'rgba(255,255,255,0.03)', marginBottom: 12,
  },
  searchInput: {flex: 1, minWidth: 0, color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, padding: 0},
  hint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, lineHeight: 17, paddingVertical: 12},
  loading: {paddingVertical: 24, alignItems: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8},
  avatar: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  name: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
  phone: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},
}));
