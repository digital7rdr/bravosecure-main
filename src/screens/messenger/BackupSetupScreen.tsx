/**
 * BackupSetupScreen — dual-mode chat backup screen.
 *
 * Mode is auto-detected on mount via GET /backup/identity/header:
 *
 *   • SETUP mode (no server backup):
 *       Two password inputs (new + confirm). Submit → setupBackup()
 *       wraps + uploads + mirrors existing history.
 *
 *   • UNLOCK mode (server already has a backup row for this user):
 *       Single password input ("Enter your existing backup password").
 *       Submit → restoreBackup() unwraps the identity, then
 *       restoreAllMessages pulls every mirrored row back into the
 *       local store. Same flow that BackupRestoreScreen runs after a
 *       fresh install — but here we don't gate the runtime, because
 *       the user is already inside the app with a working session;
 *       restoring just re-syncs anything they may have missed.
 *
 *   This way the user can enter Settings → Chat Backup at any time
 *   without losing data: if they had a backup, we never overwrite it;
 *   we offer to unlock + pull everything.
 *
 * Reachable from MessengerSettings → Chat Backup, OR via the
 * SUGGEST branch in backupBoot when the user has chats but no backup.
 */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, StatusBar,
  ScrollView, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {MessengerScreenProps} from '@navigation/types';
import LoadingView from '@components/LoadingView';
import {runBackupBiometricGate} from '@/modules/messenger/backup/backupBiometricGate';
import {setupBackup, restoreBackup} from '@/modules/messenger/backup/identityBackup';
import {setMirrorKey, drainMirrorOutbox, resetMirrorForWipe} from '@/modules/messenger/backup/messageMirror';
import {backupNow, startMirrorBootstrap} from '@/modules/messenger/backup/mirrorBootstrap';
import {startBackgroundRestore, stopBackgroundRestore} from '@/modules/messenger/backup/restoreBackground';
import {backupClient, BackupError} from '@/modules/messenger/backup/backupClient';
import {clearRestoreState} from '@/modules/messenger/backup/restoreResume';
import {setBackupEnabled, setBackupSkipped, clearBackupEnabled} from '@/modules/messenger/backup/backupFlags';
import {MIN_BACKUP_PASSWORD_CHARS} from '@/modules/messenger/backup/backupPolicy';
import {humanizeBackupError} from '@/modules/messenger/backup/backupErrorCopy';
import {getOwnCryptoStore} from '@/modules/messenger/runtime/runtime';
import {useAuthStore} from '@store/authStore';
import {useKeyboardOverlap, useRevealOnKeyboard} from '@hooks/useKeyboardLayout';
import {BACKUP_BASE} from './backupPalette';
import {scaleTextStyles} from '@utils/scaling';
import RestoreProgressOverlay, {type RestoreProgressState} from './RestoreProgressOverlay';
import {goBackOnce} from '@navigation/tapGuard';

type Props = MessengerScreenProps<'BackupSetup'>;

/**
 * Finding 11 — lightweight password-strength hint for the CREATE flow.
 * Given "lose it = backup gone forever", a length-only gate accepts
 * '1111111111'. Character-class + length feedback, no external dep.
 * Purely advisory — never blocks submit.
 */
function passwordStrength(pwd: string): {label: string; strong: boolean} {
  let classes = 0;
  if (/[a-z]/.test(pwd)) {classes++;}
  if (/[A-Z]/.test(pwd)) {classes++;}
  if (/[0-9]/.test(pwd)) {classes++;}
  if (/[^A-Za-z0-9]/.test(pwd)) {classes++;}
  if (pwd.length >= 12 && classes >= 3) {return {label: 'Strong', strong: true};}
  if ((pwd.length >= 10 && classes >= 2) || pwd.length >= 14) {return {label: 'Good', strong: true};}
  return {label: 'Weak — mix upper/lower case, numbers & symbols', strong: false};
}

const C = {...BACKUP_BASE, surf1: '#1B3A66', ok: '#00C853'};

// Audit P0-B1 — pulled from the shared policy module so the legal floor
// can be bumped in one place (current floor: 4 chars — founder decision 2026-08-27; was 10, before that 6 — see
// backupPolicy.ts for the OWASP/Signal rationale).
const MIN_PASSWORD = MIN_BACKUP_PASSWORD_CHARS;

type Mode = 'probing' | 'setup' | 'unlock' | 'probe_failed';

export default function BackupSetupScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  // BB-3 (2026-08-15 back audit) — backupBoot's RESUME-LOCKED and SUGGEST
  // lanes cold-mount this screen as the stack's ONLY route (their flagless
  // {screen: 'BackupSetup'} nesting is a listed nestedNavigationInitialFlag
  // exception), where a bare goBack() is a silent no-op: the chevron,
  // "Not now" and Skip were all dead there. Warm mounts keep the B-261
  // double-tap guard. Every leave-without-restore exit funnels through here
  // (the restore-success path stays replace('MessengerHome')).
  const leaveSetup = (): void => {
    try {
      if (navigation.canGoBack()) {
        goBackOnce(navigation);
      } else {
        navigation.replace('MessengerHome');
      }
    } catch { /* already gone */ }
  };
  // BS-BACKUP-PWVIS / B-84 KB-02 — scroll the focused password field into
  // view once the keyboard has ACTUALLY shown. The old fixed 120 ms timer
  // raced the IME animation and often landed on the pre-keyboard layout.
  const keyboardOverlap = useKeyboardOverlap();
  const revealField = useRevealOnKeyboard(scrollRef);
  const ownerUserId = useAuthStore(s => s.user?.id ?? null);
  // Key-storage owner — see BackupRestoreScreen for the full rationale.
  // Must equal the runtime's ownerKey (email ?? phone ?? id) so the
  // mirror key persists under the service the boot path actually reads.
  const ownerKey = useAuthStore(s => s.user?.email ?? s.user?.phone_e164 ?? s.user?.id ?? null);
  const [mode, setMode] = useState<Mode>('probing');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Premium full-screen restore overlay for the UNLOCK path — same
  // component BackupRestoreScreen uses, so re-unlocking a backup looks
  // identical to a fresh-install restore instead of the old inline
  // spinner + system Alert. null = not shown.
  const [overlay, setOverlay] = useState<RestoreProgressState | null>(null);
  // Round 5 UX-fix: show/hide eye toggles per password field. Matches
  // the auth screens' pattern. Critical for users who set numeric
  // passwords (like 232637) — they need to verify what they're
  // actually typing, especially when Android's autofill might've
  // been swapping their input. Each field has its own toggle so the
  // confirm field can stay hidden while the user verifies the new
  // password without leaking the new password to whoever's reading
  // their screen.
  const [showPwd, setShowPwd]         = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Probe the server: does this user already have a backup?
  // If yes → unlock mode (single password, run restore on submit). If no
  // → setup mode (two-password create flow). H-15 — extracted into a
  // retryable callback so a network-class failure surfaces a real Retry
  // button instead of an endless spinner.
  const runProbe = useCallback(async (): Promise<void> => {
    setErr(null);
    setMode('probing');
    try {
      const header = await backupClient.getIdentityHeader();
      if (header.verifierMissing) {
        // P0-1 — legacy backup created before the verify protocol has no
        // verifier key and can never be unlocked. Prompt a one-time
        // re-setup with the backup password.
        console.log('[bravo.backup.setup] legacy backup (no verifier) → re-setup');
        setErr('Your backup needs to be re-secured. Set your backup password again to continue.');
        setMode('setup');
        return;
      }
      console.log('[bravo.backup.setup] server backup exists → unlock mode');
      setMode('unlock');
    } catch (e) {
      if (e instanceof BackupError && e.kind === 'no_backup') {
        console.log('[bravo.backup.setup] no server backup → setup mode');
        setMode('setup');
      } else if (e instanceof BackupError && e.kind === 'service_disabled') {
        setErr('backup_service_disabled');
        setMode('setup');
      } else {
        // Network-class failure — DO NOT default to setup, because
        // re-running setupBackup() would overwrite the existing master
        // key on the server and orphan every previously mirrored message.
        console.warn('[bravo.backup.setup] header probe failed — refusing to default to setup:', (e as Error).message);
        setErr('probe_failed_retry');
        setMode('probe_failed');   // H-15 — render a retry prompt, not an endless spinner
      }
    }
  }, []);

  useEffect(() => { void runProbe(); }, [runProbe]);

  const setupOk  = pwd.length >= MIN_PASSWORD && pwd === confirm;
  // BS-RESTORE-PWLEN — UNLOCK only needs a NON-EMPTY password, not the
  // MIN_PASSWORD minimum. The minimum is a CREATE-time policy (setupOk);
  // enforcing it on unlock wrongly disables the RESTORE button for any
  // existing backup whose password is shorter than the current minimum
  // (e.g. a 9-char password created before MIN went to 10, or any backup
  // made on a looser client). The startup restore screen
  // (BackupRestoreScreen) already gates only on non-empty — this matches
  // it so the two restore entry points agree. Wrong passwords still fail
  // at decryption with a clear error.
  const unlockOk = pwd.length > 0;

  /**
   * Audit P1-B1 — biometric gate (shared helper).
   * Same shape as BackupRestoreScreen.requireBiometricUnlock: hard-fail
   * on cancellation, soft-fail to password-only on devices without
   * hardware / enrolment so first-boot UX still works.
   */
  const requireBiometricUnlock = useCallback(
    () => runBackupBiometricGate('Confirm to change backup'),
    [],
  );

  const handleEnable = async (): Promise<void> => {
    // BKSET-27 — guard the double-submit AND set busy BEFORE the
    // biometric await (same pattern as handleUnlock). Previously busy
    // only flipped after the gate resolved, so a second tap while the
    // biometric dialog was up ran setupBackup twice — the second run
    // mints a fresh master key and the server rotation-wipes the first
    // upload's mirror, permanently orphaning it for restore.
    if (busy || !setupOk) {return;}
    setErr(null);
    const store = getOwnCryptoStore();
    if (!store) { setErr('messenger_not_ready'); return; }
    if (!ownerUserId) { setErr('not_logged_in'); return; }
    setBusy(true);
    // Audit P1-B1 — biometric gate before backup mutates server-side
    // state. Fires before setupBackup so a stolen-device-but-known-
    // password attack can't enrol the attacker's password as the new
    // backup secret without the user's device unlock.
    const bio = await requireBiometricUnlock();
    if (!bio.ok) { setErr('Biometric verification required'); setBusy(false); return; }
    try {
      console.log('[bravo.backup.setup] enabling backup');
      // BUG-6 (audit 2026-07-23) — kill any in-flight/queued flush from a
      // PREVIOUS key before the rotation. setupBackup makes the server
      // wipe the old mirror; an old-key batch landing after that wipe was
      // recorded into the fresh ledger, permanently orphaning those rows
      // (undecryptable under the new master key, skipped by every sweep).
      resetMirrorForWipe();
      // B-94 — a fresh master key rotation-wipes the server mirror, so
      // any previous flush ledger is meaningless; purge it so nothing can
      // short-circuit the full re-upload below.
      //
      // B-6 F1 (2026-08-15) — the purge moved BEFORE the server call.
      // With it after, a rotation whose HTTP response was LOST (server
      // committed, client saw failure) left the ledger intact over a
      // wiped server mirror: the next RESUME-AUTO boot hydrated dedup
      // from that ledger and skipped every row — a silently EMPTY backup
      // behind a valid identity row (the I5 shape). BACKUP_LOOP I8 names
      // the rule: a purged ledger degrades to RE-UPLOAD; a stale one
      // degrades to SKIP. Purge-first is safe in both directions — the
      // mirror is already dead from resetMirrorForWipe() so nothing
      // repopulates the ledger mid-setup, success re-uploads everything
      // below anyway, and on failure the boot sweep re-uploads under the
      // still-valid old key (I2's pending flag covers the re-commit).
      try {
        const {clearFlushedForOwner} = require('@/modules/messenger/backup/mirrorLedger') as
          typeof import('@/modules/messenger/backup/mirrorLedger');
        await clearFlushedForOwner(ownerUserId);
      } catch (e) {
        console.warn('[bravo.backup.setup] ledger purge failed:', (e as Error).message);
      }
      const {masterKey, rawB64} = await setupBackup(store, pwd, ownerUserId ?? undefined);
      setMirrorKey(masterKey);
      // Persist the raw key in the OS keychain so the next cold start
      // can resume the mirror without prompting for the password.
      try {
        const {saveMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
          typeof import('@/modules/messenger/runtime/keychain');
        await saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64);
      } catch (e) {
        console.warn('[bravo.backup.setup] saveMirrorMasterKey failed:', (e as Error).message);
      }
      // Wire the store subscription so messages sent AFTER setup also
      // flow into the backup mirror. Without this, only the one-shot
      // backupNow() below mirrored the historical state — every chat
      // sent post-setup landed in the local store but never reached
      // the server, so the next restore would return 0 messages even
      // though the user could see the messages on screen. Mirrors the
      // same call in BackupRestoreScreen.handleUnlock so both setup
      // and unlock paths leave the mirror in the same live state.
      startMirrorBootstrap();
      // Round 5: backupNow is now async — pages SQLCipher to bypass
      // the 200/convo in-memory cap. Await so the success Alert shows
      // counts after the bulk-walk has actually enqueued every row.
      const counts = await backupNow(ownerUserId);
      // B-45 R3 — backupNow only ENQUEUES into the debounced mirror
      // queue. Drain it BEFORE the baseline commit below, otherwise the
      // commit walks the server mid-upload and signs a near-empty set
      // (live evidence: committed=3 vs server=14) — and every later
      // restore hard-fails the integrity gate as rows_count_mismatch.
      try {
        await drainMirrorOutbox();
      } catch (e) {
        console.warn('[bravo.backup.setup] outbox drain failed:', (e as Error).message);
      }
      // P3-B-2 — owner-scoped via backupFlags (legacy key also written).
      await setBackupEnabled(ownerKey ?? ownerUserId);
      // Round 5 / Security S8 — kick the first Merkle commit so the
      // user has a signed baseline immediately. Subsequent flushes
      // refresh it via the debounced hook installed in
      // mirrorBootstrap.start. Best-effort: a network blip here just
      // means the next mirror flush will commit instead.
      try {

        const {commitMerkleRoot} = require('@/modules/messenger/backup/merkleCommit') as
          typeof import('@/modules/messenger/backup/merkleCommit');
        const ident = await store.getIdentityKeyPair();
        await commitMerkleRoot({identityPrivKey: ident.privKey, userId: ownerUserId});
      } catch (e) {
        console.warn('[bravo.backup.setup] initial merkle commit failed:', (e as Error).message);
      }
      Alert.alert(
        'Backup enabled',
        `Chat backup is on. ${counts.messages} messages and ${counts.conversations} conversations are being uploaded in the background.\n\nKeep your backup password safe — without it, your chats can't be restored on a new device.`,
        [{text: 'OK', onPress: () => leaveSetup()}],
      );
    } catch (e) {
      console.warn('[bravo.backup.setup] setup failed:', (e as Error).message);
      setErr(`setup_failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (): Promise<void> => {
    // Finding 7 — guard against a double-submit (button stays live while
    // the biometric dialog is up).
    if (busy || !unlockOk) {return;}
    setErr(null);
    const store = getOwnCryptoStore();
    if (!store) { setErr('messenger_not_ready'); return; }
    if (!ownerUserId) { setErr('not_logged_in'); return; }
    // Finding 7 — set busy BEFORE the biometric prompt so a second tap
    // can't start a concurrent unlock racing on the master key.
    setBusy(true);
    // Audit P1-B1 — biometric gate before the unwrap actually restores
    // identity material on top of the existing session.
    const bio = await requireBiometricUnlock();
    if (!bio.ok) { setErr('Biometric verification required'); setBusy(false); return; }
    try {
      console.log('[bravo.backup.setup] unlocking + restoring');
      setOverlay({kind: 'progress', step: 'Verifying password…'});
      const {masterKey, identity, rawB64} = await restoreBackup(store, pwd);
      // CRITICAL — when the backup was created by a different device
      // (or after a key rotation), `restoreBackup → reinstallIdentity`
      // just OVERWROTE the local identity-priv with a different one.
      // Meanwhile the runtime booted seconds earlier (RESUME-LOCKED
      // path in backupBoot.ts:154) and published the
      // pre-restore identity-pub to auth-service's signal-keys bundle.
      // Without re-publishing now, every peer fetches the stale bundle,
      // derives shared secrets against the wrong identity, and every
      // envelope they send us trips outer-sealed-authentication-failed
      // → `[bravo.drainRelay] reconnect drain failed: sender identity
      // key mismatch` on the wire. Mirror the RESTORE path's behaviour:
      // re-upload the bundle so server-bundle and local-priv line up.
      try {
        const {publishOwnBundleAfterRestore} =
          require('@/modules/messenger/runtime/productionRuntime') as
          typeof import('@/modules/messenger/runtime/productionRuntime');
        await publishOwnBundleAfterRestore();
        console.log('[bravo.backup.setup] re-published bundle after identity restore');
      } catch (e) {
        // Non-fatal — but every peer is now stuck on stale-bundle until
        // the next successful publish. Surface loudly in logs so an
        // operator can correlate "user X can't receive messages" with
        // a failed publish on this device.
        console.warn('[bravo.backup.setup] publishOwnBundleAfterRestore failed — peers will see stale bundle until next publish:', (e as Error).message);
      }
      // H-13 — rebuild the runtime against the restored identity, exactly
      // like the fresh-install restore path. restoreBackup just overwrote
      // the local identity, but the live runtime (SessionManager /
      // SenderCertCache / cached own pubkey) is still keyed off the
      // pre-restore identity, so any send issues certs bound to the wrong
      // key → the receiver's verifySenderCert fails. Previously the only
      // fix on this path was force-closing the app.
      try {
        const {disposeLiveRuntime} = require('@/modules/messenger/runtime/productionRuntime') as
          typeof import('@/modules/messenger/runtime/productionRuntime');
        const {_resetMessengerRuntimeKeepConfig, getMessengerRuntime} =
          require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
        setOverlay({kind: 'progress', step: 'Finalising secure session…'});
        disposeLiveRuntime();
        _resetMessengerRuntimeKeepConfig();
        await getMessengerRuntime('production');
      } catch (e) {
        console.warn('[bravo.backup.setup] runtime rebuild failed:', (e as Error).message);
      }
      // BUG-5 (audit 2026-07-23) — setMirrorKey is intentionally NOT
      // called here any more. On this path the catch-up sweep IS wired
      // (RESUME-LOCKED started the bootstrap at boot), so flipping the
      // key live used to fire the sweep concurrently with the restore
      // walk: sweep uploads + commits landing mid-walk made the verifier
      // hard-fail (`rows_count_mismatch` / `root_mismatch`) on a healthy
      // account. The background runner enables the mirror AFTER the walk
      // completes, which auto-fires the same ledger-seeded sweep safely.
      try {
        const {saveMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
          typeof import('@/modules/messenger/runtime/keychain');
        await saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64);
      } catch (e) {
        console.warn('[bravo.backup.setup] saveMirrorMasterKey failed:', (e as Error).message);
      }
      // BR-1 — hand the message walk to the background runner (same
      // hand-off as BackupRestoreScreen): fixes the silent-truncation
      // (`counts.incomplete` ignored → success overlay over a partial
      // restore), the missing I7 ledger seed (now done inside the walk),
      // and frees the user from the overlay while history streams in.
      //
      // H-13 / F7 / F10 — the identity keys still gate the walk with the
      // Security-S8 Merkle verify, exactly as before.
      const idPubBytes = Buffer.from(identity.identityKey.pub, 'base64');
      const idPubAb = idPubBytes.buffer.slice(idPubBytes.byteOffset, idPubBytes.byteOffset + idPubBytes.byteLength);
      const idPrivBytes = Buffer.from(identity.identityKey.priv, 'base64');
      const idPrivAb = idPrivBytes.buffer.slice(idPrivBytes.byteOffset, idPrivBytes.byteOffset + idPrivBytes.byteLength);
      try {
        const {markRestoreIncomplete} = require('@/modules/messenger/backup/restoreResume') as
          typeof import('@/modules/messenger/backup/restoreResume');
        await markRestoreIncomplete(ownerUserId);
      } catch { /* belt-and-braces marker — never block the restore */ }
      startBackgroundRestore({
        masterKey,
        ownerUserId,
        ownerKey,
        identityPubKey:  idPubAb as ArrayBuffer,
        identityPrivKey: idPrivAb as ArrayBuffer,
      });
      navigation.replace('MessengerHome');
    } catch (e) {
      let msg: string;
      if (e instanceof BackupError) {
        if (e.kind === 'unauthorized') {
          msg = 'Wrong password';
        } else if (e.kind === 'locked') {
          msg = 'Too many wrong attempts. Try again in an hour.';
        } else {
          // BKRES-27 — humanize the wrapped kind now so a known code
          // (e.g. nonce_expired) keeps its dedicated copy in BOTH the
          // inline error and the overlay, instead of collapsing into
          // the generic 'Restore failed' prefix match.
          msg = humanizeBackupError(`Restore failed: ${e.kind}`);
        }
      } else {
        msg = `Restore failed: ${(e as Error).message}`;
      }
      // Wrong-password / locked / expired-verify are inline-correctable
      // on the unlock form (overlay would trap the user); other failures
      // own the full-screen error state. BUG-K — verify_required means
      // the password was CORRECT (token expired); it must not render as
      // "Wrong password".
      const inlineRecoverable = e instanceof BackupError &&
        (e.kind === 'unauthorized' || e.kind === 'locked' || e.kind === 'verify_required');
      if (inlineRecoverable) {
        setErr(msg);
        setOverlay(null);
      } else {
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
      }
      console.warn('[bravo.backup.setup] unlock failed:', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = async (): Promise<void> => {
    // Finding 20a — don't let a storage failure become an unhandled
    // rejection (the caller invokes this as `void handleSkip()`); still
    // navigate back either way. P3-B-2 — owner-scoped via backupFlags.
    await setBackupSkipped((ownerKey ?? ownerUserId ?? '') as string);
    leaveSetup();
  };

  const handleForgot = (): void => {
    Alert.alert(
      'Backup permanently lost?',
      'Without your password we cannot decrypt your backup. Continuing wipes the encrypted backup from our servers and lets you set a new one — your old messages cannot be recovered.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Wipe & Start Fresh', style: 'destructive', onPress: () => {
          void (async () => {
            try {
              await backupClient.forget();
              // BUG-6/B-3 (audit 2026-07-23) — tear the LIVE mirror down
              // too: the in-memory master key kept encrypting + flushing
              // rows into a server mirror that no longer has a wrapped
              // key to restore them (permanent orphans). Also stop any
              // background restore still walking the now-wiped mirror.
              stopBackgroundRestore();
              resetMirrorForWipe();
              // BKSET-24 / M-17 — mirror BackupRestoreScreen's wipe: clear
              // ALL local backup/restore state. A stale backup:enabled flag
              // suppresses the future SUGGEST branch, and a stale keychain
              // mirror key encrypts post-re-setup rows under the WIPED
              // master key — permanent restore orphans.
              try {
                if (ownerUserId) { await clearRestoreState(ownerUserId); }
                // P3-B-2 — clears the owner-scoped AND legacy enabled flags.
                await clearBackupEnabled((ownerKey ?? ownerUserId ?? '') as string);
                const {clearMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
                  typeof import('@/modules/messenger/runtime/keychain');
                if (ownerKey ?? ownerUserId) { await clearMirrorMasterKey((ownerKey ?? ownerUserId) as string); }
                // B-94 — the server mirror is gone; a stale flush ledger
                // would make a future sweep skip rows the server no longer
                // holds (silent restore data loss). Purge it with the rest.
                const {clearFlushedForOwner} = require('@/modules/messenger/backup/mirrorLedger') as
                  typeof import('@/modules/messenger/backup/mirrorLedger');
                if (ownerUserId) { await clearFlushedForOwner(ownerUserId); }
              } catch (e) {
                console.warn('[bravo.backup.setup] forget local-state cleanup failed:', (e as Error).message);
              }
              setMode('setup');
              setPwd('');
              setConfirm('');
              setErr(null);
              Alert.alert('Backup wiped', 'Set a new password below to enable backup again.');
            } catch (e) {
              Alert.alert('Could not wipe backup', (e as Error).message);
            }
          })();
        }},
      ],
    );
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={s.topBar}>
        <TouchableOpacity style={s.iconBtn} onPress={() => leaveSetup()} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={C.tx1} />
        </TouchableOpacity>
        <Text style={s.title}>CHAT BACKUP</Text>
        <View style={{width: 38}} />
      </View>

      {/* BS-BACKUP-PWVIS / B-84 / B-184 — the password field must stay
          visible while the user types it. One rule on both platforms: shrink
          this box by the true IME overlap; useRevealOnKeyboard then scrolls
          the field up once the keyboard has actually settled. */}
      <View style={{flex: 1, paddingBottom: keyboardOverlap}}>
        <ScrollView
          ref={scrollRef}
          // The wrapper above lifts by the IME overlap; the resting bottom
          // inset is still owed here, or the last control in a scrolled form
          // ends under the gesture pill / home indicator.
          contentContainerStyle={[s.body, {paddingBottom: insets.bottom + 24}]}
          keyboardShouldPersistTaps="handled">
          {mode === 'probing' ? (
            <View style={s.probingWrap}>
              <LoadingView compact label="Checking backup status…" />
            </View>
          ) : mode === 'probe_failed' ? (
            // H-15 — network-class probe failure: show the reason + a
            // Retry so the user isn't stuck on a permanent spinner. We
            // deliberately do NOT fall through to setup mode (that would
            // risk overwriting an existing backup's master key).
            <View style={s.probingWrap}>
              <Icon name="cloud-off-outline" size={48} color={C.warn} />
              <Text style={[s.probingTxt, {marginTop: 12}]}>
                Couldn&apos;t reach the backup service. Check your connection and try again.
              </Text>
              <TouchableOpacity
                style={[s.primaryBtn, {marginTop: 20, alignSelf: 'stretch'}]}
                onPress={() => { void runProbe(); }}
                accessibilityRole="button"
                accessibilityLabel="Retry checking backup status"
                activeOpacity={0.85}>
                <Text style={s.primaryBtnTxt}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : mode === 'unlock' ? (
            // ─── UNLOCK MODE ───────────────────────────────────────
            <>
              <View style={s.heroIconWrap}>
                <Icon name="lock-open-outline" size={56} color={C.act} />
              </View>
              <Text style={s.h1}>Unlock your backup</Text>
              <Text style={s.p}>
                You already have an encrypted backup on this account.
                Enter your existing password to restore your chats.
              </Text>

              <View style={s.bullet}>
                <Icon name="cloud-download-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>We'll pull every message + conversation back into this device.</Text>
              </View>
              <View style={s.bullet}>
                <Icon name="lock-check-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>5 wrong attempts triggers a 1-hour cool-down (server-enforced).</Text>
              </View>

              <Text style={s.label}>BACKUP PASSWORD</Text>
              <View style={s.pwdRow}>
                <TextInput
                  style={[s.input, s.pwdInput]}
                  value={pwd}
                  onChangeText={setPwd}
                  placeholder="Enter your existing password"
                  placeholderTextColor={C.tx3}
                  secureTextEntry={!showPwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  importantForAutofill="no"
                  editable={!busy}
                  onFocus={revealField}
                  onSubmitEditing={() => { void handleUnlock(); }}
                  returnKeyType="go"
                />
                <TouchableOpacity
                  style={s.eyeBtn}
                  onPress={() => setShowPwd(v => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                  activeOpacity={0.7}>
                  <Icon name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>

              {err && <Text style={s.err} accessibilityLiveRegion="polite">{humanizeBackupError(err)}</Text>}
              <TouchableOpacity
                style={[s.primaryBtn, (!unlockOk || busy) && s.primaryBtnDisabled]}
                disabled={!unlockOk || busy}
                onPress={() => { void handleUnlock(); }}
                activeOpacity={0.85}>
                {busy
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={s.primaryBtnTxt}>UNLOCK + RESTORE</Text>}
              </TouchableOpacity>

              <TouchableOpacity style={s.skipBtn} onPress={handleForgot} activeOpacity={0.7}>
                <Text style={[s.skipBtnTxt, {color: C.err}]}>Forgot password — wipe + start fresh</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.skipBtn} onPress={() => leaveSetup()} activeOpacity={0.7}>
                <Text style={s.skipBtnTxt}>Not now</Text>
              </TouchableOpacity>
            </>
          ) : (
            // ─── SETUP MODE ────────────────────────────────────────
            <>
              <View style={s.heroIconWrap}>
                <Icon name="shield-key-outline" size={56} color={C.act} />
              </View>
              <Text style={s.h1}>End-to-end encrypted backup</Text>
              <Text style={s.p}>
                Your messages get backed up in encrypted form so you can restore them
                on a new device. We never see your password or your messages.
              </Text>

              <View style={s.bullet}>
                <Icon name="lock-check-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>argon2id key derivation — same family as WhatsApp & Signal</Text>
              </View>
              <View style={s.bullet}>
                <Icon name="account-key-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>Your password unlocks the backup. Lose it = backup gone forever.</Text>
              </View>
              <View style={s.bullet}>
                <Icon name="cloud-upload-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>Existing chats get backed up the moment you turn this on.</Text>
              </View>

              <Text style={s.label}>BACKUP PASSWORD</Text>
              <View style={s.pwdRow}>
                <TextInput
                  style={[s.input, s.pwdInput]}
                  value={pwd}
                  onChangeText={setPwd}
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  placeholderTextColor={C.tx3}
                  secureTextEntry={!showPwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  // CRITICAL UX-fix (Round 5): explicitly DISABLE autofill.
                  // Without these, Android's Google Password Manager
                  // treats secureTextEntry as a credential field and
                  // silently substitutes the user's saved account
                  // password for what they actually typed. Both setup
                  // AND confirm fields get the same autofilled value,
                  // so the pwd === confirm match check still passes —
                  // the user sets up backup believing the password is
                  // one thing, but the bundle is wrapped under their
                  // account password instead.
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  importantForAutofill="no"
                  editable={!busy}
                  onFocus={revealField}
                />
                <TouchableOpacity
                  style={s.eyeBtn}
                  onPress={() => setShowPwd(v => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                  activeOpacity={0.7}>
                  <Icon name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>

              <Text style={s.label}>CONFIRM PASSWORD</Text>
              <View style={s.pwdRow}>
                <TextInput
                  style={[s.input, s.pwdInput]}
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="Re-enter to confirm"
                  placeholderTextColor={C.tx3}
                  secureTextEntry={!showConfirm}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  importantForAutofill="no"
                  editable={!busy}
                  onFocus={revealField}
                />
                <TouchableOpacity
                  style={s.eyeBtn}
                  onPress={() => setShowConfirm(v => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showConfirm ? 'Hide confirmation password' : 'Show confirmation password'}
                  activeOpacity={0.7}>
                  <Icon name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>

              {pwd.length > 0 && pwd.length < MIN_PASSWORD && (
                <Text style={s.warn}>Password too short — need at least {MIN_PASSWORD} characters.</Text>
              )}
              {pwd.length >= MIN_PASSWORD && (
                <Text style={[s.warn, {color: passwordStrength(pwd).strong ? C.act : C.warn}]}>
                  Strength: {passwordStrength(pwd).label}
                </Text>
              )}
              {pwd.length > 0 && confirm.length > 0 && pwd !== confirm && (
                <Text style={s.warn}>Passwords don't match.</Text>
              )}
              {err && <Text style={s.err} accessibilityLiveRegion="polite">{humanizeBackupError(err)}</Text>}

              <TouchableOpacity
                testID="enable-backup-btn"
                style={[s.primaryBtn, (!setupOk || busy) && s.primaryBtnDisabled]}
                disabled={!setupOk || busy}
                onPress={() => { void handleEnable(); }}
                activeOpacity={0.85}>
                {busy
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={s.primaryBtnTxt}>ENABLE BACKUP</Text>}
              </TouchableOpacity>

              <TouchableOpacity style={s.skipBtn} onPress={() => { void handleSkip(); }} activeOpacity={0.7}>
                <Text style={s.skipBtnTxt}>Not now</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>

      {/* Full-screen overlay during/after an unlock-restore. While
          `kind:'progress'` it masks the form; on success it owns the
          hand-off back to the previous screen. */}
      {overlay && (
        <RestoreProgressOverlay
          state={overlay}
          onContinue={() => { setOverlay(null); leaveSetup(); }}
          onClose={() => setOverlay(null)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: C.bg},
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {color: C.tx1, fontSize: 13, fontWeight: '700', letterSpacing: 1.4},
  body: {padding: 20, gap: 14},
  probingWrap: {alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 14},
  probingTxt:  {color: C.tx2, fontSize: 13, fontWeight: '600'},
  heroIconWrap: {alignItems: 'center', paddingVertical: 14},
  h1: {color: C.tx1, fontSize: 18, fontWeight: '800', textAlign: 'center'},
  p:  {color: C.tx2, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 8},
  bullet: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2,
    borderRadius: 10, padding: 12,
  },
  bulletTxt: {color: C.tx2, fontSize: 12, lineHeight: 17, flex: 1},
  label: {color: C.tx3, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: 14},
  input: {
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: C.tx1, fontSize: 14,
  },
  // Round 5 UX: row container so the eye-toggle sits inline with the
  // input, not as an absolute overlay (touch target stays predictable).
  pwdRow: {position: 'relative'},
  pwdInput: {paddingRight: 44},
  eyeBtn: {
    position: 'absolute', right: 4, top: 0, bottom: 0,
    width: 40, alignItems: 'center', justifyContent: 'center',
  },
  warn: {color: C.warn, fontSize: 12, marginTop: -6},
  err:  {color: C.err,  fontSize: 12, marginTop: -6},
  primaryBtn: {
    marginTop: 18, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', backgroundColor: C.act,
  },
  primaryBtnDisabled: {opacity: 0.4},
  primaryBtnTxt: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 1},
  skipBtn: {paddingVertical: 12, alignItems: 'center'},
  skipBtnTxt: {color: C.tx3, fontSize: 13, fontWeight: '600'},
}));
