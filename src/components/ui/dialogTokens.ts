/**
 * The obsidian/cobalt dialog vocabulary, extracted from BravoAlertHost (B-88).
 *
 * Why this file exists: `Alert.alert` can only render title/message/buttons, so
 * any dialog needing an input or a date picker has to be a bespoke Modal. Those
 * bespoke dialogs must look identical to the app-wide one — and the way that
 * goes wrong here is a second hand-copied palette that silently drifts. One
 * definition, imported by both.
 */
export const DIALOG = {
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.72)',
  textMute:  'rgba(180,188,204,0.45)',
  hair2:     'rgba(255,255,255,0.09)',
  glassFill: 'rgba(255,255,255,0.04)',
  accent:    '#5B8DEF',
  onAccent:  '#A9C5FF',
  danger:    '#F87171',
  amber:     '#F5C76B',
  backdrop:  'rgba(4,6,10,0.72)',
} as const;

export const CARD_GRADIENT = ['#131A28', '#0C111B'] as const;
export const FILL_GRADIENT = ['#4C86F0', '#2F5BE0'] as const;

/** Geometry shared by every Bravo dialog. */
export const DIALOG_METRICS = {
  cardRadius:      22,
  cardMaxWidth:    340,
  backdropPadding: 24,
  medallionSize:   44,
  buttonRadius:    14,
  buttonMinHeight: 48,
} as const;
