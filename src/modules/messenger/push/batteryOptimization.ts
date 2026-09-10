/**
 * P2-BR-1 (background-reliability audit 2026-07-10) — JS bridge for
 * BravoBatteryOptimizationModule (Kotlin): Signal-style battery-optimization
 * exemption + OEM auto-start deep links.
 *
 * Why: aggressive OEM power managers (Transsion HiOS/XOS — the TECNO KM5 QA
 * device — MIUI, ColorOS, FuntouchOS, EMUI) force-stop a swiped-away or
 * overnight-"cleaned" app; a force-stopped app receives ZERO FCM, so
 * killed-app messages AND call rings black out until the user reopens the
 * app. The mitigation is user-granted: exempt the app from battery
 * optimization, and on OEMs with an auto-start/protected-apps screen,
 * whitelist it there too. NotificationReliabilityCard drives this flow.
 *
 * Contract:
 *   - Missing native module (old APK / iOS / tests) degrades safely:
 *     isIgnoringBatteryOptimizations resolves TRUE (nothing to prompt).
 *   - The exemption dialog's grant result is not awaitable; callers re-check
 *     isIgnoringBatteryOptimizations when the app returns to foreground.
 *   - The prompt snooze is per owner (AsyncStorage), default 7 days.
 */
import {NativeModules, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface BatteryOptimizationNative {
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  openAutostartSettings(): Promise<boolean>;
  canUseFullScreenIntent?(): Promise<boolean>;
  openFullScreenIntentSettings?(): Promise<boolean>;
  isDndEnabled?(): Promise<boolean>;
  openDndSettings?(): Promise<boolean>;
}

function native(): BatteryOptimizationNative | null {
  if (Platform.OS !== 'android') {return null;}
  const mod = (NativeModules as Record<string, unknown>).BravoBatteryOptimization as
    BatteryOptimizationNative | undefined;
  return mod ?? null;
}

/** TRUE when exempt (or when there is nothing to prompt: iOS / old APK). */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  const mod = native();
  if (!mod) {return true;}
  try {
    return await mod.isIgnoringBatteryOptimizations();
  } catch (e) {
    console.warn('[bravo.battopt] check failed:', (e as Error).message);
    return true;
  }
}

/** Fire the system "let app run in background" dialog. Never throws. */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  const mod = native();
  if (!mod) {return;}
  try {
    await mod.requestIgnoreBatteryOptimizations();
  } catch (e) {
    console.warn('[bravo.battopt] request failed:', (e as Error).message);
  }
}

/**
 * Open the OEM auto-start/protected-apps screen. Resolves TRUE when an OEM
 * screen opened, FALSE on the app-details fallback (or any failure).
 */
export async function openAutostartSettings(): Promise<boolean> {
  const mod = native();
  if (!mod) {return false;}
  try {
    return await mod.openAutostartSettings();
  } catch (e) {
    console.warn('[bravo.battopt] autostart open failed:', (e as Error).message);
    return false;
  }
}

/**
 * B-63 — TRUE when the app may post full-screen intents (the lock-screen
 * incoming-call UI). Android 14+ denies this by default for non-dialer apps;
 * the 2026-07-10 device log showed every ring flagged FSI_REQUESTED_BUT_DENIED.
 * TRUE on iOS / old APK / pre-Android-14 (nothing to prompt).
 */
export async function canUseFullScreenIntent(): Promise<boolean> {
  const mod = native();
  if (!mod?.canUseFullScreenIntent) {return true;}
  try {
    return await mod.canUseFullScreenIntent();
  } catch (e) {
    console.warn('[bravo.battopt] fsi check failed:', (e as Error).message);
    return true;
  }
}

/**
 * B-63 — open the per-app "Full screen notifications" settings screen.
 * Resolves TRUE when the FSI screen opened, FALSE on fallback/no-op.
 */
export async function openFullScreenIntentSettings(): Promise<boolean> {
  const mod = native();
  if (!mod?.openFullScreenIntentSettings) {return false;}
  try {
    return await mod.openFullScreenIntentSettings();
  } catch (e) {
    console.warn('[bravo.battopt] fsi open failed:', (e as Error).message);
    return false;
  }
}

/**
 * CA-07 — TRUE when Do Not Disturb is suppressing notifications. DND silences
 * message tones and call rings with every permission granted, which reads as
 * "the app is broken". FALSE on iOS / old APK / any failure (fail quiet:
 * never nag off a signal we can't read).
 */
export async function isDndEnabled(): Promise<boolean> {
  const mod = native();
  if (!mod?.isDndEnabled) {return false;}
  try {
    return await mod.isDndEnabled();
  } catch (e) {
    console.warn('[bravo.battopt] dnd check failed:', (e as Error).message);
    return false;
  }
}

/**
 * CA-07 — open the system Do Not Disturb settings. Resolves TRUE when the DND
 * screen opened, FALSE on fallback/no-op.
 */
export async function openDndSettings(): Promise<boolean> {
  const mod = native();
  if (!mod?.openDndSettings) {return false;}
  try {
    return await mod.openDndSettings();
  } catch (e) {
    console.warn('[bravo.battopt] dnd open failed:', (e as Error).message);
    return false;
  }
}

/** OEMs whose ROMs ship an auto-start / protected-apps kill list. */
const AUTOSTART_OEMS = [
  'tecno', 'infinix', 'itel', 'transsion',
  'xiaomi', 'redmi', 'poco',
  'oppo', 'realme',
  'vivo', 'iqoo',
  'huawei', 'honor',
];

/** TRUE when the device brand likely has an OEM auto-start screen to offer. */
export function hasOemAutostartScreen(): boolean {
  if (Platform.OS !== 'android') {return false;}
  const constants = (Platform as unknown as {constants?: {Brand?: string; Manufacturer?: string}}).constants;
  const fingerprint = `${constants?.Manufacturer ?? ''} ${constants?.Brand ?? ''}`.toLowerCase();
  return AUTOSTART_OEMS.some(oem => fingerprint.includes(oem));
}

// ── Reliability-prompt snooze (per owner, AsyncStorage) ──────────────────────

const SNOOZE_KEY_PREFIX = 'notifReliability:snoozeUntil:';
const SNOOZE_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days

function snoozeKey(ownerId: string | null): string {
  return `${SNOOZE_KEY_PREFIX}${ownerId ?? 'anon'}`;
}

export async function snoozeReliabilityPrompt(ownerId: string | null, durationMs: number = SNOOZE_DEFAULT_MS): Promise<void> {
  try {
    await AsyncStorage.setItem(snoozeKey(ownerId), String(Date.now() + durationMs));
  } catch (e) {
    console.warn('[bravo.battopt] snooze persist failed:', (e as Error).message);
  }
}

export async function isReliabilityPromptSnoozed(ownerId: string | null): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(snoozeKey(ownerId));
    if (!raw) {return false;}
    const until = Number(raw);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}
