/**
 * B-680 — the app-wide accessibility font ceiling is a REAL mechanism, not a
 * decorative one.
 *
 * History: v1.0.253 shipped `Text.defaultProps.maxFontSizeMultiplier = 1.3`
 * (utils/textDefaults.ts). React 19 ignores `defaultProps` on function
 * components and RN 0.81's Text/TextInput are function components, so the cap
 * was INERT — every <Text> in the app rendered at raw system fontScale
 * (Android ≤ 2.0), which is what broke the client's Pro dashboard
 * (FONT_SCALE_LAYOUT_AUDIT_2026-08-27.md FS-01). The old
 * `textDefaults.test.ts` pinned the ASSIGNMENT, which passed while the
 * mechanism was dead.
 *
 * The real mechanism is a patch-package patch on
 * `react-native/Libraries/Text/Text.js` and
 * `react-native/Libraries/Components/TextInput/TextInput.js` that defaults
 * `maxFontSizeMultiplier` to 1.3 when the element does not set it. This test
 * renders through the SAME patched source the app bundles, so it goes red the
 * moment an RN upgrade drops the patch or the hunk stops applying.
 */
import React from 'react';
import {Text, TextInput} from 'react-native';

/**
 * react-test-renderer ships no type declarations and @types/react-test-renderer
 * is not installed — a typed import would add a TS7016 to the tsc baseline.
 * require() keeps the module untyped at the boundary and typed here (same
 * idiom as groupCallHookBoot.test.ts).
 */
interface RendererInstance {
  toJSON: () => {props: Record<string, unknown>};
  unmount: () => void;
}
interface RendererModule {
  create: (el: React.ReactElement) => RendererInstance;
  act: (cb: () => unknown) => void;
}

const {create, act} = require('react-test-renderer') as RendererModule;

const MAX_FONT_SCALE = 1.3;

function hostProps(el: React.ReactElement): Record<string, unknown> {
  let tr!: RendererInstance;
  act(() => {
    tr = create(el);
  });
  const props = tr.toJSON().props;
  act(() => tr.unmount());
  return props;
}

describe('B-680 — global maxFontSizeMultiplier ceiling (patched into RN)', () => {
  it('an unadorned <Text> reaches the host capped at 1.3', () => {
    expect(hostProps(<Text>x</Text>).maxFontSizeMultiplier).toBe(MAX_FONT_SCALE);
  });

  it('an explicit per-element cap still wins (screens may opt further down)', () => {
    expect(
      hostProps(<Text maxFontSizeMultiplier={1.1}>x</Text>).maxFontSizeMultiplier,
    ).toBe(1.1);
  });

  it('an explicit opt-OUT (undefined ceiling via 0) is honored, not overwritten', () => {
    // RN treats 0 as "no max". A screen that deliberately passes 0 keeps it.
    expect(hostProps(<Text maxFontSizeMultiplier={0}>x</Text>).maxFontSizeMultiplier).toBe(0);
  });

  it('an unadorned <TextInput> reaches the host capped at 1.3', () => {
    expect(hostProps(<TextInput />).maxFontSizeMultiplier).toBe(MAX_FONT_SCALE);
  });

  it('an explicit per-element TextInput cap still wins', () => {
    expect(hostProps(<TextInput maxFontSizeMultiplier={1.2} />).maxFontSizeMultiplier).toBe(1.2);
  });
});

describe('B-680 — the RUNTIME files carry the patch (the render path above goes through jest mocks)', () => {
  /**
   * Under jest, RN's setup swaps Text/TextInput for pass-through mocks, so the
   * render assertions above prove the MOCK layer. These scans prove the actual
   * bundled sources — the thing the device runs — still carry the injection.
   * Both layers live in the same patches/react-native+*.patch, which
   * patch-package applies atomically, but an RN upgrade regenerating
   * node_modules with a stale patch is exactly the drift this catches.
   */
  const fs = require('fs');
  const path = require('path');
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '../../../node_modules/react-native', rel), 'utf8');

  it('Libraries/Text/Text.js defaults restProps.maxFontSizeMultiplier to 1.3', () => {
    const src = read('Libraries/Text/Text.js');
    expect(src).toMatch(/if \(restProps\.maxFontSizeMultiplier === undefined\) \{\s*\r?\n\s*restProps\.maxFontSizeMultiplier = 1\.3;/);
  });

  it('Libraries/Components/TextInput/TextInput.js defaults otherProps.maxFontSizeMultiplier to 1.3', () => {
    const src = read('Libraries/Components/TextInput/TextInput.js');
    expect(src).toMatch(/if \(otherProps\.maxFontSizeMultiplier === undefined\) \{\s*\r?\n\s*otherProps\.maxFontSizeMultiplier = 1\.3;/);
  });
});
