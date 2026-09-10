/**
 * Bravo — premium security-comms design tokens.
 * Brand Kit v4 | ODX-BRAVO-PROP-2026-001
 *
 * Single source of truth for colors + typography across all Bravo screens.
 * Design direction: Command Navy base, Electric Blue accent,
 * restrained signal-green / amber / error-red semantics.
 */
import {Platform} from 'react-native';

export const Bravo = {
  // ─── Backgrounds ──────────────────────────────────────────────
  // B-90 T-13 — retargeted to the obsidian system (see theme/colors.ts).
  bg:        '#07090D',   // Obsidian — main app bg (was Command Navy #0A1F3F)
  bgSoft:    '#05070B',   // Obsidian depth layers (was Tactical Midnight #06142B)

  // ─── Surfaces ──────────────────────────────────────────────────
  card:      'rgba(27, 58, 102, 0.72)',   // surface-1 with alpha
  cardSolid: '#162F54',                   // surface-2
  cardHi:    '#122747',                   // surface-3 / drawers

  // ─── Hairlines / borders ───────────────────────────────────────
  hair:      '#1C3B66',   // border-subtle — most UI separators
  hair2:     '#244C82',   // border-default — emphasis borders
  edgeLight: 'rgba(36, 76, 130, 0.5)',

  // ─── Type ──────────────────────────────────────────────────────
  text:      '#FFFFFF',   // text-primary — titles, key data
  textDim:   '#B8C7E0',   // text-secondary — supporting text
  textMute:  '#7E8AA6',   // text-muted — metadata, timestamps
  textFaint: 'rgba(126, 138, 166, 0.5)',

  // ─── Semantic ──────────────────────────────────────────────────
  signal:    '#00C853',                    // color-success / online
  signalDim: 'rgba(0, 200, 83, 0.14)',
  amber:     '#FFC107',                    // color-warning
  amberDim:  'rgba(255, 193, 7, 0.12)',
  alert:     '#D50000',                    // color-error
  alertDim:  'rgba(213, 0, 0, 0.16)',
  info:      '#3BA6FF',                    // color-info

  // ─── Accent (Electric Blue) ────────────────────────────────────
  accent:     '#1E88FF',                    // action-default
  accentDeep: '#0E72E0',                    // action-pressed (gradient end)
  accentSoft: '#3BA6FF',                    // action-hover
  accentGlow: 'rgba(30, 136, 255, 0.35)',

  // ─── Premium glow (cyan highlight on accents — verified ring,
  // reply-quote bar, read-state checkmarks, dock primary CTA glow) ──
  glow:       '#7ED6FF',                    // text-on-glow surfaces
  glowSoft:   'rgba(126, 214, 255, 0.35)',  // halo around avatar / mic
  glowMute:   'rgba(126, 214, 255, 0.08)',  // ic-btn fill

  // ─── Module tints (function-only differentiation) ──────────────
  tintViolet:    '#A78BFA',
  tintViolet2:   '#6366F1',
  tintIndigo:    '#818CF8',
  tintIndigo2:   '#4F46E5',
} as const;

export const BravoFont = {
  light:       'Manrope_300Light',
  regular:     'Manrope_400Regular',
  medium:      'Manrope_500Medium',
  semiBold:    'Manrope_600SemiBold',
  bold:        'Manrope_700Bold',
  extraBold:   'Manrope_800ExtraBold',
  // Aliases for legacy references
  sans:        'Manrope_400Regular',
  display:     'Manrope_700Bold',
  mono:        Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'})!,
} as const;

/** Named screen-spec dimensions shared across screens. */
export const BravoMetrics = {
  tabBarH:        72,
  headerPadTop:   6,
  headerPadX:     18,
  cardRadius:     18,
  pillRadius:     999,
} as const;
