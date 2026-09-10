/**
 * KeyboardAvoidingScreen — the blessed FORM shell: a scroll body that shrinks
 * by exactly the amount of screen the keyboard covers, so any field can be
 * scrolled above the IME.
 *
 * B-184: this used to wrap `KeyboardAvoidingView`. It no longer does, and no
 * file in `src/` may — `keyboardContract.test.ts` enforces that. KAV's
 * `frame.y` comes from `onLayout` and is PARENT-relative, its
 * `keyboardVerticalOffset` inflates the padding one-for-one, `behavior="height"`
 * leaves ghost space after the keyboard closes, and `behavior=undefined` (the
 * old app-wide Android idiom) is a plain no-op. All four are gone: the single
 * `useKeyboardOverlap()` rule replaces them.
 *
 * What this gives you:
 *   • The container shrinks by the true IME overlap on BOTH platforms
 *     (see src/hooks/useKeyboardLayout.ts for why the raw RN number differs).
 *   • A ScrollView with `keyboardShouldPersistTaps="handled"` so taps on
 *     buttons WHILE the keyboard is open dismiss it AND fire the press,
 *     instead of swallowing the press as a keyboard-dismissal gesture.
 *   • `footer` renders after the scroll body but INSIDE the shrinking box, so
 *     a pinned primary action stays above the keyboard.
 *
 * When NOT to use: surfaces with a bottom-anchored composer/sheet of their own
 * (chat, call, modals). Those apply `useKeyboardLayout().bottomPad(gap)` to
 * that bottom-most node directly — same rule, one node instead of a wrapper.
 */
import React from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useBottomInset} from '@hooks/useBottomInset';

interface Props {
  children: React.ReactNode;
  /** Outer container background — defaults to transparent so the parent screen color shows through. */
  style?: StyleProp<ViewStyle>;
  /** Inner ScrollView contentContainerStyle — use this for padding around the form. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Disable the default ScrollView and render children directly. Use when content fits one screen and you want fixed positioning. */
  scrollable?: boolean;
  /** Pinned content rendered after the scroll body, still above the keyboard. */
  footer?: React.ReactNode;
  /**
   * Resting gap below `footer`, handled HERE so no screen hand-rolls it again.
   *
   * While the IME is up the container is already lifted by the true overlap, so
   * the footer needs only the gap. While it is down the footer is the
   * bottom-most element and takes `useBottomInset().bottomPad(gap)` — which
   * includes the safe-area inset only when no tab bar sits below the screen.
   * Inside a tabbed shell (Departmental, CPO, root) the bar already owns that
   * space, and adding it again is the double-count B-184/`useBottomInset` exist
   * to stop. Omit the prop to keep the previous behaviour (no footer padding).
   */
  footerGap?: number;
  /** Pass-through ScrollView props for advanced cases (refresh control, etc.). */
  scrollViewProps?: Omit<ScrollViewProps, 'children' | 'contentContainerStyle' | 'keyboardShouldPersistTaps'>;
}

export default function KeyboardAvoidingScreen({
  children,
  style,
  contentContainerStyle,
  scrollable = true,
  footer,
  footerGap,
  scrollViewProps,
}: Props): React.ReactElement {
  const keyboardOverlap = useKeyboardOverlap();
  const {bottomPad} = useBottomInset();
  // Truthiness, not `!== undefined`: the common `footer={cond && <X/>}` idiom
  // yields `false`, and `footer={null}` is just as natural — either would have
  // produced an empty View padded by up to ~48dp of phantom gap.
  const paddedFooter = footer !== undefined && footer !== null && footer !== false && footerGap !== undefined
    ? <View style={{paddingBottom: keyboardOverlap > 0 ? footerGap : bottomPad(footerGap)}}>{footer}</View>
    : footer;
  return (
    <View style={[styles.flex, style, {paddingBottom: keyboardOverlap}]}>
      {scrollable ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          {...scrollViewProps}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, contentContainerStyle]}>{children}</View>
      )}
      {paddedFooter}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  scrollContent: {flexGrow: 1},
});
