/**
 * App-wide text-scaling policy — B-680.
 *
 * Layouts are designed to hold ~1.3× type; Android lets users push fontScale
 * to 2.0. The ceiling honors the user's accessibility setting UP TO 1.3, the
 * point the design system is verified at (DESIGN_REVIEW_LOOP §2 fontScale
 * matrix row). Individual elements may still opt a specific Text further down
 * (`maxFontSizeMultiplier` on the element wins), or out (`0` = uncapped).
 *
 * THE MECHANISM DOES NOT LIVE IN THIS FILE. The v1.0.253 attempt set
 * `Text.defaultProps.maxFontSizeMultiplier` here — React 19 ignores
 * `defaultProps` on function components and RN 0.81's Text/TextInput are
 * function components, so that was INERT (the client-device breakage audited
 * in docs/audits/FONT_SCALE_LAYOUT_AUDIT_2026-08-27.md). The real cap is
 * patched directly into RN via `patches/react-native+0.81.5.patch`:
 *   - Libraries/Text/Text.js               (restProps default)
 *   - Libraries/Components/TextInput/TextInput.js (otherProps default)
 *   - jest/mocks/{Text,TextInput}.js       (same default for jest renders)
 * Pinned by `src/utils/__tests__/textScaleCap.test.tsx` (render + source
 * scan). If the patch value ever changes, change MAX_FONT_SCALE with it.
 */
export const MAX_FONT_SCALE = 1.3;
