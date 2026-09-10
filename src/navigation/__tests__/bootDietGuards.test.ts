/**
 * W4/B-685 — boot-diet pins (DEAD_PHONE_SMOOTHNESS_PLAN.md).
 *
 * Two boot costs were paid by EVERY account for features only some roles use,
 * and both regrow from one innocent import line:
 *
 *  1. MainNavigator statically imported the agent/CPO shells, whose import
 *     chain (AgentNavigator → AgentLiveTrackerScreen → BravoMap →
 *     @rnmapbox/maps) loads + initialises the 19 MB Mapbox native SDK.
 *     Device-confirmed 2026-08-28: MapboxInitializer + libmapbox-common.so +
 *     libmapbox-maps.so in logcat at shell mount on a messenger-only account.
 *     The shells are now required LAZILY at their render branches.
 *
 *  2. StripeProvider sat at the App root, initialising the native Stripe SDK
 *     at boot for a provider only four payment screens consume. Those screens
 *     now export through withPaymentBoundary, which mounts the provider
 *     per-screen (screen-module wrap, NOT registration-site wrap — the
 *     screens span BookingNavigator, AgentNavigator, and a direct
 *     MainNavigator render, and a registration wrap would miss one).
 *
 * Comment-stripped before every assertion (prose mentions the banned tokens);
 * CRLF-safe.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function stripped(rel: string): string {
  return readFileSync(join(process.cwd(), ...rel.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .split(/\r?\n/)
    .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

describe('W4 boot diet — role shells are lazy', () => {
  const main = stripped('src/navigation/MainNavigator.tsx');

  it('MainNavigator has NO static import of the agent/CPO shells', () => {
    expect(main).not.toMatch(/import\s+\w+\s+from\s+'\.\/AgentNavigator'/);
    expect(main).not.toMatch(/import\s+\w+\s+from\s+'\.\/CpoNavigator'/);
  });

  it('the shells are required lazily, memoized at module scope', () => {
    expect(main).toMatch(/LazyAgentNavigator\s*=\s*\(require\('\.\/AgentNavigator'\)/);
    expect(main).toMatch(/LazyCpoNavigator\s*=\s*\(require\('\.\/CpoNavigator'\)/);
    // The render branches still mount them (the lazy getter is USED, not dead).
    expect(main).toMatch(/getCpoNavigator\(\)/);
    expect(main).toMatch(/getAgentNavigator\(\)/);
  });
});

describe('W4 boot diet — Mapbox auto-init is stripped from the manifest', () => {
  it('both androidx.startup initializers carry tools:node="remove"', () => {
    // Raw manifest, no comment strip (XML comments contain the tokens, but the
    // assertions anchor on the meta-data ELEMENT shape, which prose never has).
    const manifest = readFileSync(
      join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8',
    ).replace(/<!--[\s\S]*?-->/g, '');
    // The maps FQCN carries a `.loader.` segment — the first cut targeted
    // `com.mapbox.maps.MapboxMapsInitializer` (the truncated logcat tag) and
    // the merged manifest kept the auto-init. Verify names against the MERGED
    // manifest, never the log tag.
    for (const name of ['com.mapbox.common.MapboxSDKCommonInitializer', 'com.mapbox.maps.loader.MapboxMapsInitializer']) {
      const re = new RegExp(
        `<meta-data\\s+android:name="${name.replace(/\./g, '\\.')}"\\s+tools:node="remove"\\s*/>`,
      );
      expect(manifest).toMatch(re);
    }
  });
});

describe('W4 boot diet — Stripe is off the boot path', () => {
  it('App.tsx neither imports nor renders StripeProvider', () => {
    const app = stripped('App.tsx');
    expect(app).not.toMatch(/@stripe\/stripe-react-native/);
    expect(app).not.toMatch(/<StripeProvider/);
  });

  it('PaymentBoundary requires Stripe lazily (no static import)', () => {
    const pb = stripped('src/components/PaymentBoundary.tsx');
    expect(pb).not.toMatch(/^\s*import\s+\{[^}]*StripeProvider[^}]*\}\s+from/m);
    expect(pb).toMatch(/require\('@stripe\/stripe-react-native'\)/);
  });

  it.each([
    ['src/screens/wallet/PaymentMethodsScreen.tsx', 'PaymentMethodsScreen'],
    ['src/screens/wallet/CreditsScreen.tsx', 'CreditsScreen'],
    ['src/screens/booking/CreditPaywallScreen.tsx', 'CreditPaywallScreen'],
    ['src/screens/pro/TierPaywall.tsx', 'TierPaywall'],
  ])('%s exports through withPaymentBoundary', (file, name) => {
    const src = stripped(file);
    expect(src).toMatch(new RegExp(`export default withPaymentBoundary\\(${name}\\)`));
    // Exactly one default export — the bare one must be GONE, not duplicated.
    expect(src.match(/export default/g)).toHaveLength(1);
  });
});
