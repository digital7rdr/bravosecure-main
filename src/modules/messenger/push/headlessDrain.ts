/**
 * B-324/B-325 residuals — the Signal-style KILLED-APP drain.
 *
 * Founder-approved 2026-07-29 ("Signal/WhatsApp level"), superseding the
 * wake-metadata option: the push stays metadata-light; the app wakes,
 * connects, decrypts and PERSISTS, then notifies fully-resolved — the model
 * Signal's PushNotificationReceiveJob uses. Concretely:
 *
 *   msg-wake (killed VM) → configureRuntimeFromPersisted()
 *                        → startBackgroundMessageNotifier({headless:true})
 *                        → getMessengerRuntime('production')  (connect+drain)
 *                        → pullEnvelopes()
 *
 * The store notifier is started BEFORE the pull so every row the drain
 * ingests banners through the ONE composition path the warm path already
 * uses (group-name title, sender Person, preview, mute, mention, badge,
 * B-323 send time). No second composition rule exists to drift.
 *
 * FAIL-OPEN CONTRACT: every guard returns 'unavailable' and the caller
 * (fcmHeadless) falls back to the pre-drain generic/guess banner. This
 * module may never make the killed path WORSE than before it existed.
 *
 * Safety gates — each pins a real incident class:
 *  - RESTORE gate (B-107): booting the runtime mid-restore ran
 *    installIdentity + a bundle publish with a throwaway identity and
 *    permanently disarmed the RESTORE gate (Round-8 data loss).
 *  - hasDbKey (Round-8 sibling): with NO local identity, a runtime boot
 *    KEYGENS one. A background wake must never be the thing that creates
 *    an identity — that destroys restorability exactly like B-107.
 *  - persisted-config record: written by MainNavigator's configure effect,
 *    cleared on signOut. Absent → never logged in here → no boot.
 *
 * Everything is lazy-required: this module is reachable from index.js's
 * top-level (via fcmHeadless) and must not drag the runtime into the
 * bundle-boot path.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {tokenVault} from '@services/tokenVault';
import {classifyPullReport, type RelayPullReport} from '../runtime/relayPullReport';
import {flushAcksBounded} from './flushAcksBounded';

export const HEADLESS_CONFIG_KEY = 'msg:headless-runtime-config:v1';

/**
 * B-703 MR-1 — 'incomplete' is the outcome that used to masquerade as
 * 'drained': the pull completed but left real envelopes on the relay
 * (identity-regen / transient-sql leave-on-relay), so nothing was ingested and
 * the caller still owes the user a banner.
 */
export type HeadlessDrainOutcome = 'drained' | 'incomplete' | 'unavailable' | 'failed';

interface PersistedHeadlessConfig {
  ownUserId: string;
  ownerKey:  string;
  /** The sender-cert authority PUBLIC key MainNavigator configured with —
   *  persisted verbatim so the two configs can never drift. Public material
   *  only; never a secret. */
  authorityPubKeyB64: string;
}

/** Written by MainNavigator right after configureMessengerRuntime — ids + the
 *  public authority key only (no tokens, no private keys; the token getter
 *  reads keychain/storage live). */
export async function persistHeadlessRuntimeConfig(cfg: PersistedHeadlessConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(HEADLESS_CONFIG_KEY, JSON.stringify(cfg));
  } catch { /* headless drain simply stays unavailable */ }
}

/** signOut clears it — a wake after logout must not boot the runtime. */
export async function clearHeadlessRuntimeConfig(): Promise<void> {
  try {
    await AsyncStorage.removeItem(HEADLESS_CONFIG_KEY);
  } catch { /* best-effort */ }
}

/** Zustand-persist rehydration settles in microtasks against AsyncStorage,
 *  but its custom merge REPLACES `conversations` — ingesting before it lands
 *  could strand rows. Bounded so a storage stall can't hang the wake. */
async function storeHydrated(store: {
  persist?: {hasHydrated?: () => boolean; onFinishHydration?: (cb: () => void) => () => void};
}): Promise<void> {
  const p = store.persist;
  if (!p?.hasHydrated || p.hasHydrated()) {return;}
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 3000);
    const unsub = p.onFinishHydration?.(() => {
      clearTimeout(timer);
      unsub?.();
      resolve();
    });
    if (!unsub) { clearTimeout(timer); resolve(); }
  });
}

/**
 * Rebuild the EXACT MainNavigator runtime config from the persisted record.
 * True → the production runtime is configured (or already was) and safe to
 * boot; false → a precondition failed and the caller must fall back.
 *
 * Also used by fcmBootstrap's tap-time pull, so a notification tap on a
 * cold (pre-UI) launch can start ingesting before MainNavigator mounts.
 */
export async function configureRuntimeFromPersisted(): Promise<boolean> {
  try {
    const rt = require('../runtime/runtime') as typeof import('../runtime/runtime');
    // Already configured (warm VM, or a prior drain) → nothing to do. Never
    // reconfigure over a live config: MainNavigator owns identity switches.
    if (rt.getActiveOwnerKey()) {return true;}

    // [NOTIFLAT] bail probes (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md
    // §B1) — every `return false` below means the killed-app pre-fetch did NOT
    // run, so the tap pays the full boot+pull cost the founder reports as
    // 5–10 s. console.warn survives release builds; these name the guard that
    // fired so device logs can attribute the miss. Reasons only — never content.
    const raw = await AsyncStorage.getItem(HEADLESS_CONFIG_KEY);
    if (!raw) {console.warn('[NOTIFLAT] headless drain bail: no persisted config'); return false;}
    let cfg: Partial<PersistedHeadlessConfig>;
    try { cfg = JSON.parse(raw) as Partial<PersistedHeadlessConfig>; } catch {
      console.warn('[NOTIFLAT] headless drain bail: config unparsable');
      return false;
    }
    if (!cfg.ownUserId || !cfg.ownerKey || !cfg.authorityPubKeyB64) {
      console.warn('[NOTIFLAT] headless drain bail: config incomplete');
      return false;
    }

    try {
      const {isRestoreModeActive} = require('../backup/restoreMode') as typeof import('../backup/restoreMode');
      if (isRestoreModeActive()) {
        console.warn('[NOTIFLAT] headless drain bail: restore gate held'); // B-107 — never boot under the restore gate
        return false;
      }
    } catch { /* flag module unavailable — proceed */ }

    // Round-8 pin — no local identity means a boot would KEYGEN one. Bail.
    const {hasDbKey} = require('../runtime/keychain') as typeof import('../runtime/keychain');
    if (!(await hasDbKey(cfg.ownerKey))) {
      console.warn('[NOTIFLAT] headless drain bail: no local db key');
      return false;
    }

    const {API_BASE_URL, MSG_BASE_URL} =
      require('@utils/constants') as typeof import('@utils/constants');

    const {useMessengerStore} = require('../store/messengerStore') as typeof import('../store/messengerStore');
    await storeHydrated(useMessengerStore as never);
    useMessengerStore.getState().setOwner(cfg.ownerKey, cfg.ownUserId);

    // B-703 MR-13 — RE-CHECK, immediately before the write. Everything above
    // this line is awaits (AsyncStorage, the keychain probe, a store-hydration
    // wait), and an INTERACTIVE session can configure itself inside that
    // window: a cold notification TAP races MainNavigator by construction, and
    // so does wake-then-quick-open. Writing `backgroundBoot: true` over the
    // interactive config leaves that session presence-'away', socket-invisible
    // and sync-suppressed for its ENTIRE life — MainNavigator does not
    // reconfigure again, and no AppState path re-asserts it, so nothing heals
    // it short of a process restart ("my peer never shows online after I open
    // from a notification").
    //
    // Answering `true` is correct: the caller asked whether a usable runtime is
    // configured, and one is — a better one.

    if (rt.getActiveOwnerKey()) {
      console.warn('[NOTIFLAT] headless configure skipped — an interactive runtime claimed it first');
      return true;
    }

    // The MainNavigator literal minus UI concerns. NO _resetMessengerRuntime:
    // a reset here would tear down a live runtime; fresh VMs have none.
    const wsUrl = `${MSG_BASE_URL.replace(/^http/, 'ws')}/ws`;
    rt.configureMessengerRuntime({
      authBaseUrl:      API_BASE_URL,
      messengerBaseUrl: MSG_BASE_URL,
      wsUrl,
      getToken:         () => tokenVault.getAccess(),
      refreshToken:     () => {
        const {refreshAccessTokenShared} = require('@/services/api') as typeof import('@/services/api');
        return refreshAccessTokenShared();
      },
      authorityPubKeyB64: cfg.authorityPubKeyB64,
      ownUserId:        cfg.ownUserId,
      ownerKey:         cfg.ownerKey,
      // B-354 — this config lane has NO UI (killed-app drain / notification
      // actions), so its socket must be presence-invisible: without the flag,
      // a message wake made the recipient light up "Active now" for every
      // watcher while the app was killed. If the user then opens the app,
      // MainNavigator always reconfigures WITHOUT the flag and rebuilds, so
      // the interactive session's socket presents presence normally.
      backgroundBoot:   true,
    });
    return true;
  } catch (e) {
    console.warn('[fcm-headless] configureRuntimeFromPersisted failed:', (e as Error).message);
    return false;
  }
}

/**
 * The bounded killed-app drain.
 *
 * 'drained' means the runtime booted, the pull completed AND every envelope it
 * pulled was accounted for — so the store notifier has posted (or correctly
 * withheld) every banner. 'incomplete' means the pull completed but left
 * envelopes on the relay: they were NOT ingested, so silence would hide a real
 * message (B-703 MR-1). 'unavailable' means a precondition failed BEFORE any
 * boot; 'failed' means the boot/pull threw, or reported nothing to trust.
 * Callers treat anything but 'drained' as "post the pre-drain fallback banner".
 */
export async function headlessDrainAndNotify(): Promise<HeadlessDrainOutcome> {
  // B-715 — stamped before the FIRST guard, so `drainMs` on the verdict line
  // covers the config read, the keychain probe and the store-hydration wait as
  // well as the runtime boot and the pull. Those guards are awaits too, and a
  // measurement that started after them would under-report the wake's real cost.
  const drainStartedAt = Date.now();
  try {
    if (!(await configureRuntimeFromPersisted())) {return 'unavailable';}

    // BEFORE the pull, so the notifier banners exactly the rows the drain
    // ingests.
    //
    // NOTE (B-703 MR-1, critic H1): it baselines against the ZUSTAND VAULT,
    // which does NOT contain `messages` — they live in SQLCipher. So in a fresh
    // headless VM the baseline is an empty message map, and the runtime boot's
    // own `hydrateMessages` replays history through this subscriber. Anything
    // that treats a notifier decision here as "this wake was handled" must
    // account for that replay. A "did the notifier withhold?" signal is NOT
    // safe — it silenced the first wake of every VM when it was tried.
    //
    // REVISED (B-703 MR-19): a bare `messagePostedGeneration` delta used to be
    // safe here because hydration of a 1-row thread could only ADD a banner.
    // The killed lane now reads `cueDeliveredSince`, which also answers false
    // when a draw FAILED — so a hydration-replay draw that fails can suppress.
    // That direction is the safe one (it makes the generic fallback MORE
    // likely, never less), and the failure is scoped to the wake's own
    // conversation when the wake names one. Do not re-widen it to a global
    // failure count: one thread's miss would then downgrade another's card.
    const notifier = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
    notifier.startBackgroundMessageNotifier({headless: true});

    const rt = require('../runtime/runtime') as typeof import('../runtime/runtime');
    const runtime = await rt.getMessengerRuntime('production');
    // B-710 — the boot we just awaited replayed the whole SQLCipher history
    // through the store subscriber. The notifier held its draws for exactly that
    // reason (its length-based anti-spray guard needs MORE THAN ONE row, so a
    // one-message thread walked through and re-bannered an old message, with
    // sound — and that draw then told this wake's own fallback "a banner exists"
    // for the message that actually arrived). The boot is done: release the hold
    // so what `pullEnvelopes` appends below counts as an arrival.
    //
    // Guarded: a throw here would turn a healthy drain into 'failed' and send the
    // killed lane down the generic-fallback path for no reason.
    try { notifier.armBackgroundMessageNotifier?.(); }
    catch (e) { console.warn('[headlessDrain] notifier arm failed:', (e as Error).message); }
    // B-703 MR-1 — pullEnvelopes never throws, so its REPORT is the only signal
    // that the fetch actually did its job. A missing method (degraded build)
    // classifies as 'failed', not 'drained': nothing was ingested either way.
    const report = await (runtime as unknown as {
      pullEnvelopes?: () => Promise<RelayPullReport | void>;
    }).pullEnvelopes?.();
    // Classify and report FIRST: `report` is already captured, nothing below
    // can change the verdict, and the probe line here is the one §7 of the
    // audit says must be read off a device — a slow or throwing flush must
    // not delay it or (via the outer catch) demote a drained wake to 'failed'.
    const verdict = classifyPullReport(report);
    // B-715 — this used to print only when the verdict was NOT 'drained', which
    // hid exactly the baseline a latency capture needs: with no line on the happy
    // path there is nothing to compare a slow run against, and no way to tell
    // "the drain finished quickly" from "the drain never ran". `drainMs` is the
    // whole configure→boot→pull leg, which on a killed device is the largest
    // client-side term in the wake→✓✓ chain.
    console.warn(
      `[NOTIFLAT] headless drain ${verdict}: drainMs=${Date.now() - drainStartedAt} pulled=${report?.pulled ?? 0} acked=${report?.acked ?? 0} skipped=${report?.skipped ?? 0} leftOnRelay=${report?.leftOnRelay ?? 0}`,
    );
    // B-703 MR-5 — then WAIT for the acks before this task resolves. When it
    // returns, Android is free to freeze the process, and an unsent ack means
    // the relay never learns this device holds the message: the sender's tick
    // stays SINGLE until the recipient opens the app (the founder's "double
    // tick only when that person is in the messenger") and the envelope
    // redelivers, which feeds the duplicate lane (MR-7). Bounded — see the
    // module doc for why an unbounded wait would trade a stuck tick for a
    // muted thread that dings.
    await flushAcksBounded(runtime, 'headless drain');
    return verdict;
  } catch (e) {
    console.warn('[fcm-headless] drain failed:', (e as Error).message);
    return 'failed';
  }
}
