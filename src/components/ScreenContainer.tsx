/**
 * ScreenContainer — the responsive screen shell.
 *
 * Composes the existing KeyboardAvoidingScreen (keyboard-inset rule + optional
 * ScrollView) and adds the two things every screen was hand-rolling: SafeArea insets and
 * (on Android tablets) max-width centering. Adopting a screen means replacing
 * its outer `View`/`SafeAreaView` + keyboard + ScrollView boilerplate — and its
 * manual `paddingTop: insets.top` — with one `<ScreenContainer>`.
 *
 * SafeArea is applied via `useSafeAreaInsets()` (the pattern already used in
 * ~83 screens) rather than <SafeAreaView>, so behavior matches the rest of
 * the app and there's no nested-provider surprise.
 *
 * Tablet centering is a no-op on phones and on iOS (supportsTablet:false, so
 * iOS never reports tablet widths) — it only constrains width on Android
 * tablets/foldables. Pass `centerOnTablet={false}` for full-bleed screens
 * (maps, media) so they aren't letterboxed.
 *
 * For a fixed footer (e.g. a pinned primary button that must stay above the
 * keyboard while the body scrolls), pass it via `footer` — it renders inside
 * the keyboard-avoiding box but OUTSIDE the scroll body.
 */
import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import KeyboardAvoidingScreen from './KeyboardAvoidingScreen';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {maxContentWidth, isTablet} from '@utils/scaling';

type InsetEdge = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  children: React.ReactNode;
  /** Render content inside a ScrollView (default) or a fixed View. */
  scrollable?: boolean;
  /** SafeArea edges to pad. Default top + bottom (portrait). */
  edges?: InsetEdge[];
  /** Pinned content rendered after the scroll body, still above the keyboard. */
  footer?: React.ReactNode;
  /** Constrain + center content on Android tablets. No-op on phones/iOS. */
  centerOnTablet?: boolean;
  /** Outer background / layout style. */
  style?: StyleProp<ViewStyle>;
  /** Padding around the scrollable content. */
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export default function ScreenContainer({
  children,
  scrollable = true,
  edges = ['top', 'bottom'],
  footer,
  centerOnTablet = true,
  style,
  contentContainerStyle,
}: Props): React.ReactElement {
  const insets = useSafeAreaInsets();
  // B-184 — the bottom inset COLLAPSES while the keyboard is up; the IME
  // already covers the nav bar / home indicator, and KeyboardAvoidingScreen
  // below is the single node that reserves the overlap. Stacking the two is
  // exactly the blind space this rule exists to kill.
  const {safeBottom} = useKeyboardLayout();

  const insetPadding: ViewStyle = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? safeBottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };

  const centered = centerOnTablet && isTablet;
  const body = centered ? (
    <View style={styles.tabletCenter}>{children}</View>
  ) : (
    children
  );

  return (
    <View style={[styles.root, insetPadding, style]}>
      <KeyboardAvoidingScreen
        scrollable={scrollable}
        contentContainerStyle={contentContainerStyle}
        footer={footer !== null && footer !== undefined ? <View>{footer}</View> : undefined}>
        {body}
      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  tabletCenter: {width: '100%', maxWidth: maxContentWidth, alignSelf: 'center'},
});
