/**
 * RTL layout helpers (BUILD_RUNBOOK Step 25). One place for the logical-direction logic so
 * the shared components (StepperBar, etc.) don't each re-implement `I18nManager.isRTL`
 * checks. NB: per `scaling.ts`, static styles read Dimensions at module load and do NOT
 * reflow mid-session — so RTL is applied via I18nManager + these per-render helpers, never
 * via a static re-read.
 */
import {I18nManager} from 'react-native';

export function isRTL(): boolean {
  return I18nManager.isRTL;
}

/** Reverse an ordered list (e.g. a stepper) when the layout is RTL. */
export function reverseIfRTL<T>(items: readonly T[]): T[] {
  return I18nManager.isRTL ? [...items].reverse() : [...items];
}

/** A row flexDirection that respects the current layout direction. */
export function rowDirection(): 'row' | 'row-reverse' {
  return I18nManager.isRTL ? 'row-reverse' : 'row';
}
