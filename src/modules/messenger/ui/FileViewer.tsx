import React, {useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TouchableOpacity,
  useWindowDimensions } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
// Why: RN <Modal> opens a NEW native window — gesture-handler only works
// inside it when the modal's content is wrapped in its own root view.
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {ZoomableImage} from './ZoomableImage';
import {useAudioPlayer, useAudioPlayerStatus} from 'expo-audio';
import {useVideoPlayer, VideoView} from 'expo-video';
import * as Sharing from 'expo-sharing';
import FileViewerNative from 'react-native-file-viewer';
import {useVaultStore, moveBytesToVault, findVaultRow, isDepartmentConversation} from '@/modules/messenger/vault';
import {readUriBytes} from '@/modules/messenger/media';
import {haptics} from '@utils/haptics';
import {resolveVaultMoveAction} from './vaultMoveAction';
// B-592 — the vault "folder" ask. Shared presentational album UI; the STATE
// passed in is the VAULT album space (vaultStore.albumState), never the
// Files-tab one — the two spaces are separate by founder decision 2026-08-08.
import {MoveToAlbumSheet, NameAlbumModal} from '@screens/messenger/albumUi';
import {useAuthStore} from '@store/authStore';
import {deriveEntitlements, showTierUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';

export type ViewableFile = {
  /** Stable id — chat surfaces pass the message id (vault handle defaults to `msg:<id>`). */
  id:        string;
  /**
   * B-86 — explicit vault-index handle. REQUIRED when the viewer is
   * opened FROM the vault (pass the row's objectKey): reconstructing
   * `msg:<id>` there would never match, so "Move to Vault" re-uploaded
   * duplicates and Delete silently removed nothing.
   */
  vaultSourceKey?: string;
  /**
   * Scope v2 Phase 4 — provenance. Threaded to moveBytesToVault so the vault
   * itself can refuse a COMPANY file, instead of relying on each surface to
   * hide the button (four surfaces offered it; the first fix covered one).
   */
  conversationId: string | null;
  name:      string;
  uri:       string;
  mimeType:  string;
  size?:     number;
  createdAt: number;
};

type MediaKind = 'image' | 'video' | 'audio' | 'other';

function kindFor(mime: string): MediaKind {
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('video/')) {return 'video';}
  if (mime.startsWith('audio/')) {return 'audio';}
  return 'other';
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {return '0:00';}
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Full-screen viewer for image / video / audio attachments.
 *
 * - Image: native <Image resizeMode="contain"> full-screen
 * - Audio: expo-audio hook-based player with play/pause + progress
 * - Video / other: metadata + "Open externally" via Linking (we avoid
 *   pulling expo-av which has an ESM interop crash on Hermes — see the
 *   `_interopNamespace` TypeError it used to throw at bundle load)
 *
 * `objectKey` convention: when a file is pushed to the vault we mint
 * `msg:<id>` so dedup across Files tab, Chat preview, and Vault index
 * is automatic.
 */
export function FileViewer({
  file,
  onClose,
  onDelete,
  onSwipe,
  allowVaultActions = true,
}: {
  file:      ViewableFile | null;
  onClose:   () => void;
  /** Caller can wire an extra step — e.g. remove the underlying chat message. */
  onDelete?: (f: ViewableFile) => void;
  /**
   * Scope v2 Phase 4 — set FALSE for a file the personal vault does not own.
   *
   * Omitting `vaultSourceKey` is NOT enough to suppress these: `vaultHandle`
   * falls back to `msg:<id>`, so the bar renders anyway. On the Enterprise
   * Vault's Company shelf that meant two taps — open, "Move to Vault" — copied
   * a company file into the PERSONAL shelf, breaking the phase's headline rule
   * ("never mixed") and leaving a copy permanently outside the channel's
   * permission inheritance: it survives removal from the channel and is not
   * membership-scoped. "Delete" was worse than useless there — it called
   * `removeFromVault('msg:<id>')`, which matches nothing, while telling the
   * user the file had been removed from the device.
   *
   * Share stays: reading out a file you can already open is the same capability
   * the channel thread gives you.
   */
  allowVaultActions?: boolean;
  /**
   * B-287 — page to the adjacent image in the surrounding thread. Only wired
   * by chat, which is the only caller that HAS neighbours; the vault and files
   * viewers pass nothing and keep a plain zoomable image.
   */
  onSwipe?: (direction: -1 | 1) => void;
}) {
  const insets = useSafeAreaInsets();
  // Foldable/rotation: size full-screen media to the LIVE window, not a value
  // frozen at module load. The activity is not recreated across a fold
  // (configChanges swallows the resize), so a module-scope Dimensions.get read
  // would stay stale and the image/video would be cut off after an unfold.
  const {width: winW, height: winH} = useWindowDimensions();
  const vaultFiles      = useVaultStore(s => s.files);
  const removeFromVault = useVaultStore(s => s.removeFile);
  // B-86 — one MFA-gated move at a time.
  const [vaultBusy, setVaultBusy] = useState(false);
  // B-592 — after a successful move, ask WHICH vault album ("folder") the file
  // belongs in. Holds the just-moved row's objectKey while the sheet is open.
  const [albumFor, setAlbumFor] = useState<string | null>(null);
  const [namingAlbum, setNamingAlbum] = useState(false);
  const vaultAlbums = useVaultStore(s => s.albumState.albums);
  // Review fix — the sheet's state must not outlive its file. A caller that
  // hides the viewer WITHOUT unmounting it (VaultScreen renders it
  // unconditionally) or pages to a neighbour would otherwise re-open the
  // picker later and file the PREVIOUS file's objectKey.
  useEffect(() => { setAlbumFor(null); setNamingAlbum(false); }, [file?.id]);

  /**
   * Scope v2 Phase 4 — a company file's vault actions are suppressed for EVERY
   * caller, derived from the file itself rather than from a prop each surface
   * has to remember.
   *
   * `moveBytesToVault` already refuses these, so Move would fail honestly. But
   * DELETE would still lie: it calls `removeFromVault('msg:<id>')`, which
   * matches nothing, while telling the user the file was removed from the
   * device. And relying on the explicit prop is what left three of four
   * surfaces open in the first place.
   *
   * A plain read, not a subscription: the viewer is short-lived and the map
   * does not change under it.
   */
  const isCompanyFile = !!file?.conversationId && isDepartmentConversation(file.conversationId);
  const showVaultActions = allowVaultActions && !isCompanyFile;

  const visible  = !!file;
  const kind     = file ? kindFor(file.mimeType) : 'other';
  const vaultHandle = file ? (file.vaultSourceKey ?? `msg:${file.id}`) : null;
  const vaultRow = vaultHandle ? findVaultRow(vaultFiles, vaultHandle) : null;
  const inVault  = !!vaultRow;

  const moveToVault = () => {
    if (!file || !vaultHandle || vaultBusy) {return;}
    // M1A rule 12 — Cloud Vault is Pro+ (org tenancy also entitles). The
    // server refuses the vault action token for Lite anyway; gating here
    // gives the honest upgrade ask instead of a failed-upload error.
    if (!deriveEntitlements(useAuthStore.getState().user).hasCloudVault) {
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      return;
    }
    haptics.tap();
    const action = resolveVaultMoveAction(file.id, vaultRow?.objectKey ?? null);
    if (action.kind === 'remove') {
      removeFromVault(action.objectKey);
      return;
    }
    // B-86 — the real pipeline: biometric ceremony → single-use MFA
    // action token → VaultClient encrypt-and-upload → real key material
    // in the index. Fails CLOSED with an honest alert (never a fake row —
    // the vault store itself refuses key-less rows, audit M-02).
    setVaultBusy(true);
    void (async () => {
      try {
        const bytes = await readUriBytes(file.uri);
        const res = await moveBytesToVault({
          sourceKey: vaultHandle,
          name:      file.name,
          mimeType:  file.mimeType,
          bytes,
          conversationId: file.conversationId,
        });
        if (res.ok) {
          haptics.impact();
          // B-592 — the file is safe; now ask which album it belongs in.
          setAlbumFor(res.objectKey);
        } else if (res.reason === 'tier') {
          // B-591 — a billing state, not a security failure. The honest ask is
          // the plans screen, the same one the pre-flight gate shows.
          showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
        } else if (res.reason !== 'cancelled') {
          Alert.alert('Not moved to vault', res.message);
        }
      } catch (e) {
        Alert.alert('Not moved to vault', e instanceof Error ? e.message : 'Could not read the file.');
      } finally {
        setVaultBusy(false);
      }
    })();
  };

  // Media-parity M15 — expo-sharing hands the OS a content:// uri via
  // its own FileProvider, so "Share" actually shares the FILE (RN's
  // Share.share({url}) is iOS-only and silently shared the name text on
  // Android). Exporting decrypted plaintext is a deliberate user action.
  const shareFile = () => {
    if (!file) {return;}
    void (async () => {
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, {mimeType: file.mimeType, dialogTitle: file.name});
        } else {
          Alert.alert('Sharing unavailable', 'This device has no app to share to.');
        }
      } catch { /* user dismissed the sheet */ }
    })();
  };

  // Media-parity M1/G1 — open documents (PDF/office/etc) via
  // react-native-file-viewer, which uses a FileProvider content:// uri +
  // ACTION_VIEW. The old Linking.openURL('file://…') threw
  // FileUriExposedException on Android 7+ (private cache, no provider),
  // so every non-image/video/audio tap failed. Falls back to the share
  // sheet ("open with…") when no viewer is registered.
  const openExternal = () => {
    if (!file) {return;}
    void (async () => {
      try {
        await FileViewerNative.open(file.uri.replace('file://', ''), {
          showOpenWithDialog: true,
          displayName:        file.name,
        });
      } catch {
        try {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(file.uri, {mimeType: file.mimeType, dialogTitle: file.name});
            return;
          }
        } catch { /* fall through to the alert */ }
        Alert.alert('Could not open', 'No app on this device can open this file type. Try Share to pick one.');
      }
    })();
  };

  const confirmDelete = () => {
    if (!file) {return;}
    Alert.alert(
      'Delete file?',
      'This removes it from this device. Any recipient who already received it keeps their copy.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => {
          haptics.heavy();
          removeFromVault(vaultRow?.objectKey ?? vaultHandle ?? `msg:${file.id}`);
          onDelete?.(file);
          onClose();
        }},
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        {/* Backdrop tap closes */}
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />

        {file && kind === 'image' && (
          // B-87/MX-03 — pinch-zoom + double-tap + pan. The no-op wrapper
          // CLAIMS single taps over the image so the backdrop close can't
          // race the double-tap timer (tap outside the photo still closes).
          <Pressable>
            <ZoomableImage uri={file.uri} width={winW} height={winH * 0.78} onSwipe={onSwipe} />
          </Pressable>
        )}

        {file && kind === 'audio' && (
          <AudioPreview file={file} />
        )}

        {file && kind === 'video' && (
          <VideoPreview file={file} />
        )}

        {file && kind === 'other' && (
          <OpenExternalPreview
            file={file}
            icon="file-document-outline"
            tint="#60A5FA"
            label="Open file"
            onOpen={openExternal}
          />
        )}

        <TouchableOpacity style={[styles.closeBtn, {top: insets.top + 8}]} onPress={onClose} activeOpacity={0.7}>
          <Icon name="close" size={24} color="#fff" />
        </TouchableOpacity>

        {file && (
          <View style={[styles.actionBar, {paddingBottom: insets.bottom + 14}]}>
            {showVaultActions && (
              <ActionButton
                icon={inVault ? 'shield-check' : vaultBusy ? 'shield-sync-outline' : 'shield-plus-outline'}
                label={inVault ? 'In Vault' : vaultBusy ? 'Securing…' : 'Move to Vault'}
                tint={inVault ? '#4ade80' : '#FBBF24'}
                activeTintBg={inVault ? 'rgba(74,222,128,0.15)' : undefined}
                activeTintBorder={inVault ? 'rgba(74,222,128,0.35)' : undefined}
                onPress={moveToVault}
                variant="action"
              />
            )}
            <ActionButton
              icon="share-variant-outline"
              label="Share"
              tint="#60A5FA"
              onPress={shareFile}
              variant="neutral"
            />
            {showVaultActions && (
              <ActionButton
                icon="trash-can-outline"
                label="Delete"
                tint="#f87171"
                onPress={confirmDelete}
                variant="danger"
              />
            )}
          </View>
        )}

        {/* B-592 — the vault "folder" picker for the file just moved. Closing
            without picking leaves the file unfiled, which is the vault's
            default state, so there is no wrong way out of this sheet. */}
        <MoveToAlbumSheet
          // Hidden while the name modal is up — FilesScreen's precedent. Three
          // stacked native Modals is the iOS "presentation in progress" trap.
          visible={albumFor !== null && !namingAlbum}
          count={1}
          albums={vaultAlbums}
          onClose={() => setAlbumFor(null)}
          onPick={id => {
            const err = albumFor
              ? useVaultStore.getState().moveToVaultAlbum([albumFor], id)
              : null;
            if (err) {
              // Album deleted between opening the sheet and picking. The file
              // is safe either way — unfiled is the vault's default state.
              Alert.alert('Not filed', 'That album no longer exists — the file stays in your vault, unfiled.');
            }
            setAlbumFor(null);
          }}
          onCreate={() => setNamingAlbum(true)}
        />
        <NameAlbumModal
          visible={namingAlbum}
          title="New album"
          initial=""
          onClose={() => setNamingAlbum(false)}
          onSubmit={name => {
            const {id, error} = useVaultStore.getState().createVaultAlbum(name);
            if (error) {return error;}
            const filed = albumFor && id
              ? useVaultStore.getState().moveToVaultAlbum([albumFor], id)
              : null;
            if (filed) {return filed;}
            setNamingAlbum(false);
            setAlbumFor(null);
            return null;
          }}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * Media-parity G1 — in-app video player (expo-video) fed the decrypted
 * local file. Videos used to be unopenable (Linking file:// threw on
 * Android). Auto-plays on mount; the player tears down on unmount.
 */
function VideoPreview({file}: {file: ViewableFile}) {
  const {width: winW, height: winH} = useWindowDimensions();
  const player = useVideoPlayer({uri: file.uri}, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <View style={[styles.videoWrap, {width: winW, height: winH * 0.72}]}>
      <VideoView
        style={{width: winW, height: winH * 0.72}}
        player={player}
        allowsFullscreen
        allowsPictureInPicture
        contentFit="contain"
        nativeControls
      />
    </View>
  );
}

/**
 * Audio preview — expo-audio, now with SEEK (media-parity M13). The
 * player is torn down automatically when the component unmounts.
 */
function AudioPreview({file}: {file: ViewableFile}) {
  const player = useAudioPlayer({uri: file.uri});
  const status = useAudioPlayerStatus(player);
  const [barWidth, setBarWidth] = useState(0);

  useEffect(() => {
    return () => {
      // Stop playback when the viewer closes so background audio
      // doesn't keep running.
      try { player.pause(); } catch { /* already gone */ }
    };
  }, [player]);

  const duration = status?.duration ?? 0;
  const current  = status?.currentTime ?? 0;
  const isPlaying = status?.playing ?? false;

  const toggle = () => {
    if (isPlaying) {player.pause();}
    else {player.play();}
  };

  // M13 — tap anywhere on the progress bar to seek to that position.
  const seekTo = (locationX: number) => {
    if (duration <= 0 || barWidth <= 0) {return;}
    const frac = Math.max(0, Math.min(1, locationX / barWidth));
    try { void player.seekTo(frac * duration); } catch { /* seek unsupported */ }
  };

  return (
    <View style={styles.audioWrap}>
      <View style={styles.audioArtwork}>
        <Icon name="music-note" size={72} color="#A78BFA" />
      </View>
      <Text style={styles.audioName} numberOfLines={2}>{file.name}</Text>
      <Pressable
        style={styles.audioProgress}
        onLayout={e => setBarWidth(e.nativeEvent.layout.width)}
        onPress={e => seekTo(e.nativeEvent.locationX)}>
        <View style={[styles.audioProgressFill, {
          width: duration > 0 ? `${Math.min(100, (current / duration) * 100)}%` : '0%',
        }]} />
      </Pressable>
      <View style={styles.audioMetaRow}>
        <Text style={styles.audioTime}>{fmtTime(current)}</Text>
        <Text style={styles.audioTime}>{fmtTime(duration)}</Text>
      </View>
      <Pressable
        onPress={toggle}
        style={({pressed}) => [
          styles.audioPlayBtn,
          pressed && styles.audioPlayBtnPressed,
        ]}>
        <Icon name={isPlaying ? 'pause' : 'play'} size={32} color="#fff" />
      </Pressable>
    </View>
  );
}

function OpenExternalPreview({
  file, icon, tint, label, onOpen,
}: {
  file:   ViewableFile;
  icon:   React.ComponentProps<typeof Icon>['name'];
  tint:   string;
  label:  string;
  onOpen: () => void;
}) {
  return (
    <View style={styles.externalWrap}>
      <Pressable
        onPress={onOpen}
        style={({pressed}) => [
          styles.externalArt,
          {backgroundColor: `${tint}1F`, borderColor: `${tint}47`},
          pressed && {backgroundColor: `${tint}33`, borderColor: `${tint}66`},
        ]}>
        <Icon name={icon} size={72} color={tint} />
      </Pressable>
      <Text style={styles.externalName} numberOfLines={2}>{file.name}</Text>
      <Text style={styles.externalMime}>{file.mimeType || 'unknown type'}</Text>
      <Pressable
        onPress={onOpen}
        style={({pressed}) => [
          styles.externalCta,
          pressed && styles.externalCtaPressed,
        ]}>
        <Icon name="open-in-new" size={16} color="#fff" />
        <Text style={styles.externalCtaText}>{label}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Action pill in the bottom bar. Uses Pressable so we can render a
 * proper pressed-state tint (Bravo brand action palette). Colours:
 *   default: icon on rgba(tint,0.10) bg, rgba(tint,0.25) border
 *   pressed: icon on rgba(tint,0.22) bg, rgba(tint,0.55) border,
 *            scale 0.96 — feels tactile without a ripple on Android.
 */
function ActionButton({
  icon, label, tint, activeTintBg, activeTintBorder, onPress, variant,
}: {
  icon:             React.ComponentProps<typeof Icon>['name'];
  label:            string;
  tint:             string;
  activeTintBg?:    string;
  activeTintBorder?: string;
  onPress:          () => void;
  variant:          'action' | 'neutral' | 'danger';
}) {
  // Variant just changes the default palette; pressed-state uses the same
  // tint with heavier alpha. Keeps palette centralised to one place.
  const defaultBg = variant === 'action'  ? 'rgba(251,191,36,0.1)'
                  : variant === 'danger'  ? 'rgba(239,68,68,0.12)'
                                          : 'rgba(96,165,250,0.12)';
  const defaultBorder = variant === 'action'  ? 'rgba(251,191,36,0.25)'
                      : variant === 'danger'  ? 'rgba(239,68,68,0.28)'
                                              : 'rgba(96,165,250,0.28)';
  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [
        styles.action,
        pressed && {transform: [{scale: 0.96}]},
      ]}>
      {({pressed}) => (
        <>
          <View style={[
            styles.actionIcon,
            {backgroundColor: activeTintBg ?? defaultBg, borderColor: activeTintBorder ?? defaultBorder},
            pressed && {
              backgroundColor: `${tint}33`,
              borderColor:     `${tint}80`,
              shadowColor:     tint,
              shadowOpacity:   0.45,
              shadowRadius:    10,
              elevation:       6,
            },
          ]}>
            <Icon name={icon} size={20} color={tint} />
          </View>
          <Text style={[styles.actionText, variant !== 'neutral' && {color: tint}]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center'},
  videoWrap: {alignItems: 'center', justifyContent: 'center'},

  audioWrap: {alignItems: 'center', paddingHorizontal: 32, gap: 14, maxWidth: 340},
  audioArtwork: {width: 180, height: 180, borderRadius: 20, backgroundColor: 'rgba(167,139,250,0.12)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.28)', alignItems: 'center', justifyContent: 'center', shadowColor: '#A78BFA', shadowOpacity: 0.3, shadowRadius: 24, elevation: 12},
  audioName: {color: '#FFF', fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 10},
  audioProgress: {width: '100%', height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.1)', marginTop: 8, overflow: 'hidden'},
  audioProgressFill: {height: '100%', backgroundColor: '#A78BFA', borderRadius: 2},
  audioMetaRow: {flexDirection: 'row', justifyContent: 'space-between', width: '100%'},
  audioTime: {color: '#B8C7E0', fontSize: 11, fontWeight: '600'},
  audioPlayBtn: {width: 64, height: 64, borderRadius: 32, backgroundColor: '#1E88FF', alignItems: 'center', justifyContent: 'center', marginTop: 10, shadowColor: '#1E88FF', shadowOpacity: 0.45, shadowRadius: 14, elevation: 8},
  audioPlayBtnPressed: {backgroundColor: '#166ED1', shadowOpacity: 0.6, transform: [{scale: 0.94}]},

  externalWrap: {alignItems: 'center', paddingHorizontal: 32, gap: 10, maxWidth: 340},
  externalArt: {width: 180, height: 180, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  externalName: {color: '#FFF', fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 10},
  externalMime: {color: '#7E8AA6', fontSize: 11, fontWeight: '500', marginBottom: 6},
  externalCta: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 99, backgroundColor: '#1E88FF', shadowColor: '#1E88FF', shadowOpacity: 0.4, shadowRadius: 12, elevation: 6},
  externalCtaPressed: {backgroundColor: '#166ED1', transform: [{scale: 0.97}]},
  externalCtaText: {color: '#FFF', fontSize: 13, fontWeight: '800'},

  closeBtn: {position: 'absolute', right: 20, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center'},

  actionBar: {position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, backgroundColor: 'rgba(6,20,43,0.85)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)'},
  action: {alignItems: 'center', gap: 6, minWidth: 70, paddingVertical: 2},
  actionIcon: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  actionText: {color: '#FFF', fontSize: 10, fontWeight: '700', letterSpacing: 0.3},
});
