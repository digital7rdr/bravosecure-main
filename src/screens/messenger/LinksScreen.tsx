/**
 * B-90 T-04 — WhatsApp-parity Links browser.
 *
 * Lists every http(s) link shared in any chat, newest first, from the
 * LOCAL SQLCipher message store (the relay only ever sees sealed
 * envelopes, so a server-side links index cannot exist).
 *
 * ⚠️ B-638 (2026-08-23) — THIS SCREEN CURRENTLY HAS NO ENTRY POINT. Its only
 * door was the Calls header's "Links ›" button, which the client asked to
 * remove ("just remove the button"). The ROUTE is still registered in both
 * navigators and the screen is untouched, so restoring a door — here, in Files,
 * in Chat Info, wherever it belongs — is a one-line change. It is recorded
 * rather than deleted deliberately: the feature works, it just is not reachable.
 *
 * Tap a row to open the link; tap the chat chip to jump to the message's
 * conversation. Rows page in via runtime.loadLinkMessages as you scroll.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  Linking,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useMessengerStore} from '@/modules/messenger/store';
import {getMessengerRuntime} from '@/modules/messenger/runtime/runtime';
import type {LocalMessage} from '@/modules/messenger/store/types';
import {allUrlsIn} from '@/modules/messenger/ui/linkPreview';
import {openConversation} from './openConversation';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

const PAGE_SIZE = 60;

interface LinkRow {
  /** `${messageId}:${index}` — one row per URL, a message can hold several. */
  id: string;
  url: string;
  host: string;
  conversationId: string;
  chatName: string;
  isGroup: boolean;
  timeLabel: string;
}

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

function fmtWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {return '';}
  const diff = Date.now() - ms;
  if (diff < 3_600_000)      {return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;}
  if (diff < 86_400_000)     {return `${Math.floor(diff / 3_600_000)}h ago`;}
  if (diff < 7 * 86_400_000) {return `${Math.floor(diff / 86_400_000)}d ago`;}
  return new Date(ms).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

export default function LinksScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const insets = useSafeAreaInsets();
  const conversations = useMessengerStore(s => s.conversations);

  const [rows, setRows] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const exhausted = useRef(false);
  const fetching  = useRef(false);
  // Offset counts raw MESSAGES paged from SQL, not rendered URL rows.
  const msgOffset = useRef(0);

  const toRows = useCallback((msgs: LocalMessage[]): LinkRow[] => {
    const out: LinkRow[] = [];
    for (const m of msgs) {
      const conv = conversations[m.conversation_id];
      const urls = allUrlsIn(m.content);
      urls.forEach((url, i) => {
        out.push({
          id:             `${m.id}:${i}`,
          url,
          host:           hostOf(url),
          conversationId: m.conversation_id,
          chatName:       conv?.name ?? 'Chat',
          isGroup:        conv?.type === 'group',
          timeLabel:      fmtWhen(m.created_at),
        });
      });
    }
    return out;
  }, [conversations]);

  const loadPage = useCallback(async () => {
    if (fetching.current || exhausted.current) {return;}
    fetching.current = true;
    try {
      const runtime = await getMessengerRuntime();
      const msgs = await runtime.loadLinkMessages?.(PAGE_SIZE, msgOffset.current) ?? [];
      msgOffset.current += msgs.length;
      if (msgs.length < PAGE_SIZE) {exhausted.current = true;}
      const fresh = toRows(msgs);
      if (fresh.length) {
        setRows(prev => {
          const seen = new Set(prev.map(r => r.id));
          return [...prev, ...fresh.filter(r => !seen.has(r.id))];
        });
      }
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, [toRows]);

  useEffect(() => { void loadPage(); }, [loadPage]);

  // A9/M9 — a link shared INSIDE a department channel used to open that channel
  // in ChatScreen, call buttons and all. This list has no dept filter at all
  // (its rows come from `loadLinkMessages`, which scans every message on the
  // device), so it was the widest remaining door into the banned surface.
  const openChat = (r: LinkRow) => {
    openConversation(navigation, {
      conversationId: r.conversationId,
      name:           r.chatName,
      isGroup:        r.isGroup,
    });
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
          style={{paddingRight: 12}}>
          <Icon name="arrow-left" size={20} color="#F2F4F8" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {flex: 1}]}>Links</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={r => r.id}
        contentContainerStyle={{paddingBottom: insets.bottom + 24, flexGrow: 1}}
        showsVerticalScrollIndicator={false}
        onEndReachedThreshold={0.4}
        onEndReached={() => { void loadPage(); }}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.emptyWrap}>
              <Icon name="link-variant" size={44} color="#2A3242" />
              <Text style={styles.emptyTitle}>No links yet</Text>
              <Text style={styles.emptyHint}>
                Links shared in your chats will appear here, newest first.
              </Text>
            </View>
          )
        }
        renderItem={({item}) => (
          <TouchableOpacity
            style={styles.linkRow}
            activeOpacity={0.8}
            accessibilityRole="link"
            accessibilityLabel={`Open ${item.url}`}
            onPress={() => { void Linking.openURL(item.url).catch(() => {}); }}>
            <View style={styles.linkIcon}>
              <Icon name="link-variant" size={18} color="#5B8DEF" />
            </View>
            <View style={styles.linkInfo}>
              <Text style={styles.linkUrl} numberOfLines={1}>{item.url}</Text>
              <View style={styles.linkMetaRow}>
                <Text style={styles.linkHost} numberOfLines={1}>{item.host}</Text>
                <Text style={styles.linkDot}>·</Text>
                <Text style={styles.linkTime}>{item.timeLabel}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.chatChip}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Open chat ${item.chatName}`}
              hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
              onPress={() => openChat(item)}>
              <Icon name={item.isGroup ? 'account-group' : 'chat-outline'} size={12} color="rgba(180,188,204,0.45)" />
              <Text style={styles.chatChipText} numberOfLines={1}>{item.chatName}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.09)'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#F2F4F8'},

  linkRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  linkIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', flexShrink: 0},
  linkInfo: {flex: 1, minWidth: 0},
  linkUrl: {fontSize: 13, fontWeight: '600', color: '#F2F4F8'},
  linkMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3},
  linkHost: {fontSize: 11, color: 'rgba(180,188,204,0.45)', flexShrink: 1},
  linkDot: {fontSize: 11, color: 'rgba(180,188,204,0.45)'},
  linkTime: {fontSize: 11, color: 'rgba(180,188,204,0.45)'},
  chatChip: {flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '40%', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', flexShrink: 0},
  chatChipText: {fontSize: 10, fontWeight: '700', color: 'rgba(229,233,242,0.62)', flexShrink: 1},

  emptyWrap: {alignItems: 'center', paddingVertical: 80, paddingHorizontal: 32, gap: 8},
  emptyTitle: {color: 'rgba(229,233,242,0.62)', fontSize: 14, fontWeight: '700', marginTop: 8},
  emptyHint: {color: 'rgba(180,188,204,0.45)', fontSize: 11, textAlign: 'center', lineHeight: 16, maxWidth: 300},
}));
