import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
  Platform,
  Vibration,
  Image,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {Colors} from '@theme/index';
import type {MessengerScreenProps} from '@navigation/types';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {useMessenger} from '@/modules/messenger/hooks';
import {addBlockedPeer, removeBlockedPeer} from '@/modules/messenger/runtime/blockedPeers';
import {writeServerRosterOrQueue} from '@/modules/messenger/runtime/pendingRosterIntents';
import {GROUP_NAME_MAX, normalizeGroupName} from '@/modules/messenger/runtime/groupNameRules';
import {GroupAvatar, useGroupAvatarUri} from '@/modules/messenger/ui/GroupAvatar';
import {AvatarViewer, type AvatarViewTarget} from '@/modules/messenger/ui/AvatarViewer';
import {launchImageLibrary} from 'react-native-image-picker';
import {avatarColorFor} from './avatarColors';
import {useAuthStore} from '@store/authStore';
import {DEV_CONTACTS} from '@/modules/messenger/dev/devContacts';
import {resolvePeerPhone} from '@/modules/messenger/contacts/peerPhone';
import {isPlaceholderName} from '@/modules/messenger/contacts/notifTitle';
import {launchCall} from '@/modules/messenger/webrtc/launchCall';
import {getSavedState, presentSaveContact, type SavedState} from '@/modules/messenger/contacts/savedContacts';
import {UsersHttpClient} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import * as Clipboard from 'expo-clipboard';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {displayRoomName} from '@utils/missionRoomName';

type Props = MessengerScreenProps<'ChatInfo'>;

const TTL_CHOICES: {label: string; sec: number | null}[] = [
  {label: 'Off',         sec: null},
  {label: '1 hour',      sec: 3600},
  {label: '24 hours',    sec: 24 * 3600},
  {label: '7 days',      sec: 7 * 24 * 3600},
];

function prettyTtl(sec: number | null): string {
  if (sec === null) {return 'Off';}
  if (sec < 3600) {return `${Math.round(sec / 60)} min`;}
  if (sec < 86400) {return `${Math.round(sec / 3600)} h`;}
  return `${Math.round(sec / 86400)} d`;
}

// Why: audit S12 — the previous FNV-1a hash of conversationId produced
// the same fingerprint for both peers regardless of their identity
// keys, so a MITM would still "verify". The real safety number is
// computed by the runtime over both identity public keys.

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

// B-286 — the SIXTH copy of this function. Same hash, same key, its own
// seven-colour palette, so opening a group's info sheet changed the avatar
// colour again after the list and the chat header had finally been made to
// agree. Now the one shared resolver.
function avatarColor(seed: string): string {
  return avatarColorFor(seed);
}

function resolveUserName(
  userId: string,
  selfId: string | undefined,
  selfName: string | undefined,
  conversations: Record<string, {peer?: {userId: string}; type: string; name?: string}>,
): string {
  if (userId === selfId || userId === 'self') {return selfName ? `${selfName} (You)` : 'You';}
  // Best source: an existing direct conversation with this user — that
  // row's name is whatever the contact-discovery flow already resolved
  // (typically the user's display_name from the auth-service profile).
  // Without this, group members fall through to the 8-char uuid-prefix
  // and the group info screen looks like a list of opaque hashes.
  const direct = Object.values(conversations).find(
    c => c.type === 'direct' && c.peer?.userId === userId && c.name,
  );
  // B-411 — a still-placeholder row name must not render; fall through to
  // the directory/phone chain below.
  if (direct?.name && !isPlaceholderName(direct.name, userId)) {return direct.name;}
  // Dev/local contacts (used in early test rigs).
  const dev = DEV_CONTACTS.find(c => c.userId === userId);
  if (dev) {return dev.name;}
  // B-226 — session directory name (populated from /conversations/mine, B-224)
  // then a known peer phone, before the raw-id code.
  const dir = useMessengerStore.getState().directoryNames[userId];
  if (dir) {return dir;}
  const phone = resolveUserPhone(userId);
  if (phone) {return phone;}
  // B-411 — neutral label, never a raw-id fragment. DISPLAY-ONLY: it must
  // never be persisted as a conversation name (openMemberChat guards on it).
  return FALLBACK_MEMBER_LABEL;
}

const FALLBACK_MEMBER_LABEL = 'Bravo user';

/**
 * B-226 — the phone column honors a discovered contact's stored E.164 (the
 * "number under the name" this screen shows), not just DEV rows.
 *
 * B-338 — the lookup itself now lives in `contacts/peerPhone` so the mid-call
 * invite sheet answers the same question the same way. This is a thin binding
 * of the store to that shared resolver; do NOT re-inline the scan here.
 */
function resolveUserPhone(userId: string): string | undefined {
  return resolvePeerPhone(
    useMessengerStore.getState().conversations,
    userId,
    DEV_CONTACTS,
  );
}

export default function ChatInfoScreen({navigation, route}: Props) {
  const {conversationId} = route.params;
  const insets = useSafeAreaInsets();
  // B-84 / KB-10 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const conversation = useMessengerStore(s => s.conversations[conversationId]);
  const currentUser  = useAuthStore(s => s.user);
  const removeConversation = useMessengerStore(s => s.removeConversation);
  const clearMessages      = useMessengerStore(s => s.clearMessages);
  const setConversationMuted = useMessengerStore(s => s.setConversationMuted);
  const setConversationTtl   = useMessengerStore(s => s.setConversationTtl);
  const {runtime} = useMessenger();
  const [resetting, setResetting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  // NAV-17 (2026-08-26 audit) — in-flight ref for Save Contact: a mash opened
  // the system contact sheet once per queued tap. Declared here, above the
  // not-found early return (rules-of-hooks).
  const saveContactBusyRef = useRef(false);
  const groupNameMap = useMessengerStore(s => s.groupMemberNames[conversationId]);
  const setGroupMemberName = useMessengerStore(s => s.setGroupMemberName);

  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const upsertConversation = useMessengerStore(s => s.upsertConversation);

  const blockPeer = () => {
    if (!conversation?.peer || isGroup || blocking) {return;}
    const peerId = conversation.peer.userId;
    // Why: optimistic UX. The previous flow waited on the HTTP round-
    // trip before removing the conversation + popping, which felt
    // unresponsive on a flaky network. Block now feels instant — pop
    // first, reconcile on failure by re-inserting the snapshot.
    const snapshot = conversation;
    setBlocking(true);
    removeConversation(conversationId);
    // M-07 — record the block locally so the receive path drops (and doesn't
    // resurrect) inbound messages from this peer; sealed sender means the relay
    // can't gate delivery, so the recipient client is the only enforcement point.
    void addBlockedPeer(peerId);
    navigation.goBack();
    void (async () => {
      try {
        await usersClient.block(peerId);
      } catch (e) {
        // Block failed server-side — roll the local block back too.
        void removeBlockedPeer(peerId);
        // Restore the conversation so the user can see what happened
        // and retry. Surface the error via the global messenger error
        // banner since the screen has already been popped.
        upsertConversation(snapshot);
        useMessengerStore.getState().setError(
          `Block failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        );
      } finally {
        setBlocking(false);
      }
    })();
  };

  const isMuted = !!conversation?.is_muted;
  const ttlSec  = conversation?.default_ttl_sec ?? null;

  // B-291 — group photo.
  const [photoBusy, setPhotoBusy] = useState(false);
  // B-289 — group rename.
  const [groupNameOpen,  setGroupNameOpen]  = useState(false);
  const [groupNameValue, setGroupNameValue] = useState('');
  const [groupNameBusy,  setGroupNameBusy]  = useState(false);
  const [ttlPickerOpen, setTtlPickerOpen] = useState(false);
  const [fingerprintOpen, setFingerprintOpen] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [safetyCopied, setSafetyCopied] = useState(false);
  // Audit P0-I3 / P0-1 — verification state mirrors the persisted ack
  // in trusted_identities. `verifiedAtMs` is set once the user taps
  // "Mark as verified"; cleared by saveIdentity on any subsequent key
  // flip (the store auto-clears) OR by the explicit "Clear" button.
  const [verifiedAtMs, setVerifiedAtMs] = useState<number | null>(null);
  const [verifyBusy,   setVerifyBusy]   = useState(false);

  // Load the real safety number on demand when the user opens the
  // fingerprint modal. Lazy because the production path may need a
  // server round-trip (recipientIdentityKeyB64 prefers the latest
  // server-side bundle over a stale local cache).
  useEffect(() => {
    if (!fingerprintOpen || !runtime || !conversation?.peer || conversation.type !== 'direct') {return;}
    const peer = conversation.peer;
    let cancelled = false;
    setSafetyNumber(null);
    setSafetyError(null);
    setSafetyCopied(false);
    setVerifiedAtMs(null);
    void (async () => {
      try {
        const code = await runtime.getSafetyNumber(peer);
        if (!cancelled) {setSafetyNumber(code);}
        // Audit P0-I3 — pull the persisted verification ack so the CTA
        // can render the right state on open. Null = TOFU-trusted only.
        try {
          const v = await runtime.getPeerVerification(peer);
          if (!cancelled) {setVerifiedAtMs(v?.verifiedAtMs ?? null);}
        } catch { /* non-fatal — leave CTA in unverified state */ }
      } catch (e) {
        if (!cancelled) {setSafetyError(e instanceof Error ? e.message : 'Could not load fingerprint');}
      }
    })();
    return () => { cancelled = true; };
  }, [fingerprintOpen, runtime, conversation?.peer, conversation?.type]);

  // Audit P0-I3 — toggle the verification record. Disabled while the
  // safety number is still loading (we'd hash an empty string), while
  // the runtime call is in flight, and for group conversations.
  const onToggleVerified = async (): Promise<void> => {
    if (!runtime || !conversation?.peer || conversation.type !== 'direct') {return;}
    if (!safetyNumber || verifyBusy) {return;}
    setVerifyBusy(true);
    try {
      if (verifiedAtMs !== null) {
        await runtime.clearPeerVerification(conversation.peer);
        setVerifiedAtMs(null);
      } else {
        const ok = await runtime.markPeerVerified(conversation.peer, safetyNumber);
        if (ok) {setVerifiedAtMs(Date.now());}
      }
    } catch {
      // Surface as an inline error inside the modal — don't crash the
      // screen if the store reject the call (e.g. peer has no trust
      // row yet because we've never decrypted anything from them).
      setSafetyError('Could not update verification status');
    } finally {
      setVerifyBusy(false);
    }
  };

  const isGroup = conversation?.type === 'group';
  // GRP-20/25 — real admin flag from the E2EE group state (members map carries
  // {admin}). In this model the group creator is the sole admin.
  const groupState = useMessengerStore(s => s.groups[conversationId]);
  const isGroupAdmin = !!(currentUser?.id && groupState?.members?.[currentUser.id]?.admin);
  // B-222 — the Add-member / rename / member-name-edit affordances are
  // admin-only. Previously `isAdmin = isGroup` showed them to EVERY member, who
  // then hit a runtime NOT_ADMIN alert when they tried to add (a dead-end). A
  // non-admin "request to add" entry point is the arch-gated B-221 approval
  // feature (group master-key distribution — needs architecture sign-off).
  const isAdmin = isGroupAdmin;

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameUserId, setRenameUserId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameProfile, setRenameProfile] = useState('');
  const [removingMember, setRemovingMember] = useState(false);
  // Whether this peer's number is in the DEVICE address book. Starts 'unknown'
  // so nothing renders until we actually know — see savedContacts.ts.
  const [savedState, setSavedState] = useState<SavedState>('unknown');
  const peerPhoneForLookup = conversation?.type === 'group'
    ? undefined
    : conversation?.phoneE164 ?? (conversation?.peer?.userId ? resolveUserPhone(conversation.peer.userId) : undefined);
  useEffect(() => {
    let alive = true;
    if (!peerPhoneForLookup) {setSavedState('unknown'); return;}
    void getSavedState(peerPhoneForLookup).then(s => { if (alive) {setSavedState(s);} });
    return () => { alive = false; };
  }, [peerPhoneForLookup]);

  // Pull the full conversations map so resolveUserName can look up
  // peer names from existing direct chats — that's the only name
  // source we have today besides the per-group rename overrides.
  const allConversations = useMessengerStore(s => s.conversations);
  // Fix #37: build a stable signature of the only fields the members
  // useMemo actually consumes (peer userId + name + type per
  // conversation). Without this, ANY mutation to ANY conversation
  // (unread count bump on a 1:1, last_message tick on an unrelated
  // group, etc.) re-ran the members computation. The signature is a
  // joined string sorted by id so it's stable across reorderings of
  // the underlying object's keys.
  const conversationsNameSignature = useMemo(() => {
    const parts: string[] = [];
    const ids = Object.keys(allConversations).sort();
    for (const id of ids) {
      const c = allConversations[id];
      parts.push(`${id}:${c.type}:${c.name ?? ''}:${c.peer?.userId ?? ''}`);
    }
    return parts.join('|');
  }, [allConversations]);

  const members = useMemo(() => {
    if (!conversation) {return [];}
    return (conversation.participants ?? []).map(userId => {
      const profileName = resolveUserName(
        userId, currentUser?.id, currentUser?.full_name ?? undefined,
        allConversations as unknown as Record<string, {peer?: {userId: string}; type: string; name?: string}>,
      );
      const override    = groupNameMap?.[userId];
      return {
        userId,
        name:        override ?? profileName,
        profileName,
        overridden:  !!override,
        phone:       resolveUserPhone(userId),
        isSelf:      userId === currentUser?.id || userId === 'self',
        // B-268 — WHO the admin is was never shown. `isAdmin` above answers
        // only "am I one", which gates my own affordances; every other member
        // rendered identically, so a group had no visible owner and nobody
        // could tell who to ask for an add or a removal. Read from the same
        // E2EE group state that authorises admin actions — not from the server
        // conversation row — so the badge cannot claim someone is an admin
        // whose actions the crypto layer would then reject.
        isAdmin:     !!groupState?.members?.[userId]?.admin,
      };
    });
    // allConversations intentionally omitted — we depend on the
    // signature instead, which only flips on members-relevant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, currentUser, groupNameMap, conversationsNameSignature, groupState]);

  // BS-MEMBER-AVATARS — fetch member profile photos by userId. The server
  // returns avatarUrl only for non-blocked, known users; everyone else
  // falls back to coloured initials below. Best-effort: a failed fetch
  // simply leaves the initials in place.
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string | null>>({});
  const memberIdSignature = members.map(m => m.userId).sort().join(',');
  useEffect(() => {
    const ids = memberIdSignature ? memberIdSignature.split(',') : [];
    if (ids.length === 0) {return;}
    let cancelled = false;
    void usersClient.getProfilesByIds(ids)
      .then(profiles => {
        if (cancelled) {return;}
        const map: Record<string, string | null> = {};
        for (const p of profiles) {map[p.userId] = p.avatarUrl;}
        setMemberAvatars(prev => ({...prev, ...map}));
        // B-115 — this fetch used to DISCARD displayName. Keep it in the
        // session directory map so member labels everywhere stop falling
        // back to raw-id fragments. Manual overrides still win (readers
        // consult groupMemberNames first).
        try {
          const entries: Record<string, string> = {};
          // B-253 — and the avatars, for the same reason. This screen used to
          // be the ONLY place a profile photo was ever visible, because it
          // kept the result of this fetch to itself; feeding the session
          // directory means one visit here lights up the chat list, the call
          // screens and the calls log too.
          const avatars: Record<string, string | null> = {};
          for (const p of profiles) {
            if (p.displayName) {entries[p.userId] = p.displayName;}
            avatars[p.userId] = p.avatarUrl;
          }
          useMessengerStore.getState().setDirectoryNames(entries);
          useMessengerStore.getState().setDirectoryAvatars(avatars);
        } catch { /* best-effort */ }
      })
      .catch(() => { /* best-effort — initials remain */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIdSignature]);

  // Peer userId for a 1:1 conversation (used to show their avatar at the
  // top). Null for groups / when the peer isn't resolved.
  const peerId = (!isGroup && conversation?.peer?.userId) ? conversation.peer.userId : null;

  // Founder 2026-08-01 — tapping the profile photo opens it full screen so a
  // person (or text in the picture) can be identified.
  const [avatarView, setAvatarView] = useState<AvatarViewTarget | null>(null);
  const groupPhotoUri = useGroupAvatarUri(isGroup ? conversationId : null);

  const openRename = (userId: string, current: string, profile: string) => {
    setRenameUserId(userId);
    setRenameValue(current);
    setRenameProfile(profile);
    setRenameOpen(true);
  };

  // Founder 2026-08-01 (WhatsApp parity) — in a 10-member group most people
  // are strangers: tapping a member must offer "Message privately" (jump to
  // the 1:1 thread) and "Save contact" (system contact form, prefilled).
  // Admin keeps the rename flow as a third option instead of it hijacking
  // the whole tap. Self stays inert.
  const saveMemberContact = async (name: string, phone: string): Promise<void> => {
    try {
      const Contacts = require('expo-contacts') as typeof import('expo-contacts');
      await Contacts.presentFormAsync(null, {
        name,
        firstName: name,
        contactType: Contacts.ContactTypes.Person,
        phoneNumbers: [{label: 'mobile', number: phone}],
      } as never);
    } catch (e) {
      Alert.alert('Could not open contacts', (e as Error).message);
    }
  };

  const openMemberChat = (userId: string, name: string): void => {
    const canonical = resolveDirectConversationIdFromState(useMessengerStore.getState(), userId);
    // Founder bugs 2+3 (2026-08-01) — mirror NewChatScreen's contact-open:
    // without seeding the row, the private thread never appears in the chat
    // list and the presence header has no peer to resolve (showed offline
    // for an online member). Seed ONLY the synthetic key; never overwrite an
    // existing canonical row's metadata.
    if (canonical.startsWith('direct:')) {
      // B-411 — never persist the 'Bravo user' DISPLAY fallback: it is not
      // placeholder-shaped, so no sweep would ever heal it. Seed the
      // placeholder form instead (upgradeable by useRegisteredNames) and
      // keep the pretty label as a route param only.
      const isDisplayFallback = name === FALLBACK_MEMBER_LABEL;
      upsertConversation({
        id:             canonical,
        type:           'direct',
        name:           isDisplayFallback ? `Bravo · ${userId.slice(0, 8)}` : name,
        ...(isDisplayFallback ? {name_source: 'placeholder' as const} : null),
        participants:   [currentUser?.id ?? 'self', userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId, deviceId: 1},
        session_state:  'fresh',
      });
    }
    navigation.navigate('Chat', {conversationId: canonical, name, isGroup: false});
  };

  const onMemberTap = (m: {userId: string; name: string; profileName: string; phone?: string; isSelf: boolean}): void => {
    if (m.isSelf) {return;}
    const buttons: Array<{text: string; style?: 'cancel' | 'destructive'; onPress?: () => void}> = [
      {text: 'Message privately', onPress: () => openMemberChat(m.userId, m.name)},
    ];
    if (m.phone) {
      const phone = m.phone;
      buttons.push({text: 'Save contact', onPress: () => { void saveMemberContact(m.name, phone); }});
    }
    if (isAdmin) {
      buttons.push({text: 'Rename in group', onPress: () => openRename(m.userId, m.name, m.profileName)});
      // Founder bug 1 (2026-08-01) — Remove must be its OWN action, not
      // buried inside the rename modal. confirmRemoveMember shows its own
      // destructive confirm before touching anything.
      buttons.push({text: 'Remove from group', style: 'destructive', onPress: () => confirmRemoveMember(m.userId)});
    }
    buttons.push({text: 'Cancel', style: 'cancel'});
    Alert.alert(m.name, m.phone ?? undefined, buttons);
  };

  const saveRename = () => {
    if (!renameUserId) {return;}
    const trimmed = renameValue.trim();
    // Empty value clears the override and restores the profile name.
    setGroupMemberName(
      conversationId,
      renameUserId,
      trimmed && trimmed !== renameProfile ? trimmed : null,
    );
    setRenameOpen(false);
    setRenameUserId(null);
  };

  const resetToProfile = () => {
    if (!renameUserId) {return;}
    setGroupMemberName(conversationId, renameUserId, null);
    setRenameOpen(false);
    setRenameUserId(null);
  };

  /**
   * B-291 — set or remove the group photo.
   *
   * The runtime encrypts and uploads BEFORE broadcasting, so a failed upload
   * cannot leave members pointing at an object that does not exist. That means
   * this can take a moment on a slow link — hence `photoBusy`, which both
   * disables the tap and swaps the badge icon.
   */
  const canEditPhoto = isGroup && isAdmin && !!runtime?.setGroupPhoto;
  const hasPhoto = !!groupState?.photo;

  const applyPhoto = (imageUri: string | null, mimeType?: string) => {
    const setFn = runtime?.setGroupPhoto;
    if (!setFn || photoBusy) {return;}
    void (async () => {
      setPhotoBusy(true);
      try {
        await setFn({groupId: conversationId, imageUri, mimeType});
      } catch (e) {
        Alert.alert('Could not update photo', (e as Error).message);
      } finally {
        setPhotoBusy(false);
      }
    })();
  };

  const presentPhotoOptions = () => {
    if (!canEditPhoto) {return;}
    const options: Array<{text: string; style?: 'cancel' | 'destructive'; onPress?: () => void}> = [
      // Founder 2026-08-01 — admins keep the edit sheet, so viewing rides it.
      ...(groupPhotoUri
        ? [{text: 'View photo', onPress: () => setAvatarView({uri: groupPhotoUri, name: title})}]
        : []),
      {
        text: 'Choose from library',
        onPress: () => {
          void (async () => {
            const res = await launchImageLibrary({
              mediaType: 'photo',
              // Group avatars render at 84pt at most; a full-resolution phone
              // photo would be megabytes of ciphertext for every member to
              // download to draw a 42pt circle.
              maxWidth: 512,
              maxHeight: 512,
              quality: 0.8,
              selectionLimit: 1,
            });
            const asset = res.assets?.[0];
            if (!asset?.uri) {return;}
            applyPhoto(asset.uri, asset.type ?? 'image/jpeg');
          })();
        },
      },
    ];
    if (hasPhoto) {
      options.push({
        text: 'Remove photo',
        style: 'destructive',
        onPress: () => applyPhoto(null),
      });
    }
    options.push({text: 'Cancel', style: 'cancel'});
    Alert.alert('Group photo', 'Everyone in the group sees this photo.', options);
  };

  /**
   * B-289 — save a new group name.
   *
   * The rename is signed and broadcast to every member; fan-out is best-effort
   * (a name is not key material), so the local apply lands even offline and a
   * missed peer re-syncs. Validation is `normalizeGroupName`, the SAME helper
   * the runtime re-applies, so what the user is shown is what gets signed.
   */
  const saveGroupName = () => {
    const renameFn = runtime?.renameGroup;
    if (!renameFn || groupNameBusy) {return;}
    const clean = normalizeGroupName(groupNameValue);
    if (!clean) {
      Alert.alert('Name required', 'A group needs a name.');
      return;
    }
    if (clean === title) {setGroupNameOpen(false); return;}
    void (async () => {
      setGroupNameBusy(true);
      try {
        await renameFn({groupId: conversationId, name: clean});
        setGroupNameOpen(false);
      } catch (e) {
        Alert.alert('Could not rename', (e as Error).message);
      } finally {
        setGroupNameBusy(false);
      }
    })();
  };

  // GRP-20/25 — admin removes a member. removeGroupMember rekeys the group
  // (remove @ epoch E, fresh master key @ E+1) and fails fast BEFORE any
  // state change, so a failure here leaves the group intact.
  // Founder 2026-08-01 — callable with an explicit target so the member
  // sheet offers Remove INDEPENDENTLY; the rename-modal path still works
  // via the renameUserId fallback.
  const confirmRemoveMember = (targetUserId?: string) => {
    const removeFn = runtime?.removeGroupMember;
    const uid = targetUserId ?? renameUserId;
    if (!uid || removingMember || !removeFn) {return;}
    const target = members.find(m => m.userId === uid);
    if (!target || target.isSelf) {return;}
    Alert.alert(
      'Remove from group?',
      `Remove ${target.name}? They will no longer receive new messages.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRemovingMember(true);
              try {
                await removeFn({groupId: conversationId, removedUserId: target.userId});
                // P1-5 — the local crypto rekey above already excludes the
                // member from the new master key; now reconcile the SERVER
                // roster so the next /conversations/mine sync can't resurrect
                // them into fan-out (media keys + download grants). A failed
                // write is durably queued + retried; until then the Home sync
                // guard keeps the local (shrunk) participants authoritative.
                const ownerKey = useMessengerStore.getState()._ownUserId ?? undefined;
                const res = await writeServerRosterOrQueue({
                  conversationId, memberUserId: target.userId, action: 'remove', ownerKey,
                });
                if (res.queued) {
                  useMessengerStore.getState().setError(
                    'Member removed on this device. The group roster will finish syncing when you reconnect.',
                  );
                }
                setRenameOpen(false);
                setRenameUserId(null);
              } catch (e) {
                Alert.alert('Remove failed', e instanceof Error ? e.message : 'Could not remove this member.');
              } finally {
                setRemovingMember(false);
              }
            })();
          },
        },
      ],
    );
  };

  if (!conversation) {
    return (
      <View style={[styles.root, {paddingTop: insets.top, justifyContent: 'center', alignItems: 'center'}]}>
        <Text style={{color: 'rgba(180,188,204,0.45)', fontSize: 13}}>Conversation not found.</Text>
      </View>
    );
  }

  // Deck page 19 - mission rooms already in flight keep the legacy title.
  const title     = displayRoomName(conversation.name) || 'Chat';
  const partLen = conversation.participants?.length ?? 0;
  const peerPhone = isGroup
    ? undefined
    : conversation.phoneE164 ?? resolveUserPhone(conversation.peer.userId);
  const subtitle  = isGroup
    ? `${partLen} ${partLen === 1 ? 'member' : 'members'}`
    : peerPhone ?? '';

  const handleSaveContact = async (): Promise<void> => {
    if (!peerPhone) {return;}
    if (saveContactBusyRef.current) {return;}
    saveContactBusyRef.current = true;
    try {
      try {
        // Opens the SYSTEM new-contact sheet pre-filled with the Bravo display
        // name + number. Deliberately not a silent addContactAsync: writing to
        // someone's address book is outward-facing and not easily undone, so the
        // user sees exactly what will be saved and can edit or cancel.
        await presentSaveContact({displayName: title, phoneE164: peerPhone});
      } catch { /* user cancelled, or no contacts app — nothing to report */ }
      // Re-read rather than trusting a return value: the platforms disagree on
      // what they report after the sheet closes, and the user may have edited
      // the number or cancelled.
      setSavedState(await getSavedState(peerPhone));
    } catch { /* best-effort — keep the last known saved state */ }
    finally {
      // finally, or a getSavedState rejection latches the ref and kills the
      // button until remount (critic finding).
      saveContactBusyRef.current = false;
    }
  };

  const handleResetSession = () => {
    if (!runtime || !conversation?.peer || isGroup) {return;}
    Alert.alert(
      'Reset secure session?',
      'Use this if recent messages from this contact show "decrypt failed" — usually because they reinstalled. Your local session is rebuilt; the next message you send will rebuild theirs too.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setResetting(true);
              try {
                await runtime.resetSessionWith(conversation.peer);
                Alert.alert('Session reset', 'Send a message to complete the rebuild on their side.');
              } catch (e) {
                Alert.alert('Reset failed', e instanceof Error ? e.message : 'Could not refetch peer keys.');
              } finally {
                setResetting(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleDelete = () => {
    Alert.alert(
      isGroup ? 'Leave group?' : 'Delete chat?',
      isGroup
        ? 'You will leave the group and the other members are notified that you left. This device drops the chat and its key.'
        : 'The chat is removed entirely from this device — both the conversation row and all messages and call records.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: isGroup ? 'Leave' : 'Delete', style: 'destructive', onPress: () => {
          void (async () => {
            // P1-G4 — for a group, broadcast leave + rekey to the remaining
            // members (forward secrecy) BEFORE dropping it locally. Best-effort:
            // a failed fan-out must not strand the user in a group they left, so
            // the local removal below always runs.
            if (isGroup) {
              try { await runtime?.leaveGroup?.({groupId: conversationId}); }
              catch (e) { console.warn('[ChatInfo.leaveGroup] failed:', (e as Error).message); }
              // P1-5 — drop SELF from the server roster too. Without this the
              // server still lists us and /conversations/mine re-creates the
              // group on our next sync (the leave never "sticks"). Await BEFORE
              // the local removal below so a failed write enqueues its retry
              // intent before any Home sync runs — the guard then skips
              // re-creating this left group while the self-removal is pending.
              const selfId = currentUser?.id ?? useMessengerStore.getState()._ownUserId;
              if (selfId) {
                const res = await writeServerRosterOrQueue({
                  conversationId, memberUserId: selfId, action: 'remove',
                  ownerKey: useMessengerStore.getState()._ownUserId ?? undefined,
                }).catch(() => ({queued: false} as const));
                if (res.queued) {
                  useMessengerStore.getState().setError(
                    'You left the group. The roster will finish syncing when you reconnect.',
                  );
                }
              }
            }
            removeConversation(conversationId);
            navigation.navigate('MessengerHome');
          })();
        }},
      ],
    );
  };

  const handleClearMessages = () => {
    Alert.alert(
      'Clear messages?',
      'Every text, attachment, and call record in this chat will be removed from this device. The conversation itself stays in your list. Cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Clear', style: 'destructive', onPress: () => {
          // P2-10 — also drop every still-queued outbox row so the reconnect
          // drain doesn't ship a message the user just cleared.
          void runtime?.discardOutboxForConversation?.(conversationId).catch(() => { /* best-effort */ });
          clearMessages(conversationId);
          navigation.goBack();
        }},
      ],
    );
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="rgba(229,233,242,0.62)" />
          <Text style={styles.headerTitle}>{isGroup ? 'Group Info' : 'Chat Info'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[{paddingBottom: insets.bottom + 40}]}
        showsVerticalScrollIndicator={false}>

        {/* Profile */}
        <View style={styles.profileSection}>
          {/* B-291 — an admin taps the avatar to set or remove the group photo.
              Non-admins get the same avatar without the affordance. */}
          {isGroup ? (
            <TouchableOpacity
              activeOpacity={canEditPhoto || groupPhotoUri ? 0.7 : 1}
              disabled={photoBusy || (!canEditPhoto && !groupPhotoUri)}
              // Founder 2026-08-01 — non-admins tap to VIEW the photo full
              // screen; admins keep the edit sheet (View photo rides it).
              onPress={canEditPhoto
                ? presentPhotoOptions
                : () => { if (groupPhotoUri) {setAvatarView({uri: groupPhotoUri, name: title});} }}
              accessibilityRole={canEditPhoto || groupPhotoUri ? 'button' : 'image'}
              accessibilityLabel={canEditPhoto ? 'Group photo. Tap to change.' : 'Group photo. Tap to view.'}>
              <GroupAvatar
                groupId={conversationId}
                size={84}
                radius={42}
                fallback={
                  <View style={[styles.profileAvatar, {backgroundColor: avatarColor(conversation.id)}]}>
                    <Icon name="account-group" size={40} color="#FFF" />
                  </View>
                }
              />
              {canEditPhoto && (
                <View style={styles.photoEditBadge}>
                  <Icon
                    name={photoBusy ? 'progress-upload' : 'camera'}
                    size={14}
                    color="#FFF"
                  />
                </View>
              )}
            </TouchableOpacity>
          ) : peerId && memberAvatars[peerId]
            ? (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setAvatarView({uri: memberAvatars[peerId]!, name: title})}
                accessibilityRole="button"
                accessibilityLabel="Profile photo. Tap to view full screen.">
                <Image source={{uri: memberAvatars[peerId]!}} style={styles.profileAvatar} />
              </TouchableOpacity>
            )
            : (
              <View style={[styles.profileAvatar, {backgroundColor: avatarColor(conversation.id)}]}>
                <Text style={styles.profileInitials}>{initialsOf(title)}</Text>
              </View>
            )}
          {/* B-289 — the group name is editable by an admin. A plain Text for
              everyone else: a tappable label that does nothing reads as broken,
              and the runtime rejects a non-admin rename anyway. */}
          {isGroup && isAdmin && !!runtime?.renameGroup ? (
            <TouchableOpacity
              style={styles.groupNameRow}
              activeOpacity={0.7}
              onPress={() => { setGroupNameValue(title); setGroupNameOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={`Group name: ${title}. Tap to change.`}>
              <Text style={styles.profileName} numberOfLines={2}>{title}</Text>
              <Icon name="pencil-outline" size={15} color="rgba(180,188,204,0.55)" />
            </TouchableOpacity>
          ) : (
            <Text style={styles.profileName} numberOfLines={2}>{title}</Text>
          )}
          {!!subtitle && <Text style={styles.profilePhone}>{subtitle}</Text>}
          {/* Is this number actually in the phone's address book?
              Without this the screen is ambiguous: a name resolved from the
              Bravo directory (B-79) looks exactly like one that came from your
              own contacts, so you cannot tell whether you have the person
              saved. 'unknown' (permission denied / unavailable) renders
              NOTHING — a wrong "not saved" badge would push people to create
              duplicates of contacts they already have. */}
          {!isGroup && savedState === 'saved' && (
            <View style={styles.savedChip}>
              <Icon name="account-check" size={12} color="#4ade80" />
              <Text style={styles.savedChipText}>Saved in contacts</Text>
            </View>
          )}
          {!isGroup && savedState === 'not-saved' && !!peerPhone && (
            <TouchableOpacity
              style={styles.saveChip}
              onPress={() => { void handleSaveContact(); }}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`Save ${title} to your phone contacts`}>
              <Icon name="account-plus-outline" size={12} color="#5B8DEF" />
              <Text style={styles.saveChipText}>Not in contacts · Save</Text>
            </TouchableOpacity>
          )}
          <View style={styles.e2eBadge}>
            <Icon name="lock" size={13} color="#4ade80" />
            <Text style={styles.e2eText}>AES-256 Encrypted</Text>
          </View>
        </View>

        {/* Quick actions */}
        <View style={styles.quickActionsRow}>
          <QuickAction
            icon="phone" color="#4ade80" bg="rgba(34,197,94,0.12)" border="rgba(34,197,94,0.25)" label="Call"
            onPress={() => launchCall(navigation, {conversationId, callType: 'voice'})} />
          <QuickAction
            icon="video" color="#5B8DEF" bg="rgba(91,141,239,0.12)" border="rgba(91,141,239,0.25)" label="Video"
            onPress={() => launchCall(navigation, {conversationId, callType: 'video'})} />
          <QuickAction
            icon={isMuted ? 'bell' : 'bell-off'}
            color={isMuted ? '#F59E0B' : 'rgba(229,233,242,0.62)'}
            bg={isMuted ? 'rgba(245,158,11,0.12)' : 'rgba(100,116,139,0.12)'}
            border={isMuted ? 'rgba(245,158,11,0.3)' : 'rgba(100,116,139,0.25)'}
            label={isMuted ? 'Unmute' : 'Mute'}
            onPress={() => setConversationMuted(conversationId, !isMuted)} />
          <QuickAction
            icon={isGroup ? 'account-plus' : 'block-helper'}
            color={isGroup ? '#A78BFA' : '#f87171'}
            bg={isGroup ? 'rgba(167,139,250,0.1)' : 'rgba(239,68,68,0.1)'}
            border={isGroup ? 'rgba(167,139,250,0.25)' : 'rgba(239,68,68,0.2)'}
            label={isGroup ? 'Add' : 'Block'}
            onPress={isGroup
              // SN-09 — this tile used to navigate with NO params. React
              // Navigation then rendered NewChat in ordinary new-message mode,
              // so picking a contact opened a 1:1 chat instead of adding them
              // to the group — the group's membership never changed. Pass the
              // same params as the "Add member" row below.
              ? () => navigation.navigate('NewChat', {
                  addToGroupId: conversationId,
                  groupName:    title,
                })
              : () => Alert.alert('Block contact?', 'Incoming messages will be silently dropped. You can unblock from Settings.', [
                  {text: 'Cancel', style: 'cancel'},
                  {text: 'Block', style: 'destructive', onPress: blockPeer},
                ])
            } />
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Members — groups only */}
        {isGroup && (
          <>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>Members · {members.length}</Text>
              {isAdmin && <Text style={styles.sectionHint}>Tap to rename</Text>}
            </View>
            {/* BS-GROUP-ADD — add a member to an existing group. Routes to
                NewChat in add-to-group mode, which calls runtime.addGroupMember
                (rekeys the group epoch) on pick. */}
            {isAdmin && (
              <TouchableOpacity
                style={styles.addMemberRow}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('NewChat', {
                  addToGroupId: conversationId,
                  groupName:    title,
                })}>
                <View style={styles.addMemberIcon}>
                  <Icon name="account-plus" size={20} color={Colors.primary} />
                </View>
                <Text style={styles.addMemberText}>Add member</Text>
              </TouchableOpacity>
            )}
            {members.map(m => (
              <TouchableOpacity
                key={m.userId}
                style={styles.memberRow}
                activeOpacity={m.isSelf ? 1 : 0.7}
                disabled={m.isSelf}
                onPress={() => onMemberTap(m)}>
                {memberAvatars[m.userId]
                  ? <Image source={{uri: memberAvatars[m.userId]!}} style={styles.memberAvatar} />
                  : (
                    <View style={[styles.memberAvatar, {backgroundColor: avatarColor(m.userId)}]}>
                      <Text style={styles.memberInitials}>{initialsOf(m.profileName)}</Text>
                    </View>
                  )}
                <View style={{flex: 1, minWidth: 0}}>
                  <View style={styles.memberNameRow}>
                    <Text style={[styles.memberName, {minWidth: '35%'}]} numberOfLines={1}>{m.name}</Text>
                    {m.isAdmin && (
                      <View style={styles.adminTag}>
                        <Icon name="shield-crown-outline" size={9} color="#4ADE80" />
                        <Text style={styles.adminTagText}>ADMIN</Text>
                      </View>
                    )}
                    {m.overridden && (
                      <View style={styles.aliasTag}>
                        <Icon name="pencil" size={9} color="#5B8DEF" />
                        <Text style={styles.aliasTagText}>ALIAS</Text>
                      </View>
                    )}
                  </View>
                  {m.overridden
                    ? <Text style={styles.memberPhone} numberOfLines={1}>was {m.profileName}</Text>
                    : !!m.phone && <Text style={styles.memberPhone} numberOfLines={1}>{m.phone}</Text>
                  }
                </View>
                {m.isSelf
                  ? <Text style={styles.selfBadge}>YOU</Text>
                  : isAdmin && <Icon name="pencil-outline" size={16} color="rgba(180,188,204,0.45)" />
                }
              </TouchableOpacity>
            ))}
            <View style={styles.divider} />
          </>
        )}

        {/* Settings */}
        <Text style={styles.sectionHeader}>Settings</Text>

        <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={() => setTtlPickerOpen(true)}>
          <View style={[styles.settingIcon, {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.2)'}]}>
            <Icon name="send-clock" size={18} color="#5B8DEF" />
          </View>
          <Text style={styles.settingTitle}>Disappearing Messages</Text>
          <Text style={[styles.settingRight, {color: '#5B8DEF'}]}>{prettyTtl(ttlSec)}</Text>
        </TouchableOpacity>

        {!isGroup && (
          <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={() => setFingerprintOpen(true)}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(234,179,8,0.1)', borderColor: 'rgba(234,179,8,0.2)'}]}>
              <Icon name="key-variant" size={18} color="#FBBF24" />
            </View>
            <Text style={styles.settingTitle}>Encryption Key</Text>
            <Text style={[styles.settingRight, {color: '#5B8DEF'}]}>View Safety Number</Text>
          </TouchableOpacity>
        )}

        {/* Reset secure session — only meaningful for direct chats. */}
        {!isGroup && (
          <TouchableOpacity
            style={styles.settingRow}
            activeOpacity={0.8}
            onPress={handleResetSession}
            disabled={resetting}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.2)'}]}>
              <Icon name="key-change" size={18} color="#F59E0B" />
            </View>
            <Text style={styles.settingTitle}>
              {resetting ? 'Resetting…' : 'Reset Secure Session'}
            </Text>
            <Text style={styles.settingRight}>Recovery</Text>
          </TouchableOpacity>
        )}

        {/* Clear messages — keeps the conversation row but wipes
            text bubbles, attachments, and call records. Useful for
            testing without re-creating the chat from scratch. */}
        {!isGroup && (
          <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={handleClearMessages}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.2)'}]}>
              <Icon name="broom" size={18} color="#fbbf24" />
            </View>
            <Text style={[styles.settingTitle, {color: '#fbbf24'}]}>
              Clear Messages
            </Text>
          </TouchableOpacity>
        )}

        {/* Destructive action — removes the whole chat from the list. */}
        <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={handleDelete}>
          <View style={[styles.settingIcon, {backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)'}]}>
            <Icon name={isGroup ? 'exit-run' : 'delete-sweep'} size={18} color="#ef4444" />
          </View>
          <Text style={[styles.settingTitle, {color: '#ef4444'}]}>
            {isGroup ? 'Exit Group' : 'Delete Chat'}
          </Text>
        </TouchableOpacity>

      </ScrollView>

      {/* Full-screen profile photo (founder 2026-08-01) */}
      <AvatarViewer target={avatarView} onClose={() => setAvatarView(null)} />

      {/* Disappearing messages — TTL picker */}
      <Modal
        visible={ttlPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTtlPickerOpen(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setTtlPickerOpen(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Disappearing Messages</Text>
            <Text style={styles.modalSub}>Messages auto-burn after the chosen duration. Applies to all new messages in this chat.</Text>
            <View style={{marginTop: 12}}>
              {TTL_CHOICES.map(opt => {
                const active = opt.sec === ttlSec;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.ttlOption, active && styles.ttlOptionActive]}
                    onPress={() => { setConversationTtl(conversationId, opt.sec); setTtlPickerOpen(false); }}
                    activeOpacity={0.8}>
                    <Text style={[styles.ttlOptionText, active && {color: '#5B8DEF'}]}>{opt.label}</Text>
                    {active && <Icon name="check" size={18} color="#5B8DEF" />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Encryption fingerprint */}
      <Modal
        visible={fingerprintOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFingerprintOpen(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setFingerprintOpen(false)}>
          <View style={styles.modalCard}>
            <View style={{alignItems: 'center', marginBottom: 12}}>
              <Icon name="shield-check" size={32} color="#4ade80" />
            </View>
            <Text style={[styles.modalTitle, {textAlign: 'center'}]}>Safety Number</Text>
            <Text style={[styles.modalSub, {textAlign: 'center'}]}>
              Compare these 60 digits with your contact in person, on a call, or via a trusted channel. If both phones show the same number, your conversation has not been intercepted.
            </Text>
            <View style={styles.fingerprintBox}>
              {safetyError
                ? <Text style={[styles.fingerprintText, {color: '#f87171'}]}>{safetyError}</Text>
                : safetyNumber
                  ? <Text style={styles.fingerprintText}>{safetyNumber}</Text>
                  : <Text style={[styles.fingerprintText, {color: 'rgba(180,188,204,0.45)'}]}>Computing…</Text>}
            </View>
            {/* Audit P0-I3 — verification status banner. Renders only
                once the safety number has resolved (so the CTA below
                can actually hash and persist it). */}
            {safetyNumber && (
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  alignSelf: 'center', marginTop: 12,
                }}>
                <Icon
                  name={verifiedAtMs !== null ? 'shield-check' : 'shield-alert-outline'}
                  size={14}
                  color={verifiedAtMs !== null ? '#4ade80' : 'rgba(180,188,204,0.45)'}
                />
                <Text style={{color: verifiedAtMs !== null ? '#4ade80' : 'rgba(180,188,204,0.45)', fontSize: 12}}>
                  {verifiedAtMs !== null
                    ? `Verified ${new Date(verifiedAtMs).toLocaleDateString()}`
                    : 'Not yet verified'}
                </Text>
              </View>
            )}
            <View style={{flexDirection: 'row', gap: 8, alignSelf: 'center', marginTop: 16, flexWrap: 'wrap', justifyContent: 'center'}}>
              <TouchableOpacity
                style={[styles.fingerprintAction, !safetyNumber && {opacity: 0.4}]}
                onPress={() => {
                  if (!safetyNumber) {return;}
                  void Clipboard.setStringAsync(safetyNumber);
                  Vibration.vibrate(8);
                  setSafetyCopied(true);
                  setTimeout(() => setSafetyCopied(false), 1400);
                }}
                disabled={!safetyNumber}
                activeOpacity={0.85}>
                <Icon name={safetyCopied ? 'check' : 'content-copy'} size={14} color="#5B8DEF" />
                <Text style={styles.fingerprintActionText}>{safetyCopied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
              {/* Audit P0-I3 — mark / clear verification CTA. */}
              <TouchableOpacity
                style={[styles.fingerprintAction, (!safetyNumber || verifyBusy) && {opacity: 0.4}]}
                onPress={() => { void onToggleVerified(); }}
                disabled={!safetyNumber || verifyBusy}
                activeOpacity={0.85}>
                <Icon
                  name={verifiedAtMs !== null ? 'shield-off-outline' : 'shield-check'}
                  size={14}
                  color="#5B8DEF"
                />
                <Text style={styles.fingerprintActionText}>
                  {verifiedAtMs !== null ? 'Clear' : 'Mark verified'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSave}
                onPress={() => setFingerprintOpen(false)}
                activeOpacity={0.85}>
                <Text style={styles.modalSaveText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* B-289 — Admin: change the group's name */}
      {groupNameOpen && (
      <Modal
        visible
        transparent
        animationType="fade"
        onRequestClose={() => setGroupNameOpen(false)}>
        {/* B-184 — one rule: the backdrop shrinks by the IME overlap so the
            centred card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Group name</Text>
            <Text style={styles.modalSub}>
              Everyone in the group sees this name.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={groupNameValue}
              onChangeText={setGroupNameValue}
              placeholder="Group name"
              placeholderTextColor="rgba(180,188,204,0.45)"
              autoFocus
              maxLength={GROUP_NAME_MAX}
              returnKeyType="done"
              onSubmitEditing={saveGroupName}
            />
            <View style={styles.modalRow}>
              <View style={{flex: 1}} />
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setGroupNameOpen(false)}
                activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSave, groupNameBusy && {opacity: 0.5}]}
                onPress={saveGroupName}
                disabled={groupNameBusy}
                activeOpacity={0.85}>
                <Text style={styles.modalSaveText}>
                  {groupNameBusy ? 'Saving…' : 'Save'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      )}

      {/* Admin: rename member in this group */}
      <Modal
        visible={renameOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameOpen(false)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename member</Text>
            <Text style={styles.modalSub}>
              Only shown inside this group. Their profile stays as <Text style={{color: 'rgba(229,233,242,0.62)'}}>{renameProfile}</Text>.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder={renameProfile}
              placeholderTextColor="rgba(180,188,204,0.45)"
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={saveRename}
            />
            {/* GRP-20/25 — admin-only destructive removal (never for self) */}
            {isGroupAdmin && !!runtime?.removeGroupMember && (
              <TouchableOpacity
                style={[styles.modalRemoveRow, removingMember && {opacity: 0.5}]}
                onPress={() => confirmRemoveMember()}
                disabled={removingMember}
                activeOpacity={0.8}>
                <Icon name="account-remove-outline" size={16} color="#F87171" />
                <Text style={styles.modalRemoveText}>
                  {removingMember ? 'Removing…' : 'Remove from group'}
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={resetToProfile} activeOpacity={0.8}>
                <Text style={styles.modalResetText}>Reset</Text>
              </TouchableOpacity>
              <View style={{flex: 1}} />
              <TouchableOpacity style={styles.modalCancel} onPress={() => setRenameOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSave} onPress={saveRename} activeOpacity={0.85}>
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function QuickAction({icon, color, bg, border, label, onPress}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  color: string; bg: string; border: string; label: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.quickAction} activeOpacity={0.8} onPress={onPress}>
      <View style={[styles.quickCircle, {backgroundColor: bg, borderColor: border}]}>
        <Icon name={icon} size={22} color={color} />
      </View>
      <Text style={styles.quickLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)'},
  backBtn: {flexDirection: 'row', alignItems: 'center', gap: 6},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: 'rgba(229,233,242,0.62)'},

  profileSection: {alignItems: 'center', paddingTop: 32, paddingBottom: 24, paddingHorizontal: 16},
  // Address-book state chips. 32 tall + hitSlop-free padding keeps the tappable
  // "Save" variant at a comfortable target without crowding the profile block.
  savedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10,
    paddingHorizontal: 12, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(34,197,94,0.10)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.22)',
  },
  savedChipText: {color: '#4ade80', fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2},
  saveChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10,
    paddingHorizontal: 12, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  saveChipText: {color: '#5B8DEF', fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2},
  profileAvatar: {width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: '#000', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.3, shadowRadius: 16, elevation: 8},
  profileInitials: {color: '#FFF', fontSize: 24, fontWeight: '800', letterSpacing: 1},
  profileName: {fontSize: 18, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 2, color: '#FFFFFF', marginBottom: 4, textAlign: 'center'},
  // B-289 — the pencil sits beside a long name that may wrap, so the row
  // shrinks the label rather than pushing the icon off-screen.
  groupNameRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '86%'},
  // B-291 — the camera chip that says the avatar is tappable. Bottom-right so it
  // never covers a face.
  photoEditBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#5B8DEF',
    borderWidth: 2, borderColor: Colors.background,
  },
  profilePhone: {fontSize: 12, color: 'rgba(180,188,204,0.45)', marginBottom: 12},
  e2eBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99},
  e2eText: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#4ade80'},

  quickActionsRow: {flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 24, gap: 8},
  quickAction: {flex: 1, alignItems: 'center', gap: 6},
  quickCircle: {width: 50, height: 50, borderRadius: 25, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  quickLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)'},

  divider: {height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 16},
  sectionHeader: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8},

  sectionHeaderRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingRight: 16},
  sectionHint: {color: '#5B8DEF', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase'},

  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10},
  memberAvatar: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  memberInitials: {color: '#FFF', fontSize: 12, fontWeight: '800'},
  // BS-GROUP-ADD — "Add member" row.
  addMemberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10},
  addMemberIcon: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', flexShrink: 0},
  addMemberText: {color: Colors.primary, fontSize: 14, fontWeight: '700'},
  memberNameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  memberName: {color: '#FFFFFF', fontSize: 13, fontWeight: '700', flexShrink: 1},
  memberPhone: {color: 'rgba(180,188,204,0.45)', fontSize: 11, marginTop: 2},
  aliasTag: {flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  aliasTagText: {color: '#5B8DEF', fontSize: 8, fontWeight: '800', letterSpacing: 1.2},
  // B-268 — mirrors aliasTag's geometry so the two can sit side by side on one
  // name row without the line jumping. Signal-green, not the cobalt used for
  // ALIAS/YOU: admin is an authority state, not an annotation about naming.
  adminTag: {flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)'},
  adminTagText: {color: '#4ADE80', fontSize: 8, fontWeight: '800', letterSpacing: 1.2},
  selfBadge: {color: '#5B8DEF', fontSize: 9, fontWeight: '800', letterSpacing: 1.5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)'},

  settingRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)'},
  settingIcon: {width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  settingTitle: {flex: 1, fontSize: 13, fontWeight: '700', color: '#FFFFFF'},
  settingRight: {fontSize: 11, fontWeight: '700', color: 'rgba(180,188,204,0.45)'},

  // Admin rename modal
  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  modalCard: {width: '100%', maxWidth: 380, backgroundColor: '#0C1018', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  modalTitle: {color: '#FFF', fontSize: 16, fontWeight: '800', letterSpacing: 0.3},
  modalSub: {color: 'rgba(180,188,204,0.45)', fontSize: 11, marginTop: 6, lineHeight: 16},
  modalInput: {marginTop: 16, backgroundColor: '#07090D', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: '#FFF', fontSize: 14},
  modalRemoveRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)'},
  modalRemoveText: {color: '#F87171', fontSize: 13, fontWeight: '700'},
  modalRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16},
  modalCancel: {paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8},
  modalCancelText: {color: 'rgba(229,233,242,0.62)', fontSize: 13, fontWeight: '700'},
  modalResetText: {color: '#5B8DEF', fontSize: 13, fontWeight: '700'},
  modalSave: {paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, backgroundColor: '#5B8DEF'},
  modalSaveText: {color: '#FFF', fontSize: 13, fontWeight: '800'},

  ttlOption: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  ttlOptionActive: {borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,0.10)'},
  ttlOptionText: {color: '#FFF', fontSize: 13, fontWeight: '600'},

  fingerprintBox: {marginTop: 16, padding: 14, borderRadius: 10, backgroundColor: '#07090D', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  fingerprintText: {color: '#4ade80', fontSize: 14, fontWeight: '700', letterSpacing: 2, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
  fingerprintAction: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)'},
  fingerprintActionText: {color: '#5B8DEF', fontSize: 13, fontWeight: '700'},
}));
