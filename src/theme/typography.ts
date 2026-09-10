/**
 * Typography — Manrope via @expo-google-fonts/manrope.
 * Each style uses the exact loaded family name so Android resolves the correct font file.
 *
 * Font sizes + line heights are routed through `scaleFont` (see
 * src/utils/scaling.ts) so type is responsive on small/large devices,
 * clamped to 0.85×–1.20× of the design size. Computed once at module load
 * (the device size is fixed under portrait-lock), so this stays a plain
 * object with the same keys/shape — screens reading `Typography.h1` are
 * unchanged. Identity at the 375dp reference device.
 */
import {scaleFont} from '@utils/scaling';

export const FontFamily = {
  light:     'Manrope_300Light',
  regular:   'Manrope_400Regular',
  medium:    'Manrope_500Medium',
  semiBold:  'Manrope_600SemiBold',
  bold:      'Manrope_700Bold',
  extraBold: 'Manrope_800ExtraBold',
} as const;

export const Typography = {
  // ─── Display ─────────────────────────────────────────
  h1: {
    fontFamily: FontFamily.bold,
    fontSize: scaleFont(32),
    lineHeight: scaleFont(40),
    letterSpacing: -0.5,
  },
  h2: {
    fontFamily: FontFamily.bold,
    fontSize: scaleFont(24),
    lineHeight: scaleFont(32),
    letterSpacing: -0.3,
  },
  h3: {
    fontFamily: FontFamily.semiBold,
    fontSize: scaleFont(20),
    lineHeight: scaleFont(28),
  },
  h4: {
    fontFamily: FontFamily.semiBold,
    fontSize: scaleFont(17),
    lineHeight: scaleFont(24),
  },

  // ─── Body ─────────────────────────────────────────────
  bodyLarge: {
    fontFamily: FontFamily.regular,
    fontSize: scaleFont(17),
    lineHeight: scaleFont(26),
  },
  body: {
    fontFamily: FontFamily.regular,
    fontSize: scaleFont(15),
    lineHeight: scaleFont(22),
  },
  bodySmall: {
    fontFamily: FontFamily.regular,
    fontSize: scaleFont(13),
    lineHeight: scaleFont(18),
  },

  // ─── UI ──────────────────────────────────────────────
  label: {
    fontFamily: FontFamily.medium,
    fontSize: scaleFont(13),
    lineHeight: scaleFont(18),
    letterSpacing: 0.3,
  },
  caption: {
    fontFamily: FontFamily.regular,
    fontSize: scaleFont(11),
    lineHeight: scaleFont(15),
    letterSpacing: 0.2,
  },
  button: {
    fontFamily: FontFamily.semiBold,
    fontSize: scaleFont(16),
    lineHeight: scaleFont(22),
    letterSpacing: 0.2,
  },
  buttonSmall: {
    fontFamily: FontFamily.semiBold,
    fontSize: scaleFont(14),
    lineHeight: scaleFont(20),
  },
  overline: {
    fontFamily: FontFamily.bold,
    fontSize: scaleFont(11),
    lineHeight: scaleFont(15),
    letterSpacing: 3,
    textTransform: 'uppercase' as const,
  },
} as const;
