import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  AppState,
  InteractionManager,
  Platform,
  type AppStateStatus,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useVaultStore} from '@/modules/messenger/vault';
import LoadingView, {BravoShieldBadge} from '@components/LoadingView';

/**
 * `stalled` is 'failed' for every rendering purpose — it exists so the copy can
 * be honest. "Authentication cancelled or failed" is a lie when nothing ever
 * answered, and this gate's whole failure mode is that the user cannot tell the
 * difference between "thinking" and "wedged".
 */
type Status = 'checking' | 'prompting' | 'authed' | 'failed' | 'stalled' | 'unsupported';

// Opt-in flag set by Settings → Biometric Lock (ProfileScreen). The gate only
// engages when this is '1'; it is OFF by default.
const LOCK_KEY = 'settings:biometricLock';
/**
 * FIX-12 (B-438 residual) — the last value of LOCK_KEY we managed to READ.
 *
 * `getItem(...).catch(() => null)` conflated "storage errored" with "flag not
 * set", so ONE transient read failure silently disabled the app lock for that
 * whole boot — the security control simply wasn't there, and nothing said so.
 * This mirror gives the error path a local truth to fail CLOSED against.
 */
const LOCK_MIRROR_KEY = 'settings:biometricLock:lastKnown';

/**
 * FIX-12 — the ONE way to answer "is the lock on?".
 *
 * "not set" and "could not be read" are different answers and used to produce
 * the same one (lock off). One retry first (Android storage errors here are
 * almost always transient); on a genuine read failure fall back to the mirror
 * of the last value we successfully read and fail CLOSED if it says the lock
 * was on. With no evidence it was ever enabled, stay open — Biometric Lock is
 * opt-in, and failing closed for someone who never turned it on is an outage.
 *
 * Module-scoped and shared by BOTH the boot read and the AppState-resume
 * re-lock. The audit found the first cut fixed only the boot read while the
 * resume path kept the old `getItem().catch(() => null)` — which not only
 * failed open but OVERWROTE the correct in-memory state for the rest of the
 * session. The resume path is the more frequently exercised of the two.
 */
async function resolveLockFlag(): Promise<boolean> {
  let raw: string | null = null;
  let unreadable = false;
  try {
    raw = await AsyncStorage.getItem(LOCK_KEY);
  } catch {
    try { raw = await AsyncStorage.getItem(LOCK_KEY); }
    catch { unreadable = true; }
  }
  if (!unreadable) {
    const on = raw === '1';
    // Mirror it so a future unreadable read has something to fail closed on.
    // Wrapped, not just `.catch`ed: a partial storage shim can make setItem
    // undefined, and that throws synchronously — the gate must not care.
    try {
      AsyncStorage.setItem(LOCK_MIRROR_KEY, on ? '1' : '0')?.catch(() => { /* best-effort */ });
    } catch { /* storage shim without setItem */ }
    return on;
  }
  let mirror: string | null = null;
  try { mirror = await AsyncStorage.getItem(LOCK_MIRROR_KEY); } catch { /* storage fully down */ }
  if (mirror === '1') {
    console.warn('[biogate] lock flag unreadable — failing CLOSED on last known value');
    return true;
  }
  return false;
}

// BS-LOCK — how long the app can be backgrounded before we force a
// re-lock on return. Short app-switches (checking a code in another app,
// an OS permission dialog, bouncing between dashboards) fall under this
// window and DON'T re-prompt; a real exit / long background does.
const LOCK_GRACE_MS = 30_000;

/**
 * How long the gate may sit on an unanswered native prompt before it gives the
 * user a way out.
 *
 * ── THE BUG THIS EXISTS FOR ("freeze at Verifying ID") ────────────────────
 *
 * `authenticateAsync` had no bound at all. If the native prompt never resolved,
 * `status` stayed 'prompting' forever — and the retry button renders ONLY on
 * 'failed', so there was no affordance of any kind. Worse, the re-entrancy
 * guard made the foreground-relock path a silent no-op while that call was
 * wedged: it set 'checking', `authenticate()` returned immediately, and the
 * gate parked on a spinner that nothing could ever move. On a cold boot from an
 * incoming-call notification this silently eats the call while the 45s ring TTL
 * burns, which is why it has been reported as a CALL symptom.
 *
 * ── WHY 8s, AND WHY NOT 20 ────────────────────────────────────────────────
 *
 * The false-positive cost is essentially NIL: reporting stalled does not
 * dismiss a live prompt, does not bypass the gate, and a late success is still
 * honoured — behind a real system sheet the user sees nothing change.
 *
 * The false-NEGATIVE cost is a burnt call, and it has a HARD DEADLINE. Every
 * call tap lane waits exactly 20 000ms for `navigationRef.isReady()` and then
 * abandons the route ("nav not ready after 20s — abandoning"), and the nav ref
 * cannot become ready while this gate is up, because `RootNavigator` is its
 * CHILD. So a 20s watchdog hands the user their retry button at the very
 * instant the call route gives up — a race nobody can win. 8s leaves ~12s to
 * press UNLOCK and authenticate before that deadline.
 *
 * It also stays well under Android's ~30s BiometricPrompt timeout, so a
 * genuinely live prompt still gets to answer for itself and resolve normally.
 *
 * ⚠️ NOT A WALL-CLOCK BOUND ON ANDROID. `JavaTimerManager` stops the JS timer
 * queue while the activity is paused, so any prompt that backgrounds the app
 * (the device-credential fallback, an FSI over the top, some OEM face-unlock
 * UIs) freezes this countdown and the escape appears on resume instead.
 *
 * (Weakening a biometric gate needs architecture approval; a timeout-to-retry
 * weakens nothing — it only offers the retry button that already existed.)
 */
const PROMPT_WATCHDOG_MS = 8_000;

/**
 * The OTHER way this gate hangs, which the prompt watchdog cannot see.
 *
 * Two awaits happen before `authenticate()` is ever called: the opt-in flag
 * read, and `runAfterInteractions`. If the flag read never settles,
 * `lockEnabled` stays null and the gate renders a full-screen spinner with NO
 * LABEL and no button — a more silent wedge than the original. If the
 * interaction queue never flushes (RN blocks it on any `useNativeDriver:false`
 * animation), status parks on 'checking', which is literally "Verifying
 * identity…" with no retry: the reported symptom, with no watchdog behind it.
 *
 * So the boot path gets its own deadline. It FAILS CLOSED — an unreadable flag
 * engages the lock rather than skipping it — and the user still gets the retry
 * button, so this cannot lock anybody out: retry re-reads the flag, and a
 * device with no enrolment still falls through to 'unsupported'.
 */
const BOOT_WATCHDOG_MS = 6_000;

interface Props {
  children: React.ReactNode;
}

/**
 * Gates the app behind device biometrics (fingerprint / face) with a
 * PIN/pattern fallback via `disableDeviceFallback: false`. The gate re-locks
 * when the app returns to foreground.
 */
export default function BiometricGate({children}: Props) {
  const [status, setStatus] = useState<Status>('checking');
  // Tracks whether the user has EVER successfully unlocked in this session.
  // After the first unlock we keep `children` mounted and only overlay the
  // lock UI on re-lock, so the navigation tree (and its state) survives
  // every AppState background↔active cycle.
  const [everUnlocked, setEverUnlocked] = useState(false);
  // null = still reading the opt-in flag, false = lock off (no gate), true = on.
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  // The opt-in flag read itself never came back — render the retry instead of a
  // labelless spinner, and keep children unmounted while we cannot tell.
  const [bootStalled, setBootStalled] = useState(false);
  // Guard: prevents concurrent authenticate() calls (AppState 'active' fires
  // on Android launch, racing with the mount effect; biometric dialog going
  // bg→active would also trigger a second call while the first is pending).
  const authenticating = useRef(false);
  // The outstanding prompt went past the watchdog and was reported stalled. A
  // user-initiated retry may then SUPERSEDE it; a stray AppState fire may not.
  const stalled = useRef(false);
  /**
   * Two refs, not one, and the distinction matters.
   *
   * `nextRun` only ever counts UP, so every attempt has a unique id for its own
   * lifetime. `ownerRun` says which attempt currently owns the UI — a superseded
   * run must not write status or release the guard when it finally settles.
   *
   * They are separate because a LATE SUCCESS takes ownership BACK (the user did
   * authenticate; the prompt that superseded it must not then re-lock them by
   * being cancelled). Reusing one counter for that would let a later attempt be
   * issued an id that collides with the run it superseded.
   */
  const nextRun = useRef(0);
  const ownerRun = useRef(0);
  // Wall-clock when the app last went to background — drives the grace
  // window so a quick switch-and-return doesn't re-lock. Null = foreground.
  const backgroundedAt = useRef<number | null>(null);

  const authenticate = useCallback(async () => {
    if (authenticating.current && !stalled.current) {
      /**
       * A genuine concurrent fire (AppState 'active' racing the mount effect,
       * or the prompt itself bouncing the app bg→active). Do NOT open a second
       * native prompt.
       *
       * The status write is for HONESTY, not for the fix: 'checking' and
       * 'prompting' render identically today, so nothing observable depends on
       * it. What actually rescues the caller is that the OWNING run's watchdog
       * is provably still pending here — `stalled.current` false means it has
       * not fired — so the relock path can no longer park on a spinner nothing
       * will move.
       */
      setStatus('prompting');
      return;
    }
    /**
     * Something asked for a prompt over one we already reported as stalled — a
     * pressed UNLOCK, or a foreground relock. Either is evidence enough to
     * replace it.
     *
     * ⚠️ NOT "a relock cannot land inside the watchdog window". The relock arm
     * also runs with `backgroundedAt` null (`awayMs === 0` falls through the
     * grace check — the Android-launch race), so this CAN fire over a live
     * prompt the user was about to answer. That costs them one re-prompt; the
     * alternative — refusing to supersede — costs a permanently dead gate.
     */
    const superseding = authenticating.current && stalled.current;

    const id = ++nextRun.current;
    ownerRun.current = id;
    authenticating.current = true;
    stalled.current = false;
    setStatus('prompting');
    // Release-visible on purpose: this file logged NOTHING on any path, which
    // is precisely why the freeze was invisible in every device log so far.
    // `transform-remove-console` strips `log` and keeps `warn`.
    console.warn(`[biogate] prompt open run=${id}${superseding ? ' (superseding)' : ''}`);
    /**
     * ARMED BEFORE THE FIRST AWAIT, and that ordering is the whole point.
     *
     * The first draft of this fix awaited `cancelAuthenticate()` up in the
     * supersede branch — i.e. before any watchdog existed. That call is
     * dispatched to the Android MAIN queue, and a blocked main thread is
     * exactly the condition that produces a wedged prompt in the first place:
     * it could hang with status 'checking', no button and no live timer, which
     * is the bug this file exists to remove, re-created by its own fix.
     * NOTHING may await above this line.
     */
    const watchdog = setTimeout(() => {
      if (ownerRun.current !== id) {return;}
      stalled.current = true;
      console.warn(`[biogate] STALLED run=${id} — no answer in ${PROMPT_WATCHDOG_MS}ms, offering retry`);
      setStatus('stalled');
    }, PROMPT_WATCHDOG_MS);
    try {
      /**
       * Clear any outstanding native prompt FIRST, always, on Android.
       *
       * `LocalAuthenticationModule` keeps one `isAuthenticating` flag and one
       * promise: a second `authenticateAsync` over a live one resolves the OLD
       * promise with `app_cancel` and re-points at the new caller WITHOUT
       * showing a prompt. So a plain retry after a native wedge showed the user
       * another blank 20 seconds. Cancelling first is a no-op when nothing is
       * outstanding, and it is now inside the watchdog's protection.
       */
      if (Platform.OS === 'android') {
        try { await LocalAuthentication.cancelAuthenticate(); } catch { /* nothing to cancel */ }
        /**
         * Let the cancel LAND before opening the next prompt.
         *
         * `cancelAuthenticate` returns as soon as its main-queue block runs; it
         * does not resolve the outstanding promise — `onAuthenticationError`
         * does that later, on a background executor. The module keeps ONE
         * `promise` field, so re-prompting immediately races that callback into
         * resolving the NEW promise with `user_cancel`: the user gets a
         * fingerprint dialog with "cancelled or failed" already behind it, and
         * authenticating on it does nothing. A short settle costs nothing and
         * is inside the watchdog above.
         */
        await new Promise(r => setTimeout(r, 250));
        // Ownership can have moved during either await — e.g. a late success
        // from the run we just cancelled took it back. Do not prompt over it.
        if (ownerRun.current !== id) {return;}
      }
      /**
       * ⚠️ `getEnrolledLevelAsync`, NOT `hasHardwareAsync` + `isEnrolledAsync`.
       *
       * THE FAIL-OPEN THIS REPLACES: on Android `isEnrolledAsync()` is
       * `canAuthenticate(BIOMETRIC_WEAK) == BIOMETRIC_SUCCESS`, so after five
       * failed fingerprint attempts — a LOCKOUT — it returns false. The old
       * predicate read that as "this device has no biometrics" and took the
       * `unsupported` arm, which sets `everUnlocked` and opens the app WITH NO
       * AUTHENTICATION AT ALL. Fail 5×, force-stop, relaunch, and you were in.
       * Same for `HW_UNAVAILABLE`, `SECURITY_UPDATE_REQUIRED`, and for a user
       * who removed their enrolment while the app was running. iOS already
       * guards this (`biometryLockout` counts as enrolled); Android did not.
       *
       * The honest question is "does this device hold ANY secret", and that is
       * exactly what the enrolled LEVEL answers. `disableDeviceFallback:false`
       * means a SECRET-only device (PIN/pattern, no biometric hardware) still
       * gets a working prompt — so dropping the hardware check tightens the
       * gate without locking anybody out. Only a device with nothing enrolled
       * at all falls through, which is the case the arm exists for.
       */
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (ownerRun.current !== id) {return;}
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        // Genuinely nothing to authenticate against — let the user in rather
        // than brick an unconfigured device.
        console.warn(`[biogate] unsupported device level=${String(level)}`);
        setStatus('unsupported');
        setEverUnlocked(true);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Bravo Secure',
        fallbackLabel: 'Use device PIN',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (ownerRun.current !== id) {
        // A newer run owns the UI. A late FAILURE is just noise — drop it.
        if (!result.success) {return;}
        /**
         * A late SUCCESS still unlocks: the user did authenticate, and refusing
         * it would re-prompt somebody who has just proved who they are. Taking
         * ownership back is the point — otherwise the prompt that superseded
         * this one re-locks them the moment it is cancelled, and the superseding
         * run's own ownership check aborts it before it opens anything.
         *
         * Reachable on iOS in practice, not Android: the Android module keeps a
         * single `promise` field, so a second `authenticateAsync` orphans the
         * first rather than letting it resolve successfully. iOS builds a fresh
         * `LAContext` per call, so both really can answer.
         */
        console.warn(`[biogate] late success from superseded run=${id} — honoured`);
        ownerRun.current = id;
      }
      console.warn(`[biogate] prompt closed run=${id} success=${result.success}`);
      if (result.success) {
        setStatus('authed');
        setEverUnlocked(true);
      } else {
        setStatus('failed');
      }
    } catch (e) {
      console.warn(`[biogate] prompt threw run=${id}: ${(e as Error)?.message}`);
      if (ownerRun.current === id) {setStatus('failed');}
    } finally {
      clearTimeout(watchdog);
      // Only the OWNING run releases the guard; a superseded one would hand it
      // back while the newer prompt is still open.
      if (ownerRun.current === id) {
        authenticating.current = false;
        stalled.current = false;
      }
    }
  }, []);

  // Read the opt-in flag once on mount. Biometric Lock is OFF by default —
  // the gate only engages when the user enabled it in Settings.
  const readLockFlag = useCallback(async () => {
    setBootStalled(false);
    setLockEnabled(await resolveLockFlag());
  }, []);
  useEffect(() => { void readLockFlag(); }, [readLockFlag]);

  // Defer the initial prompt until after the first frame paints (so the
  // LockView renders smoothly before the native biometric dialog appears) —
  // but only once we know the lock is actually enabled.
  useEffect(() => {
    if (lockEnabled !== true) {return;}
    const task = InteractionManager.runAfterInteractions(() => { void authenticate(); });
    return () => task.cancel();
  }, [lockEnabled, authenticate]);

  /**
   * THE BOOT DEADLINE — the wedge the prompt watchdog structurally cannot see.
   *
   * It only starts once `authenticate()` has been entered. Two awaits happen
   * before that: the opt-in flag read, and `runAfterInteractions`. Either can
   * hang, and both land the user on a spinner with no button — the flag one on
   * a spinner with no LABEL either.
   *
   * Fails CLOSED (an unreadable flag engages the lock) and always ends on an
   * actionable state, so it cannot lock anyone out: the retry re-reads the flag
   * and a device with no enrolment still falls through to 'unsupported'.
   */
  useEffect(() => {
    if (everUnlocked || lockEnabled === false) {return;}
    const t = setTimeout(() => {
      // A prompt IS in flight — it owns its own watchdog, leave it alone.
      if (authenticating.current) {return;}
      if (lockEnabled === null) {
        // The flag read never came back. Do NOT force the gate on — that
        // immediately fires the auto-prompt effect and swallows the very
        // button we are trying to show. Offer the retry instead; it re-reads
        // the flag, and children stay unmounted meanwhile (fail closed).
        console.warn('[biogate] BOOT STALLED — opt-in flag unreadable, offering retry');
        setBootStalled(true);
        return;
      }
      // Flag read fine, but the interaction queue never handed us the prompt.
      if (status === 'checking') {
        console.warn('[biogate] BOOT STALLED — prompt never started, offering retry');
        setStatus('stalled');
      }
    }, BOOT_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [lockEnabled, status, everUnlocked]);

  // Re-lock on return from background — but only after a GRACE WINDOW.
  // BS-LOCK — QA: the password/biometric prompt should fire on app start
  // and after a real exit, NOT on every quick app-switch or when bouncing
  // between dashboards (which can briefly background the app via a native
  // dialog / OS chrome). Re-locking on every background blip forced a
  // re-prompt constantly. Fix: stamp the time we backgrounded; on return,
  // only re-lock if we were away longer than LOCK_GRACE_MS. A quick
  // round-trip stays unlocked (WhatsApp/banking-app behaviour); a genuine
  // exit (or a long background) still re-prompts.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active') {
        const awayMs = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
        backgroundedAt.current = null;
        // Within the grace window → treat as a quick switch; stay unlocked.
        if (awayMs > 0 && awayMs < LOCK_GRACE_MS) {return;}
        // Re-read the opt-in flag so enabling/disabling Biometric Lock in
        // Settings takes effect on the next foreground. Only re-lock when on.
        // Through the SAME resolver as the boot read (retry + mirror,
        // fail-closed) — the bare `.catch(() => null)` that used to live here
        // was the B-438-class fail-open, on the more frequent path.
        void (async () => {
          const enabled = await resolveLockFlag();
          setLockEnabled(enabled);
          if (!enabled) {return;}
          useVaultStore.getState().lock();
          setStatus('checking');
          void authenticate();
        })();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [status, authenticate]);

  const unlocked = status === 'authed' || status === 'unsupported';
  const showLock = !unlocked;

  // Lock OFF (default) → no gate at all.
  if (lockEnabled === false) {return <>{children}</>;}
  // Still reading the flag → neutral dark splash for the ~instant it takes,
  // so app content never flashes before a (possibly enabled) lock engages.
  // …unless the read never came back, in which case that splash has no label
  // and no button and is the most silent wedge in the file. Offer the retry;
  // it re-reads the flag, and children stay unmounted until it answers.
  if (lockEnabled === null) {
    return bootStalled
      ? <LockView status="stalled" onRetry={() => void readLockFlag()} />
      : <LoadingView fullscreen />;
  }

  // First boot — no children yet; full-screen lock until first unlock.
  if (!everUnlocked) {
    return <LockView status={status} onRetry={() => void authenticate()} />;
  }

  // After first unlock — keep children mounted; overlay lock when re-locked.
  return (
    <View style={{flex: 1}}>
      {children}
      {showLock && (
        <View style={[StyleSheet.absoluteFillObject, {zIndex: 1000}]}>
          <LockView status={status} onRetry={() => void authenticate()} />
        </View>
      )}
    </View>
  );
}

function LockView({status, onRetry}: {status: Status; onRetry: () => void}) {
  // Waiting states render THE loading screen itself — the founder's rule is
  // that every loading screen is this one, so the gate composes it rather
  // than drawing a lookalike.
  //
  // 'stalled' MUST fall through to the actionable half. It was added precisely
  // because a waiting state with no way out is this gate's whole failure mode:
  // the user sat on "Verifying identity…" with nothing to press.
  if (status !== 'failed' && status !== 'stalled') {
    return (
      <View style={s.root}>
        <LoadingView fullscreen label="Verifying identity…" />
      </View>
    );
  }
  return (
    <View style={s.root}>
      <BravoShieldBadge size={96} />
      <Text style={s.title}>Bravo Secure</Text>
      <Text style={s.subtitle}>
        {status === 'stalled'
          // Honest: nothing answered. Telling them it was "cancelled or failed"
          // when they never saw a prompt is the copy that makes a stuck gate
          // look like a broken app.
          ? 'The unlock prompt did not respond. Tap to try again.'
          : 'Authentication cancelled or failed.'}
      </Text>
      <TouchableOpacity style={s.retryBtn} activeOpacity={0.85} onPress={onRetry}>
        <Icon name="fingerprint" size={18} color="#fff" style={{marginRight: 8}} />
        <Text style={s.retryText}>UNLOCK</Text>
      </TouchableOpacity>
    </View>
  );
}

const PRIMARY = '#5B8DEF';
const BG      = '#07090D';

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    fontFamily: 'Manrope_800ExtraBold',
    fontSize: 24,
    color: '#F2F4F8',
    letterSpacing: -0.3,
    marginTop: 24,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Manrope_400Regular',
    color: 'rgba(229,233,242,0.62)',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 36,
    height: 52,
    paddingHorizontal: 28,
    backgroundColor: PRIMARY,
    borderRadius: 12,
    shadowColor: PRIMARY,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 6,
  },
  retryText: {
    color: '#fff',
    fontSize: 14, fontWeight: '800',
    letterSpacing: 1.5,
  },
});
