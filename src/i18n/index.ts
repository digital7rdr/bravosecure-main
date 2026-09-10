/**
 * Lightweight in-house i18n (BUILD_RUNBOOK Step 25) — zero new deps. English + Arabic
 * (RTL) + Bengali. The device locale seeds the default (via Hermes Intl, no
 * expo-localization needed); the persisted user preference overrides it on boot. RTL is
 * applied via React Native's I18nManager — note forceRTL needs an app reload to fully
 * take effect, so a language change to/from Arabic shows a "restart" prompt (an RN limit).
 */
import {I18nManager} from 'react-native';
import en from './locales/en';
import ar from './locales/ar';
import bn from './locales/bn';

export type Lang = 'en' | 'ar' | 'bn';

const CATALOGS: Record<Lang, Record<string, string>> = {en, ar, bn};
const RTL_LANGS: readonly Lang[] = ['ar'];
const SUPPORTED: readonly Lang[] = ['en', 'ar', 'bn'];

let current: Lang = 'en';
const listeners = new Set<() => void>();

/** Best-effort device language via Intl (no extra dep); falls back to English. */
export function getDeviceLanguage(): Lang {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale; // e.g. 'ar-AE'
    const code = locale.split('-')[0].toLowerCase();
    if (code === 'ar' || code === 'bn') {return code;}
  } catch {
    /* Intl missing — fall through to English. */
  }
  return 'en';
}

export function getLanguage(): Lang {
  return current;
}

export function isSupported(lang: string): lang is Lang {
  return (SUPPORTED as readonly string[]).includes(lang);
}

export function isRtlLang(lang: Lang = current): boolean {
  return RTL_LANGS.includes(lang);
}

/** Set the active language (clamped to a supported one) and notify subscribers. */
export function setLanguage(lang: Lang): void {
  current = isSupported(lang) ? lang : 'en';
  listeners.forEach(l => l());
}

/**
 * Apply RTL layout for a language. Returns true if I18nManager actually flipped (the
 * caller should then prompt a reload — forceRTL only fully applies after a restart).
 */
export function applyRtl(lang: Lang = current): boolean {
  const shouldRtl = isRtlLang(lang);
  if (I18nManager.isRTL !== shouldRtl) {
    I18nManager.allowRTL(shouldRtl);
    I18nManager.forceRTL(shouldRtl);
    return true;
  }
  return false;
}

/** Translate a key with optional `{name}` interpolation; falls back en → key. */
export function t(key: string, params?: Record<string, string | number>): string {
  const cat = CATALOGS[current] ?? CATALOGS.en;
  let s = cat[key] ?? CATALOGS.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

/** Subscribe to language changes (for a re-render hook). Returns an unsubscribe fn. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Boot the i18n layer: persisted preference wins, else the device default. */
export function initI18n(persisted?: Lang | null): void {
  setLanguage(persisted && isSupported(persisted) ? persisted : getDeviceLanguage());
  applyRtl();
}
